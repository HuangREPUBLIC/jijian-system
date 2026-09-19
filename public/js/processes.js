"use strict";
// 工序模板：整套工序清单的新建 / 编辑 / 删除，以及每日工资设置。

/* ---- 进页面前拉数据 ---- */
LOADERS.processes = async () => {
  const [t, roleRes, w] = await Promise.all([
    api("GET", "/process-templates"),
    api("GET", "/roles").catch(() => ({ roles: [] })),  // 普通员工取不到岗位列表就留空，不阻塞页面
    getDailyWage()
  ]);
  state.tplList = t.list || [];
  state.dailyWage = w.value || 100;
  state.tplRoles = roleRes.roles || [];
};

/* ---- 页面渲染 ---- */
/* ---------- 工序模板：整套工序清单，跟款式表单/修改工序页共用编辑器 ---------- */
function vProcesses() {
  const list = state.tplList;
  const editing = state.tplEditing;   // 正在编辑/新建的模板：{ id, name } 或 null

  if (editing) {
    return `<section class="group"><div class="card">
        <label class="field"><span>模板名称<span class="req">*</span></span>
          <input class="in" id="tpl-name" value="${esc(editing.name || "")}"
            placeholder="例如：长袖衬衫标准工序"></label>
      </div></section>
      ${procEditorHtml()}
      <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
        <button class="btn block" onclick="A.tplSave()">${editing.id ? "保存修改" : "创建模板"}</button>
        <button class="btn ghost block" onclick="A.tplCancel()">取消</button></div></section>`;
  }

  const totalProcs = (list || []).reduce((n, t) => n + t.items.length, 0);
  return `<section class="group"><div class="sum-bar">
      <div class="sum-item"><div class="sum-num num">${(list || []).length}</div><div class="sum-label">模板数量</div></div>
      <div class="sum-item"><div class="sum-num num">${totalProcs}</div><div class="sum-label">工序总数</div></div>
    </div></section>

  ${list === null ? skeletonHtml(3)
    : list.length ? list.map((t) => {
      const total = t.items.reduce((n, it) => n + (Number(it.unitPrice) || 0), 0);
      return `<section class="group"><div class="card tpl-card">
        <button class="tpl-head w-row" onclick="A.tplEdit('${t.id}')">
          <div class="row-main">
            <div class="row-label">${esc(t.name)}</div>
            <div class="row-sub">${t.items.length} 道工序 · 工价合计 <span class="num">${num(total)}</span> 元</div>
            <div class="tpl-procs">${t.items.slice(0, 6).map((it) =>
              `<span class="tag">${esc(it.name)}</span>`).join("")}${
              t.items.length > 6 ? `<span class="tag">…</span>` : ""}</div>
          </div><span class="chev">›</span></button>
        <div class="sc-acts">
          <button onclick="A.tplEdit('${t.id}')">编辑</button>
          <button onclick="A.tplDelete('${t.id}')">删除</button>
        </div>
      </div></section>`;
    }).join("")
    : `<section class="group"><div class="card">${emptyHtml("还没有工序模板。把常用的一整套工序存成模板，建款式时「选择模板」一键套用。", "processes")}</div></section>`}

  <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn block" onclick="A.tplNew()">新建工序模板</button></div></section>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  // 编辑器组件读的是 state.pe，所以进出编辑态时要把模板内容搬进/搬出 state.pe
  tplNew() {
    state.tplEditing = { id: null, name: "" };
    state.pe = { styleId: null, mode: "default", sizes: [], roles: state.tplRoles || [], items: [] };
    formSnap.base = formSnap();
    render();
  },
  tplEdit(id) {
    const t = (state.tplList || []).find((x) => x.id === id);
    if (!t) return;
    state.tplEditing = { id: t.id, name: t.name };
    state.pe = {
      styleId: null,
      mode: (t.items[0] && t.items[0].priceMode) || "default",
      // 分码单价要有尺码才能编辑；模板不绑定款式，就把已存过价的尺码列出来
      sizes: [...new Set(t.items.flatMap((it) => Object.keys(it.prices || {})))],
      roles: state.tplRoles || [],
      items: tplItemsToPe(t.items)
    };
    formSnap.base = formSnap();
    render();
  },
  tplCancel() { state.tplEditing = null; state.pe = null; formSnap.base = null; render(); },
  async tplSave() {
    A.syncTplName();
    const name = String((state.tplEditing && state.tplEditing.name) || "").trim();
    if (!name) return toast("请填写模板名称");
    const items = A.peCollect();
    if (!items.length) return toast("至少要有一道工序");
    const cur = state.tplEditing;
    try {
      // 后端没有"改模板"的接口，编辑就是删旧建新——模板是一坨值，没有需要保留的引用关系
      if (cur.id) await api("DELETE", "/process-templates/" + cur.id);
      await api("POST", "/process-templates", { name, items });
      state.tplEditing = null; state.pe = null; formSnap.base = null;
      await loadView("processes"); render();
      toast(cur.id ? "模板已保存" : "模板已创建");
    } catch (e) { toast((e && e.error) || "保存失败"); }
  },
  tplDelete(id) {
    const t = (state.tplList || []).find((x) => x.id === id);
    modal({
      title: "删除工序模板", danger: true, okText: "删除",
      body: t ? `确定删除「${t.name}」吗？已经套用过这个模板的款式不受影响。` : "确定删除吗？",
      onOk: () => { run(() => api("DELETE", "/process-templates/" + id), "已删除"); return true; }
    });
  },

  // 模板名称框没有 onchange，重绘会把它清回旧值；所有触发 render() 的编辑动作先调这个
  syncTplName() {
    const el = $("tpl-name");
    if (el && state.tplEditing) state.tplEditing.name = el.value;
  },
  async saveDailyWage(v) {
    const val = Number(v);
    if (!(val > 0)) { toast("日工资基数要大于 0"); render(); return; }
    syncPeForms();
    try {
      await api("POST", "/settings/daily-wage", { value: val });
      state.dailyWage = val; render(); toast("已保存，之后按日定额算工价用这个数");
    } catch (e) { toast((e && e.error) || "保存失败"); render(); }
  },
});
