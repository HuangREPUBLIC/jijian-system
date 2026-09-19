"use strict";
// 打印菲票：选范围 / 份数 / 模板，生成打印页。

/* ---- 进页面前拉数据 ---- */
LOADERS.cutprint = async () => {
  const d = await api("GET", "/cut-orders/" + route.id);
  const maxNo = d.bundles.length ? Math.max(...d.bundles.map(b => b.bundle_no)) : 1;
  const minNo = d.bundles.length ? Math.min(...d.bundles.map(b => b.bundle_no)) : 1;
  state.cp = {
    orderId: route.id, order: d.order, bundleCount: d.bundles.length,
    from: minNo, to: maxNo, picks: "", usePicks: false,
    copies: 1, template: "label60x40", rotate: false, perNote: false, showPrice: false,
    note: d.order.ticket_note || "", companyName: d.order.company_name || COMPANY_NAME
  };
};

/* ---- 页面渲染 ---- */
/* ---------- 打印菲票：只有扎号范围传给后端，其余是前端排版参数；打印机由系统对话框选 ---------- */
const PRINT_TEMPLATES = [["label60x40", "标签 60×40mm"], ["label80x60", "标签 80×60mm"], ["a4grid", "A4 一页多张"]];
function vCutPrint() {
  const cp = state.cp;
  if (!cp) return skeletonHtml(5);
  const o = cp.order;
  return `<section class="group"><div class="card">
      <div class="row-item"><div class="row-main">
        <div class="row-label">${esc(o.style_code || o.style_name || "—")} · 床次${o.bed_no}</div>
        <div class="row-sub">共 ${num(cp.bundleCount)} 张菲票，扎号 ${cp.from} ~ ${cp.to}</div>
      </div></div>
    </div></section>

    <section class="group"><div class="card">
      <div class="field row"><span>打印扎号<span class="req">*</span></span>
        <input class="in tiny" type="number" inputmode="numeric" value="${esc(cp.from)}"
          ${cp.usePicks ? "disabled" : ""} onchange="A.cpSet('from',this.value)">
        <span class="range-sep">—</span>
        <input class="in tiny" type="number" inputmode="numeric" value="${esc(cp.to)}"
          ${cp.usePicks ? "disabled" : ""} onchange="A.cpSet('to',this.value)"></div>

      <div class="field"><label class="chkline">
        <input type="checkbox" ${cp.usePicks ? "checked" : ""} onchange="A.cpToggle('usePicks')">
        <span>任选扎号打印</span></label>
        ${cp.usePicks ? `<input class="in" value="${esc(cp.picks)}" placeholder="用逗号分隔，例如 1,4,7"
          onchange="A.cpSet('picks',this.value)">` : ""}</div>

      <div class="field row"><span>打印份数<span class="req">*</span></span>
        <div class="stepper">
          <button onclick="A.cpStep(-1)" aria-label="减少">−</button>
          <input class="in" type="number" inputmode="numeric" value="${esc(cp.copies)}" onchange="A.cpSet('copies',this.value)">
          <button onclick="A.cpStep(1)" aria-label="增加">＋</button></div></div>

      <label class="field"><span>纸张模板<span class="req">*</span></span>
        ${selectHtml("cp-tpl", PRINT_TEMPLATES, cp.template, "A.cpSet('template',this.value)")}
        <div class="row-sub">打印机由系统打印对话框选择，网页无法指定打印机</div></label>

      <label class="field"><span>菲票备注</span>
        <input class="in" value="${esc(cp.note)}" placeholder="会印在每张票上" onchange="A.cpSet('note',this.value)"></label>
      <label class="field"><span>公司名称</span>
        <input class="in" value="${esc(cp.companyName)}" onchange="A.cpSet('companyName',this.value)"></label>

      <div class="field"><label class="chkline">
        <input type="checkbox" ${cp.showPrice ? "checked" : ""} onchange="A.cpToggle('showPrice')">
        <span>打印工价</span></label>
        <div class="row-sub">默认不印。开启后只印那些在工序里勾了「显示价格」的工序。</div></div>
      <div class="field"><label class="chkline">
        <input type="checkbox" ${cp.rotate ? "checked" : ""} onchange="A.cpToggle('rotate')">
        <span>打印方向旋转 180°</span></label></div>
      <div class="field"><label class="chkline">
        <input type="checkbox" ${cp.perNote ? "checked" : ""} onchange="A.cpToggle('perNote')">
        <span>逐个备注打印（用每一扎自己的备注）</span></label></div>
    </div></section>

    <section class="group">
      ${cp.ready ? `<div class="card print-ready">
          <div class="row-item"><div class="row-main">
            <div class="row-label">已排版 ${cp.ready.count} 张菲票 × ${cp.ready.copies} 份</div>
            <div class="row-sub">点下面的按钮调起系统打印对话框，在那里选打印机和纸张</div>
          </div></div>
        </div>
        <div class="btn-row" style="padding-left:0;padding-right:0">
          <button class="btn block" id="do-print-btn" onclick="A.firePrint()">开始打印</button>
          <button class="btn ghost block" onclick="A.cpReset()">重新排版</button>
        </div>`
      : `<div class="btn-row" style="padding-left:0;padding-right:0">
          <button class="btn block" onclick="A.doPrint()">排版并打印</button></div>`}
    </section>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  cpSet(k, v) {
    state.cp[k] = (k === "from" || k === "to" || k === "copies") ? Math.max(1, Number(v) || 1) : v;
    if (k === "copies") state.cp.copies = Math.min(10, state.cp.copies);
    // 改了任何设置，上一次排好的内容就作废，必须重新排——否则会印出跟界面对不上的东西
    state.cp.ready = null;
    render();
  },
  cpToggle(k) { state.cp[k] = !state.cp[k]; state.cp.ready = null; render(); },
  // 必须是同步函数、直接在 onclick 里调 print()，中间不能有 await——
  // 一旦跨过 await，浏览器就不再认为这是用户手势触发的，又会被当成自动打印拦掉
  firePrint() { window.print(); },
  cpStep(d) { A.cpSet("copies", (Number(state.cp.copies) || 1) + d); },
  cpReset() { state.cp.ready = null; $("print-root").innerHTML = ""; render(); },

  async doPrint() {
    const cp = state.cp;
    const q = new URLSearchParams();
    if (cp.usePicks) {
      if (!String(cp.picks).trim()) return toast("请填写要打印的扎号");
      q.set("picks", String(cp.picks).trim());
    } else { q.set("from", cp.from); q.set("to", cp.to); }

    let data;
    try { data = await api("GET", `/cut-orders/${cp.orderId}/print-data?${q}`); }
    catch (e) { return toast((e && e.error) || "取打印数据失败"); }

    const { order: o, processes, bundles } = data;
    const company = cp.companyName || o.company_name || "";
    const copies = Math.max(1, Math.min(10, Number(cp.copies) || 1));

    const ticket = (b) => `<div class="ticket${cp.rotate ? " rot" : ""}">
      <div class="tk-top"><span>${esc(company)}</span><span>${esc(o.style_code || o.style_name || "")}</span></div>
      <div class="tk-mid">
        <div class="tk-bundle"><div class="tk-bundle-n">${b.bundle_no}</div><div class="tk-bundle-l">扎号</div></div>
        <div class="tk-qr">${b.qrSvg}</div>
      </div>
      <div class="tk-rows">
        <span>菲票 ${b.ticket_no}</span><span>床次 ${o.bed_no}</span>
        <span>${esc(b.color || "")}</span><span>${esc(b.size || "")}</span>
        <span><b>${num(b.qty)} 件</b></span>
        ${b.vat_no ? `<span>缸号 ${esc(b.vat_no)}</span>` : ""}
        ${o.doc_no ? `<span>制单 ${esc(o.doc_no)}</span>` : ""}
        ${o.customer ? `<span>${esc(o.customer)}</span>` : ""}
      </div>
      <div class="tk-procs">${processes.map(p =>
        `<span>${esc(p.name)}${cp.showPrice && p.show_price ? ` ${num(p.unit_price)}` : ""}</span>`).join("")}</div>
      ${(cp.perNote ? b.note : cp.note) ? `<div class="tk-note">${esc(cp.perNote ? (b.note || "") : cp.note)}</div>` : ""}
    </div>`;

    const html = [];
    for (const b of bundles) for (let i = 0; i < copies; i++) html.push(ticket(b));

    // @page 的尺寸不能用 CSS 变量、也没法靠 class 切换，只能在打印前把这段样式换掉
    const PAGE_SIZES = { label60x40: "60mm 40mm", label80x60: "80mm 60mm", a4grid: "A4" };
    let pageStyle = document.getElementById("page-size");
    if (!pageStyle) {
      pageStyle = document.createElement("style");
      pageStyle.id = "page-size";
      document.head.appendChild(pageStyle);
    }
    pageStyle.textContent = `@page { size: ${PAGE_SIZES[cp.template] || "A4"}; margin: 0 }`;

    const root = $("print-root");
    root.className = "tpl-" + cp.template;
    root.innerHTML = html.join("");
    toast(`已排版 ${bundles.length} 张菲票 × ${copies} 份`);
    // 不自动 print()：Safari 会拦下非用户手势触发的打印，改成露出按钮让用户点
    state.cp.ready = { count: bundles.length, copies };
    render();
    // 滚到按钮那儿，免得用户不知道还要再点一下
    setTimeout(() => { const el = $("do-print-btn"); if (el) el.scrollIntoView({ block: "center", behavior: "smooth" }); }, 80);
  },
});
