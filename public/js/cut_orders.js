"use strict";
// 生产管理：裁床单列表 / 按款式汇总、查看裁床单、修改 / 删除 / 复制。

/* ---- 进页面前拉数据 ---- */
LOADERS.cutview = async () => {
  state.cv = await api("GET", "/cut-orders/" + route.id);
};
LOADERS.cutorders = async () => {
  const co = state.co;
  const q = new URLSearchParams();
  if (co.kw) q.set("kw", co.kw);
  if (co.from) q.set("from", co.from);
  if (co.to) q.set("to", co.to);
  const [ov, list, byStyle] = await Promise.all([
    api("GET", "/production/overview?range=" + co.range).catch(() => ({ completed: 0, inProduction: 0 })),
    api("GET", "/cut-orders?" + q).catch(() => ({ list: [], total: 0 })),
    api("GET", "/production/by-style?" + q).catch(() => ({ list: [] }))
  ]);
  co.overview = ov; co.list = list.list || []; co.total = list.total || 0; co.byStyle = byStyle.list || [];
};

/* ---- 页面渲染 ---- */
/* ---------- 查看裁床单 ----------
 * 两张表：裁床汇总表（颜色×尺码件数矩阵）和裁床编菲表（每扎扎号+件数，按尺码分组，双列扎号/数量）。 */
function vCutView() {
  const d = state.cv;
  if (!d) return skeletonHtml(4);
  const { order: o, bundles, processes, summary: sm } = d;

  // 编菲表：先按 (颜色,尺码) 把扎归堆，同一格里可能有好几扎，列数取最多的那一格
  const byCell = {};
  bundles.forEach(b => (byCell[b.color + "|" + b.size] || (byCell[b.color + "|" + b.size] = [])).push(b));
  const maxPer = Math.max(1, ...Object.values(byCell).map(a => a.length));

  return `<section class="group"><div class="card style-card">
      ${orderHeadHtml(o, kv("款名", esc(o.style_name || "—")) + kv("床次", o.bed_no)
        + kv("总扎数", num(o.total_bundles)) + kv("总件数", num(o.total_qty)) + datesCell(o))}
      ${processes.length ? `<div class="sc-procline">
        <span class="sc-k">工序（${processes.length} 道）</span>
        <span class="sc-v">${processes.map(p => esc(p.name) + (p.show_price ? ` ${num(p.unit_price)}元` : "")).join(" · ")}</span>
      </div>` : ""}
    </div></section>

    <section class="group">
      <div class="group-title">裁床汇总表</div>
      <div class="card"><div class="tbl-wrap matrix"><table class="tbl mx-tbl">
        <tr><th class="mx-head">颜色/尺码</th><th>颜色合计</th>${sm.sizes.map(z => `<th>${esc(z)}</th>`).join("")}</tr>
        ${sm.colors.map(c => `<tr><th class="mx-head">${esc(c)}</th>
          <td class="num">${num(sm.colorTotals[c] || 0)}</td>
          ${sm.sizes.map(z => `<td class="num">${num((sm.matrix[c] || {})[z] || 0)}</td>`).join("")}</tr>`).join("")}
        <tr><th class="mx-head">尺码合计</th><td class="num">${num(sm.total)}</td>
          ${sm.sizes.map(z => `<td class="num">${num(sm.sizeTotals[z] || 0)}</td>`).join("")}</tr>
      </table></div></div>
    </section>

    <section class="group">
      <div class="group-title">裁床编菲表</div>
      <div class="card"><div class="tbl-wrap matrix"><table class="tbl mx-tbl">
        <tr><th class="mx-head" rowspan="2">颜色/尺码</th>
          ${sm.sizes.map(z => `<th colspan="${maxPer * 2}">${esc(z)}</th>`).join("")}</tr>
        <tr>${sm.sizes.map(() => Array.from({ length: maxPer }, () => `<th>扎号</th><th>数量</th>`).join("")).join("")}</tr>
        ${sm.colors.map(c => `<tr><th class="mx-head">${esc(c)}</th>
          ${sm.sizes.map(z => {
            const arr = byCell[c + "|" + z] || [];
            return Array.from({ length: maxPer }, (_, i) => arr[i]
              ? `<td class="num">${arr[i].bundle_no}</td><td class="num">${num(arr[i].qty)}</td>`
              : `<td></td><td></td>`).join("");
          }).join("")}</tr>`).join("")}
      </table></div></div>
    </section>

    <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn block" onclick="go('cutprogress','${o.id}')">查看生产进度</button>
      ${isManager() ? `<button class="btn ghost block" onclick="go('cutprint','${o.id}')">打印菲票</button>` : ""}
    </div>
    ${isManager() ? `<div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn ghost block" onclick="A.editCutOrderFrom('${o.id}')">修改裁床单</button>
      <button class="btn ghost danger block" onclick="A.delCutOrderFrom('${o.id}')">删除这张裁床单</button>
    </div>` : ""}</section>`;
}

/* ---------- 生产管理 ----------
 * 已完成件数＝这段时间打点了多少件（车间日产出口径），不同于单张裁床单"全工序做完"的完工口径。 */
function vCutOrders() {
  const co = state.co;
  const ov = co.overview || { completed: 0, inProduction: 0 };
  const rangeBtn = (k, t) => `<button class="${co.range === k ? "on" : ""}" onclick="A.setCoRange('${k}')">${t}</button>`;
  const list = co.list, byStyle = co.byStyle;
  const totalQty = (list || []).reduce((n, o) => n + Number(o.total_qty || 0), 0);
  const doneQty = (list || []).reduce((n, o) => n + Number(o.completed_qty || 0), 0);

  const orderCard = (o) => {
    // 进度条走后端算的工序件数进度，跟"生产进度"页同一个口径；
    // completed_qty（全工序做完、能出货的件数）另外用文字报，两个数不互相顶替
    const pct = Number(o.percent) || 0;
    return `<section class="group"><div class="card cut-card">
      <div class="cc-head tap" onclick="go('cutprogress','${o.id}')">
        ${styleThumbHtml(o.style_id, o.style_image)}
        <div class="sc-info">
          <div class="sc-title">款号：${esc(o.style_code || o.style_name || "—")}</div>
          <div class="sc-grid">
            ${kv("床次", o.bed_no)}
            ${kv("件数", num(o.total_qty))}
            ${kv("类型", o.source === "self" ? "自建" : esc(o.source))}
            ${datesCell(o)}
          </div>
        </div>
        <span class="chev">›</span>
      </div>
      ${progRowHtml(pct)}
      <div class="cc-note">全工序做完 ${num(o.completed_qty)} / ${num(o.total_qty)} 件</div>
      <div class="sc-acts">
        ${isManager() ? `<button onclick="A.coMore('${o.id}')">更多</button>` : ""}
        ${isManager() ? `<button onclick="go('cutprint','${o.id}')">打印菲票</button>` : ""}
        ${isManager() ? `<button onclick="A.coCopy('${o.id}')">复制</button>` : ""}
        <button onclick="go('cutview','${o.id}')">查看裁床单</button>
      </div>
    </div></section>`;
  };

  return `<div class="ov-card">
      <div class="ov-tabs">${rangeBtn("today", "今日")}${rangeBtn("yesterday", "昨日")}${rangeBtn("month", "本月")}</div>
      <div class="ov-label">已完成件数</div>
      <div class="ov-value num">${num(ov.completed)}</div>
      <div class="ov-sub">当前生产中件数 ${num(ov.inProduction)} 件</div>
    </div>

    <section class="group">
      <div class="group-title">生产明细</div>
      <div class="seg">
        <button class="${co.tab === "sheet" ? "on" : ""}" onclick="A.setCoTab('sheet')">按裁床单看</button>
        <button class="${co.tab === "style" ? "on" : ""}" onclick="A.setCoTab('style')">按款看</button>
      </div>
      ${searchbarHtml("co-kw", co.kw, "款号 / 款名 / 床次 / 制单号", "A.setCoKw")}
      <div class="daterange">
        <button class="dr-btn" onclick="A.toggleCoDate()">
          <span class="dr-label">裁床日期</span>
          <span class="dr-val">${co.from || co.to ? `${esc(co.from || "不限")} ~ ${esc(co.to || "不限")}` : "全部日期"}</span>
          <span class="dr-chev${co.dateOpen ? " up" : ""}">⌄</span>
        </button>
        ${co.dateOpen ? `<div class="dr-panel">
          <label class="field"><span>起</span>${dateFieldHtml("co-from", co.from, "A.setCoDate('from',this.value)")}</label>
          <label class="field"><span>止</span>${dateFieldHtml("co-to", co.to, "A.setCoDate('to',this.value)")}</label>
          <div class="btn-row"><button class="btn ghost mini block" onclick="A.clearCoDate()">清除日期</button></div>
        </div>` : ""}
      </div>
    </section>

    ${co.tab === "sheet" ? `
      <section class="group"><div class="sum-bar">
        <div class="sum-item"><div class="sum-num num">${(list || []).length}</div><div class="sum-label">裁床单</div></div>
        <div class="sum-item"><div class="sum-num num">${num(totalQty)}</div><div class="sum-label">裁床总件数</div></div>
        <div class="sum-item"><div class="sum-num num">${num(doneQty)}</div><div class="sum-label">已完成件数</div></div>
      </div></section>
      ${list === null ? skeletonHtml(3)
      : list.length ? list.map(orderCard).join("")
        : `<section class="group"><div class="card">${emptyHtml("还没有裁床单，去「款式管理」里点「裁床编菲」新建", "cutting")}</div></section>`}`
    : `<section class="group"><div class="card">
        ${byStyle === null ? skeletonHtml(3, false) : byStyle.length ? byStyle.map(x => `
          <div class="row-item">
            <div class="row-main"><div class="row-label">${esc(x.style_code || x.style_name)}</div>
              <div class="row-sub">${esc(x.style_name || "")} · ${x.sheet_count} 张裁床单</div></div>
            <div class="row-value num">${num(x.completed_qty)} / ${num(x.total_qty)}</div>
          </div>`).join("") : emptyHtml("这段时间没有裁床单", "cutting")}
      </div></section>`}`;
}

// 删除裁床单的确认弹窗，delCutOrder / delCutOrderFrom 共用，只是拿到 order 的方式和删除后的落点不同
function confirmDelCutOrder(o, onDeleted) {
  modal({
    title: "删除裁床单", danger: true, okText: "删除",
    body: o ? `确定删除「${o.style_code || o.style_name} · 床次${o.bed_no}」吗？这张单的 ${num(o.total_bundles)} 张菲票和进度都会一起看不到。` : "确定删除吗？",
    onOk: () => { onDeleted(); return true; }
  });
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  // 从「查看裁床单」进来时 state.co.list 可能是空的（没经过生产管理页），
  // 所以这两个包一层：先保证列表里有这张单的数据，再复用原来的弹窗
  async ensureCoOrder(id) {
    if ((state.co.list || []).some((o) => o.id === id)) return;
    if (state.cv && state.cv.order && state.cv.order.id === id) { state.co.list = [...(state.co.list || []), state.cv.order]; return; }
    try {
      const r = await api("GET", "/cut-orders?limit=200");
      state.co.list = r.list || [];
    } catch (e) { /* 拉不到就退回用详情页已有的数据 */ }
    if (!(state.co.list || []).some((o) => o.id === id) && state.cv) {
      state.co.list = [...(state.co.list || []), state.cv.order];
    }
  },
  async editCutOrderFrom(id) { await A.ensureCoOrder(id); A.editCutOrder(id); },
  async delCutOrderFrom(id) {
    await A.ensureCoOrder(id);
    const o = (state.co.list || []).find((x) => x.id === id);
    confirmDelCutOrder(o, async () => {
      // 删完这张单，详情页已经没有东西可看了，回生产管理列表
      try { await api("DELETE", "/cut-orders/" + id); toast("已删除"); go("cutorders"); }
      catch (e) { toast((e && e.error) || "删除失败"); }
    });
  },

  setCoRange(k) { state.co.range = k; run(() => Promise.resolve()); },
  setCoTab(k) { state.co.tab = k; render(); },
  setCoKw: debouncedSearch("_coT", "co-kw", 300, (v) => { state.co.kw = v; }, () => loadView("cutorders")),
  toggleCoDate() { state.co.dateOpen = !state.co.dateOpen; render(); },
  setCoDate(which, v) { state.co[which] = v; run(() => Promise.resolve()); },
  clearCoDate() { state.co.from = ""; state.co.to = ""; run(() => Promise.resolve()); },

  // 手机上四个操作按钮排不下，把"修改/删除"收进这个二级弹层，跟参考系统一致
  coMore(id) {
    const o = (state.co.list || []).find(x => x.id === id);
    if (!o) return;
    modal({
      title: `床次 ${o.bed_no} · ${o.style_code || o.style_name}`,
      html: `<div class="card" style="margin-top:0">
        <button class="row-item tap w-row" onclick="A.modalCancel();A.editCutOrder('${id}')">
          <div class="row-main"><div class="row-label">修改裁床单</div>
            <div class="row-sub">改制单号 / 客户 / 日期 / 备注</div></div></button>
        <button class="row-item tap w-row" onclick="A.modalCancel();A.delCutOrder('${id}')">
          <div class="row-main"><div class="row-label" style="color:var(--bad-ink)">删除裁床单</div>
            <div class="row-sub">删除后这张单的进度也一并看不到了</div></div></button>
      </div>`,
      cancelOnly: true, cancelText: "取消"
    });
  },
  async editCutOrder(id) {
    const o = (state.co.list || []).find(x => x.id === id);
    if (!o) return;
    const F = [["docNo", "制单号", o.doc_no], ["customer", "客户", o.customer],
      ["orderNo", "订单号", o.order_no], ["cutDate", "裁床日期", o.cut_date],
      ["shipDate", "发货日期", o.ship_date], ["bedNote", "床次备注", o.bed_note],
      ["ticketNote", "菲票备注", o.ticket_note], ["companyName", "公司名称", o.company_name]];
    modal({
      title: "修改裁床单",
      html: `<div class="card" style="margin-top:0">${F.map(([k, label, v]) => `
        <label class="field"><span>${esc(label)}</span>
          <input class="in" id="ce-${k}" value="${esc(v || "")}"></label>`).join("")}</div>`,
      okText: "保存",
      onOk: () => {
        const body = {};
        F.forEach(([k]) => { const el = $("ce-" + k); if (el) body[k] = el.value.trim(); });
        run(() => api("PATCH", "/cut-orders/" + id, body), "已保存");
        return true;
      }
    });
  },
  delCutOrder(id) {
    const o = (state.co.list || []).find(x => x.id === id);
    confirmDelCutOrder(o, () => run(() => api("DELETE", "/cut-orders/" + id), "已删除"));
  },
  coCopy(id) {
    const o = (state.co.list || []).find(x => x.id === id);
    modal({
      title: "复制成新床次", input: true, value: o ? String((o.bed_no || 0) + 1) : "",
      okText: "复制",
      onOk: (v) => {
        const bedNo = Number(v);
        if (!(bedNo > 0)) { toast("请填写新的床次"); return false; }
        // 复制会重新取一批菲票号：复制出来的是另一批实体票，不能跟原单同号
        run(() => api("POST", `/cut-orders/${id}/copy`, { bedNo }), "已复制");
        return true;
      }
    });
  },
});
