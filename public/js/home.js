"use strict";
// 首页：管理员看全局概况，员工看本月完成度和预估工资。

/* ---- 进页面前拉数据 ---- */
LOADERS.home = async () => {
  const scan = await api("GET", "/scan?date=" + todayStr()).catch(() => ({ records: [] }));
  state.home.today = (scan.records || []).reduce((s, r) => s + Number(r.qty || 0), 0);
  const month = monthStr();
  if (isManager()) {
    // 管理员看的是全局概况：在职人数/今日全员完成/本月工资总额，不是自己的计件数据(管理员不计件)
    const [users, scanAll, paySummary] = await Promise.all([
      api("GET", "/users").catch(() => ({ users: [] })),
      api("GET", "/scan-all?date=" + todayStr()).catch(() => ({ records: [] })),
      api("GET", "/payroll/summary?month=" + month).catch(() => ({ list: [] }))
    ]);
    state.home.mgr = {
      staffCount: (users.users || []).filter(u => u.role !== "admin").length,
      todayQty: (scanAll.records || []).reduce((s, r) => s + Number(r.qty || 0), 0),
      monthWage: (paySummary.list || []).reduce((s, r) => s + Number(r.total || 0), 0)
    };
    state.notif.recent = ((await api("GET", "/notifications").catch(() => ({ list: [] }))).list || []).slice(0, 5);
  } else {
    // 普通员工看自己的：本月完成度(打卡时长/出勤时长)、本月预估工资
    const [eff, pay] = await Promise.all([
      api("GET", `/efficiency/monthly?month=${month}`).catch(() => null),
      api("GET", `/payroll/mine?month=${month}`).catch(() => null)
    ]);
    state.home.emp = { eff, pay };
  }
};

/* ---- 页面渲染 ---- */
/* ---------- 工作台 ---------- */
// 桌面端(≥1024px)工作台首屏多一排统计卡片(工具格子已挪进侧边栏)：管理员看全局数据，员工看自己的。
function homeStatsHtml() {
  const stat = (label, value, sub, ic) => `<div class="hstat">
    <span class="hstat-ic">${icon(ic)}</span>
    <div class="hstat-main"><div class="hstat-label">${esc(label)}</div>
      <div class="hstat-num num">${esc(String(value))}</div>${sub ? `<div class="hstat-sub">${esc(sub)}</div>` : ""}</div></div>`;
  if (isManager()) {
    const d = state.home.mgr;
    if (!d) return "";
    const recent = state.notif.recent || [];
    return `<section class="group home-desk-only">
      <div class="hstat-row">
        ${stat("在职员工", d.staffCount, "人", "employees")}
        ${stat("今日全员完成", num(d.todayQty), "件", "efficiency")}
        ${stat("本月工资总额", money(d.monthWage), "预估，含调整项", "payroll")}
      </div>
    </section>
    <section class="group home-desk-only">
      <div class="group-title">最近动态<button class="link-btn right" onclick="go('notifs')">全部</button></div>
      <div class="card">${recent.length ? recent.map(x => notifItemHtml(x)).join("") : emptyHtml("暂无动态", "inbox")}</div>
    </section>`;
  }
  const d = state.home.emp;
  if (!d) return "";
  const eff = d.eff, pay = d.pay;
  return `<section class="group home-desk-only">
    <div class="hstat-row">
      ${stat("本月完成度", eff && eff.percent !== null ? pctText(eff.percent) : "—", "时效小时 / 出勤小时", "efficiency")}
      ${stat("本月出勤", eff ? num(eff.attendanceHours) : "—", "小时", "attendance")}
      ${stat("本月预估工资", pay ? money(pay.total) : "—", "计件 + 餐补/奖金 - 扣罚", "payroll")}
    </div>
  </section>`;
}
// 早上好 / 下午好：打开 App 第一眼先叫名字，比一个光秃秃的数字亲切
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
}
function vHome() {
  const m = me();
  const tool = (v, label, ic, badge) => `<button class="tool" onclick="go('${v}')">
    <span class="tool-ic">${icon(ic)}</span><span>${esc(label)}</span>${badge ? `<span class="badge">${badge}</span>` : ""}</button>`;
  // 管理员/主管不计件，"今天完成件数"对他们永远是 0；换成全车间今天的产出，下面再带两个关键数
  const mgr = isManager() ? state.home.mgr : null;
  const emp = !isManager() ? state.home.emp : null;
  const heroNum = isManager() ? (mgr ? num(mgr.todayQty) : "—") : num(state.home.today);
  const effP = emp && emp.eff && emp.eff.percent !== null && emp.eff.percent !== undefined ? emp.eff.percent : null;
  const chips = isManager()
    ? (mgr ? [`在职 ${mgr.staffCount} 人`, `本月工资 ${money(mgr.monthWage)}`] : [])
    : [effP !== null ? `本月完成度 ${pctText(effP)}` : "", emp && emp.pay ? `本月预估 ${money(emp.pay.total)}` : ""].filter(Boolean);
  return `<div class="hero-card">
      <div class="hero-hi">${greeting()}，${esc(m.name || "")}</div>
      <div class="hero-num num">${heroNum}<span class="hero-unit">件</span></div>
      <div class="hero-text">${isManager() ? "今天全车间完成件数" : "今天完成件数，继续加油"}</div>
      ${chips.length ? `<div class="hero-chips">${chips.map(c => `<span class="hero-chip num">${esc(c)}</span>`).join("")}</div>` : ""}
    </div>

    <section class="group home-profile-card"><div class="card"><div class="row-item">
      <span class="avatar mini">${esc(shortName(m.name))}</span>
      <div class="row-main"><div class="row-label">${esc(m.name)}</div><div class="row-sub num">${esc(m.phone)}</div></div>
      <span class="tag">${esc(roleLabelOf(m))}</span>
    </div></div></section>

    ${homeStatsHtml()}

    <section class="group home-tools">
      <div class="group-title">工具</div>
      <div class="tools-grid">
        ${tool("processes", "工序模板", "processes")}
        ${tool("styles", "款式管理", "styles")}
        ${tool("cutorders", "生产管理", "cutting")}
        ${isManager() ? tool("attendance", "考勤录入", "attendance") : ""}
        ${tool("efficiency", "效率看板", "efficiency")}
        ${tool("scanlog", "打点记录", "scanlog")}
        ${isManager() ? tool("payroll", "薪资管理", "payroll") : ""}
        ${isManager() ? tool("admin", "管理", "admin") : ""}
      </div>
    </section>`;
}
