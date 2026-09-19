"use strict";
// 管理：员工列表、改岗位、重置密码、增删员工。

/* ---- 进页面前拉数据 ---- */
LOADERS.admin = async () => {
  const [u, r] = await Promise.all([api("GET", "/users"), api("GET", "/roles")]);
  state.users = u.users || []; state.roles = r.roles || [];
};

/* ---- 页面渲染 ---- */
/* ---------- 管理（员工账号 + 新增员工，仅管理员/主管可见） ---------- */
// 岗位下拉 = 本系统岗位；这人挂的是跟单系统的老岗位时，用服务端给的中文名补一项，免得选不中
function roleOptionsFor(u) {
  const opts = (state.roles || []).map((r) => [r.k, r.label]);
  if (u.role && !opts.some(([k]) => k === u.role)) {
    opts.push([u.role, u.roleLabel && u.roleLabel !== u.role ? u.roleLabel : u.role + "（未知岗位）"]);
  }
  return opts;
}

function vAdmin() {
  if (!isManager()) return `<div class="card"><div class="empty">仅管理员或主管可访问</div></div>`;
  const kw = state.empKw.trim();
  const all = staffUsers();
  // 姓名、手机号都能搜（手机号搜尾号最常用），姓名完全相同的排最前
  const matched = rankFilter(all, kw, u => [u.name, u.phone, u.roleLabel]);
  // 分页：每页 10 个。搜索关键词变化时会重置回第 1 页；筛完变短了也把页码收回有效范围
  const pages = Math.max(1, Math.ceil(matched.length / EMP_PAGE_SIZE));
  const page = Math.min(Math.max(1, state.empPage), pages);
  const users = matched.slice((page - 1) * EMP_PAGE_SIZE, page * EMP_PAGE_SIZE);
  const roles = state.roles || [];
  return `<section class="group">
    <div class="group-title">员工账号${state.users ? ` · 共 ${all.length} 人${kw ? `（匹配 ${matched.length} 人）` : ""}` : ""}</div>
    ${searchbarHtml("emp-kw", state.empKw, "搜姓名 / 手机号", "A.setEmpKw")}
    <div class="card">
      ${state.users === null ? skeletonHtml(4, false)
      : users.length ? users.map(u => `<div class="emp-item">
        <span class="avatar mini">${esc(shortName(u.name))}</span>
        <div class="emp-main">
          <div class="emp-name">${hl(u.name, kw)}${u.id === me().id ? ` <span class="tag">我</span>` : ""}</div>
          <div class="emp-phone num">${hl(u.phone, kw)}</div>
        </div>
        <div class="emp-role">${selectHtml("role-" + u.id, roleOptionsFor(u), u.role, `A.changeRole('${u.id}',this.value)`)}</div>
        <div class="emp-acts">
          <button class="act-btn" onclick="A.editUser('${u.id}')">编辑</button>
          <button class="act-btn ghost" onclick="A.resetPw('${u.id}')">重置密码</button>
          <button class="act-btn danger" onclick="A.delUser('${u.id}')">离职</button></div>
      </div>`).join("")
        : kw ? emptyHtml("没有匹配的员工", "search") : emptyHtml("还没有员工，在下面新增", "employees")}
    </div>
    ${pages > 1 ? `<div class="pager">
      <button class="act-btn ghost" ${page <= 1 ? "disabled" : ""} onclick="A.setEmpPage(${page - 1})">上一页</button>
      <span class="pager-info num">第 ${page} / ${pages} 页</span>
      <button class="act-btn ghost" ${page >= pages ? "disabled" : ""} onclick="A.setEmpPage(${page + 1})">下一页</button>
    </div>` : ""}
  </section>

  <section class="group">
    <div class="group-title">新增员工</div>
    <div class="card">
      <label class="field"><span>姓名<span class="req">*</span></span><input class="in" id="nu-name" autocomplete="off" placeholder="员工姓名"></label>
      <label class="field"><span>手机号<span class="req">*</span></span><input class="in" id="nu-phone" inputmode="tel" maxlength="11" autocomplete="off" placeholder="11 位手机号，用来登录"></label>
      <label class="field"><span>岗位</span>${selectHtml("nu-role", roles.map(r => [r.k, r.label]), "worker")}</label>
      <label class="field"><span>初始密码</span><input class="in" id="nu-pass" value="123456"></label>
      <div class="btn-row"><button class="btn" onclick="A.addUser()">创建账号</button></div>
    </div>
  </section>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  // 换关键词就回到第 1 页
  setEmpKw: debouncedSearch("_empT", "emp-kw", 300, (v) => { state.empKw = v; state.empPage = 1; }),
  setEmpPage(n) { state.empPage = Math.max(1, n); render(); window.scrollTo(0, 0); },
  changeRole(id, role) { run(() => api("PATCH", "/users/" + id, { role }), "已设置岗位"); },
  editUser(id) {
    const u = (state.users || []).find(x => x.id === id); if (!u) return;
    modal({
      title: "编辑员工", okText: "保存",
      html: `<label class="m-field"><span>姓名</span><input class="in" id="eu-name" value="${esc(u.name)}"></label>
        <label class="m-field"><span>手机号</span><input class="in" id="eu-phone" inputmode="tel" value="${esc(u.phone)}"></label>`,
      onOk: () => {
        const name = val("eu-name"), phone = val("eu-phone");
        if (!name || !phone) { toast("姓名和手机号都要填"); return false; }
        run(() => api("PATCH", "/users/" + id, { name, phone }), "已保存");
      }
    });
  },
  delUser(id) {
    const u = (state.users || []).find(x => x.id === id);
    modal({
      title: "员工离职", body: `确定把 ${u ? u.name : "该员工"} 设为离职吗？`, danger: true, okText: "离职",
      onOk: () => run(() => api("DELETE", "/users/" + id), "已离职")
    });
  },
  async addUser() {
    const name = val("nu-name"), phone = val("nu-phone");
    if (!name || !phone) return toast("请填写姓名和手机号");
    const password = val("nu-pass") || "123456";
    await run(() => api("POST", "/users", { name, phone, role: val("nu-role") || "worker", password }),
      `已添加，初始密码 ${password}`);
  },
  resetPw(id) {
    const u = (state.users || []).find(x => x.id === id);
    modal({
      title: "重置密码", body: `把 ${u ? u.name : "该员工"} 的密码重置成下面这个，告诉本人即可登录。`,
      input: true, value: "123456", okText: "重置",
      onOk: (v) => {
        const password = String(v || "").trim() || "123456";
        run(() => api("POST", `/users/${id}/reset-password`, { password }), `已重置为 ${password}`);
      }
    });
  },
});
