"use strict";
// 页面外框：标题栏、面包屑、底部 tab、桌面侧边栏、通知铃铛，以及 render() 把当前页面画出来。

/* crumb：桌面端侧边栏能直接跳到任何工具页，不需要手机端"‹ 返回上一级"的手势按钮，
 * 所以额外给出面包屑用的 {label, fn}，桌面端 CSS 隐藏 left 返回按钮改显示它；手机端不变。 */
function pageMeta() {
  const back = (label, v) => `<button class="nav-btn nav-back" onclick="A.navBack('${v}')" aria-label="返回${esc(label)}">
    <svg viewBox="0 0 12 20" aria-hidden="true"><path d="M10 2L2 10l8 8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>${esc(label)}</button>`;
  const T = {
    home: "首页", scan: "打点", mine: "我的", admin: "管理",
    processes: "工序模板", styles: "款式管理", styleprocs: "修改工序", attendance: "考勤录入",
    efficiency: "效率看板", scanlog: "打点记录", payroll: "薪资管理", notifs: "消息通知",
    cutorders: "生产管理", cutform: "裁床编菲", cutview: "查看裁床单", cutprint: "打印菲票",
    cutprogress: "生产进度", bundleprogress: "生产进度详情", procprogress: "工序进展"
  };
  const parent = SUB_VIEWS[route.v];
  // 面包屑走完整条链（如 生产进度详情 › 生产进度 › 生产管理 › 首页）；除直接上级外链上节点不带 id，
  // 只能回到该页的"无 id"列表态，对 home/styles/cutorders 这类列表页正合适。
  const chain = [];
  let cur = parent, guard = 0;
  while (cur && guard++ < 6) { chain.unshift(cur); cur = SUB_VIEWS[cur]; }
  return {
    title: T[route.v] || APP_NAME,
    left: parent ? back(T[parent], parent) : "",
    chain: chain.map((v) => ({ v, label: T[v] || APP_NAME })),
    crumb: parent ? { label: T[parent], fn: `go('${parent}')` } : null
  };
}
function tabbarHtml() {
  const tabs = [["home", "首页", "home"], ["scan", "打点", "scan"]];
  if (isManager()) tabs.push(["admin", "管理", "admin"]);
  tabs.push(["mine", "我的", "mine"]);
  const active = SUB_VIEWS[route.v] || route.v;
  return `<nav class="tabbar">${tabs.map(([v, label, ic]) => `
    <button class="tab ${active === v ? "on" : ""}" onclick="go('${v}')" ${active === v ? `aria-current="page"` : ""}>
      <span class="ti">${icon(ic)}${v === "mine" ? badgeHtml() : ""}</span>
      <span>${esc(label)}</span></button>`).join("")}</nav>`;
}
// 桌面端左侧固定侧边栏(≥1024px 才显示，CSS 控制；手机端渲染进 DOM 但 display:none)。
// 工作台的工具格子在桌面端拆开分组摆进侧边栏，跟移动端"格子入口"两套导航并存、互不影响。
function sidebarHtml() {
  const active = SUB_VIEWS[route.v] || route.v;
  const m = me();
  const item = (v, label, ic) => `<button class="dsb-item${active === v ? " on" : ""}" onclick="go('${v}')">
    <span class="dsb-ic">${icon(ic)}</span><span>${esc(label)}</span></button>`;
  const groups = [
    ["总览", [["home", "首页", "home"]]],
    ["生产", [
      ["scan", "打点", "scan"], ["processes", "工序模板", "processes"], ["styles", "款式管理", "styles"],
      ["cutorders", "生产管理", "cutting"],
      ...(isManager() ? [["attendance", "考勤录入", "attendance"]] : []), ["efficiency", "效率看板", "efficiency"],
      ["scanlog", "打点记录", "scanlog"]
    ]],
    ["系统", [
      ...(isManager() ? [["payroll", "薪资管理", "payroll"], ["admin", "管理", "admin"]] : []),
      ["mine", "我的", "mine"]
    ]]
  ];
  return `<nav class="dsidebar">
    <div class="dsb-brand"><div class="dsb-logo">${APP_LOGO}</div><div class="dsb-name">${esc(APP_NAME)}</div></div>
    <div class="dsb-nav">${groups.map(([title, items]) => `
      <div class="dsb-group"><div class="dsb-group-title">${esc(title)}</div>
        ${items.map(([v, label, ic]) => item(v, label, ic)).join("")}</div>`).join("")}</div>
    <div class="dsb-foot">
      <span class="avatar">${esc(shortName(m.name))}</span>
      <div><div class="dsb-foot-name">${esc(m.name)}</div><div class="dsb-foot-role">${esc(roleLabelOf(m))}</div></div>
    </div>
  </nav>`;
}
// 桌面端顶部右上角铃铛按钮(放在居中的 .navbar-in 里，跟标题同一行)
function deskBellBtnHtml() {
  const m = me();
  return `<button class="dbell" onclick="A.toggleNotifPanel()" aria-label="通知" aria-expanded="${notifPanelOpen}">${icon("bell")}${badgeHtml("dbell-dot")}</button>
    <div class="dh-user">
      <span class="avatar sm">${esc(shortName(m.name))}</span>
      <span class="dh-uname">${esc(m.name)}</span>
    </div>`;
}
// 通知面板必须挂在 <header class="navbar">（position:sticky 且不限宽）下面，不能挂在居中/限宽的
// .navbar-in 或铃铛按钮下面，否则宽屏下面板位置会跟着居中容器宽度走，对不齐或被裁切。
function deskNotifOverlayHtml() {
  if (!notifPanelOpen) return "";
  const list = state.notif.list;
  return `<div class="dbell-back" onclick="A.toggleNotifPanel()"></div>
    <div class="dbell-panel" role="dialog" aria-label="通知">
      <div class="dbell-panel-head"><span>通知</span><span class="dbell-acts">
        ${(list || []).some(x => !x.read) ? `<button type="button" class="link-btn" onclick="event.stopPropagation();A.markAllNotifRead()">全部已读</button>` : ""}
        ${(list || []).some(x => x.read) ? `<button type="button" class="link-btn" onclick="event.stopPropagation();A.clearReadNotifs()">清空已读</button>` : ""}
      </span></div>
      <div class="dbell-panel-list">${list === null ? skeletonHtml(3, false) : list.length ? list.map(x => notifItemHtml(x, { desk: true, del: true })).join("")
        : emptyHtml("没有新通知", "inbox")}</div>
      <button type="button" class="dbell-foot" onclick="go('notifs')">查看全部通知</button>
    </div>`;
}
function render() {
  const app = $("app");
  if (showWelcome) { app.innerHTML = vWelcome(); return; }
  if (!me() && state.token && bootError) {
    app.innerHTML = `<div class="login-page"><div class="login-inner"><div class="login-brand">
      <div class="login-logo">${APP_LOGO}</div><h1 class="login-title">${esc(APP_NAME)}</h1></div>
      ${emptyHtml(bootError + "，请检查网络", "refresh", `<button class="btn" onclick="location.reload()">重新连接</button>`)}</div></div>`;
    return;
  }
  if (!me()) { app.innerHTML = vLogin(); return; }
  const meta = pageMeta();
  const views = {
    home: vHome, scan: vScan, processes: vProcesses, styles: vStyles, styleprocs: vStyleProcs, attendance: vAttendance,
    efficiency: vEfficiency, scanlog: vScanlog, payroll: vPayroll, admin: vAdmin, mine: vMine,
    notifs: vNotifs, cutorders: vCutOrders, cutform: vCutForm, cutview: vCutView, cutprogress: vCutProgress, cutprint: vCutPrint,
    bundleprogress: vBundleProgress, procprogress: vProcProgress
  };
  app.innerHTML = `
    ${sidebarHtml()}
    ${route.v === "home" ? `<div class="home-brand"><div class="co">${esc(COMPANY_NAME)}</div><div class="app">${esc(APP_NAME)}</div></div>` : ""}
    ${meta.chain && meta.chain.length ? `<nav class="dbreadcrumb">${meta.chain.map((c) =>
      `<button class="dbc-link" onclick="go('${c.v}')">${esc(c.label)}</button><span class="dbc-sep">\u203a</span>`).join("")
      }<span class="dbc-current">${esc(meta.title)}</span></nav>` : ""}
    <header class="navbar"><div class="navbar-in">
      <div class="nav-slot mobile-only">${meta.left || ""}</div>
      <h1 class="nav-title">${esc(meta.title)}</h1>
      <div class="nav-slot right">${deskBellBtnHtml()}</div>
    </div>${deskNotifOverlayHtml()}</header>
    ${tabbarHtml()}
    <main class="page" data-view="${route.v}">${(views[route.v] || vHome)()}</main>`;
  syncOverlayHistory();
}
