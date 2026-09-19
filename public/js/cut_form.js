"use strict";
// 裁床编菲表单：选颜色 / 尺码、填件数矩阵、按规则生成扎号并提交。

/* ---- 进页面前拉数据 ---- */
LOADERS.cutform = async () => {
  const [s2, o] = await Promise.all([
    state.styles ? Promise.resolve({ styles: state.styles }) : api("GET", "/styles"),
    api("GET", "/style-options").catch(() => ({}))
  ]);
  state.styles = s2.styles || [];
  setStyleOptions(o);
  const st = state.styles.find((x) => x.id === route.id);
  // 换了款式就重建表单；同一个款式来回进出保留用户填了一半的内容
  if (!state.cf || state.cf.styleId !== route.id) {
    state.cf = {
      styleId: route.id, styleName: st ? (st.code || st.name) : "",
      bedNo: "", docNo: "", customer: (st && st.customer) || "", cutDate: todayStr(), shipDate: "",
      orderNo: "", bedNote: "", ticketNote: "", companyName: COMPANY_NAME,
      // 候选 = 这个款式已选的颜色/尺码；默认全部带上，省得每张单重选一遍
      styleColors: String((st && st.color) || "").split(",").map(x => x.trim()).filter(Boolean),
      styleSizes: String((st && st.size) || "").split(",").map(x => x.trim()).filter(Boolean),
      colors: String((st && st.color) || "").split(",").map(x => x.trim()).filter(Boolean),
      sizes: String((st && st.size) || "").split(",").map(x => x.trim()).filter(Boolean),
      cells: {}, startNo: 1,
      // multiple 默认开：车间的说法是"件数=每张菲票多少件，扎数=打几张菲票"，
      // 关掉是"把总件数按扎数平分"，那是少数情况。
      customNo: false, customVat: false, rowCopy: true, colCopy: false, multiple: true, sameBundles: false,
      bundlesAll: 1, customNos: {}, vatNos: {}
    };
  }
};

/* ---- 页面渲染 ---- */
/* ---------- 裁床编菲：行=颜色、列=尺码，每格填件数+扎数 ---------- */
// colors/sizes 用数组保序：顺序就是扎号编号的遍历顺序
const CF_SWITCHES = [
  ["customNo", "自定义扎号"], ["customVat", "自定义缸号"],
  ["rowCopy", "行复制"], ["colCopy", "列复制"],
  ["multiple", "件数=每扎件数"], ["sameBundles", "每格扎数相同"]
];
const cfKey = (c, z) => c + "|" + z;
function cfCell(c, z) { return state.cf.cells[cfKey(c, z)] || { input: "", bundles: "" }; }
function cfCellTotal(c, z) {
  const cell = cfCell(c, z);
  const n = Number(cell.bundles) || 0, v = Number(cell.input) || 0;
  if (!n || v <= 0) return 0;
  return state.cf.multiple ? v * n : Math.round(v);
}
function cfBundleCount() {
  return state.cf.colors.reduce((t, c) =>
    t + state.cf.sizes.reduce((x, z) => x + (Number(cfCell(c, z).bundles) || 0), 0), 0);
}
function cfPickRow(kind) {
  const cf = state.cf;
  // 候选只来自这个款式已选的颜色/尺码，不是全局选项池——全局池里别的款用的颜色摆在这里会让人误以为这一款也能裁那个色
  const all = kind === "color" ? cf.styleColors : cf.styleSizes;
  const cur = kind === "color" ? cf.colors : cf.sizes;
  const label = kind === "color" ? "添加颜色" : "添加尺码";
  const what = kind === "color" ? "颜色" : "尺码";
  return `<div class="field"><span>${label}</span>
    <div class="chips">${all.length ? all.map(v => {
      const on = cur.includes(v);
      return `<button type="button" class="chip ${on ? "on" : ""}"
        onclick="A.cfToggleAxis('${kind}','${jsArg(v)}')">${esc(v)}${on ? "" : " ＋"}</button>`;
    }).join("")
    : `<span class="row-sub">这个款式还没有选${what}，先去款式管理里给它加上</span>`}</div></div>`;
}
function cfMatrixHtml() {
  const cf = state.cf;
  if (!cf.colors.length || !cf.sizes.length) return `<div class="empty">先在上面选好颜色和尺码</div>`;
  const sizeTotal = (z) => cf.colors.reduce((t, c) => t + cfCellTotal(c, z), 0);
  const grand = cf.sizes.reduce((t, z) => t + sizeTotal(z), 0);
  return `<div class="tbl-wrap matrix"><table class="tbl mx-tbl">
    <tr><th class="mx-head">颜色/尺码</th>${cf.sizes.map(z => `<th>${esc(z)}</th>`).join("")}<th>合计</th></tr>
    ${cf.colors.map(c => `<tr>
      <th class="mx-head">${esc(c)}</th>
      ${cf.sizes.map(z => `<td><div class="mx-cell">
        <input class="in num" type="number" inputmode="numeric" placeholder="${cf.multiple ? "每扎件数" : "该格总件数"}"
          value="${esc(cfCell(c, z).input)}"
          onchange="A.cfSetCell('${jsArg(c)}','${jsArg(z)}','input',this.value)">
        <input class="in num" type="number" inputmode="numeric" placeholder="菲票张数"
          value="${esc(cfCell(c, z).bundles)}" ${cf.sameBundles ? "disabled" : ""}
          onchange="A.cfSetCell('${jsArg(c)}','${jsArg(z)}','bundles',this.value)">
      </div></td>`).join("")}
      <td class="num">${num(cf.sizes.reduce((t, z) => t + cfCellTotal(c, z), 0))}</td></tr>`).join("")}
    <tr><th class="mx-head">合计</th>${cf.sizes.map(z => `<td class="num">${num(sizeTotal(z))}</td>`).join("")}
      <td class="num">${num(grand)}</td></tr>
  </table></div>
  <div class="mx-sum">总扎数：<b class="num">${num(cfBundleCount())}</b>　总件数：<b class="num">${num(grand)}</b></div>
  <div class="mx-hint">${cf.multiple
    ? "上格填每张菲票多少件，下格填打几张。例如 S 码填「20 / 2」＝打出 2 张各 20 件的菲票。"
    : "上格填这一格总共多少件，下格填打几张，系统按张数平分（除不尽的余数补到最后一张）。"}</div>`;
}
function vCutForm() {
  const cf = state.cf;
  if (!cf) return skeletonHtml(5);
  const f = (label, key, ph, req) => `<label class="field"><span>${label}${req ? '<span class="req">*</span>' : ""}</span>
    <input class="in" id="cf-${key}" value="${esc(cf[key] || "")}" placeholder="${esc(ph || "")}"
      onchange="A.cfSet('${key}',this.value)"></label>`;
  return `<section class="group"><div class="card">
      <div class="row-item"><div class="row-main">
        <div class="row-label">款号：${esc(cf.styleName || "—")}</div>
        <div class="row-sub">生成后可在「生产管理」里查看、打印、跟进度</div></div></div>
    </div></section>

    <section class="group">
      <div class="group-title">基础信息</div>
      <div class="card">
        <label class="field"><span>床次<span class="req">*</span></span>
          <input class="in" id="cf-bedNo" type="number" inputmode="numeric" value="${esc(cf.bedNo)}"
            placeholder="第几床" onchange="A.cfSet('bedNo',this.value)"></label>
        ${f("制单号", "docNo", "请输入制单号")}
        ${optPickerHtml("customer")}
        <label class="field"><span>裁床日期<span class="req">*</span></span>
          ${dateFieldHtml("cf-cutDate", cf.cutDate, "A.cfSet('cutDate',this.value)")}</label>
        <label class="field"><span>发货日期</span>
          ${dateFieldHtml("cf-shipDate", cf.shipDate, "A.cfSet('shipDate',this.value)")}</label>
        ${f("订单号", "orderNo", "请输入订单号")}
        ${f("床次备注", "bedNote", "请输入床次备注")}
        ${f("菲票备注", "ticketNote", "会印在每张菲票上")}
        ${f("公司名称", "companyName", "会印在每张菲票上")}
      </div>
    </section>

    <section class="group">
      <div class="group-title">录入裁床表</div>
      <div class="card">
        ${cfPickRow("color")}
        ${cfPickRow("size")}
      </div>
      <div class="card" style="margin-top:10px">${cfMatrixHtml()}</div>
      <div class="card" style="margin-top:10px">
        <div class="field row"><span>从</span>
          <input class="in tiny" type="number" inputmode="numeric" value="${esc(cf.startNo)}"
            onchange="A.cfSetStart(this.value)"><span>扎起</span>
          <button class="act-btn ghost" onclick="A.cfClear()">清空裁床表</button></div>
        ${cf.sameBundles ? `<div class="field row"><span>每格扎数</span>
          <input class="in tiny" type="number" inputmode="numeric" value="${esc(cf.bundlesAll)}"
            onchange="A.cfSetBundlesAll(this.value)"></div>` : ""}
        <div class="sw-grid">${CF_SWITCHES.map(([k, label]) => `<div class="sw-item">
          <button class="sw ${cf[k] ? "on" : ""}" role="switch" aria-checked="${!!cf[k]}"
            onclick="A.cfToggle('${k}')"><i></i></button><span>${label}</span></div>`).join("")}</div>
      </div>
    </section>

    <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn block" onclick="A.cfSubmit()">生成菲票</button></div></section>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  cfSet(k, v) { state.cf[k] = v; },
  cfToggleAxis(kind, encV) {
    const v = decodeURIComponent(encV), cf = state.cf;
    const arr = kind === "color" ? cf.colors : cf.sizes;
    const i = arr.indexOf(v);
    // 移出某一行/列时把它名下的格子一起清掉，免得留下看不见却仍在算总数的脏数据
    if (i >= 0) {
      arr.splice(i, 1);
      Object.keys(cf.cells).forEach(k => {
        const [c, z] = k.split("|");
        if ((kind === "color" ? c : z) === v) delete cf.cells[k];
      });
    } else arr.push(v);
    render();
  },
  cfSetCell(encC, encZ, field, v) {
    const c = decodeURIComponent(encC), z = decodeURIComponent(encZ), cf = state.cf;
    const key = cfKey(c, z);
    const cell = cf.cells[key] || (cf.cells[key] = { input: "", bundles: "" });
    cell[field] = v;
    // 行复制/列复制：填完一格自动把同值铺到该行/该列还空着的格子；两个都开就先行后列
    const fill = (k2) => {
      const x = cf.cells[k2] || (cf.cells[k2] = { input: "", bundles: "" });
      if (x[field] === "" || x[field] === undefined) x[field] = v;
    };
    if (cf.rowCopy) cf.sizes.forEach(z2 => fill(cfKey(c, z2)));
    if (cf.colCopy) cf.colors.forEach(c2 => fill(cfKey(c2, z)));
    // 扎数如果是"每件扎数相同"模式，改一格等于改全部
    if (field === "bundles" && cf.sameBundles) A.cfSetBundlesAll(v);
    render();
  },
  cfToggle(k) {
    state.cf[k] = !state.cf[k];
    if (k === "sameBundles" && state.cf.sameBundles) A.cfSetBundlesAll(state.cf.bundlesAll);
    render();
  },
  cfSetStart(v) { state.cf.startNo = Math.max(1, Number(v) || 1); render(); },
  cfSetBundlesAll(v) {
    const n = Math.max(0, Number(v) || 0), cf = state.cf;
    cf.bundlesAll = n;
    cf.colors.forEach(c => cf.sizes.forEach(z => {
      const k = cfKey(c, z), x = cf.cells[k] || (cf.cells[k] = { input: "", bundles: "" });
      x.bundles = n;
    }));
    render();
  },
  cfClear() { state.cf.cells = {}; state.cf.customNos = {}; state.cf.vatNos = {}; render(); },
  async cfSubmit() {
    const cf = state.cf;
    // 输入框用的是 onchange，用户没失焦时 state 还是旧值，提交前从 DOM 兜一次
    // customer 现在是选择器不是输入框，不能再从 DOM 兜（会读成 undefined 把已选的清掉）
    ["bedNo", "docNo", "orderNo", "bedNote", "ticketNote", "companyName"].forEach(k => {
      const el = $("cf-" + k); if (el) cf[k] = el.value.trim();
    });
    if (!cf.bedNo) return toast("请填写床次");
    if (!cf.cutDate) return toast("请选择裁床日期");
    if (!cf.colors.length || !cf.sizes.length) return toast("请选择颜色和尺码");
    const cells = {};
    Object.keys(cf.cells).forEach(k => {
      const c = cf.cells[k];
      const input = Number(c.input) || 0, bundles = Number(c.bundles) || 0;
      if (input > 0 && bundles > 0) cells[k] = { input, bundles };
    });
    if (!Object.keys(cells).length) return toast("裁床表还没填件数");
    try {
      const r = await api("POST", "/cut-orders", {
        styleId: cf.styleId, bedNo: Number(cf.bedNo), docNo: cf.docNo, customer: cf.customer,
        cutDate: cf.cutDate, shipDate: cf.shipDate, orderNo: cf.orderNo,
        bedNote: cf.bedNote, ticketNote: cf.ticketNote, companyName: cf.companyName,
        colors: cf.colors, sizes: cf.sizes, cells,
        startNo: cf.startNo, multiple: cf.multiple,
        customNos: cf.customNo ? cf.customNos : undefined,
        vatNos: cf.customVat ? cf.vatNos : undefined
      });
      toast(`已生成 ${r.order.total_bundles} 张菲票，共 ${num(r.order.total_qty)} 件`);
      state.cf = null;                 // 用完就丢，下次进来是干净的表单
      go("cutview", r.order.id);
    } catch (e) { toast((e && e.error) || "生成失败"); }
  },
});
