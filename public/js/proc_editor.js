"use strict";
// 工序编辑器：款式表单和「修改工序」页共用（工序名、单价、按尺码定价、岗位可见、套用 / 保存模板）。

/* ---- 页面渲染 ---- */
// 重绘前先把款式名/模板名/工序表输入框的值兜回 state，否则重绘会用旧值覆盖用户刚打的字
// 模板里存的工序条目 → 工序编辑器条目
const tplItemsToPe = items => items.map((it) => ({
  name: it.name || "", unitPrice: Number(it.unitPrice) || 0,
  dailyQuota: it.dailyQuota === undefined ? "" : it.dailyQuota,
  prices: it.prices || {}, showPrice: it.showPrice !== false, visibleRoles: it.visibleRoles || []
}));

/* ---------- 工序编辑器：款式表单「生产工序」段落和「修改工序」页共用这一份 ----------
 * 工序名直接打字即可添加，工序模板只是可选的快捷来源。 */
// 工价 = 日工资基数 ÷ 日定额（例：日定额 909 件 → 约 0.11 元/件）；基数存后端设置，这里是本地缓存，默认 100
const dailyWage = () => Number(state.dailyWage) || 100;
const PRICE_MODES = [["default", "默认单价"], ["size", "分码单价"], ["role", "分岗位单价"]];
function peTotal() {
  return (state.pe.items || []).reduce((s, it) => s + (Number(it.unitPrice) || 0), 0);
}
// 切模式前先看有没有设过多单价：跟参考系统一致，有多单价就不让直接切，先让用户清掉
function peHasMultiPrices() {
  return (state.pe.items || []).some((it) => it.prices && Object.keys(it.prices).some((k) => it.prices[k] !== "" && it.prices[k] !== null));
}
function peRoleLabel(k) {
  const r = (state.pe.roles || []).find((x) => x.k === k);
  return r ? r.label : k;
}
function procEditorHtml() {
  const pe = state.pe, mode = pe.mode;
  // 内嵌在款式表单里时，尺码列跟着表单当前勾选的尺码走（不是打开表单那一刻的快照）；
  // 独立的「修改工序」页没有 styleForm，用装载时从款式记录里取的 sizes 快照。
  const sizes = styleForm ? Object.keys(styleForm.size || {}) : (pe.sizes || []);
  const cols = mode === "size" ? sizes : mode === "role" ? pe.roles.map((r) => r.k) : [];
  return `<section class="group"><div class="sum-bar">
      <div class="sum-item"><div class="sum-num num">${num(peTotal())}</div><div class="sum-label">默认工价合计</div></div>
      <div class="sum-item"><div class="sum-num num">${pe.items.length}</div><div class="sum-label">工序数量合计</div></div>
    </div></section>

  <section class="group"><div class="card">
    <div class="field row"><span>日工资基数</span>
      <input class="in tiny num" id="pe-wage" type="number" inputmode="decimal" step="any"
        value="${esc(dailyWage())}" ${isManager() ? "" : "disabled"} onchange="A.saveDailyWage(this.value)">
      <span>元/天</span>
      ${isManager() ? "" : `<span class="row-sub">只有管理员和主管能改</span>`}</div>
    <div class="row-sub" style="padding:0 0 6px">工价 = 日工资基数 ÷ 日定额。改这个数会影响之后所有按日定额自动算出来的工价，已经填好的工价不动。</div>
  </div></section>

  <section class="group">
    <div class="btn-row" style="padding-left:0;padding-right:0;justify-content:flex-end">
      <button class="btn ghost mini" onclick="A.pePickTemplate()">选择模板</button>
      <button class="btn ghost mini" onclick="A.peSaveTemplate()">保存模板</button>
    </div>
    <div class="card">
      <div class="field"><span>价格模式</span>
        <div class="seg">${PRICE_MODES.map(([k, t]) =>
          `<button class="${mode === k ? "on" : ""}" onclick="A.peSetMode('${k}')">${t}</button>`).join("")}</div>
        <div class="row-sub">如果设置了多单价，请先删除多单价再改变单价模式</div></div>
    </div>

    <div class="card"><div class="tbl-wrap"><table class="tbl pe-tbl">
      <tr class="pe-head"><th>操作</th><th>序号</th><th>工序名称</th><th>工价价格(元)</th><th>日定额<span class="th-note">件/天</span></th>
        ${cols.map((c) => `<th>${esc(mode === "role" ? peRoleLabel(c) : c)}</th>`).join("")}
        <th>显示价格</th><th>可见岗位</th></tr>
      ${pe.items.length ? pe.items.map((it, i) => `<tr class="pe-row">
        <td class="pe-c-del"><button class="act-btn danger" onclick="A.peDel(${i})" aria-label="删除第 ${i + 1} 道工序">删除</button></td>
        <td class="pe-c-seq num" data-label="序号">${i + 1}</td>
        <td class="pe-c-name" data-label="工序名称"><input class="in" value="${esc(it.name)}" placeholder="工序名称" onchange="A.peSetName(${i},this.value)"></td>
        <td class="pe-c-price" data-label="工价（元）"><div class="stepper">
          <button type="button" onclick="A.peStep(${i},-1)" aria-label="减少工价">−</button>
          <input class="in num" type="number" inputmode="decimal" step="any" value="${esc(it.unitPrice)}"
            onchange="A.peSetPrice(${i},this.value)" aria-label="工价">
          <button type="button" onclick="A.peStep(${i},1)" aria-label="增加工价">＋</button></div></td>
        <td class="pe-c-quota" data-label="日定额（件/天）"><input class="in num pe-quota" type="number" inputmode="numeric" step="any"
          value="${esc(it.dailyQuota === undefined || it.dailyQuota === null ? "" : it.dailyQuota)}"
          placeholder="件/天" onchange="A.peSetQuota(${i},this.value)" aria-label="日定额"></td>
        ${cols.map((c) => `<td class="pe-c-sub" data-label="${esc(mode === "role" ? peRoleLabel(c) : c)}"><input class="in pe-sub" type="number" inputmode="decimal" step="any"
          value="${esc((it.prices && it.prices[c] !== undefined && it.prices[c] !== null) ? it.prices[c] : "")}"
          placeholder="${num(it.unitPrice)}"
          onchange="A.peSetSubPrice(${i},'${jsArg(c)}',this.value)"></td>`).join("")}
        <td class="pe-c-show" data-label="显示价格"><button class="sw ${it.showPrice ? "on" : ""}" onclick="A.peToggleShow(${i})"
          aria-label="显示价格" role="switch" aria-checked="${!!it.showPrice}"><i></i></button></td>
        <td class="pe-c-roles" data-label="可见岗位"><button class="act-btn" onclick="A.pePickRoles(${i})">${
          it.visibleRoles && it.visibleRoles.length ? esc(it.visibleRoles.map(peRoleLabel).join("、")) : "所有岗位可见"}</button></td>
      </tr>`).join("") : `<tr class="pe-empty"><td colspan="${6 + cols.length + 2}">${emptyHtml("还没有工序，点下面「新增工序」直接打字添加", "processes")}</td></tr>`}
    </table></div></div>

    <div class="pe-hint">填了日定额会自动按「工价 = ${dailyWage()} 元 ÷ 日定额」算出工价；
      个别工序不按这个口径定价的，直接改工价那一栏覆盖即可。</div>
    <div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn block" onclick="A.peAdd()">＋ 新增工序</button></div>
  </section>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  // 下面这一串 peXxx 都会触发 render() 整页重绘，而款号/款式名称的输入框没有 onchange，
  // 不先把 DOM 里的值同步回 state，用户刚打的字会被重绘出来的旧值悄悄覆盖。
  peSetMode(mode) {
    A.syncStyleForm(); A.syncTplName();
    if (mode !== state.pe.mode && peHasMultiPrices()) return toast("请先删除多单价再改变单价模式");
    state.pe.mode = mode; render();
  },
  peAdd() { syncPeForms(); state.pe.items.push({ name: "", unitPrice: 0, dailyQuota: "", prices: {}, showPrice: true, visibleRoles: [] }); render(); },
  peDel(i) { syncPeForms(); state.pe.items.splice(i, 1); render(); },
  // 输入框用 onchange，没失焦时 state 还是旧值：重绘或提交前先从 DOM 兜一次
  peSyncNames() {
    document.querySelectorAll(".pe-tbl tr.pe-row").forEach((tr, i) => {
      const it = state.pe.items[i]; if (!it) return;
      const nameEl = tr.querySelector(".pe-c-name input");
      if (nameEl) it.name = nameEl.value;
      const priceEl = tr.querySelector(".stepper input");
      if (priceEl) it.unitPrice = Number(priceEl.value) || 0;
      const quotaEl = tr.querySelector(".pe-quota");
      if (quotaEl) it.dailyQuota = quotaEl.value === "" ? "" : (Number(quotaEl.value) || 0);
    });
  },

  peSetQuota(i, v) {
    const it = state.pe.items[i];
    const q = v === "" ? "" : (Number(v) || 0);
    it.dailyQuota = q;
    // 日定额一填就把工价算出来；手动改工价仍然可以覆盖它（有些工序不按这个口径定价）
    if (q > 0) it.unitPrice = Math.round((dailyWage() / q) * 10000) / 10000;
    render();
  },
  peSetName(i, v) { state.pe.items[i].name = v; },
  peSetPrice(i, v) { A.syncStyleForm(); A.syncTplName(); state.pe.items[i].unitPrice = Number(v) || 0; render(); },
  // 工价步进按量级自适应：< 1 元一次 0.01、< 10 元一次 0.1、再大一次 1；
  // 往下减按"减完之后"的量级取步长，1.00 往下是 0.99 而不是 0.90。
  peStep(i, d) {
    syncPeForms();
    const it = state.pe.items[i];
    const cur = Number(it.unitPrice) || 0;
    const ref = d < 0 ? cur - 1e-9 : cur;
    const step = ref < 1 ? 0.01 : ref < 10 ? 0.1 : 1;
    // 按步长网格走：加就到下一个严格更大的格点，减就到上一个严格更小的格点，
    // 所以 0.113 点"+"得 0.12（不是 0.123），点"−"得 0.11
    const k = cur / step;
    const nextK = d > 0 ? Math.floor(k + 1e-9) + 1 : Math.ceil(k - 1e-9) - 1;
    it.unitPrice = Math.max(0, Math.round(nextK * step * 10000) / 10000);
    render();
  },
  // 分码 / 分岗单价（prices 按尺码或岗位 key 存）
  peSetSubPrice(i, encSize, v) {
    const k = decodeURIComponent(encSize), it = state.pe.items[i];
    it.prices = it.prices || {};
    if (v === "") delete it.prices[k]; else it.prices[k] = Number(v) || 0;
  },
  peToggleShow(i) { syncPeForms(); state.pe.items[i].showPrice = !state.pe.items[i].showPrice; render(); },
  pePickRoles(i) {
    const it = state.pe.items[i];
    const chosen = new Set(it.visibleRoles || []);
    const html = `<div class="card" style="margin-top:0">${(state.pe.roles || []).map((r) => `
      <label class="row-item"><span class="row-main"><span class="row-label">${esc(r.label)}</span></span>
        <input type="checkbox" value="${esc(r.k)}" ${chosen.has(r.k) ? "checked" : ""}></label>`).join("")
      || `<div class="empty">还没有岗位</div>`}</div>
      <div class="row-sub">都不勾 = 所有岗位可见</div>`;
    modal({ title: "可见岗位", html, okText: "确定", onOk: () => {
      it.visibleRoles = [...document.querySelectorAll(".modal input[type=checkbox]:checked")].map((el) => el.value);
      render(); return true;
    } });
  },
  async peSaveTemplate() {
    const items = A.peCollect();
    if (!items.length) return toast("还没有工序");
    // onOk 必须是同步函数：modalOk() 用 `if (keep === false) return` 判断要不要留住弹窗，
    // async 函数返回的 Promise 永远是真值，空名校验就废了。异步保存放进 run() 里自己跑。
    modal({ title: "保存为工序模板", input: true, okText: "保存", onOk: (v) => {
      const name = String(v || "").trim();
      if (!name) { toast("请填写模板名称"); return false; }
      run(() => api("POST", "/process-templates", { name, items }), "模板已保存");
      return true;
    } });
  },
  async pePickTemplate() {
    const r = await api("GET", "/process-templates");
    const list = r.list || [];
    const html = list.length ? list.map((t) => `<div class="row-item tap" onclick="A.peApplyTemplate('${t.id}')">
        <div class="row-main"><div class="row-label">${esc(t.name)}</div>
          <div class="row-sub">${t.items.length} 道工序</div></div>
        <button class="act-btn danger ghost" onclick="event.stopPropagation();A.peDelTemplate('${t.id}')">删除</button>
      </div>`).join("") : `<div class="empty">还没有保存过模板</div>`;
    state.pe.templates = list;
    modal({ title: "选择模板", html: `<div class="card" style="margin-top:0">${html}</div>`, cancelOnly: true, cancelText: "关闭" });
  },
  peApplyTemplate(id) {
    const t = (state.pe.templates || []).find((x) => x.id === id);
    if (!t) return;
    state.pe.items = tplItemsToPe(t.items);
    A.modalCancel(); render(); toast("已套用模板");
  },
  async peDelTemplate(id) {
    await run(() => api("DELETE", "/process-templates/" + id), "已删除");
    A.pePickTemplate();
  },
  // 提交用的工序列表（去掉没填名字的）
  peCollect() {
    A.peSyncNames();
    return state.pe.items.filter((it) => String(it.name || "").trim()).map((it) => ({
      name: String(it.name).trim(),
      priceMode: state.pe.mode,
      unitPrice: Number(it.unitPrice) || 0,
      dailyQuota: it.dailyQuota === "" || it.dailyQuota === undefined ? "" : Number(it.dailyQuota),
      prices: state.pe.mode === "default" ? null : (it.prices || {}),
      showPrice: it.showPrice !== false,
      visibleRoles: it.visibleRoles || []
    }));
  },
  async peSubmit() {
    const items = A.peCollect();
    await run(() => api("PUT", `/styles/${state.pe.styleId}/processes`, { items }), "工序已保存");
    go("styles");
  },
});
