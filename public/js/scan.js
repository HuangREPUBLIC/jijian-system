"use strict";
// 打点：扫菲票（摄像头 / 手输扎号）→ 选工序 → 提交，以及当天打点列表。

/* ---- 进页面前拉数据 ---- */
LOADERS.scan = async () => {
  const [p, s] = await Promise.all([api("GET", "/processes"), api("GET", "/styles")]);
  state.processes = p.processes || []; state.styles = s.styles || [];
  const [rec, eff] = await Promise.all([
    api("GET", "/scan?date=" + state.scan.date),
    api("GET", "/efficiency/daily?date=" + state.scan.date).catch(() => null)
  ]);
  state.scan.records = rec.records || []; state.scan.eff = eff;
};

/* ---- 页面渲染 ---- */
/* ---------- 打点 ---------- */
// 原生 BarcodeDetector 只有 Chrome/安卓有，iOS 全系 WebKit 内核没有，没有原生实现时退回 jsQR；
// 两条路都基于 getUserMedia，需要 https（或 localhost）安全上下文，否则浏览器不给摄像头。
const HAS_NATIVE_SCAN = typeof window !== "undefined" && "BarcodeDetector" in window;
const CAN_SCAN = typeof navigator !== "undefined" &&
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

function scanBundleHtml() {
  const sc = state.scan, b = sc.bundle;
  return `<section class="group">
    <div class="group-title">扫菲打点</div>
    <div class="card scan-card">
      ${sc.camOn ? `<div class="scan-viewport">
          <video id="scan-cam" class="scan-cam" playsinline muted autoplay></video>
          <div class="scan-frame" aria-hidden="true"><i class="scan-line"></i></div>
          <div class="scan-tools">
            <button type="button" class="scan-tool${A._torchOn ? " on" : ""}" id="scan-torch" ${A._torchCap ? "" : "hidden"} onclick="A.toggleTorch()" aria-pressed="${!!A._torchOn}">${icon("torch")}<span>手电筒</span></button>
            <button type="button" class="scan-tool" onclick="A.stopCamera()">${icon("close")}<span>关闭</span></button>
          </div></div>
        <div class="scan-hint" role="status">${esc(sc.camMsg || "把菲票上的二维码放进框里")}</div>`
      : CAN_SCAN ? `<button type="button" class="scan-cta" onclick="A.startCamera()">
          <span class="scan-cta-ic">${icon("scan")}</span>
          <span><b>扫码打点</b><small>对准菲票上的二维码，自动识别</small></span></button>` : ""}
      <div class="scan-manual">
        <input class="in" id="sc-ticket" value="${esc(sc.ticketInput)}" placeholder="或手动输入扎号 / 菲票号"
          inputmode="numeric" enterkeyhint="search" autocomplete="off"
          onchange="A.setTicketInput(this.value)" onkeydown="if(event.key==='Enter')A.lookupTicket()">
        <button class="btn mini" onclick="A.lookupTicket()">查找</button>
      </div>
      ${!CAN_SCAN ? `<div class="scan-note">${
        location.protocol === "https:" || location.hostname === "localhost"
          ? "这个浏览器不给用摄像头，请手动输入扎号或菲票号"
          : "摄像头需要 https 才能用（当前是 http），请手动输入扎号或菲票号"}</div>` : ""}
    </div>

    ${b ? `<div class="card style-card scan-result" id="scan-result" style="margin-top:10px">
      <div class="sc-head">
        ${styleThumbHtml(sc.bundleOrder.style_id, sc.bundleOrder.style_image)}
        <div class="sc-info">
          <div class="sc-title">扎号 ${b.bundle_no}　菲票 ${b.ticket_no}</div>
          <div class="sc-grid">
            ${kv("款号", esc(sc.bundleOrder.style_code || sc.bundleOrder.style_name || "—"))}
            ${kv("床次", sc.bundleOrder.bed_no)}
            ${bundleCells(b)}
          </div>
        </div>
      </div>
      <div class="proc-scan">
        ${sc.bundleProcs.map(p => `<div class="row-item">
          <div class="row-main"><div class="row-label">${esc(p.name)}${
            p.show_price && p.unit_price !== null ? ` <span class="row-sub">${num(p.unit_price)}元</span>` : ""}</div>
            <div class="row-sub">已完成 ${num(p.done)} 件，剩余 ${num(p.remaining)} 件</div></div>
          <div class="row-acts">
            ${p.remaining > 0 ? `<input class="in tiny" id="sq-${p.id}" type="number" inputmode="numeric"
                placeholder="${num(p.remaining)}" aria-label="${esc(p.name)} 打点件数，不填就是做完剩下的 ${num(p.remaining)} 件">
              <button class="act-btn" onclick="A.scanBundleSubmit('${p.id}')">打点</button>`
            : `<span class="tag ok">已完成</span>`}
          </div></div>`).join("")}
        <div class="scan-tip">件数不填 = 这一扎剩下的全部做完</div>
      </div>
    </div>` : ""}
  </section>`;
}

function vScan() {
  const procs = state.processes || [], styles = state.styles || [], eff = state.scan.eff;
  const recs = state.scan.records;
  const pct = eff && eff.percent !== null && eff.percent !== undefined ? eff.percent : null;
  return scanBundleHtml() + `<section class="group">
    <div class="group-title">自由打点（不按菲票）</div>
    <div class="card">
      <label class="field"><span>日期</span>${dateFieldHtml("sc-date", state.scan.date, "A.setScanDate(this.value)")}</label>
      <label class="field"><span>工序<span class="req">*</span></span>
        ${procs.length ? selectHtml("sc-proc", procs.map(p => [p.id, p.name]), (procs[0] || {}).id)
      : `<div class="row-sub">请先在「工序模板」里添加工序</div>`}</label>
      ${styles.length ? `<label class="field"><span>款式（选填）</span>
        ${selectHtml("sc-style", styles.map(s => [s.id, s.name + (s.code ? " · " + s.code : "")]), "", "", "不选")}</label>` : ""}
      <label class="field"><span>完成数量<span class="req">*</span></span>
        <input class="in" id="sc-qty" type="number" inputmode="decimal" step="any" placeholder="请输入件数"></label>
    </div>
    <div class="btn-row" style="padding-left:0;padding-right:0"><button class="btn block" onclick="A.submitScan()">提交打点</button></div>
  </section>

  <section class="group"><div class="card"><div class="row-item">
    <div class="row-main"><div class="row-label">今日完成度</div>
      <div class="row-sub">出勤 ${eff ? num(eff.attendanceHours) : 0} 小时 · 时效 ${eff ? Math.round((eff.effectiveHours || 0) * 10) / 10 : 0} 小时</div></div>
    ${pct !== null ? `<span class="tag ${pct >= 1 ? "ok" : "warn"}">${pctText(pct)}</span>`
      : `<span class="row-value">暂无考勤数据</span>`}
  </div></div></section>

  <section class="group">
    <div class="group-title">当天打点记录</div>
    <div class="card">${recs === null ? skeletonHtml(3, false) : recs.length ? recs.map(r => {
        const p = (state.processes || []).find(x => x.id === r.process_id);
        const name = r.process_name || (p ? p.name : "工序");
        // 扫扎产生的记录带扎号/颜色/尺码，自由打点的没有，两种都要能读
        const sub = r.bundle_no
          ? `扎号 ${r.bundle_no}${r.color ? " · " + esc(r.color) : ""}${r.size ? " · " + esc(r.size) : ""}`
          : "自由打点";
        return `<div class="row-item">
          <div class="row-main"><div class="row-label">${esc(name)}</div>
            <div class="row-sub">${sub} · ${HHMM(r.created_at)}</div></div>
          <div class="slog-qty num">${num(r.qty)}<span class="slog-unit">件</span></div>
          <div class="row-acts"><button class="act-btn danger ghost" onclick="A.delScan('${r.id}')">删除</button></div></div>`;
      }).join("") : emptyHtml("这天还没有打点记录", "scan")}</div>
  </section>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  setScanDate(v) { if (!v) return; state.scan.date = v; state.scan.records = null; go("scan"); },
  submitScan() {
    return guard("submitScan", async () => {
      const procs = state.processes || [];
      if (!procs.length) return toast("请先添加工序模板");
      const qty = val("sc-qty");
      if (!qty) return toast("请填写完成数量");
      if (!(Number(qty) > 0)) return toast("完成数量要大于 0");
      const styleId = val("sc-style");
      const r = await run(() => api("POST", "/scan", {
        processId: val("sc-proc"), styleId: styleId || undefined, date: state.scan.date, qty: Number(qty)
      }), "已打点");
      if (r) buzz(30);
    });
  },
  // 删打点记录会直接影响工资，先确认，而且把删的是哪一笔说清楚
  delScan(id) {
    const r = (state.scan.records || []).find(x => x.id === id);
    modal({
      title: "删除这条打点？", danger: true, okText: "删除",
      body: r ? `${r.process_name || "工序"} ${num(r.qty)} 件${r.bundle_no ? `（扎号 ${r.bundle_no}）` : ""}，删除后对应的计件工资也会扣掉。` : "删除后对应的计件工资也会扣掉。",
      onOk: () => { run(() => api("DELETE", "/scan/" + id), "已删除"); return true; }
    });
  },

  setTicketInput(v) { state.scan.ticketInput = v; },
  async lookupTicket(opt) {
    // DOM 里有值就以 DOM 为准（用户刚打的字还没失焦）；DOM 是空的就用 state
    // ——摄像头扫到码时是直接写 state 的，不能被空输入框清掉
    const el = $("sc-ticket");
    if (el && el.value.trim()) state.scan.ticketInput = el.value;
    // 扫出来的是 JJ:36440 这种带前缀的，手输的可能只有数字，两种都收
    const raw = String(state.scan.ticketInput || "").trim().replace(/^JJ:/i, "");
    if (!raw) return toast("请输入扎号或菲票号");
    try {
      const r = await api("GET", "/bundles/by-ticket/" + encodeURIComponent(raw));
      state.scan.bundle = r.bundle; state.scan.bundleOrder = r.order; state.scan.bundleProcs = r.processes;
    } catch (e) {
      state.scan.bundle = null; state.scan.bundleOrder = null; state.scan.bundleProcs = null;
      buzz([40, 60, 40]);
      toast((e && e.error) || "查不到这张菲票");
    }
    render();
    // 扫码进来的：把结果卡片滚到眼前，不用自己往下找
    if (opt && opt.scroll && state.scan.bundle) {
      setTimeout(() => { const el = $("scan-result"); if (el) el.scrollIntoView({ block: "start", behavior: REDUCED_MOTION ? "auto" : "smooth" }); }, 60);
    }
  },
  scanBundleSubmit(orderProcessId) {
    return guard("scan-" + orderProcessId, async () => {
      const el = $("sq-" + orderProcessId);
      const raw = el ? el.value.trim() : "";
      if (raw !== "" && !(Number(raw) > 0)) return toast("件数要大于 0");
      try {
        const r = await api("POST", "/scan", {
          ticketNo: state.scan.bundle.ticket_no, orderProcessId,
          qty: raw === "" ? undefined : Number(raw),   // 不填就是完成整扎剩余
          date: state.scan.date
        });
        buzz(30);
        toast(r && r.remaining === 0 ? `已打点 ${num(r.record.qty)} 件，这道工序整扎做完了` : `已打点 ${num(r.record.qty)} 件`);
        await A.lookupTicket();          // 重新拉一次，剩余件数立刻刷新
        await loadView("scan"); render();
      } catch (e) { buzz([40, 60, 40]); toast((e && e.error) || "打点失败"); }
    });
  },

  /* 摄像头扫码性能：jsQR 耗时与像素数成正比，先只解取景框附近的裁切区域（ROI，更快也更容易识别小码），
   * 每隔几帧再解整帧兜底；反色（黑底白码）少见，每 4 帧才试一次，省一半耗时。 */
  async startCamera() {
    const sc = state.scan;
    if (sc.camOn) { A.stopCamera(); return; }
    // 先渲染取景区；拿到视频流后不能再 render()（会把绑好流的 <video> 换掉导致黑屏），提示都直接改 DOM
    sc.camOn = true; sc.camMsg = "正在打开摄像头…"; render();
    const session = A._camSession = (A._camSession || 0) + 1;       // 关了又开，旧的那一轮循环要能认出自己已作废
    // 提示音要在用户点按的那一刻创建 AudioContext，否则 iOS 不让出声
    try { if (!A._beepCtx && (window.AudioContext || window.webkitAudioContext)) A._beepCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { }

    const setMsg = (t) => {
      state.scan.camMsg = t;
      const el = document.querySelector(".scan-hint");
      if (el) el.textContent = t;
    };
    // 每次用之前重新拿一次 video 元素并确认流还接着：万一别处触发了重绘，这里能自愈
    const attach = (stream) => {
      const v = $("scan-cam");
      if (!v) return null;
      if (v.srcObject !== stream) {
        v.srcObject = stream;
        v.setAttribute("playsinline", "");   // iOS 不加这个会强制全屏播放
        v.muted = true;
        const pr = v.play();
        if (pr && pr.catch) pr.catch(() => { });
      }
      return v;
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      if (A._camSession !== session || !state.scan.camOn) { stream.getTracks().forEach(t => t.stop()); return; }
      A._camStream = stream;
      if (!attach(stream)) { A.stopCamera(); return; }

      // 手电筒 / 连续对焦：只有部分安卓机型支持，拿得到能力才露出按钮
      const track = stream.getVideoTracks()[0];
      A._torchOn = false;
      try {
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        if (caps.focusMode && caps.focusMode.indexOf("continuous") >= 0) track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => { });
        A._torchCap = !!caps.torch;
        const tb = $("scan-torch"); if (tb && caps.torch) tb.hidden = false;
      } catch (e) { }

      const detector = HAS_NATIVE_SCAN ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
      if (!detector && !window.jsQR) {
        setMsg("正在加载扫码组件…");
        await new Promise((resolve, reject) => {
          const el = document.createElement("script");
          el.src = "/jsQR.js"; el.onload = resolve; el.onerror = reject;
          document.head.appendChild(el);
        }).catch(() => { toast("扫码组件加载失败，请手动输入扎号"); });
      }
      const jsQR = window.jsQR;
      setMsg("把菲票上的二维码放进框里");

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      let lastBad = "", lastBadAt = 0;
      const hit = (raw) => {
        if (!/^JJ:\d+$/i.test(raw || "")) {
          // 扫到了别的码（客户条码、网址）：提示一次，别每帧都刷
          if (raw && (raw !== lastBad || Date.now() - lastBadAt > 3000)) { lastBad = raw; lastBadAt = Date.now(); setMsg("这不是本系统的菲票码，请对准菲票上的二维码"); }
          return false;
        }
        buzz(60); A._beep();
        state.scan.ticketInput = raw.replace(/^JJ:/i, "");
        A.stopCamera();
        A.lookupTicket({ scroll: true });
        return true;
      };

      let frame = 0, waited = 0;
      // 有新帧才解；<video> 被重绘替换后新帧回调不会再来，另挂一个定时器兜底，tick 里的 attach 会把流接回新元素
      const next = (video) => {
        if (A._camSession !== session || !state.scan.camOn) return;
        let armed = true;
        const fire = () => { if (!armed) return; armed = false; clearTimeout(A._camTimer); A._camTimer = setTimeout(tick, detector ? 60 : 90); };
        if (video && video.requestVideoFrameCallback) video.requestVideoFrameCallback(fire);
        A._camTimer = setTimeout(fire, 300);
      };
      const tick = async () => {
        if (A._camSession !== session || !state.scan.camOn) return;
        const video = attach(stream);
        if (!video) { A.stopCamera(); return; }
        // 刚打开时 videoWidth 还是 0，要等第一帧解码出来
        if (!video.videoWidth) {
          waited += 150;
          if (waited === 3000) setMsg("摄像头没出画面，试试关掉再打开，或直接手动输入扎号");
          A._camTimer = setTimeout(tick, 150);
          return;
        }
        frame++;
        try {
          if (detector) {
            const codes = await detector.detect(video);
            if (A._camSession !== session || !state.scan.camOn) return;   // 等检测结果时摄像头已被关掉
            for (const c of codes) if (hit(c.rawValue)) return;
          } else if (jsQR) {
            const vw = video.videoWidth, vh = video.videoHeight;
            // 每 3 帧里 2 帧只解中间的方块（取景框附近，比框大一圈留余量），第 3 帧解整帧兜底
            const roi = frame % 3 !== 0;
            const side = Math.min(vw, vh) * 0.8;
            const sx = roi ? (vw - side) / 2 : 0, sy = roi ? (vh - side) / 2 : 0;
            const sw = roi ? side : vw, sh = roi ? side : vh;
            const scale = Math.min(1, (roi ? 480 : 640) / Math.max(sw, sh));
            canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: frame % 4 === 0 ? "attemptBoth" : "dontInvert" });
            if (code && hit(code.data)) return;
          }
        } catch (e) { /* 单帧解不出来无所谓，下一帧继续 */ }
        next(video);
      };
      tick();
    } catch (e) {
      A.stopCamera();
      // 权限被拒、没有摄像头、被别的应用占用是三回事，分开提示
      const name = e && e.name;
      if (name === "NotAllowedError") toast("摄像头权限被拒绝，请在浏览器设置里允许，或手动输入扎号");
      else if (name === "NotFoundError") toast("这台设备没有可用的摄像头，请手动输入扎号");
      else if (name === "NotReadableError") toast("摄像头被别的程序占用了，关掉它再试");
      else toast("打不开摄像头（" + (name || "未知错误") + "），请手动输入扎号");
    }
  },
  stopCamera() {
    A._camSession = (A._camSession || 0) + 1;
    clearTimeout(A._camTimer); A._camTimer = null;
    if (A._camStream) { A._camStream.getTracks().forEach(t => t.stop()); A._camStream = null; }
    A._torchOn = false; A._torchCap = false;
    state.scan.camOn = false; state.scan.camMsg = ""; render();
  },
  async toggleTorch() {
    const track = A._camStream && A._camStream.getVideoTracks()[0];
    if (!track) return;
    try {
      A._torchOn = !A._torchOn;
      await track.applyConstraints({ advanced: [{ torch: A._torchOn }] });
      const b = $("scan-torch"); if (b) { b.classList.toggle("on", A._torchOn); b.setAttribute("aria-pressed", String(A._torchOn)); }
    } catch (e) { A._torchOn = false; toast("这台手机不支持在网页里开手电筒"); }
  },
  // 扫到码的"嘀"：1.2kHz、80ms，音量压低，车间里听得见又不刺耳
  _beep() {
    const ac = A._beepCtx;
    if (!ac) return;
    try {
      if (ac.state === "suspended") ac.resume();
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
      o.type = "sine"; o.frequency.value = 1200;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.09);
    } catch (e) { }
  },
});
