"use strict";
// 款式的尺码 / 颜色 / 客户选项池：下拉选择、搜索、新增、删除。

/* ---- 页面渲染 ---- */
// /style-options 接口拉回来的尺码/颜色/客户选项池，取值时兜底成空数组
function setStyleOptions(o) { state.styleOptions = { sizes: o.sizes || [], colors: o.colors || [], customers: o.customers || [] }; }

/* ---------- 款式的尺码/颜色/客户选项控件 ----------
 * 已选项 chip 自带 × 可删，选项的增删都收进同一个下拉面板里。 */
const OPT_META = {
  size: { label: "款式尺码", listKey: "sizes", multi: true, ph: "搜索 / 选择尺码" },
  color: { label: "款式颜色", listKey: "colors", multi: true, ph: "搜索 / 选择颜色" },
  customer: { label: "客户名称", listKey: "customers", multi: false, ph: "搜索 / 选择客户" }
};
// 选项控件改的是哪张表单：款式表单，或裁床编菲（只用客户这一项）
const optForm = () => (route.v === "cutform" ? state.cf : styleForm);
function optSelected(type) {
  const f = optForm();
  if (type === "customer") return f.customer ? [f.customer] : [];
  const map = type === "size" ? f.size : f.color;
  return Object.keys(map).filter((k) => map[k]);
}
// 选项池里同名的那一条，没有就返回 ""（归一化后比，全角/大小写/空格不算区别）。
// 渲染时判「按钮能不能点」和新增时判「要不要拦下来」都用它，两边不会跑偏。
// 返回原文而不是 true/false：提示语里要显示列表中真正长什么样（用户输 xl，列表里是 XL）
function optFind(type, value) {
  const all = ((state.styleOptions || {})[OPT_META[type].listKey]) || [];
  return all.find((v) => normText(v) === normText(value)) || "";
}
function optPickerHtml(type) {
  const meta = OPT_META[type];
  const all = ((state.styleOptions || {})[meta.listKey]) || [];
  const ui = state.optUI[type];
  const sel = optSelected(type);
  const kw = (ui.kw || "").trim();
  const cand = rankFilter(all, kw, (v) => [v]);
  const dup = kw ? optFind(type, kw) : "";
  // 按钮变灰时必须说清楚为什么，否则用户只看到灰按钮，不知道是自己没输还是重名了。
  // 提示里回显列表中的原文（输 xl 时说的是「XL」），才对得上下面要点的那一行
  const hint = dup ? `「${esc(dup)}」已经有了，在下面点它就能选` : "";
  return `<div class="field optbox${ui.open ? " open" : ""}">
    <span>${esc(meta.label)}${meta.multi ? "（可多选）" : ""}</span>
    <div class="opt-chips">
      ${sel.length ? sel.map((v) => `<span class="chip on">${esc(v)}<button class="chip-x" type="button"
          onclick="event.stopPropagation();A.optRemove('${type}','${jsArg(v)}')" aria-label="移除${esc(v)}">×</button></span>`).join("")
      : `<span class="row-sub">还没有选${esc(meta.label)}</span>`}
      <button class="chip add" type="button" onclick="A.optOpen('${type}')">＋ 选择</button>
    </div>
    ${ui.open ? `<div class="opt-panel">
      <div class="opt-add-row">
        <input class="in opt-search" placeholder="${esc(meta.ph)}" value="${esc(ui.kw)}"
          oninput="A.optSearch('${type}',this.value)"
          onkeydown="if(event.key==='Enter'&&!event.isComposing&&!A._ime){event.preventDefault();A.optCreate('${type}')}"
          autocomplete="off" enterkeyhint="done" ${IME_ATTRS}>
        <button class="btn mini opt-add" type="button" onclick="A.optCreate('${type}')"
          ${kw && !dup ? "" : "disabled"}>＋ 新增</button>
      </div>
      ${hint ? `<p class="opt-hint">${hint}</p>` : ""}
      <div class="opt-list">
        ${cand.length ? cand.map((v) => `<div class="opt-row${sel.includes(v) ? " on" : ""}"
            onclick="A.optToggle('${type}','${jsArg(v)}')">
            <span class="opt-name">${esc(v)}</span>
            <button class="act-btn danger ghost" type="button"
              onclick="event.stopPropagation();A.optDeleteOption('${type}','${jsArg(v)}')">删除</button>
          </div>`).join("")
      : `<p class="empty opt-empty">${kw ? "没有匹配的" + esc(meta.label) + "，点上面「＋ 新增」建一个"
        : "还没有" + esc(meta.label) + "，在上面输入名称后点「＋ 新增」"}</p>`}
      </div>
      <div class="btn-row"><button class="btn ghost mini block" type="button" onclick="A.optOpen('${type}')">收起</button></div>
    </div>` : ""}
  </div>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  optOpen(type) { A.syncStyleForm(); const u = state.optUI[type]; u.open = !u.open; u.kw = ""; render(); },
  optSearch(type, kw) {
    if (A._ime) return;
    A.syncStyleForm();
    state.optUI[type].kw = kw; render();
    const el = document.querySelector(".optbox.open .opt-search");
    if (el) { el.focus(); el.setSelectionRange(kw.length, kw.length); }
  },
  optToggle(type, encV) {
    const v = decodeURIComponent(encV);
    A.syncStyleForm();
    const f = optForm();
    if (type === "customer") { f.customer = f.customer === v ? "" : v; state.optUI[type].open = false; }
    else { const m = type === "size" ? f.size : f.color; if (m[v]) delete m[v]; else m[v] = true; }
    render();
  },
  optRemove(type, encV) {
    const v = decodeURIComponent(encV);
    A.syncStyleForm();
    const f = optForm();
    if (type === "customer") f.customer = "";
    else delete (type === "size" ? f.size : f.color)[v];
    render();
  },
  optCreate(type) {
    const value = (state.optUI[type].kw || "").trim();
    if (!value) return toast("请先输入要新增的名称");
    // 已有同名的就别再建一条，直接让用户去点现成的（回车能绕过灰按钮，所以这里也得拦）
    const dup = optFind(type, value);
    if (dup) return toast(`已经有「${dup}」了，直接点它即可`);
    A.syncStyleForm();
    // 新增要发两趟请求（POST 再 GET 刷新），车间手机卡顿时容易连点，交给 guard 去重加转圈
    return guard("optCreate-" + type, async () => {
      try {
        await api("POST", "/style-options", { type, value });
        const o = await api("GET", "/style-options");
        setStyleOptions(o);
        const f = optForm();
        if (type === "customer") { f.customer = value; state.optUI[type].open = false; }
        else (type === "size" ? f.size : f.color)[value] = true;
        state.optUI[type].kw = "";
        render(); toast("已新增");
      } catch (e) { toast((e && e.error) || "新增失败"); }
    });
  },
  async optDeleteOption(type, encV) {
    const value = decodeURIComponent(encV);
    A.syncStyleForm();
    try {
      await api("DELETE", "/style-options", { type, value });
      const o = await api("GET", "/style-options");
      setStyleOptions(o);
      // 删掉的选项如果正被这张款式选中，一并清掉，免得留下一个选不到的"幽灵"选中态
      const f = optForm();
      if (type === "size") delete f.size[value];
      else if (type === "color") delete f.color[value];
      else if (f.customer === value) f.customer = "";
      render(); toast("已删除");
    } catch (e) { toast((e && e.error) || "删除失败"); }
  },
});
