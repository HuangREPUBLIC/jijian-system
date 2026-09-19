"use strict";
// 通用界面控件：弹窗、日期/月份/下拉/搜索框。
// 弹窗：窄屏从底部升起（可拖拽关闭），宽屏居中对话框；Esc 关闭、回车=确定、安卓返回键关弹窗（见 syncOverlayHistory）。

/* ---- 页面渲染 ---- */
const isNarrow = () => !!(window.matchMedia && matchMedia("(max-width: 640px)").matches);
function modal(opts) { modalState = opts; renderModal(); }
function renderModal() {
  const mask = $("mask");
  if (!modalState) {
    if (mask.classList.contains("show") && !mask.classList.contains("closing")) {
      mask.classList.add("closing");
      clearTimeout(renderModal._t);
      renderModal._t = setTimeout(() => {
        if (!modalState) { mask.classList.remove("show", "closing"); mask.innerHTML = ""; }
      }, REDUCED_MOTION ? 0 : 200);
    }
    syncOverlayHistory();
    return;
  }
  clearTimeout(renderModal._t);
  const o = modalState;
  mask.classList.remove("closing");
  mask.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
    <div class="m-grab" aria-hidden="true"></div>
    <div class="m-title" id="m-title">${esc(o.title)}</div>
    ${o.body ? `<div class="m-body">${esc(o.body)}</div>` : ""}
    ${o.html ? `<div class="m-html">${o.html}</div>` : ""}
    ${o.input ? `<input class="in m-input" id="m-input" ${o.inputMode ? `inputmode="${o.inputMode}"` : ""} enterkeyhint="done" autocomplete="off">` : ""}
    <div class="m-actions">
      <button class="btn ghost" onclick="A.modalCancel()">${esc(o.cancelText || (o.cancelOnly ? "关闭" : "取消"))}</button>
      ${o.cancelOnly ? "" : `<button class="btn ${o.danger ? "danger" : ""}" onclick="A.modalOk()">${esc(o.okText || "确定")}</button>`}
    </div></div>`;
  // 点遮罩关闭；但弹窗里有输入框时不这么做，免得手一滑把填了一半的内容丢了
  mask.onclick = (e) => {
    if (e.target === mask && !mask.querySelector(".modal input:not([type=checkbox]), .modal textarea")) A.modalCancel();
  };
  mask.classList.add("show");
  if (o.input) {
    const i = $("m-input");
    i.value = o.value || "";
    i.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) A.modalOk(); };
    setTimeout(() => { i.focus(); try { i.select(); } catch (x) { } }, 60);
  }
  attachSheetDrag(mask.querySelector(".modal"));
  syncOverlayHistory();
}
// 底部面板下拉关闭：只在把手和标题上按住才算拖面板，面板里的列表照常滚动
function attachSheetDrag(sheet) {
  if (!sheet || !isNarrow()) return;
  const mask = $("mask");
  let y0 = null, dy = 0, pid = null, hist = [];
  const down = (e) => {
    if (e.pointerType === "mouse") return;
    y0 = e.clientY; dy = 0; pid = e.pointerId; hist = [{ y: y0, t: performance.now() }];
    try { e.currentTarget.setPointerCapture(pid); } catch (x) { }
    sheet.classList.add("dragging");
  };
  const move = (e) => {
    if (y0 === null || e.pointerId !== pid) return;
    const d = e.clientY - y0;
    dy = d > 0 ? d : -rubber(-d, 240);                       // 往上拉有阻尼，往下跟手
    sheet.style.transform = `translate3d(0,${dy}px,0)`;
    mask.style.setProperty("--mask-a", String(Math.max(0, 1 - Math.max(0, dy) / (sheet.offsetHeight || 400))));
    const now = performance.now();
    hist.push({ y: e.clientY, t: now });
    while (hist.length > 2 && now - hist[0].t > 100) hist.shift();
  };
  const up = (e) => {
    if (y0 === null || e.pointerId !== pid) return;
    y0 = null;
    const a = hist[0], b = hist[hist.length - 1];
    const v = b.t - a.t > 8 ? (b.y - a.y) / (b.t - a.t) * 1000 : 0;
    sheet.classList.remove("dragging");
    mask.style.removeProperty("--mask-a");
    if (dy + project(v, 0.99) > sheet.offsetHeight * 0.4 || v > 900) { sheet.style.transform = "translate3d(0,110%,0)"; A.modalCancel(); }
    else sheet.style.transform = "";
  };
  sheet.querySelectorAll(".m-grab, .m-title").forEach(h => {
    h.addEventListener("pointerdown", down); h.addEventListener("pointermove", move);
    h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
  });
}

// 真正的 input[type=date] 透明盖满按钮区域接收点击（部分手机不支持 showPicker() 会点了没反应），下面露出中文日期按钮
function dateFieldHtml(id, v, onChange) {
  return `<div class="datefield">
    <button type="button" class="in date-btn ${v ? "" : "is-empty"}" id="${id}--label" tabindex="-1">${v ? esc(fmtDate(v)) : "选择日期"}</button>
    <input type="date" id="${id}" class="date-native" value="${esc(v || "")}" autocomplete="off"
      onchange="A.syncDateLabel('${id}');${onChange}" onclick="A.openDate(this)" onfocus="A.openDate(this)"></div>`;
}
// 月份同日期做法；不支持 input[type=month] 的老浏览器会退化成文本框，改用「年+月」两个下拉兜底
const MONTH_INPUT_OK = (function () {
  const i = document.createElement("input");
  i.setAttribute("type", "month");
  return i.type === "month";
})();
function monthFieldHtml(id, v, onChange) {
  if (MONTH_INPUT_OK) {
    return `<div class="datefield">
      <button type="button" class="in date-btn ${v ? "" : "is-empty"}" id="${id}--label" tabindex="-1">${v ? esc(fmtMonth(v)) : "选择月份"}</button>
      <input type="month" id="${id}" class="date-native" value="${esc(v || "")}" autocomplete="off"
        onchange="A.syncMonthLabel('${id}');${onChange}" onclick="A.openDate(this)" onfocus="A.openDate(this)"></div>`;
  }
  A._monthCb[id] = onChange;
  const m = String(v || monthStr()).match(/^(\d{4})-(\d{2})$/) || [];
  const y0 = new Date().getFullYear();
  const years = [y0 - 2, y0 - 1, y0, y0 + 1];
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
  return `<div style="display:flex;gap:8px">
    <select class="in" id="${id}--y" onchange="A.syncMonthSelect('${id}')">${years.map(y =>
      `<option value="${y}" ${String(y) === m[1] ? "selected" : ""}>${y}年</option>`).join("")}</select>
    <select class="in" id="${id}--m" onchange="A.syncMonthSelect('${id}')">${months.map(x =>
      `<option value="${x}" ${x === m[2] ? "selected" : ""}>${+x}月</option>`).join("")}</select>
    <input type="hidden" id="${id}" value="${esc(v || "")}"></div>`;
}
function selectHtml(id, opts, cur, onChange, placeholder) {
  // 当前值不在候选里（比如款式上存的客户名后来被从选项池删了）也要保留显示，不能悄悄丢掉
  const list = (cur !== "" && cur !== null && cur !== undefined && !opts.some(([v]) => String(v) === String(cur)))
    ? [[cur, cur]].concat(opts) : opts;
  return `<select class="in" id="${id}" ${onChange ? `onchange="${onChange}"` : ""}>
    ${placeholder ? `<option value="">${esc(placeholder)}</option>` : ""}
    ${list.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(t)}</option>`).join("")}
  </select>`;
}

/* ---------- 款式管理 ---------- */
// 搜索框：左边放大镜，有字时右边一个清除按钮（手机上删一长串款号很烦）
function searchbarHtml(id, value, ph, handler) {
  return `<div class="searchbar"><span class="sb-ic">${icon("search")}</span>
    <input id="${id}" type="search" placeholder="${esc(ph)}" value="${esc(value || "")}" enterkeyhint="search"
      autocomplete="off" oninput="${handler}(this.value)" ${IME_ATTRS}>
    ${value ? `<button type="button" class="sb-clear" aria-label="清除" onclick="${handler}('');var i=document.getElementById('${id}');if(i){i.value='';i.focus()}">${icon("close")}</button>` : ""}</div>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  modalOk() {
    const st = modalState; if (!st) return;
    const v = st.input ? ($("m-input") ? $("m-input").value : "") : null;
    if (st.onOk) { const keep = st.onOk(v); if (keep === false) return; }
    modalState = null; renderModal();
  },
  modalCancel() { modalState = null; renderModal(); },

  openDate(el) {
    // 原生日期框只有点在日历图标那一小块才会自动弹选择器，不管点哪都强制弹一次
    try { if (el.showPicker) el.showPicker(); } catch (e) { }
  },
  syncDateLabel(id) {
    const el = $(id), lab = $(id + "--label"); if (!el || !lab) return;
    lab.textContent = el.value ? fmtDate(el.value) : "选择日期";
    lab.classList.toggle("is-empty", !el.value);
  },
  syncMonthLabel(id) {
    const el = $(id), lab = $(id + "--label"); if (!el || !lab) return;
    lab.textContent = el.value ? fmtMonth(el.value) : "选择月份";
    lab.classList.toggle("is-empty", !el.value);
  },
  _monthCb: {},
  // 老浏览器的「年+月」两个下拉：拼出 yyyy-MM 塞进隐藏 input，再跑那个字段原本的 onchange
  syncMonthSelect(id) {
    const el = $(id), y = $(id + "--y"), m = $(id + "--m");
    if (!el || !y || !m) return;
    el.value = y.value + "-" + m.value;
    const cb = A._monthCb[id];
    if (cb) new Function(cb).call(el);
  },
});
