"use strict";
// 薪资管理：按月看每个人的计件工资，手动调整。

/* ---- 进页面前拉数据 ---- */
LOADERS.payroll = async () => {
  state.pay.list = (await api("GET", "/payroll/summary?month=" + state.pay.month)).list || [];
};

/* ---- 页面渲染 ---- */
/* ---------- 薪资管理（仅管理员/主管可见） ----------
 * 一人一卡：姓名/岗位 + 应发合计，下面四格（计件是算出来的，餐补/奖金/扣罚是手工调整项，扣罚显示负号）。 */
const PAY_CELLS = [
  ["pieceWage", "计件", ""], ["mealSubsidy", "餐补", ""],
  ["bonus", "奖金", ""], ["penalty", "扣罚", "minus"]
];
function vPayroll() {
  if (!isManager()) return `<div class="card"><div class="empty">仅管理员或主管可访问</div></div>`;
  const head = `<section class="group"><div class="card">
    <label class="field"><span>月份</span>${monthFieldHtml("pay-month", state.pay.month, "A.setPayMonth(this.value)")}</label>
  </div></section>`;
  const raw = state.pay.list;
  if (raw === null) return head + skeletonHtml(4);

  // 这个月一分钱都没有的人不铺满整页；真要给他加奖金，先改月份或者去「管理」页
  const list = raw.filter(it => it.total !== 0 || it.pieceWage !== 0)
    .slice().sort((a, b) => b.total - a.total);
  const sum = (k) => list.reduce((n, it) => n + (Number(it[k]) || 0), 0);

  // 0 一律走灰色：扣罚 0 也标红会让人以为真扣了钱
  const cell = (it, [k, label, cls]) => {
    const v = Number(it[k]) || 0;
    return `<div class="pay-cell">
      <div class="pay-v num ${v === 0 ? "zero" : cls}">${cls === "minus" && v ? "-" : ""}${num(v)}</div>
      <div class="pay-k">${label}</div></div>`;
  };

  const card = (it) => `<div class="card pay-card">
    <div class="pay-head">
      <span class="avatar mini">${esc(shortName(it.name))}</span>
      <div class="pay-who">
        <div class="pay-name">${esc(it.name)}</div>
        <div class="pay-role">${esc(it.roleLabel || "")}</div>
      </div>
      <div class="pay-tot">
        <div class="pay-tot-v num">${money(it.total)}</div>
        <div class="pay-tot-l">应发</div>
      </div>
    </div>
    <div class="pay-grid">${PAY_CELLS.map(c => cell(it, c)).join("")}</div>
    <div class="sc-acts">
      <button onclick="A.editPay('${it.userId}')">${state.pay.editing === it.userId ? "收起" : "调整餐补 / 奖金 / 扣罚"}</button>
    </div>
    ${state.pay.editing === it.userId ? `<div class="pay-edit">
      <label class="field"><span>餐补</span>
        <input class="in" id="pa-meal" type="number" inputmode="decimal" step="any" value="${esc(it.mealSubsidy || "")}" placeholder="0"></label>
      <label class="field"><span>奖金</span>
        <input class="in" id="pa-bonus" type="number" inputmode="decimal" step="any" value="${esc(it.bonus || "")}" placeholder="0"></label>
      <label class="field"><span>扣罚</span>
        <input class="in" id="pa-pen" type="number" inputmode="decimal" step="any" value="${esc(it.penalty || "")}" placeholder="0"></label>
      <div class="btn-row" style="padding:0">
        <button class="btn block" onclick="A.savePay('${it.userId}')">保存</button>
        <button class="btn ghost block" onclick="A.editPay('${it.userId}')">取消</button>
      </div>
    </div>` : ""}
  </div>`;

  return head + `
  <section class="group"><div class="sum-bar">
    <div class="sum-item"><div class="sum-num num">${money(sum("total"))}</div><div class="sum-label">应发合计</div></div>
    <div class="sum-item"><div class="sum-num num">${money(sum("pieceWage"))}</div><div class="sum-label">计件合计</div></div>
    <div class="sum-item"><div class="sum-num num">${list.length}</div><div class="sum-label">有工资的人数</div></div>
  </div></section>

  <section class="group">
    <div class="group-title">${esc(fmtMonth(state.pay.month))}工资</div>
    ${list.length ? list.map(card).join("") : `<div class="card">${emptyHtml("这个月还没有工资数据", "payroll")}</div>`}
  </section>`;
}

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  setPayMonth(v) { if (!v) return; state.pay.month = v; state.pay.list = null; state.pay.editing = ""; go("payroll"); },
  editPay(userId) { state.pay.editing = state.pay.editing === userId ? "" : userId; render(); },
  async savePay(userId) {
    const body = {
      userId, month: state.pay.month,
      mealSubsidy: Number(val("pa-meal")) || 0, penalty: Number(val("pa-pen")) || 0, bonus: Number(val("pa-bonus")) || 0
    };
    await run(() => api("POST", "/payroll/adjustments", body).then(() => { state.pay.editing = ""; }), "已保存");
  },
});
