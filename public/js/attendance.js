"use strict";
// 考勤录入：按员工按月记出勤时长。

/* ---- 进页面前拉数据 ---- */
LOADERS.attendance = async () => {
  // 员工列表是 managerRequired 的：普通员工调不动，把原因 toast 出来，
  // 页面也别一直卡在"加载中…"
  try { state.users = (await api("GET", "/users")).users || []; }
  catch (e) { state.users = []; state.att.records = []; throw e; }
  // 管理员不参与计件考勤，选人列表里不出现（跟员工列表口径一致）
  const staff = staffUsers();
  if (!staff.some(u => u.id === state.att.userId)) state.att.userId = staff.length ? staff[0].id : "";
  state.att.records = state.att.userId
    ? (await api("GET", `/attendance?month=${state.att.date.slice(0, 7)}&userId=${state.att.userId}`)).attendance || []
    : [];
};

/* ---- 页面渲染 ---- */
/* ---------- 考勤录入 ---------- */
function vAttendance() {
  const users = state.users === null ? null : staffUsers(), recs = state.att.records;
  return `<section class="group"><div class="card">
      <label class="field"><span>员工</span>${users === null ? `<div class="row-sub">加载中…</div>`
      : users.length ? selectHtml("at-user", users.map(u => [u.id, u.name]), state.att.userId, "A.setAttUser(this.value)")
        : `<div class="row-sub">还没有员工</div>`}</label>
      <label class="field"><span>日期</span>${dateFieldHtml("at-date", state.att.date, "A.setAttDate(this.value)")}</label>
      <label class="field"><span>出勤小时</span><input class="in" id="at-hours" type="number" inputmode="decimal" step="any" placeholder="例：8"></label>
    </div>
    <div class="btn-row" style="padding-left:0;padding-right:0"><button class="btn block" onclick="A.saveAttendance()">保存考勤</button></div>
  </section>

  <section class="group">
    <div class="group-title">本月考勤（${esc(fmtMonth(state.att.date.slice(0, 7)))}）</div>
    <div class="card">${recs === null ? skeletonHtml(3, false) : recs.length ? recs.map(r => `
      <div class="row-item"><div class="row-main"><div class="row-label">${esc(fmtDate(r.date))}</div></div>
        <div class="row-value num">${num(r.hours)} 小时</div></div>`).join("")
      : emptyHtml("这个月还没有考勤记录", "attendance")}</div>
  </section>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  setAttUser(v) { state.att.userId = v; state.att.records = null; go("attendance"); },
  setAttDate(v) { if (!v) return; state.att.date = v; state.att.records = null; go("attendance"); },
  async saveAttendance() {
    if (!state.att.userId) return toast("请先添加员工");
    const hours = val("at-hours");
    if (!hours) return toast("请填写工时");
    await run(() => api("POST", "/attendance", { userId: state.att.userId, date: state.att.date, hours: Number(hours) }), "已保存");
  },
});
