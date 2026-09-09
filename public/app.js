"use strict";
/**
 * 计件跟踪系统 — 手机网页版（可添加到主屏当 App 用的 PWA）。
 *
 * 功能照搬原来的微信小程序（miniprogram/pages/*）：工作台、工序模板、款式管理、打点、
 * 考勤录入、效率看板、生产管理、扫菲记录、我的，
 * 「员工管理（员工列表 + 新增员工）」集中到独立的「管理」页面（仅管理员/主管可见，
 * 跟「跟单系统」的管理后台一个做法）；薪资管理是工作台上单独的一个入口，同样只有管理员/主管看得到。
 * 登录方式跟「跟单系统」一致：手机号 + 密码，账号只能由管理员在管理页面创建，员工不能自助注册。
 * 登录状态不过期：token 存 localStorage，只有后端返回 401 或用户主动退出才会清掉。
 *
 * 写法跟「跟单系统」(daka-system/public/app.js) 保持一致：无构建步骤的原生 JS，
 * 全局 state 存数据，go(view,id) 切页，A.* 是所有 onclick 事件处理的命名空间，
 * v开头的函数返回一段 HTML 字符串。权限在服务端强制校验，这里只负责隐藏没权限的入口。
 */

/* ================= 状态 ================= */
const TOKEN_KEY = "jj_token";

let state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  me: null,
  users: null, roles: null,
  processes: null, styles: null, styleOptions: null, styleKw: "",
  // 生产管理页：range 是概览卡的今日/昨日/本月；tab 是"按裁床单看/按款看"；from/to 是明细的日期区间
  co: { range: "today", tab: "sheet", kw: "", from: "", to: "", dateOpen: false, overview: null, list: null, byStyle: null },
  // 裁床编菲表单。colors/sizes 的顺序就是矩阵的行列顺序，也就是扎号编号的遍历顺序，
  // 所以是按点选先后入列的数组，不是集合。
  cf: null,
  cv: null,   // 查看裁床单：{ order, bundles, processes, summary }
  pg: null, pgKw: "",  // 生产进度（按扎）
  pr: null,            // 工序进展
  bp: null,            // 生产进度详情（一扎的每道工序）
  cp: null,            // 打印菲票设置
  home: { today: 0, mgr: null, emp: null },
  // 扫菲打点：ticketInput 是手输/扫出来的扎号或菲票号，bundle/bundleOrder/bundleProcs 是查到的那一扎
  scan: { date: todayStr(), records: null, eff: null,
    ticketInput: "", bundle: null, bundleOrder: null, bundleProcs: null, camOn: false },
  att: { userId: "", date: todayStr(), records: null },
  eff: { month: monthStr(), list: null },
  slog: { date: todayStr(), records: null },
  pay: { month: monthStr(), list: null, mine: null, editing: "" },
  empKw: "", empPage: 1,
  notif: { unread: 0, list: null },
  // 尺码/颜色/客户三个选项控件各自的展开状态与搜索词。桌面端展开是下拉面板，手机端是底部弹层。
  optUI: { size: { open: false, kw: "" }, color: { open: false, kw: "" }, customer: { open: false, kw: "" } },
  // 工序编辑器：款式表单里的「生产工序」段落和款式列表的「修改工序」页共用这份状态
  pe: null
};
const EMP_PAGE_SIZE = 10;       // 管理页员工列表每页条数
let route = { v: "home", id: null };
let showWelcome = false;        // 打开 App 时短暂展示的欢迎界面（logo/公司名称/计件跟踪）
let modalState = null;
let deferredInstall = null;     // 安卓/桌面 Chrome 的原生安装事件
let notifPanelOpen = false;     // 桌面端顶部铃铛下拉面板是否展开
let procForm = null;            // 工序模板表单
let styleForm = null;           // 款式表单

const isMobileDevice = () => /iPhone|iPad|iPod|Android|Mobile|HarmonyOS/i.test(navigator.userAgent || "")
  || (navigator.maxTouchPoints > 1 && window.matchMedia && window.matchMedia("(pointer:coarse)").matches);
const isStandalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
  || window.navigator.standalone === true;

/* ================= 工具 ================= */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const val = id => { const el = $(id); return el ? String(el.value).trim() : ""; };
function todayStr() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function monthStr() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}
// 日期字符串 2026-08-15 -> 2026年8月15日
function fmtDate(v) {
  const m = String(v || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1]}年${+m[2]}月${+m[3]}日` : (v || "");
}
function fmtMonth(v) {
  const m = String(v || "").match(/^(\d{4})-(\d{1,2})$/);
  return m ? `${m[1]}年${+m[2]}月` : (v || "");
}
// 通知时间：24小时内显示"刚刚/xx分钟前/xx小时前"，更早显示日期
function fmtNotifTime(ms) {
  const diff = Date.now() - ms;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + "分钟前";
  if (diff < 86400000) return Math.floor(diff / 3600000) + "小时前";
  const d = new Date(ms), p = n => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 通知条目：actorName/targetLabel/what 都在时用"头像+姓名+对象胶囊+改动说明"的卡片式展示；
// 老通知(升级前生成的)这几列是 NULL，退回最初的纯文本单行展示，不强行拼凑。
// 铃铛下拉/通知整页/首页"最近动态"预览三处共用同一套结构，desk=true 用更紧凑的字号。
function notifItemHtml(n, desk) {
  const rich = !!(n.actorName && n.targetLabel && n.what);
  const cls = `notif-item${desk ? " desk" : ""}${n.read ? "" : " unread"}`;
  const initials = s => (s || "").length > 2 ? s.slice(-2) : (s || "");
  return `<div class="${cls}" onclick="A.openNotif('${n.id}','${n.link || ""}')">
    ${rich ? `<span class="avatar sm">${esc(initials(n.actorName))}</span>` : ""}
    <div class="notif-main">${rich ? `
      <div class="notif-top"><span class="notif-actor">${esc(n.actorName)}</span><span class="tag">${esc(n.targetLabel)}</span></div>
      <div class="notif-what">${esc(n.what)}</div>` : `
      <div class="notif-plain">${esc(n.text)}</div>`}
      <div class="notif-time">${fmtNotifTime(n.createdAt)}</div>
    </div></div>`;
}
const num = n => Math.round(Number(n || 0) * 100) / 100;
const pctText = p => (p === null || p === undefined) ? "" : Math.round(p * 1000) / 10 + "%";
function toast(s, sticky) {
  const m = $("msg"); m.textContent = s; m.classList.add("show");
  clearTimeout(toast._t);
  if (!sticky) toast._t = setTimeout(() => m.classList.remove("show"), 2400);
}
const me = () => state.me;
// 跟服务端 auth.js 的 isManager 保持一致：管理员 + 技术主管/业务主管才看得到
// 「管理」页面（员工列表/新增员工）和「薪资管理」入口。
const SUPERVISOR_ROLES = ["r1785125327446", "r1785125333976", "tech_lead", "biz_lead"];
const isAdmin = () => !!me() && me().role === "admin";
const isManager = () => !!me() && (me().role === "admin" || SUPERVISOR_ROLES.indexOf(me().role) >= 0);
const roleLabelOf = u => u ? (u.roleLabel || (u.role === "admin" ? "管理员" : "员工")) : "";
// 员工名单：管理员不算计件工人，考勤录入的选人、管理页的员工表格都不列他们
const staffUsers = () => (state.users || []).filter(u => u.role !== "admin");
const COMPANY_NAME = "惠锦制衣有限公司";
const APP_NAME = "计件跟踪";
const APP_LOGO = `
  <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="lg-bg" x1="60" y1="30" x2="440" y2="490" gradientUnits="userSpaceOnUse">
        <stop stop-color="#1E63AE"/><stop offset=".55" stop-color="#153F72"/><stop offset="1" stop-color="#0E2F58"/>
      </linearGradient>
      <linearGradient id="lg-gloss" x1="90" y1="60" x2="300" y2="300" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FFFFFF" stop-opacity=".22"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="512" height="512" rx="116" fill="url(#lg-bg)"/>
    <path d="M116 0h280a116 116 0 0 1 116 116v70C420 96 300 40 176 40 152 40 128 42 106 46A116 116 0 0 1 116 0Z" fill="url(#lg-gloss)"/>
    <circle cx="256" cy="256" r="158" fill="#FFFFFF"/>
    <path d="M177 264 L233 320 L339 203" stroke="#71A8DE" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

// 工具格子图标：沿用小程序 utils/icons.js 那套线条图标，改成 currentColor 以便跟主题色走
const ICONS = {
  employees: `<circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.8 3.1-6.5 7-6.5s7 2.7 7 6.5"/>`,
  processes: `<circle cx="5" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="18" r="2"/><path d="M6.8 7.6l3.4 3M13.8 13.6l3.4 3"/>`,
  styles: `<path d="M8.5 4l3.5 2 3.5-2 3 3-2 2v11H7.5V9l-2-2z"/>`,
  attendance: `<rect x="3.5" y="5" width="17" height="15" rx="2.2"/><path d="M3.5 9.5h17M8 3v3M16 3v3"/><path d="M9 14l2 2 4-4.3"/>`,
  efficiency: `<path d="M4 20V13M10 20V8M16 20V11M20 20V4"/><path d="M4 20.3h16" stroke-width="1.4"/>`,
  cutting: `<path d="M12 3.2l7.6 4.3v9L12 20.8l-7.6-4.3v-9L12 3.2z"/><path d="M4.5 7.6L12 12l7.6-4.4M12 12v8.6"/>`,
  payroll: `<circle cx="12" cy="12" r="8"/><path d="M9 8.3l3 4 3-4M12 12v5.3M9.5 13.6h5M9.5 15.6h5"/>`,
  scanlog: `<path d="M4 8V5.3A1.3 1.3 0 015.3 4H8M20 8V5.3A1.3 1.3 0 0018.7 4H16M4 16v2.7A1.3 1.3 0 005.3 20H8M20 16v2.7a1.3 1.3 0 01-1.3 1.3H16"/><path d="M4 12h16" stroke-dasharray="1.6 2.2"/>`,
  operations: `<circle cx="12" cy="13" r="7.6"/><path d="M12 9v4.3l3 1.8"/><path d="M6.2 4.3L4.4 6M17.8 4.3L19.6 6"/>`,
  admin: `<circle cx="12" cy="12" r="3"/><path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V20a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1H20a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>`,
  home: `<path d="M4 10.5 12 4l8 6.5"/><path d="M6 10v9.2a.8.8 0 0 0 .8.8h10.4a.8.8 0 0 0 .8-.8V10"/>`,
  scan: `<path d="M4 8V5.3A1.3 1.3 0 015.3 4H8M20 8V5.3A1.3 1.3 0 0018.7 4H16M4 16v2.7A1.3 1.3 0 005.3 20H8M20 16v2.7a1.3 1.3 0 01-1.3 1.3H16"/><path d="M8 12h8"/>`,
  mine: `<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>`,
  bell: `<path d="M6 9.5a6 6 0 0 1 12 0c0 4 1.4 5.6 1.4 5.6H4.6S6 13.5 6 9.5Z"/><path d="M10 19a2 2 0 0 0 4 0"/>`,
  trash: `<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
};
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;

/* ================= API ================= */
async function api(method, path, body) {
  const headers = {};
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const opts = { method, headers };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch("/api" + path, opts);
  if (r.status === 401 && state.token) { A.forceLogout(); throw { error: "登录已失效，请重新登录" }; }
  let j = null; try { j = await r.json(); } catch (e) { }
  if (!r.ok) throw (j || { error: "请求失败" });
  return j;
}
// 执行一个动作 → 重新拉当前页数据 → 重绘
// 返回 fn() 的结果（成功）或 undefined（失败）：调用方需要知道操作是否成功时可以判断返回值，
// 已有的 15 处调用都没接返回值，这个改动对它们是无害的。
async function run(fn, okMsg) {
  try { const result = await fn(); await loadView(route.v); render(); if (okMsg) toast(okMsg); return result; }
  catch (e) { toast((e && e.error) || "操作失败"); return undefined; }
}

/* ---- 应用内通知：轮询未读数，桌面端铃铛红点 / 手机端"我的"页红点用 ---- */
let notifTimer = null;
async function refreshNotifUnread() {
  try {
    const r = await api("GET", "/notifications/unread-count");
    if (r.total !== state.notif.unread) { state.notif.unread = r.total; render(); }
  } catch (e) { /* 网络抖动/未登录，静默跳过，下一轮再试 */ }
}
function startNotifPoll() {
  if (notifTimer) return;
  refreshNotifUnread();
  notifTimer = setInterval(refreshNotifUnread, 10000);
}
function stopNotifPoll() { clearInterval(notifTimer); notifTimer = null; }

/* ================= 数据加载（每个页面各自拉自己要的接口） ================= */
async function loadView(v) {
  if (v === "home") {
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
      state.notif.list = (await api("GET", "/notifications").catch(() => ({ list: [] }))).list || [];
    } else {
      // 普通员工看自己的：本月完成度(打卡时长/出勤时长)、本月预估工资
      const [eff, pay] = await Promise.all([
        api("GET", `/efficiency/monthly?month=${month}`).catch(() => null),
        api("GET", `/payroll/mine?month=${month}`).catch(() => null)
      ]);
      state.home.emp = { eff, pay };
    }
    return;
  }
  if (v === "scan") {
    const [p, s] = await Promise.all([api("GET", "/processes"), api("GET", "/styles")]);
    state.processes = p.processes || []; state.styles = s.styles || [];
    const [rec, eff] = await Promise.all([
      api("GET", "/scan?date=" + state.scan.date),
      api("GET", "/efficiency/daily?date=" + state.scan.date).catch(() => null)
    ]);
    state.scan.records = rec.records || []; state.scan.eff = eff;
    return;
  }
  if (v === "processes") { state.processes = (await api("GET", "/processes")).processes || []; return; }
  if (v === "styles") {
    const [s, o, p] = await Promise.all([
      api("GET", "/styles"), api("GET", "/style-options").catch(() => ({})), api("GET", "/processes")
    ]);
    state.styles = s.styles || []; state.processes = p.processes || [];
    state.styleOptions = { sizes: o.sizes || [], colors: o.colors || [], customers: o.customers || [] };
    return;
  }
  if (v === "cutform") {
    const [s2, o] = await Promise.all([
      state.styles ? Promise.resolve({ styles: state.styles }) : api("GET", "/styles"),
      api("GET", "/style-options").catch(() => ({}))
    ]);
    state.styles = s2.styles || [];
    state.styleOptions = { sizes: o.sizes || [], colors: o.colors || [], customers: o.customers || [] };
    const st = state.styles.find((x) => x.id === route.id);
    // 换了款式就重建表单；同一个款式来回进出保留用户填了一半的内容
    if (!state.cf || state.cf.styleId !== route.id) {
      state.cf = {
        styleId: route.id, styleName: st ? (st.code || st.name) : "",
        bedNo: "", docNo: "", customer: (st && st.customer) || "", cutDate: todayStr(), shipDate: "",
        orderNo: "", bedNote: "", ticketNote: "", companyName: COMPANY_NAME,
        // 款式上已经填过的尺码/颜色直接带过来，省得每张单重选一遍
        colors: String((st && st.color) || "").split(",").map(x => x.trim()).filter(Boolean),
        sizes: String((st && st.size) || "").split(",").map(x => x.trim()).filter(Boolean),
        cells: {}, startNo: 1,
        customNo: false, customVat: false, rowCopy: true, colCopy: false, multiple: false, sameBundles: false,
        bundlesAll: 1, customNos: {}, vatNos: {}
      };
    }
    return;
  }
  if (v === "cutprint") {
    const d = await api("GET", "/cut-orders/" + route.id);
    const maxNo = d.bundles.length ? Math.max(...d.bundles.map(b => b.bundle_no)) : 1;
    const minNo = d.bundles.length ? Math.min(...d.bundles.map(b => b.bundle_no)) : 1;
    state.cp = {
      orderId: route.id, order: d.order, bundleCount: d.bundles.length,
      from: minNo, to: maxNo, picks: "", usePicks: false,
      copies: 1, template: "label60x40", rotate: false, perNote: false,
      note: d.order.ticket_note || "", companyName: d.order.company_name || COMPANY_NAME
    };
    return;
  }
  if (v === "cutprogress") {
    state.pg = await api("GET", `/cut-orders/${route.id}/progress`);
    state.pgKw = state.pgKw || "";
    return;
  }
  if (v === "procprogress") {
    state.pr = await api("GET", `/cut-orders/${route.id}/process-progress`);
    return;
  }
  if (v === "bundleprogress") {
    state.bp = await api("GET", "/bundles/" + route.id);
    return;
  }
  if (v === "cutview") {
    state.cv = await api("GET", "/cut-orders/" + route.id);
    return;
  }
  if (v === "cutorders") {
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
    return;
  }
  if (v === "styleprocs") {
    const [r, roleRes] = await Promise.all([
      api("GET", `/styles/${route.id}/processes`),
      api("GET", "/roles").catch(() => ({ roles: [] }))  // 普通员工没有管理权限，取不到岗位列表就留空，不阻塞页面
    ]);
    const style = (state.styles || []).find((s) => s.id === route.id) || {};
    state.pe = {
      styleId: route.id,
      mode: (r.list[0] && r.list[0].price_mode) || "default",
      sizes: String(style.size || "").split(",").filter(Boolean),
      roles: roleRes.roles || [],
      items: r.list.map((x) => ({
        name: x.name, unitPrice: x.unit_price, prices: x.prices || {},
        showPrice: x.show_price !== false, visibleRoles: x.visible_roles || []
      }))
    };
    return;
  }
  if (v === "attendance") {
    // 员工列表是 managerRequired 的（跟小程序一样）：普通员工调不动，把原因 toast 出来，
    // 页面也别一直卡在"加载中…"
    try { state.users = (await api("GET", "/users")).users || []; }
    catch (e) { state.users = []; state.att.records = []; throw e; }
    // 管理员不参与计件考勤，选人列表里不出现（跟员工列表口径一致）
    const staff = staffUsers();
    if (!staff.some(u => u.id === state.att.userId)) state.att.userId = staff.length ? staff[0].id : "";
    state.att.records = state.att.userId
      ? (await api("GET", `/attendance?month=${state.att.date.slice(0, 7)}&userId=${state.att.userId}`)).attendance || []
      : [];
    return;
  }
  if (v === "efficiency") {
    state.eff.list = (await api("GET", "/efficiency/summary?month=" + state.eff.month)).list || [];
    return;
  }
  if (v === "scanlog") { state.slog.records = (await api("GET", "/scan-all?date=" + state.slog.date)).records || []; return; }
  if (v === "admin") {
    const [u, r] = await Promise.all([api("GET", "/users"), api("GET", "/roles")]);
    state.users = u.users || []; state.roles = r.roles || [];
    return;
  }
  if (v === "payroll") {
    state.pay.list = (await api("GET", "/payroll/summary?month=" + state.pay.month)).list || [];
    return;
  }
  if (v === "mine") {
    const m = await api("GET", "/me");
    state.me = m.user;
    if (!isManager()) state.pay.mine = await api("GET", "/payroll/mine?month=" + state.pay.month).catch(() => null);
    return;
  }
  if (v === "notifs") {
    state.notif.list = (await api("GET", "/notifications")).list || [];
    return;
  }
}

/* ================= 图片：压缩 / 选择器 / 缩略图 / 大图查看 =================
   交互跟「跟单系统」完全一致：拍照 / 相册两个独立入口、缩略图点开大图查看器。
   区别只在存储：jijian 的款式图直接以 base64 data URI 存在 jj_styles.image/images 字段里，
   不走 /uploads 静态文件。所以压缩比 gendan 更狠一点（长边 1400 / 质量 0.78），
   并且限制单个款式所有图片加起来不超过 5MB（服务端 express.json 上限是 8MB）。 */
let photoDraft = {};            // { 上下文key: [dataURI,...] } 表单里正在编辑的照片
let lightbox = null;            // 大图查看器状态
let galleryReg = {};            // 缩略图分组注册表：base64 很长，不能直接塞进 data-gallery 属性
let galleryN = 0;
function regGallery(urls) { const k = "g" + (++galleryN); galleryReg[k] = urls; return k; }
const IMG_LIMIT = 5 * 1024 * 1024;

function normalizePhotos(v) {
  if (Array.isArray(v)) return v.filter(x => typeof x === "string" && x);
  if (typeof v === "string" && v) return [v];
  return [];
}
// 小程序时期的款式图存的是微信云存储 fileID（cloud://...），网页打不开，只能提示一下
const showable = u => /^(data:|https?:|\/)/.test(String(u || ""));
function compressImage(file) {
  return new Promise((resolve) => {
    if (!file || !/^image\//.test(file.type)) return resolve(null);
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1400, scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        try { resolve(c.toDataURL("image/jpeg", 0.78)); } catch (e) { resolve(rd.result); }
      };
      img.onerror = () => resolve(null);
      img.src = rd.result;
    };
    rd.onerror = () => resolve(null);
    rd.readAsDataURL(file);
  });
}
function photoThumbs(urls, editable, ctx) {
  const g = regGallery(urls.filter(showable));
  return urls.map((u, i) => {
    const gi = urls.filter(showable).indexOf(u);
    return `<div class="ph-thumb">${showable(u)
      ? `<img src="${esc(u)}" data-gallery="${g}" data-i="${gi < 0 ? 0 : gi}" onclick="A.lightboxFromEl(this)" alt="款式图">`
      : `<div class="ph-na">旧版小程序图片<br>网页打不开</div>`}
      ${editable ? `<span class="ph-x" onclick="A.removeDraftPhoto('${ctx}',${i})">✕</span>` : ""}</div>`;
  }).join("");
}
// 拍照和相册拆成两个独立入口：部分手机(尤其华为)系统选择器在 <input multiple> 上会隐藏"拍照"选项
// (一次拍照只能出一张图，跟多选语义冲突)，只拆开两个按钮才能保证两条路都能用
function pickerInner(ctx) {
  const list = photoDraft[ctx] || [];
  return photoThumbs(list, true, ctx) +
    `<label class="ph-add"><input type="file" accept="image/*" capture="environment" style="display:none" onchange="A.addDraftPhotos('${ctx}',this)">
      <span class="ph-plus">📷</span><span>拍照</span></label>` +
    `<label class="ph-add"><input type="file" accept="image/*" multiple style="display:none" onchange="A.addDraftPhotos('${ctx}',this)">
      <span class="ph-plus">＋</span><span>相册</span></label>`;
}
function photoPicker(ctx) { return `<div class="photos-grid" id="pe-${ctx}">${pickerInner(ctx)}</div>`; }
function photoGallery(urls) {
  urls = normalizePhotos(urls);
  if (!urls.length) return "";
  return `<div class="photos-grid ro">${photoThumbs(urls, false)}</div>`;
}
// 给大图加双指缩放 + 拖动 + 双击（页面本身仍锁定缩放，这里单独放开）
function attachLightboxGestures(img) {
  let scale = 1, tx = 0, ty = 0, mode = null;
  let startDist = 0, startScale = 1, startX = 0, startY = 0, startTx = 0, startTy = 0, lastTap = 0;
  const apply = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  img.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      mode = "pinch"; startDist = dist(e.touches); startScale = scale; startTx = tx; startTy = ty; e.preventDefault();
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) {              // 双击：放大 / 还原
        if (scale > 1) { scale = 1; tx = 0; ty = 0; } else { scale = 2.5; }
        apply(); e.preventDefault();
      } else if (scale > 1) {                 // 放大后单指拖动
        mode = "pan"; startX = e.touches[0].clientX; startY = e.touches[0].clientY; startTx = tx; startTy = ty;
      }
      lastTap = now;
    }
  }, { passive: false });
  img.addEventListener("touchmove", (e) => {
    if (mode === "pinch" && e.touches.length === 2) {
      scale = Math.min(5, Math.max(1, startScale * dist(e.touches) / startDist)); apply(); e.preventDefault();
    } else if (mode === "pan" && e.touches.length === 1 && scale > 1) {
      tx = startTx + (e.touches[0].clientX - startX); ty = startTy + (e.touches[0].clientY - startY); apply(); e.preventDefault();
    }
  }, { passive: false });
  img.addEventListener("touchend", () => { if (scale <= 1) { scale = 1; tx = 0; ty = 0; apply(); } mode = null; });
}
function renderLightbox() {
  let el = $("lightbox");
  if (!lightbox) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement("div"); el.id = "lightbox"; el.className = "lightbox"; document.body.appendChild(el); }
  const { photos, i } = lightbox;
  el.innerHTML = `<div class="lb-bar"><span class="lb-count num">${i + 1} / ${photos.length}</span>
      <button class="lb-close" onclick="A.closeLightbox()">✕</button></div>
    <img class="lb-img" src="${esc(photos[i])}" alt="照片">
    ${photos.length > 1 ? `<button class="lb-nav prev" onclick="event.stopPropagation();A.lbStep(-1)">‹</button>
      <button class="lb-nav next" onclick="event.stopPropagation();A.lbStep(1)">›</button>` : ""}`;
  // 只有点黑色背景才关闭；点图片是为了缩放，不关
  el.onclick = (e) => { if (e.target === el) A.closeLightbox(); };
  const img = el.querySelector(".lb-img");
  if (img) attachLightboxGestures(img);
}

/* ================= 弹窗 ================= */
function modal(opts) { modalState = opts; renderModal(); }
function renderModal() {
  const mask = $("mask");
  if (!modalState) { mask.classList.remove("show"); mask.innerHTML = ""; return; }
  const o = modalState;
  mask.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <div class="m-title">${esc(o.title)}</div>
    ${o.body ? `<div class="m-body">${esc(o.body)}</div>` : ""}
    ${o.html ? `<div style="margin-top:14px">${o.html}</div>` : ""}
    ${o.input ? `<input class="in" id="m-input" style="margin-top:14px">` : ""}
    <div class="m-actions">
      <button class="btn ghost" onclick="A.modalCancel()">取消</button>
      <button class="btn ${o.danger ? "danger" : ""}" onclick="A.modalOk()">${esc(o.okText || "确定")}</button>
    </div></div>`;
  if (o.input) { const i = $("m-input"); i.value = o.value || ""; i.focus(); }
  mask.classList.add("show");
}

/* ================= 表单小控件 ================= */
// 日期：真正的 input[type=date] 透明地盖满整个按钮区域直接接收点击/触摸(不靠 JS 模拟点击，
// 部分手机浏览器不支持 showPicker() 会导致点了没反应)，下面露出显示「2026年8月15日」的中文按钮
function dateFieldHtml(id, v, onChange) {
  return `<div class="datefield">
    <button type="button" class="in date-btn ${v ? "" : "empty"}" id="${id}--label" tabindex="-1">${v ? esc(fmtDate(v)) : "选择日期"}</button>
    <input type="date" id="${id}" class="date-native" value="${esc(v || "")}" autocomplete="off"
      onchange="A.syncDateLabel('${id}');${onChange}" onclick="A.openDate(this)" onfocus="A.openDate(this)"></div>`;
}
// 月份：跟日期同一套做法——原生控件透明地盖在上面接收点击，界面上显示的是我们自己排的中文
// 「2026年8月」，不用浏览器原生渲染出来的英文月份名。个别老浏览器不认 input[type=month]
// （会退化成文本框），那种情况下改用「年 + 月」两个下拉，保证哪台手机都点得动。
const MONTH_INPUT_OK = (function () {
  const i = document.createElement("input");
  i.setAttribute("type", "month");
  return i.type === "month";
})();
function monthFieldHtml(id, v, onChange) {
  if (MONTH_INPUT_OK) {
    return `<div class="datefield">
      <button type="button" class="in date-btn ${v ? "" : "empty"}" id="${id}--label" tabindex="-1">${v ? esc(fmtMonth(v)) : "选择月份"}</button>
      <input type="month" id="${id}" class="date-native" value="${esc(v || "")}" autocomplete="off"
        onchange="A.syncMonthLabel('${id}');${onChange}" onclick="A.openDate(this)" onfocus="A.openDate(this)"></div>`;
  }
  A._monthCb[id] = onChange;
  const m = String(v || monthStr()).match(/^(\d{4})-(\d{2})$/) || [];
  const y0 = new Date().getFullYear();
  const years = [y0 - 2, y0 - 1, y0, y0 + 1];
  const months = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
  return `<div style="display:flex;gap:8px">
    <select class="in" id="${id}--y" onchange="A.syncMonthSelect('${id}')">${years.map(y =>
      `<option value="${y}" ${String(y) === m[1] ? "selected" : ""}>${y}年</option>`).join("")}</select>
    <select class="in" id="${id}--m" onchange="A.syncMonthSelect('${id}')">${months.map(x =>
      `<option value="${x}" ${x === m[2] ? "selected" : ""}>${+x}月</option>`).join("")}</select>
    <input type="hidden" id="${id}" value="${esc(v || "")}"></div>`;
}
function selectHtml(id, opts, cur, onChange, placeholder) {
  // 当前值不在候选里（比如款式上存的客户名后来被从选项池删了）也要保留显示，不能悄悄丢掉
  const list = (cur !== "" && cur !== null && cur !== undefined && !opts.some(([v]) => String(v) === String(cur)))
    ? [[cur, cur]].concat(opts) : opts;
  return `<select class="in" id="${id}" ${onChange ? `onchange="${onChange}"` : ""}>
    ${placeholder ? `<option value="">${esc(placeholder)}</option>` : ""}
    ${list.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(t)}</option>`).join("")}
  </select>`;
}

/* ================= 路由与渲染 ================= */
const SUB_VIEWS = { processes: "home", styles: "home", styleprocs: "home", attendance: "home", efficiency: "home",
  scanlog: "home", payroll: "home", notifs: "mine",
  cutorders: "home", cutform: "styles", cutview: "cutorders", cutprint: "cutorders",
  cutprogress: "cutorders", bundleprogress: "cutprogress", procprogress: "cutprogress" };
function go(v, id) {
  route = { v, id: id || null };
  lightbox = null; renderLightbox();
  if (v !== "styles") { styleForm = null; photoDraft = {}; }
  if (v !== "processes") procForm = null;
  render(); window.scrollTo(0, 0);
  // 出错也要重绘一次：loadView 里出错时已经把对应数据清空了，别让页面继续显示上一次的旧内容
  loadView(v).then(render).catch(e => { render(); toast((e && e.error) || "加载失败"); });
}
/* crumb：桌面端侧边栏能直接跳到任何工具页，不需要手机端"‹ 返回上一级"的手势按钮，
 * 所以额外给出面包屑用的 {label, fn}，桌面端 CSS 隐藏 left 返回按钮改显示它；手机端不变。 */
function pageMeta() {
  const back = (label, v) => `<button class="nav-btn" onclick="go('${v}')">‹ ${esc(label)}</button>`;
  const T = {
    home: "首页", scan: "打点", mine: "我的", admin: "管理",
    processes: "工序模板", styles: "款式管理", styleprocs: "修改工序", attendance: "考勤录入",
    efficiency: "效率看板", scanlog: "扫菲记录", payroll: "薪资管理", notifs: "消息通知",
    cutorders: "生产管理", cutform: "裁床编菲", cutview: "查看裁床单", cutprint: "打印菲票",
    cutprogress: "生产进度", bundleprogress: "生产进度详情", procprogress: "工序进展"
  };
  const parent = SUB_VIEWS[route.v];
  // 面包屑要走完整条链：生产进度详情 › 生产进度 › 生产管理 › 首页。
  // 新加的页面嵌套到三层，只显示直接上级的话在桌面端会看不出自己在哪儿。
  // 注意逐级的 id 我们并不保留（每页只知道自己的 id），所以链上除了直接上级之外
  // 都只能回到该页的"无 id"状态——对 home/styles/cutorders 这些列表页正好合适。
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
    <button class="tab ${active === v ? "on" : ""}" onclick="go('${v}')">
      <span class="ti">${icon(ic)}${v === "mine" && state.notif.unread ? `<span class="badge">${state.notif.unread > 99 ? "99+" : state.notif.unread}</span>` : ""}</span>
      <span>${esc(label)}</span></button>`).join("")}</nav>`;
}
// 桌面端左侧固定侧边栏(≥1024px 才显示，CSS 控制；手机端渲染进 DOM 但 display:none，不影响手机端布局)。
// 工作台里那一堆工具格子在桌面端直接拆开摆进侧边栏(分组，参照 gendan 的做法/图二那个模板)，
// 桌面端不用先进工作台再点格子，跟移动端"格子入口"是两套并存的导航，互不影响。
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
      ["scanlog", "扫菲记录", "scanlog"]
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
      <span class="avatar">${esc((m.name || "").length > 2 ? m.name.slice(-2) : m.name)}</span>
      <div><div class="dsb-foot-name">${esc(m.name)}</div><div class="dsb-foot-role">${esc(roleLabelOf(m))}</div></div>
    </div>
  </nav>`;
}
// 桌面端顶部右上角铃铛按钮(放在居中的 .navbar-in 里，跟标题同一行)
function deskBellBtnHtml() {
  const n = state.notif.unread;
  const m = me();
  return `<button class="dbell" onclick="A.toggleNotifPanel()" aria-label="通知">${icon("bell")}${n ? `<span class="dbell-dot">${n > 99 ? "99+" : n}</span>` : ""}</button>
    <div class="dh-user">
      <span class="avatar sm">${esc((m.name || "").length > 2 ? m.name.slice(-2) : m.name)}</span>
      <span class="dh-uname">${esc(m.name)}</span>
    </div>`;
}
// 通知下拉面板 —— 不能挂在 .navbar-in(居中/限宽)或铃铛按钮下面，那样面板位置会跟着
// 居中容器的宽度走，宽屏下经常对不齐/被裁切。要直接挂在 <header class="navbar"> 下面
// (跟 .navbar-in 平级)：.navbar 是 position:sticky 且没有限宽，绝对定位的面板相对它摆放，
// right:24px 就是稳定贴着"真正可用区域"的右边，不受居中内容宽度影响(跟 gendan 同一个做法)。
function deskNotifOverlayHtml() {
  if (!notifPanelOpen) return "";
  const list = state.notif.list || [];
  return `<div class="dbell-back" onclick="A.toggleNotifPanel()"></div>
    <div class="dbell-panel">
      <div class="dbell-panel-head"><span>通知</span>${list.some(x => !x.read)
        ? `<a href="javascript:void(0)" onclick="event.stopPropagation();A.markAllNotifRead()">全部已读</a>` : ""}</div>
      <div class="dbell-panel-list">${list.length ? list.map(x => notifItemHtml(x, true)).join("")
        : `<div class="empty" style="padding:24px 16px">暂无通知</div>`}</div>
    </div>`;
}
function render() {
  const app = $("app");
  galleryReg = {};                 // 缩略图分组注册表跟着这次渲染重新登记，避免越攒越多
  if (showWelcome) { app.innerHTML = vWelcome(); return; }
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
      <div class="nav-slot">${meta.left || ""}</div>
      <h1 class="nav-title">${esc(meta.title)}</h1>
      <div class="nav-slot right">${deskBellBtnHtml()}</div>
    </div>${deskNotifOverlayHtml()}</header>
    ${tabbarHtml()}
    <main class="page" data-view="${route.v}">${(views[route.v] || vHome)()}</main>`;
}

/* ---------- 登录 ---------- */
function vLogin() {
  const installBtn = (isStandalone() || !isMobileDevice()) ? ""
    : `<button class="btn ghost block install-cta" onclick="A.install()">📲 安装到手机（像 App 一样用）</button>`;
  return `<div class="login-page"><div class="login-inner">
    <div class="login-brand">
      <div class="login-logo">${APP_LOGO}</div>
      <p class="login-company">${esc(COMPANY_NAME)}</p>
      <h1 class="login-title">${esc(APP_NAME)}</h1></div>
    <div class="login-card">
      <label class="lg-field"><span>手机号</span>
        <input id="lg-phone" inputmode="tel" autocomplete="username" placeholder="请输入手机号"></label>
      <label class="lg-field"><span>密码</span>
        <input id="lg-pass" type="password" autocomplete="current-password" placeholder="请输入密码"
          onkeydown="if(event.key==='Enter')A.login()"></label>
    </div>
    <button class="btn block login-btn" onclick="A.login()">登 录</button>
    ${installBtn}
  </div></div>`;
}
function vWelcome() {
  return `<div class="login-page" onclick="A.dismissWelcome()"><div class="login-inner"><div class="login-brand">
    <div class="login-logo">${APP_LOGO}</div>
    <p class="login-company">${esc(COMPANY_NAME)}</p>
    <h1 class="login-title">${esc(APP_NAME)}</h1>
  </div></div></div>`;
}

/* ---------- 工作台 ---------- */
// 工作台桌面端首屏内容：手机端只看到 hero-card + 个人信息卡 + 工具格子(跟以前一样)；
// 桌面端(≥1024px，工具格子被 CSS 隐藏，因为已经拆到侧边栏了)额外看到一排统计卡片，
// 管理员和普通员工看到的统计维度不一样——管理员看全局(在职人数/今日全员完成/本月工资总额)，
// 普通员工看自己的(本月完成度/本月预估工资)，参照 gendan 桌面端统计卡片的样式风格。
function homeStatsHtml() {
  const stat = (label, value, sub, ic) => `<div class="hstat">
    <span class="hstat-ic">${icon(ic)}</span>
    <div class="hstat-main"><div class="hstat-label">${esc(label)}</div>
      <div class="hstat-num num">${esc(String(value))}</div>${sub ? `<div class="hstat-sub">${esc(sub)}</div>` : ""}</div></div>`;
  if (isManager()) {
    const d = state.home.mgr;
    if (!d) return "";
    const recent = (state.notif.list || []).slice(0, 5);
    return `<section class="group home-desk-only">
      <div class="hstat-row">
        ${stat("在职员工", d.staffCount, "", "employees")}
        ${stat("今日全员完成", d.todayQty, "件", "efficiency")}
        ${stat("本月工资总额", "¥" + num(d.monthWage), "预估，含调整项", "payroll")}
      </div>
    </section>
    <section class="group home-desk-only">
      <div class="group-title">最近动态</div>
      <div class="card">${recent.length ? recent.map(x => notifItemHtml(x, false)).join("") : `<div class="empty">暂无动态</div>`}</div>
    </section>`;
  }
  const d = state.home.emp;
  if (!d) return "";
  const eff = d.eff, pay = d.pay;
  return `<section class="group home-desk-only">
    <div class="hstat-row">
      ${stat("本月完成度", eff && eff.percent !== null ? pctText(eff.percent) : "—", "打卡时长 / 出勤时长", "efficiency")}
      ${stat("本月出勤", eff ? num(eff.attendanceHours) : "—", "小时", "attendance")}
      ${stat("本月预估工资", pay ? "¥" + num(pay.total) : "—", "计件 + 餐补/奖金 - 扣罚", "payroll")}
    </div>
  </section>`;
}
function vHome() {
  const m = me();
  const tool = (v, label, ic, badge) => `<button class="tool" onclick="go('${v}')">
    ${icon(ic)}<span>${esc(label)}</span>${badge ? `<span class="badge">${badge}</span>` : ""}</button>`;
  return `<div class="hero-card">
      <div class="hero-num num">${state.home.today}</div>
      <div class="hero-text">今天完成件数，继续加油</div>
    </div>

    <section class="group home-profile-card"><div class="card"><div class="row-item">
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
        ${tool("scanlog", "扫菲记录", "scanlog")}
        ${isManager() ? tool("payroll", "薪资管理", "payroll") : ""}
        ${isManager() ? tool("admin", "管理", "admin") : ""}
      </div>
    </section>`;
}

/* ---------- 打点 ---------- */
// 摄像头扫码只有 Chrome/安卓的 BarcodeDetector 支持，iOS Safari 没有。
// 所以按钮按能力渲染，手输扎号/菲票号永远是可用的兜底路径——车间手机型号杂，不能只留一条路。
const CAN_SCAN = typeof window !== "undefined" && "BarcodeDetector" in window;

function scanBundleHtml() {
  const sc = state.scan, b = sc.bundle;
  return `<section class="group">
    <div class="group-title">扫菲打点</div>
    <div class="card">
      <div class="field row"><span>扎号 / 菲票号</span>
        <input class="in" id="sc-ticket" value="${esc(sc.ticketInput)}" placeholder="扫码或手动输入"
          inputmode="numeric" onchange="A.setTicketInput(this.value)">
        <button class="act-btn" onclick="A.lookupTicket()">查找</button>
        ${CAN_SCAN ? `<button class="act-btn" onclick="A.startCamera()">${sc.camOn ? "关闭摄像头" : "摄像头扫码"}</button>` : ""}</div>
      ${sc.camOn ? `<div class="field"><video id="scan-cam" class="scan-cam" playsinline muted></video>
        <div class="row-sub">把菲票上的二维码对准取景框</div></div>` : ""}
      ${!CAN_SCAN ? `<div class="field"><div class="row-sub">这个浏览器不支持摄像头扫码，请手动输入扎号或菲票号</div></div>` : ""}
    </div>

    ${b ? `<div class="card style-card" style="margin-top:10px">
      <div class="sc-head">
        ${showable(sc.bundleOrder.style_image) ? `<img class="sc-thumb" src="${esc(sc.bundleOrder.style_image)}"
            onclick="A.lightboxOne(this)" alt="款式图">` : `<div class="sc-thumb sc-noimg" aria-hidden="true"></div>`}
        <div class="sc-info">
          <div class="sc-title">扎号 ${b.bundle_no}　菲票 ${b.ticket_no}</div>
          <div class="sc-grid">
            <span class="sc-cell"><span class="sc-k">款号：</span><span class="sc-v">${esc(sc.bundleOrder.style_code || sc.bundleOrder.style_name || "—")}</span></span>
            <span class="sc-cell"><span class="sc-k">床次：</span><span class="sc-v">${sc.bundleOrder.bed_no}</span></span>
            <span class="sc-cell"><span class="sc-k">颜色：</span><span class="sc-v">${esc(b.color || "—")}</span></span>
            <span class="sc-cell"><span class="sc-k">尺码：</span><span class="sc-v">${esc(b.size || "—")}</span></span>
            <span class="sc-cell"><span class="sc-k">件数：</span><span class="sc-v">${num(b.qty)}</span></span>
          </div>
        </div>
      </div>
      <div class="proc-scan">
        ${sc.bundleProcs.map(p => `<div class="row-item">
          <div class="row-main"><div class="row-label">${esc(p.name)}${
            p.show_price && p.unit_price !== null ? ` <span class="row-sub">${num(p.unit_price)}元</span>` : ""}</div>
            <div class="row-sub">已完成 ${num(p.done)} 件，剩余 ${num(p.remaining)} 件</div></div>
          <div class="row-acts">
            ${p.remaining > 0 ? `<input class="in tiny" id="sq-${p.id}" type="number" inputmode="numeric"
                placeholder="${num(p.remaining)}">
              <button class="act-btn" onclick="A.scanBundleSubmit('${p.id}')">打点</button>`
            : `<span class="tag ok">已完成</span>`}
          </div></div>`).join("")}
      </div>
    </div>` : ""}
  </section>`;
}

function vScan() {
  const procs = state.processes || [], styles = state.styles || [], eff = state.scan.eff;
  const recs = state.scan.records;
  const pct = eff && eff.percent !== null && eff.percent !== undefined ? eff.percent : null;
  return scanBundleHtml() + `<section class="group">
    <div class="group-title">自由打点（不按菲票）</div>
    <div class="card">
      <label class="field"><span>日期</span>${dateFieldHtml("sc-date", state.scan.date, "A.setScanDate(this.value)")}</label>
      <label class="field"><span>工序<span class="req">*</span></span>
        ${procs.length ? selectHtml("sc-proc", procs.map(p => [p.id, p.name]), (procs[0] || {}).id)
      : `<div class="row-sub">请先在「工序模板」里添加工序</div>`}</label>
      ${styles.length ? `<label class="field"><span>款式（选填）</span>
        ${selectHtml("sc-style", styles.map(s => [s.id, s.name + (s.code ? " · " + s.code : "")]), "", "", "不选")}</label>` : ""}
      <label class="field"><span>完成数量<span class="req">*</span></span>
        <input class="in" id="sc-qty" type="number" inputmode="decimal" step="any" placeholder="请输入件数"></label>
    </div>
    <div class="btn-row" style="padding-left:0;padding-right:0"><button class="btn block" onclick="A.submitScan()">提交打点</button></div>
  </section>

  <section class="group"><div class="card"><div class="row-item">
    <div class="row-main"><div class="row-label">今日完成度</div>
      <div class="row-sub">出勤 ${eff ? num(eff.attendanceHours) : 0} 小时 · 时效 ${eff ? Math.round((eff.effectiveHours || 0) * 10) / 10 : 0} 小时</div></div>
    ${pct !== null ? `<span class="tag ${pct >= 1 ? "ok" : "warn"}">${pctText(pct)}</span>`
      : `<span class="row-value">暂无考勤数据</span>`}
  </div></div></section>

  <section class="group">
    <div class="group-title">当天打点记录</div>
    <div class="card">${recs === null ? `<div class="empty">加载中…</div>` : recs.length ? recs.map(r => {
        const p = (state.processes || []).find(x => x.id === r.process_id);
        const name = r.process_name || (p ? p.name : "工序");
        // 扫扎产生的记录带扎号/颜色/尺码，自由打点的没有，两种都要能读
        const sub = r.bundle_no
          ? `扎号 ${r.bundle_no}${r.color ? " · " + esc(r.color) : ""}${r.size ? " · " + esc(r.size) : ""}`
          : "自由打点";
        return `<div class="row-item">
          <div class="row-main"><div class="row-label">${esc(name)}<span class="row-sub"> ${sub}</span></div>
            <div class="row-sub num">${num(r.qty)} 件</div></div>
          <div class="row-acts"><button class="act-btn danger" onclick="A.delScan('${r.id}')">删除</button></div></div>`;
      }).join("") : `<div class="empty">这天还没有打点记录</div>`}</div>
  </section>`;
}

/* ---------- 工序模板 ---------- */
function vProcesses() {
  const list = state.processes;
  const totalPrice = num((list || []).reduce((s, p) => s + Number(p.unit_price || 0), 0));
  const f = procForm;
  return `<section class="group"><div class="sum-bar">
      <div class="sum-item"><div class="sum-num num">${(list || []).length}</div><div class="sum-label">工序数量</div></div>
      <div class="sum-item"><div class="sum-num num">${totalPrice}</div><div class="sum-label">单价合计（元）</div></div>
    </div></section>

  <section class="group"><div class="card">
    ${list === null ? `<div class="empty">加载中…</div>` : list.length ? list.map((p, i) => `
      <div class="row-item tap" onclick="A.editProcess('${p.id}')">
        <div class="row-main"><div class="row-label">${i + 1}. ${esc(p.name)}</div>
          <div class="row-sub">标准定额 ${num(p.std_qty)}${esc(p.unit || "")} · 小时定额 ${num(p.hour_quota)}${
    p.unit_price ? ` · 单价 ${num(p.unit_price)}元` : ""}</div></div>
        <div class="row-acts"><button class="act-btn danger" onclick="event.stopPropagation();A.delProcess('${p.id}')">删除</button></div>
      </div>`).join("") : `<div class="empty">还没有工序模板</div>`}
  </div></section>

  <section class="group">
    <div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn ${f ? "ghost" : ""} block" onclick="A.toggleProcessForm()">${f ? "取消" : "新增工序模板"}</button></div>
    ${f ? `<div class="card">
      <label class="field"><span>工序名称<span class="req">*</span></span><input class="in" id="pf-name" value="${esc(f.name)}"></label>
      <label class="field"><span>单位（如：个）</span><input class="in" id="pf-unit" value="${esc(f.unit)}"></label>
      <label class="field"><span>标准定额<span class="req">*</span></span><input class="in" id="pf-std" type="number" inputmode="decimal" step="any" value="${esc(f.stdQty)}"></label>
      <label class="field"><span>小时定额<span class="req">*</span></span><input class="in" id="pf-hour" type="number" inputmode="decimal" step="any" value="${esc(f.hourQuota)}"></label>
      <label class="field"><span>计件单价（元/件，选填，薪资管理要用）</span><input class="in" id="pf-price" type="number" inputmode="decimal" step="any" value="${esc(f.unitPrice)}"></label>
      <div class="btn-row"><button class="btn block" onclick="A.saveProcess()">保存</button></div>
    </div>` : ""}
  </section>`;
}

/* ---------- 款式管理 ---------- */
function styleImages(s) {
  let imgs = [];
  try { imgs = s.images ? JSON.parse(s.images) : []; } catch (e) { imgs = []; }
  if ((!imgs || !imgs.length) && s.image) imgs = [s.image];
  return normalizePhotos(imgs);
}
function vStyles() {
  if (styleForm) return vStyleForm();
  const list = state.styles;
  const kw = (state.styleKw || "").trim().toLowerCase();
  // 搜索放在前端做：款式总量是几十到几百条，一次拉全再本地过滤，比每敲一个字打一次接口跟手
  const shown = list === null ? null : (kw
    ? list.filter(s => `${s.code || ""} ${s.name || ""}`.toLowerCase().includes(kw))
    : list);
  return `<div class="searchbar"><input id="st-kw" placeholder="请输入款号 / 款名" value="${esc(state.styleKw || "")}"
      oninput="A.setStyleKw(this.value)"></div>

  ${shown === null ? `<section class="group"><div class="card"><div class="empty">加载中…</div></div></section>`
      : shown.length ? shown.map(s => {
        const imgs = styleImages(s);
        const cover = imgs.filter(showable)[0];
        const g = regGallery(imgs.filter(showable));
        return `<section class="group"><div class="card style-card">
        <div class="sc-head">
          ${cover ? `<img class="sc-thumb" src="${esc(cover)}" data-gallery="${g}" data-i="0"
              onclick="A.lightboxFromEl(this)" alt="款式图">`
            : `<div class="sc-thumb sc-noimg" aria-hidden="true"></div>`}
          <div class="sc-info">
            <div class="sc-title">款号 ${esc(s.code || "—")}</div>
            <div class="sc-grid">
              <span class="sc-cell"><span class="sc-k">款名：</span><span class="sc-v">${esc(s.name || "—")}</span></span>
              <span class="sc-cell"><span class="sc-k">工序：</span><span class="sc-v">${num(s.process_count || 0)} 道</span></span>
              <span class="sc-cell"><span class="sc-k">工价：</span><span class="sc-v">¥${Number(s.total_price || 0).toFixed(4)}</span></span>
              <span class="sc-cell"><span class="sc-k">是否裁床：</span><span class="sc-v">${s.has_cutting === 0 ? "否" : "是"}</span></span>
            </div>
          </div>
          <button class="sc-del" title="删除款式" aria-label="删除款式"
            onclick="A.delStyle('${s.id}')">${icon("trash")}</button>
        </div>
        <div class="sc-acts">
          <button onclick="A.editStyle('${s.id}')">编辑款式</button>
          <button onclick="go('cutform','${s.id}')">裁床编菲</button>
          <button onclick="go('styleprocs','${s.id}')">修改工序</button>
          <button onclick="A.openSyncProcs('${s.id}')">同步工序</button>
        </div>
      </div></section>`;
      }).join("")
      : `<section class="group"><div class="card"><div class="empty">${kw ? "没有匹配的款式" : "还没有款式"}</div></div></section>`}

  <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn block" onclick="A.newStyle()">新建款式</button></div></section>`;
}

/* ---------- 款式的尺码/颜色/客户选项控件 ----------
 * 原来的做法是一排 chip + 右上角一个裸齿轮图标（点开才能删选项），用户根本找不到，
 * 等于"没有删减功能"。改成：已选项 chip 自带 ×，选项的增删都收进同一个下拉面板里。 */
const OPT_META = {
  size: { label: "款式尺码", listKey: "sizes", multi: true, ph: "搜索 / 选择尺码" },
  color: { label: "款式颜色", listKey: "colors", multi: true, ph: "搜索 / 选择颜色" },
  customer: { label: "客户名称", listKey: "customers", multi: false, ph: "搜索 / 选择客户" }
};
function optSelected(type) {
  if (type === "customer") return styleForm.customer ? [styleForm.customer] : [];
  const map = type === "size" ? styleForm.size : styleForm.color;
  return Object.keys(map).filter((k) => map[k]);
}
function optPickerHtml(type) {
  const meta = OPT_META[type];
  const all = ((state.styleOptions || {})[meta.listKey]) || [];
  const ui = state.optUI[type];
  const sel = optSelected(type);
  const kw = (ui.kw || "").trim();
  const cand = all.filter((v) => !kw || v.toLowerCase().includes(kw.toLowerCase()));
  const exact = all.some((v) => v === kw);
  return `<div class="field optbox${ui.open ? " open" : ""}">
    <span>${esc(meta.label)}${meta.multi ? "（可多选）" : ""}</span>
    <div class="opt-chips">
      ${sel.length ? sel.map((v) => `<span class="chip on">${esc(v)}<button class="chip-x" type="button"
          onclick="event.stopPropagation();A.optRemove('${type}','${encodeURIComponent(v)}')" aria-label="移除${esc(v)}">×</button></span>`).join("")
      : `<span class="row-sub">还没有选${esc(meta.label)}</span>`}
      <button class="chip add" type="button" onclick="A.optOpen('${type}')">＋ 选择</button>
    </div>
    ${ui.open ? `<div class="opt-panel">
      <input class="in opt-search" placeholder="${esc(meta.ph)}" value="${esc(ui.kw)}"
        oninput="A.optSearch('${type}',this.value)" autocomplete="off">
      <div class="opt-list">
        ${cand.length ? cand.map((v) => `<div class="opt-row${sel.includes(v) ? " on" : ""}"
            onclick="A.optToggle('${type}','${encodeURIComponent(v)}')">
            <span class="opt-name">${esc(v)}</span>
            <button class="act-btn danger ghost" type="button"
              onclick="event.stopPropagation();A.optDeleteOption('${type}','${encodeURIComponent(v)}')">删除</button>
          </div>`).join("") : `<div class="empty">没有匹配的${esc(meta.label)}</div>`}
        ${kw && !exact ? `<div class="opt-row create" onclick="A.optCreate('${type}')">＋ 新建「${esc(kw)}」</div>` : ""}
      </div>
      <div class="btn-row"><button class="btn ghost mini block" type="button" onclick="A.optOpen('${type}')">收起</button></div>
    </div>` : ""}
  </div>`;
}

/* ---------- 工序编辑器：款式表单里的「生产工序」段落和款式列表的「修改工序」页共用这一份 ----------
 * 之前那版只有 序号/工序名/工价，而且没有工序模板就完全加不了工序（"请先去工序模板里添加"
 * 是条死路）。现在工序名直接打字就能加，工序模板降级成可选的快捷来源。 */
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
      <tr><th>操作</th><th>序号</th><th>工序名称</th><th>工价价格(元)</th>
        ${cols.map((c) => `<th>${esc(mode === "role" ? peRoleLabel(c) : c)}</th>`).join("")}
        <th>显示价格</th><th>可见岗位</th></tr>
      ${pe.items.length ? pe.items.map((it, i) => `<tr>
        <td><button class="act-btn danger" onclick="A.peDel(${i})">删除</button></td>
        <td class="num">${i + 1}</td>
        <td><input class="in" value="${esc(it.name)}" placeholder="工序名称" onchange="A.peSetName(${i},this.value)"></td>
        <td><div class="stepper">
          <button onclick="A.peStep(${i},-1)" aria-label="减少">−</button>
          <input class="in" type="number" inputmode="decimal" step="any" value="${esc(it.unitPrice)}" onchange="A.peSetPrice(${i},this.value)">
          <button onclick="A.peStep(${i},1)" aria-label="增加">＋</button></div></td>
        ${cols.map((c) => `<td><input class="in pe-sub" type="number" inputmode="decimal" step="any"
          value="${esc((it.prices && it.prices[c] !== undefined && it.prices[c] !== null) ? it.prices[c] : "")}"
          placeholder="${num(it.unitPrice)}"
          onchange="A.${mode === "role" ? "peSetRolePrice" : "peSetSizePrice"}(${i},'${encodeURIComponent(c)}',this.value)"></td>`).join("")}
        <td><button class="sw ${it.showPrice ? "on" : ""}" onclick="A.peToggleShow(${i})"
          aria-label="显示价格" role="switch" aria-checked="${!!it.showPrice}"><i></i></button></td>
        <td><button class="act-btn" onclick="A.pePickRoles(${i})">${
          it.visibleRoles && it.visibleRoles.length ? esc(it.visibleRoles.map(peRoleLabel).join("、")) : "所有岗位可见"}</button></td>
      </tr>`).join("") : `<tr><td colspan="${5 + cols.length + 2}"><div class="empty">还没有工序，点下面「新增工序」直接打字添加</div></td></tr>`}
    </table></div></div>

    <div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn block" onclick="A.peAdd()">＋ 新增工序</button></div>
  </section>`;
}
function vStyleForm() {
  const f = styleForm;
  return `<section class="group">
    <div class="group-title">基础信息</div>
    <div class="card">
      <div class="field"><span>款式图片</span>${photoPicker("style")}</div>
      <label class="field"><span>款号<span class="req">*</span></span>
        <input class="in ${f.err.code ? "bad" : ""}" id="sf-code" value="${esc(f.code)}" placeholder="请输入款号">
        ${f.err.code ? `<div class="field-err">${esc(f.err.code)}</div>` : ""}</label>
      <label class="field"><span>款式名称<span class="req">*</span></span>
        <input class="in ${f.err.name ? "bad" : ""}" id="sf-name" value="${esc(f.name)}" placeholder="请输入款式名称">
        ${f.err.name ? `<div class="field-err">${esc(f.err.name)}</div>` : ""}</label>
      ${optPickerHtml("size")}
      ${optPickerHtml("color")}
      ${optPickerHtml("customer")}
    </div>
  </section>

  <section class="group">
    <div class="group-title">生产工序</div>
    ${procEditorHtml()}
  </section>

  <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn block" onclick="A.saveStyle()">提交</button>
    <button class="btn ghost block" onclick="A.cancelStyle()">取消</button></div></section>`;
}
function vStyleProcs() {
  // go() 切路由后会先同步 render() 一次，这时 loadView 还没跑完，state.pe 可能还是上一个页面
  // 留下的 null（或者上一个款式的数据）——不判空直接调用 procEditorHtml() 会当场报错。
  if (!state.pe || state.pe.styleId !== route.id) return `<section class="group"><div class="empty">加载中…</div></section>`;
  return procEditorHtml() + `<section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn block" onclick="A.peSubmit()">保存</button>
    <button class="btn ghost block" onclick="go('styles')">取消</button></div></section>`;
}

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
    <div class="card">${recs === null ? `<div class="empty">加载中…</div>` : recs.length ? recs.map(r => `
      <div class="row-item"><div class="row-main"><div class="row-label">${esc(fmtDate(r.date))}</div></div>
        <div class="row-value num">${num(r.hours)} 小时</div></div>`).join("")
      : `<div class="empty">这个月还没有考勤记录</div>`}</div>
  </section>`;
}

/* ---------- 效率看板 ---------- */
function vEfficiency() {
  const list = (state.eff.list || []).slice().sort((a, b) =>
    (b.percent === null ? -1 : b.percent) - (a.percent === null ? -1 : a.percent));
  return `<section class="group"><div class="card">
    <label class="field"><span>月份</span>${monthFieldHtml("ef-month", state.eff.month, "A.setEffMonth(this.value)")}</label>
  </div></section>
  <section class="group"><div class="card">
    ${state.eff.list === null ? `<div class="empty">加载中…</div>` : list.length ? list.map(x => `
      <div class="row-item">
        <div class="row-main"><div class="row-label">${esc(x.name)}</div>
          <div class="row-sub">出勤 ${num(x.attendanceHours)} 小时 · 时效 ${Math.round(x.effectiveHours * 10) / 10} 小时</div></div>
        <span class="tag ${x.percent === null ? "role" : x.percent < 1 ? "warn" : "ok"}">${x.percent === null ? "暂无考勤" : pctText(x.percent)}</span>
      </div>`).join("") : `<div class="empty">这个月还没有数据</div>`}
  </div></section>`;
}



/* ---------- 裁床编菲 ----------
 * 矩阵：行=颜色、列=尺码。每格两个输入——件数与扎数。
 * 件数的含义随「倍数模式」变：开=每扎件数；关=该格总件数（后端按扎数平分，余数补最后一扎）。
 * colors/sizes 数组的顺序 = 矩阵行列顺序 = 扎号编号的遍历顺序（尺码→该尺码第几扎→颜色轮转），
 * 所以这里用数组按点选先后维护，不能用集合。
 */
const CF_SWITCHES = [
  ["customNo", "自定义扎号"], ["customVat", "自定义缸号"],
  ["rowCopy", "行复制"], ["colCopy", "列复制"],
  ["multiple", "倍数模式"], ["sameBundles", "每件扎数相同"]
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
// 颜色/尺码的选择：候选来自全局选项池，点一下加进矩阵、再点一下移出
function cfPickRow(kind) {
  const cf = state.cf;
  const all = ((state.styleOptions || {})[kind === "color" ? "colors" : "sizes"]) || [];
  const cur = kind === "color" ? cf.colors : cf.sizes;
  const label = kind === "color" ? "添加颜色" : "添加尺码";
  return `<div class="field"><span>${label}</span>
    <div class="chips">${all.length ? all.map(v => {
      const on = cur.includes(v);
      return `<button type="button" class="chip ${on ? "on" : ""}"
        onclick="A.cfToggleAxis('${kind}','${encodeURIComponent(v)}')">${esc(v)}${on ? "" : " ＋"}</button>`;
    }).join("") : `<span class="row-sub">选项池是空的，先去款式表单里新增${kind === "color" ? "颜色" : "尺码"}</span>`}</div></div>`;
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
        <input class="in" type="number" inputmode="numeric" placeholder="${cf.multiple ? "每扎件数" : "件数"}"
          value="${esc(cfCell(c, z).input)}"
          onchange="A.cfSetCell('${encodeURIComponent(c)}','${encodeURIComponent(z)}','input',this.value)">
        <input class="in" type="number" inputmode="numeric" placeholder="扎数"
          value="${esc(cfCell(c, z).bundles)}" ${cf.sameBundles ? "disabled" : ""}
          onchange="A.cfSetCell('${encodeURIComponent(c)}','${encodeURIComponent(z)}','bundles',this.value)">
      </div></td>`).join("")}
      <td class="num">${num(cf.sizes.reduce((t, z) => t + cfCellTotal(c, z), 0))}</td></tr>`).join("")}
    <tr><th class="mx-head">合计</th>${cf.sizes.map(z => `<td class="num">${num(sizeTotal(z))}</td>`).join("")}
      <td class="num">${num(grand)}</td></tr>
  </table></div>
  <div class="mx-sum">总扎数：<b class="num">${num(cfBundleCount())}</b>　总数：<b class="num">${num(grand)}</b></div>`;
}
function vCutForm() {
  const cf = state.cf;
  if (!cf) return `<div class="empty">加载中…</div>`;
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
        ${f("客户", "customer", "请输入客户")}
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


/* ---------- 查看裁床单 ----------
 * 两张表：裁床汇总表（颜色×尺码的件数矩阵）和裁床编菲表（每一扎的扎号+件数）。
 * 编菲表按尺码分组，每组两列「扎号 / 数量」，跟纸质表的读法一致。
 */
function vCutView() {
  const d = state.cv;
  if (!d) return `<div class="empty">加载中…</div>`;
  const { order: o, bundles, processes, summary: sm } = d;

  // 编菲表：先按 (颜色,尺码) 把扎归堆，同一格里可能有好几扎，列数取最多的那一格
  const byCell = {};
  bundles.forEach(b => (byCell[b.color + "|" + b.size] || (byCell[b.color + "|" + b.size] = [])).push(b));
  const maxPer = Math.max(1, ...Object.values(byCell).map(a => a.length));

  return `<section class="group"><div class="card style-card">
      <div class="sc-head">
        ${showable(o.style_image) ? `<img class="sc-thumb" src="${esc(o.style_image)}"
            onclick="A.lightboxOne(this)" alt="款式图">`
      : `<div class="sc-thumb sc-noimg" aria-hidden="true"></div>`}
        <div class="sc-info">
          <div class="sc-title">款号 ${esc(o.style_code || o.style_name || "—")}</div>
          <div class="sc-grid">
            <span class="sc-cell"><span class="sc-k">款名：</span><span class="sc-v">${esc(o.style_name || "—")}</span></span>
            <span class="sc-cell"><span class="sc-k">床次：</span><span class="sc-v">${o.bed_no}</span></span>
            <span class="sc-cell"><span class="sc-k">总扎数：</span><span class="sc-v">${num(o.total_bundles)}</span></span>
            <span class="sc-cell"><span class="sc-k">总件数：</span><span class="sc-v">${num(o.total_qty)}</span></span>
            <span class="sc-cell sc-dates"><span class="sc-k">裁床</span><span class="sc-v">${esc(o.cut_date || "—")}</span>
              <span class="sc-arrow">→</span><span class="sc-k">交货</span><span class="sc-v">${esc(o.ship_date || "—")}</span></span>
          </div>
        </div>
      </div>
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
    </div></section>`;
}



/* ---------- 打印菲票 ----------
 * 份数 / 旋转180° / 逐个备注 / 公司名称 / 菲票备注 都是纯前端渲染参数，不进请求；
 * 只有扎号范围和任选扎号会传给后端（它要按范围取扎并生成二维码）。
 * 「打印机」这一项在网页端换成「纸张模板」——浏览器不能枚举/指定打印机，
 * 打印机由系统打印对话框选，这是 Web 的硬限制，不是功能缺失。
 */
const PRINT_TEMPLATES = [["label60x40", "标签 60×40mm"], ["label80x60", "标签 80×60mm"], ["a4grid", "A4 一页多张"]];
function vCutPrint() {
  const cp = state.cp;
  if (!cp) return `<div class="empty">加载中…</div>`;
  const o = cp.order;
  return `<section class="group"><div class="card">
      <div class="row-item"><div class="row-main">
        <div class="row-label">${esc(o.style_code || o.style_name || "—")} · 床次${o.bed_no}</div>
        <div class="row-sub">共 ${num(cp.bundleCount)} 张菲票，扎号 ${cp.from} ~ ${cp.to}</div>
      </div></div>
    </div></section>

    <section class="group"><div class="card">
      <div class="field row"><span>打印扎号<span class="req">*</span></span>
        <input class="in tiny" type="number" inputmode="numeric" value="${esc(cp.from)}"
          ${cp.usePicks ? "disabled" : ""} onchange="A.cpSet('from',this.value)">
        <span class="range-sep">—</span>
        <input class="in tiny" type="number" inputmode="numeric" value="${esc(cp.to)}"
          ${cp.usePicks ? "disabled" : ""} onchange="A.cpSet('to',this.value)"></div>

      <div class="field"><label class="chkline">
        <input type="checkbox" ${cp.usePicks ? "checked" : ""} onchange="A.cpToggle('usePicks')">
        <span>任选扎号打印</span></label>
        ${cp.usePicks ? `<input class="in" value="${esc(cp.picks)}" placeholder="用逗号分隔，例如 1,4,7"
          onchange="A.cpSet('picks',this.value)">` : ""}</div>

      <div class="field row"><span>打印份数<span class="req">*</span></span>
        <div class="stepper">
          <button onclick="A.cpStep(-1)" aria-label="减少">−</button>
          <input class="in" type="number" inputmode="numeric" value="${esc(cp.copies)}" onchange="A.cpSet('copies',this.value)">
          <button onclick="A.cpStep(1)" aria-label="增加">＋</button></div></div>

      <label class="field"><span>纸张模板<span class="req">*</span></span>
        ${selectHtml("cp-tpl", PRINT_TEMPLATES, cp.template, "A.cpSet('template',this.value)")}
        <div class="row-sub">打印机由系统打印对话框选择，网页无法指定打印机</div></label>

      <label class="field"><span>菲票备注</span>
        <input class="in" value="${esc(cp.note)}" placeholder="会印在每张票上" onchange="A.cpSet('note',this.value)"></label>
      <label class="field"><span>公司名称</span>
        <input class="in" value="${esc(cp.companyName)}" onchange="A.cpSet('companyName',this.value)"></label>

      <div class="field"><label class="chkline">
        <input type="checkbox" ${cp.rotate ? "checked" : ""} onchange="A.cpToggle('rotate')">
        <span>打印方向旋转 180°</span></label></div>
      <div class="field"><label class="chkline">
        <input type="checkbox" ${cp.perNote ? "checked" : ""} onchange="A.cpToggle('perNote')">
        <span>逐个备注打印（用每一扎自己的备注）</span></label></div>
    </div></section>

    <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn block" onclick="A.doPrint()">打印</button></div></section>`;
}

/* ---------- 生产进度（按扎） ----------
 * 两个容易混的口径，这里都要显示，不能互相顶替：
 *   已完成数   = 该扎各道工序完成件数的**最小值**（所有工序都过了的件数）
 *   进度百分比 = 已整扎做完的**工序数** / 工序总数
 */
function vCutProgress() {
  const d = state.pg;
  if (!d) return `<div class="empty">加载中…</div>`;
  const o = d.order, procs = d.processes;
  const kw = (state.pgKw || "").trim();
  const list = kw ? d.bundles.filter(b => String(b.bundle_no).includes(kw) || String(b.ticket_no).includes(kw)) : d.bundles;
  const pct = o.total_qty > 0 ? Math.round((d.completed_qty / o.total_qty) * 100) : 0;
  return `<section class="group"><div class="card style-card">
      <div class="sc-head">
        ${showable(o.style_image) ? `<img class="sc-thumb" src="${esc(o.style_image)}"
            onclick="A.lightboxOne(this)" alt="款式图">`
      : `<div class="sc-thumb sc-noimg" aria-hidden="true"></div>`}
        <div class="sc-info">
        <div class="sc-title">款号 ${esc(o.style_code || o.style_name || "—")}</div>
        <div class="sc-grid">
          <span class="sc-cell"><span class="sc-k">床次：</span><span class="sc-v">${o.bed_no}</span></span>
          <span class="sc-cell"><span class="sc-k">件数：</span><span class="sc-v">${num(o.total_qty)}</span></span>
          <span class="sc-cell"><span class="sc-k">客户：</span><span class="sc-v">${esc(o.customer || "—")}</span></span>
          <span class="sc-cell"><span class="sc-k">工序：</span><span class="sc-v">${procs.length} 道</span></span>
          <span class="sc-cell sc-dates"><span class="sc-k">裁床</span><span class="sc-v">${esc(o.cut_date || "—")}</span>
            <span class="sc-arrow">→</span><span class="sc-k">交货</span><span class="sc-v">${esc(o.ship_date || "—")}</span></span>
        </div>
        </div>
      </div>
      <div class="cc-prog">
        <span class="cc-prog-t">已完成件数 ${num(d.completed_qty)}</span>
        <div class="pbar"><i style="width:${pct}%"></i></div><span class="cc-pct num">${pct}%</span></div>
    </div></section>

    <section class="group"><div class="card">
      <button class="row-item tap w-row" onclick="go('procprogress','${o.id}')">
        <div class="row-main"><div class="row-label">查看工序进展</div>
          <div class="row-sub">每道工序做了多少、还剩多少，按颜色尺码分解</div></div>
        <span class="chev">›</span></button>
    </div></section>

    <section class="group">
      <div class="group-title">每扎进展</div>
      <div class="searchbar"><input id="pg-kw" placeholder="请输入扎号 / 菲票号" value="${esc(state.pgKw)}"
        oninput="A.setPgKw(this.value)"></div>
      ${list.length ? list.map(b => `<div class="card bundle-card">
        <button class="row-item tap w-row" onclick="go('bundleprogress','${b.id}')">
          <div class="row-main">
            <div class="row-label">扎号：${b.bundle_no}</div>
            <div class="sc-grid" style="margin-top:4px">
              <span class="sc-cell"><span class="sc-k">菲票ID：</span><span class="sc-v">${b.ticket_no}</span></span>
              <span class="sc-cell"><span class="sc-k">颜色：</span><span class="sc-v">${esc(b.color || "—")}</span></span>
              <span class="sc-cell"><span class="sc-k">件数：</span><span class="sc-v">${num(b.qty)}</span></span>
              <span class="sc-cell"><span class="sc-k">尺码：</span><span class="sc-v">${esc(b.size || "—")}</span></span>
            </div>
            <div class="cc-prog" style="padding:8px 0 0">
              <span class="cc-prog-t">已完成数 ${num(b.done)}</span>
              <div class="pbar"><i style="width:${b.percent}%"></i></div>
              <span class="cc-pct">${procs.filter(p => (b.perProcess || {})[p.id] >= b.qty).length}/${procs.length} 道</span></div>
          </div><span class="chev">›</span></button>
        ${isManager() ? `<div class="qty-edit-row">
          <button class="act-btn" onclick="A.editBundleQty('${b.id}',${b.qty})">修改裁床件数</button></div>` : ""}
      </div>`).join("") : `<div class="card"><div class="empty">${kw ? "没有匹配的扎号" : "这张单还没有菲票"}</div></div>`}
    </section>`;
}

/* ---------- 生产进度详情：一扎的每道工序 ---------- */
function vBundleProgress() {
  const d = state.bp;
  if (!d) return `<div class="empty">加载中…</div>`;
  const b = d.bundle, o = d.order, procs = d.processes;
  const doneProcs = procs.filter(p => p.done >= b.qty).length;
  const pct = procs.length ? Math.round((doneProcs / procs.length) * 100) : 0;
  return `<section class="group"><div class="card">
      <div class="row-item"><div class="row-main">
        <div class="row-label">扎号：${b.bundle_no}</div>
        <div class="sc-grid" style="margin-top:6px">
          <span class="sc-cell"><span class="sc-k">菲票号：</span><span class="sc-v">${b.ticket_no}</span></span>
          <span class="sc-cell"><span class="sc-k">颜色：</span><span class="sc-v">${esc(b.color || "—")}</span></span>
          <span class="sc-cell"><span class="sc-k">件数：</span><span class="sc-v">${num(b.qty)}</span></span>
          <span class="sc-cell"><span class="sc-k">尺码：</span><span class="sc-v">${esc(b.size || "—")}</span></span>
        </div>
        <div class="cc-prog" style="padding:10px 0 0">
          <span class="cc-prog-t">已完成工序数 ${doneProcs} / ${procs.length}</span>
          <div class="pbar"><i style="width:${pct}%"></i></div><span class="cc-pct num">${pct}%</span></div>
      </div></div>
    </div></section>

    <section class="group">
      <div class="group-title">每道工序进展</div>
      <div class="card">
        ${isManager() ? `<div class="qty-edit-row">
          <button class="act-btn" onclick="A.editBundleQty('${b.id}',${b.qty})">修改裁床件数</button></div>` : ""}
        ${procs.map(p => `<div class="row-item">
          <div class="row-main"><div class="row-label">${esc(p.name)}</div>
            <div class="pbar" style="margin-top:6px"><i style="width:${b.qty > 0 ? Math.round(p.done / b.qty * 100) : 0}%"></i></div></div>
          <div class="row-value">已完成${num(p.done)}件，剩余${num(p.remaining)}件</div>
        </div>`).join("")}
      </div>
      <div class="btn-row" style="padding-left:0;padding-right:0">
        <button class="btn ghost block" onclick="go('cutprogress','${o.id}')">返回该单进度</button></div>
    </section>`;
}

/* ---------- 工序进展：每道工序 + 颜色尺码分解 ---------- */
function vProcProgress() {
  const d = state.pr;
  if (!d) return `<div class="empty">加载中…</div>`;
  return d.processes.length ? d.processes.map(p => `<section class="group">
      <div class="group-title">${esc(p.name)}</div>
      <div class="card">
        <div class="ring-wrap">
          <div class="ring" style="--p:${p.percent}"><span>${p.percent}%</span></div>
          <div class="ring-nums">
            <div class="rn"><div class="rn-v num">${num(p.total)}</div><div class="rn-l">工序总数</div></div>
            <div class="rn"><div class="rn-v num">${num(p.done)}</div><div class="rn-l">完成</div></div>
            <div class="rn"><div class="rn-v num">${num(p.remaining)}</div><div class="rn-l">余数</div></div>
          </div>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <tr><th>颜色</th><th>尺寸</th><th>工序总数</th><th>完成</th><th>余数</th></tr>
          ${p.breakdown.map(x => `<tr><td>${esc(x.color)}</td><td>${esc(x.size)}</td>
            <td class="num">${num(x.total)}</td><td class="num">${num(x.done)}</td><td class="num">${num(x.remaining)}</td></tr>`).join("")}
        </table></div>
      </div>
    </section>`).join("") : `<section class="group"><div class="card"><div class="empty">这张单还没有工序</div></div></section>`;
}

/* ---------- 生产管理 ----------
 * 概览卡（今日/昨日/本月已完成 + 当前生产中件数）+ 生产明细（按裁床单看 / 按款看）。
 * 已完成件数按"这段时间打点了多少件"算，跟单张单的完工口径不是一回事：
 * 前者是车间关心的日产出，后者是"这一扎所有工序都过了"才算数。
 */
function vCutOrders() {
  const co = state.co;
  const ov = co.overview || { completed: 0, inProduction: 0 };
  const rangeBtn = (k, t) => `<button class="${co.range === k ? "on" : ""}" onclick="A.setCoRange('${k}')">${t}</button>`;
  const list = co.list, byStyle = co.byStyle;
  const totalQty = (list || []).reduce((n, o) => n + Number(o.total_qty || 0), 0);
  const doneQty = (list || []).reduce((n, o) => n + Number(o.completed_qty || 0), 0);

  const orderCard = (o) => {
    const pct = o.total_qty > 0 ? Math.round((o.completed_qty / o.total_qty) * 100) : 0;
    return `<section class="group"><div class="card cut-card">
      <div class="cc-head tap" onclick="go('cutprogress','${o.id}')">
        ${showable(o.style_image) ? `<img class="sc-thumb" src="${esc(o.style_image)}" alt="款式图">`
        : `<div class="sc-thumb sc-noimg" aria-hidden="true"></div>`}
        <div class="sc-info">
          <div class="sc-title">款号：${esc(o.style_code || o.style_name || "—")}</div>
          <div class="sc-grid">
            <span class="sc-cell"><span class="sc-k">床次：</span><span class="sc-v">${o.bed_no}</span></span>
            <span class="sc-cell"><span class="sc-k">件数：</span><span class="sc-v">${num(o.total_qty)}</span></span>
            <span class="sc-cell"><span class="sc-k">类型：</span><span class="sc-v">${o.source === "self" ? "自建" : esc(o.source)}</span></span>
            <span class="sc-cell sc-dates"><span class="sc-k">裁床</span><span class="sc-v">${esc(o.cut_date || "—")}</span>
              <span class="sc-arrow">→</span><span class="sc-k">交货</span><span class="sc-v">${esc(o.ship_date || "—")}</span></span>
          </div>
        </div>
        <span class="chev">›</span>
      </div>
      <div class="cc-prog"><span class="cc-prog-t">已完成件数 ${num(o.completed_qty)}</span>
        <div class="pbar"><i style="width:${pct}%"></i></div><span class="cc-pct num">${pct}%</span></div>
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
      <div class="searchbar"><input id="co-kw" placeholder="请输入款号 / 床次" value="${esc(co.kw)}"
        oninput="A.setCoKw(this.value)"></div>
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
      ${list === null ? `<section class="group"><div class="card"><div class="empty">加载中…</div></div></section>`
      : list.length ? list.map(orderCard).join("")
        : `<section class="group"><div class="card"><div class="empty">还没有裁床单，去「款式管理」里点「裁床编菲」新建</div></div></section>`}`
    : `<section class="group"><div class="card">
        ${byStyle === null ? `<div class="empty">加载中…</div>` : byStyle.length ? byStyle.map(x => `
          <div class="row-item">
            <div class="row-main"><div class="row-label">${esc(x.style_code || x.style_name)}</div>
              <div class="row-sub">${esc(x.style_name || "")} · ${x.sheet_count} 张裁床单</div></div>
            <div class="row-value num">${num(x.completed_qty)} / ${num(x.total_qty)}</div>
          </div>`).join("") : `<div class="empty">暂无数据</div>`}
      </div></section>`}`;
}

/* ---------- 扫菲记录 ---------- */
function vScanlog() {
  const recs = state.slog.records;
  return `<section class="group"><div class="card">
    <label class="field"><span>日期</span>${dateFieldHtml("sl-date", state.slog.date, "A.setSlogDate(this.value)")}</label>
  </div></section>
  <section class="group"><div class="card">
    ${recs === null ? `<div class="empty">加载中…</div>` : recs.length ? recs.map(r => `
      <div class="row-item"><div class="row-main"><div class="row-label">${esc(r.user_name)}</div>
        <div class="row-sub">${esc(r.process_name)} · ${num(r.qty)} 件</div></div></div>`).join("")
      : `<div class="empty">这天还没有打点记录</div>`}
  </div></section>`;
}

/* ---------- 管理（员工账号 + 新增员工，仅管理员/主管可见） ---------- */
function vAdmin() {
  if (!isManager()) return `<div class="card"><div class="empty">仅管理员或主管可访问</div></div>`;
  const kw = state.empKw.trim();
  const all = staffUsers();
  const matched = kw ? all.filter(u => (u.name || "").includes(kw)) : all;
  // 分页：每页 10 个。搜索关键词变化时会重置回第 1 页；筛完变短了也把页码收回有效范围
  const pages = Math.max(1, Math.ceil(matched.length / EMP_PAGE_SIZE));
  const page = Math.min(Math.max(1, state.empPage), pages);
  const users = matched.slice((page - 1) * EMP_PAGE_SIZE, page * EMP_PAGE_SIZE);
  const roles = state.roles || [];
  return `<section class="group">
    <div class="group-title">员工账号${state.users ? ` · 共 ${all.length} 人${kw ? `（匹配 ${matched.length} 人）` : ""}` : ""}</div>
    <div class="searchbar"><input id="emp-kw" placeholder="搜索姓名" value="${esc(state.empKw)}" oninput="A.setEmpKw(this.value)"></div>
    <div class="card"><div class="tbl-wrap"><table class="tbl">
      <tr><th>姓名</th><th>手机号</th><th>岗位</th><th>操作</th></tr>
      ${state.users === null ? `<tr><td colspan="4"><div class="empty">加载中…</div></td></tr>`
      : users.length ? users.map(u => `<tr>
        <td style="white-space:nowrap">${esc(u.name)}${u.id === me().id ? ` <span class="tag">我</span>` : ""}</td>
        <td class="num">${esc(u.phone)}</td>
        <td>${selectHtml("role-" + u.id, roles.map(r => [r.k, r.label]), u.role, `A.changeRole('${u.id}',this.value)`)}</td>
        <td style="white-space:nowrap">
          <button class="act-btn" onclick="A.editUser('${u.id}')">编辑</button>
          <button class="act-btn ghost" style="margin-left:6px" onclick="A.resetPw('${u.id}')">重置密码</button>
          <button class="act-btn danger" style="margin-left:6px" onclick="A.delUser('${u.id}')">离职</button></td></tr>`).join("")
        : `<tr><td colspan="4"><div class="empty">${kw ? "没有匹配的员工" : "还没有员工"}</div></td></tr>`}
    </table></div></div>
    ${pages > 1 ? `<div class="pager">
      <button class="act-btn ghost" ${page <= 1 ? "disabled" : ""} onclick="A.setEmpPage(${page - 1})">上一页</button>
      <span class="pager-info num">第 ${page} / ${pages} 页</span>
      <button class="act-btn ghost" ${page >= pages ? "disabled" : ""} onclick="A.setEmpPage(${page + 1})">下一页</button>
    </div>` : ""}
  </section>

  <section class="group">
    <div class="group-title">新增员工</div>
    <div class="card">
      <label class="field"><span>姓名<span class="req">*</span></span><input class="in" id="nu-name"></label>
      <label class="field"><span>手机号<span class="req">*</span></span><input class="in" id="nu-phone" inputmode="tel"></label>
      <label class="field"><span>岗位</span>${selectHtml("nu-role", roles.map(r => [r.k, r.label]), "worker")}</label>
      <label class="field"><span>初始密码</span><input class="in" id="nu-pass" value="123456"></label>
      <div class="btn-row"><button class="btn" onclick="A.addUser()">创建账号</button></div>
    </div>
  </section>`;
}

/* ---------- 薪资管理（工作台入口，仅管理员/主管可见） ---------- */
function vPayroll() {
  if (!isManager()) return `<div class="card"><div class="empty">仅管理员或主管可访问</div></div>`;
  return `<section class="group"><div class="card">
    <label class="field"><span>月份</span>${monthFieldHtml("pay-month", state.pay.month, "A.setPayMonth(this.value)")}</label>
  </div></section>

  <section class="group"><div class="card">${state.pay.list === null ? `<div class="empty">加载中…</div>`
      : state.pay.list.length ? state.pay.list.map(it => `
      <div class="row-item tap" onclick="A.editPay('${it.userId}')">
        <div class="row-main"><div class="row-label">${esc(it.name)}</div>
          <div class="row-sub num">计件 ${num(it.pieceWage)} · 餐补 ${num(it.mealSubsidy)} · 扣罚 ${num(it.penalty)} · 奖金 ${num(it.bonus)}</div></div>
        <span class="tag hl num">${num(it.total)} 元</span>
      </div>
      ${state.pay.editing === it.userId ? `<div class="card-pad" style="background:var(--bg)">
        <label class="field" style="background:none;padding-left:0;padding-right:0"><span>餐补</span>
          <input class="in" id="pa-meal" type="number" inputmode="decimal" step="any" value="${esc(it.mealSubsidy || "")}"></label>
        <label class="field" style="background:none;padding-left:0;padding-right:0"><span>扣罚</span>
          <input class="in" id="pa-pen" type="number" inputmode="decimal" step="any" value="${esc(it.penalty || "")}"></label>
        <label class="field" style="background:none;padding-left:0;padding-right:0;border:0"><span>奖金</span>
          <input class="in" id="pa-bonus" type="number" inputmode="decimal" step="any" value="${esc(it.bonus || "")}"></label>
        <button class="btn block" style="margin-top:12px" onclick="A.savePay('${it.userId}')">保存</button>
      </div>` : ""}`).join("") : `<div class="empty">这个月还没有数据</div>`}</div>
  </section>`;
}

/* ---------- 我的 ---------- */
// 手机端消息通知整页列表(桌面端等价功能是顶部铃铛下拉，见 deskBellHtml())
function vNotifs() {
  const list = state.notif.list || [];
  return `<section class="group">
    <div class="card-pad" style="display:flex;justify-content:flex-end">${list.some(x => !x.read)
      ? `<a href="javascript:void(0)" onclick="A.markAllNotifRead()">全部已读</a>` : ""}</div>
    <div class="card">${list.length ? list.map(x => notifItemHtml(x, false)).join("") : `<div class="empty">暂无通知</div>`}</div>
  </section>`;
}
function vMine() {
  const m = me(), p = state.pay.mine;
  const nm = m.name || "";
  return `<section class="group"><div class="card"><div class="card-pad" style="display:flex;align-items:center;gap:14px">
      <span class="avatar">${esc(nm.length > 2 ? nm.slice(-2) : nm)}</span>
      <div><div style="font-size:19px;font-weight:600">${esc(nm)}</div>
        <div class="row-sub">${esc(COMPANY_NAME)}</div></div>
    </div></div></section>

  <section class="group"><div class="card">
    <div class="row-item"><div class="row-main"><div class="row-label">职位</div></div><div class="row-value">${esc(roleLabelOf(m))}</div></div>
    <div class="row-item"><div class="row-main"><div class="row-label">手机</div></div><div class="row-value num">${esc(m.phone)}</div></div>
    <div class="row-item" style="cursor:pointer" onclick="go('notifs')"><div class="row-main"><div class="row-label">消息通知</div></div>
      <div class="row-value" style="display:flex;align-items:center;gap:6px">${state.notif.unread ? `<span class="badge">${state.notif.unread > 99 ? "99+" : state.notif.unread}</span>` : ""}<span class="chev">›</span></div></div>
  </div></section>

  <section class="group">
    <div class="group-title">修改密码</div>
    <div class="card">
      <label class="field"><span>新密码</span><input class="in" type="password" id="my-p1" autocomplete="new-password"></label>
      <label class="field"><span>确认新密码</span><input class="in" type="password" id="my-p2" autocomplete="new-password"
        onkeydown="if(event.key==='Enter')A.changeMyPw()"></label>
      <div class="btn-row"><button class="btn" onclick="A.changeMyPw()">确认修改</button></div>
    </div>
  </section>

  ${isManager() ? "" : `<section class="group">
    <div class="group-title">我的薪资</div>
    <div class="card">
      <label class="field"><span>月份</span>${monthFieldHtml("my-month", state.pay.month, "A.setMyPayMonth(this.value)")}</label>
    </div>
    <div class="card" style="margin-top:10px">${p ? `
      <div class="row-item"><div class="row-main"><div class="row-label">计件工资</div></div><div class="row-value num">${num(p.pieceWage)} 元</div></div>
      <div class="row-item"><div class="row-main"><div class="row-label">餐补</div></div><div class="row-value num">${num(p.mealSubsidy)} 元</div></div>
      <div class="row-item"><div class="row-main"><div class="row-label">扣罚</div></div><div class="row-value num">${num(p.penalty)} 元</div></div>
      <div class="row-item"><div class="row-main"><div class="row-label">奖金</div></div><div class="row-value num">${num(p.bonus)} 元</div></div>
      <div class="row-item"><div class="row-main"><div class="row-label">合计</div></div><span class="tag hl num">${num(p.total)} 元</span></div>`
      : `<div class="empty">加载中…</div>`}</div>
  </section>`}

  <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    ${(isStandalone() || !isMobileDevice()) ? "" : `<button class="btn ghost block" style="margin-bottom:10px" onclick="A.install()">📲 安装到手机</button>`}
    <button class="btn danger ghost block" onclick="A.logout()">退出登录</button>
  </div></section>`;
}

/* ================= 动作 ================= */
const A = {
  /* ---- 弹窗 ---- */
  modalOk() {
    const st = modalState; if (!st) return;
    const v = st.input ? ($("m-input") ? $("m-input").value : "") : null;
    if (st.onOk) { const keep = st.onOk(v); if (keep === false) return; }
    modalState = null; renderModal();
  },
  modalCancel() { modalState = null; renderModal(); },

  /* ---- 图片 ---- */
  async addDraftPhotos(ctx, input) {
    const files = [...(input.files || [])]; input.value = "";
    if (!files.length) return;
    photoDraft[ctx] = photoDraft[ctx] || [];
    let ok = 0, fail = 0;
    for (let k = 0; k < files.length; k++) {
      toast(`处理照片 ${k + 1}/${files.length}…`, true);
      const uri = await compressImage(files[k]);
      if (!uri) { fail++; continue; }
      const used = photoDraft[ctx].reduce((s, u) => s + u.length, 0);
      if (used + uri.length > IMG_LIMIT) { toast("图片总量超出上限，请先保存或删掉几张"); break; }
      photoDraft[ctx].push(uri); ok++;
    }
    const el = $("pe-" + ctx); if (el) el.innerHTML = pickerInner(ctx);
    toast(fail ? `已添加 ${ok} 张，${fail} 张失败` : `已添加 ${ok} 张`);
  },
  removeDraftPhoto(ctx, i) {
    if (photoDraft[ctx]) { photoDraft[ctx].splice(i, 1); const el = $("pe-" + ctx); if (el) el.innerHTML = pickerInner(ctx); }
  },
  lightboxFromEl(el) {
    const g = galleryReg[el.getAttribute("data-gallery")] || [];
    if (!g.length) return;
    lightbox = { photos: g, i: +el.getAttribute("data-i") || 0 }; renderLightbox();
  },
  lbStep(d) {
    if (!lightbox) return;
    const n = lightbox.photos.length;
    lightbox.i = (lightbox.i + d + n) % n; renderLightbox();
  },
  closeLightbox() { lightbox = null; renderLightbox(); },

  /* ---- 登录 ---- */
  async login() {
    const phone = val("lg-phone"), pass = ($("lg-pass") || {}).value || "";
    if (!phone || !pass) return toast("请填写手机号和密码");
    try {
      const r = await api("POST", "/login", { phone, password: pass });
      await A.enter(r.token, r.user);
    } catch (e) {
      if (showWelcome) { showWelcome = false; render(); }
      toast((e && e.error) || "登录失败");
    }
  },
  async enter(token, user) {
    state.token = token; state.me = user;
    localStorage.setItem(TOKEN_KEY, token);
    showWelcome = true; render();           // 密码验证通过就先顶上欢迎界面，不用等数据回来
    route = { v: "home", id: null };
    await Promise.all([loadView("home").catch(() => { }), new Promise(r => setTimeout(r, 1200))]);
    showWelcome = false; render();
    startNotifPoll();
  },
  dismissWelcome() { if (!showWelcome) return; showWelcome = false; render(); },

  /* ---- 应用内通知(桌面端顶部铃嘴面板) ---- */
  async toggleNotifPanel() {
    notifPanelOpen = !notifPanelOpen;
    if (notifPanelOpen) {
      try { state.notif.list = (await api("GET", "/notifications")).list || []; } catch (e) { }
    }
    render();
  },
  async openNotif(id, link) {
    notifPanelOpen = false;
    try {
      await api("POST", `/notifications/${id}/read`);
      const item = (state.notif.list || []).find(x => x.id === id);
      if (item && !item.read) { item.read = true; state.notif.unread = Math.max(0, state.notif.unread - 1); }
    } catch (e) { }
    if (link) go(link.replace(/^\//, "")); else render();
  },
  async markAllNotifRead() {
    try {
      await api("POST", "/notifications/read-all");
      (state.notif.list || []).forEach(x => x.read = true);
      state.notif.unread = 0;
    } catch (e) { }
    render();
  },
  logout() {
    modal({
      title: "退出登录？", body: "下次需要重新输入手机号和密码。", danger: true, okText: "退出",
      onOk: () => A.forceLogout()
    });
  },
  // 登录状态不过期：只有这里（主动退出）和后端返回 401 时才会清掉本地 token
  forceLogout() {
    stopNotifPoll();
    state.token = null; state.me = null;
    // 把上一个账号的数据一并清掉，换账号登录时不会先闪一下别人的数据
    state.users = state.roles = state.processes = state.styles = state.styleOptions = null;
    state.home = { today: 0 };
    state.notif = { unread: 0, list: null };
    state.scan.records = state.scan.eff = null;
    state.att.userId = ""; state.att.records = null;
    state.eff.list = null; state.slog.records = null;
    state.pay.list = state.pay.mine = null; state.pay.editing = "";
    styleForm = procForm = null; photoDraft = {};
    localStorage.removeItem(TOKEN_KEY);
    route = { v: "home", id: null }; render();
  },

  /* ---- 安装到主屏 ---- */
  async install() {
    if (isStandalone()) return toast("已经是从主屏打开的了");
    if (deferredInstall) {                      // 安卓 / 桌面 Chrome：直接弹系统安装框
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (e) { }
      deferredInstall = null;
      return;
    }
    A.installGuide();                           // iOS 等：给图文步骤
  },
  installGuide() {
    const ua = navigator.userAgent || "";
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isWeixin = /MicroMessenger/i.test(ua);
    let steps;
    if (isWeixin) {
      steps = `<div class="guide-step"><b>1.</b> 点右上角 <b>···</b> 菜单</div>
        <div class="guide-step"><b>2.</b> 选「在浏览器打开」（Safari 或 手机自带浏览器）</div>
        <div class="guide-step"><b>3.</b> 再按下面的步骤添加到主屏</div>
        <div class="guide-note">微信内置浏览器不能直接装，要先用系统浏览器打开</div>`;
    } else if (isIOS) {
      steps = `<div class="guide-step"><b>1.</b> 点底部中间的 <span class="ios-share"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7"/></svg></span> 分享按钮（方框加向上箭头）</div>
        <div class="guide-step"><b>2.</b> 在菜单里找到 <b>「添加到主屏幕」</b></div>
        <div class="guide-step"><b>3.</b> 右上角点「添加」，桌面就出现图标了</div>`;
    } else {
      steps = `<div class="guide-step"><b>1.</b> 点浏览器右上角 <b>⋮</b> 菜单</div>
        <div class="guide-step"><b>2.</b> 选 <b>「安装应用」</b> 或「添加到主屏幕」</div>
        <div class="guide-step"><b>3.</b> 确认，桌面就出现图标了</div>`;
    }
    modal({ title: "装到手机主屏", html: `<div class="guide">${steps}</div>`, okText: "知道了", onOk: () => { } });
  },
  /* ---- 日期控件 ---- */
  openDate(el) {
    // 原生日期框只有点在日历图标那一小块才会自动弹选择器，不管点哪都强制弹一次
    try { if (el.showPicker) el.showPicker(); } catch (e) { }
  },
  syncDateLabel(id) {
    const el = $(id), lab = $(id + "--label"); if (!el || !lab) return;
    lab.textContent = el.value ? fmtDate(el.value) : "选择日期";
    lab.classList.toggle("empty", !el.value);
  },
  syncMonthLabel(id) {
    const el = $(id), lab = $(id + "--label"); if (!el || !lab) return;
    lab.textContent = el.value ? fmtMonth(el.value) : "选择月份";
    lab.classList.toggle("empty", !el.value);
  },
  _monthCb: {},
  // 老浏览器的「年+月」两个下拉：拼出 yyyy-MM 塞进隐藏 input，再跑那个字段原本的 onchange
  syncMonthSelect(id) {
    const el = $(id), y = $(id + "--y"), m = $(id + "--m");
    if (!el || !y || !m) return;
    el.value = y.value + "-" + m.value;
    const cb = A._monthCb[id];
    if (cb) new Function(cb).call(el);
  },

  /* ---- 打点 ---- */
  setScanDate(v) { if (!v) return; state.scan.date = v; state.scan.records = null; go("scan"); },
  async submitScan() {
    const procs = state.processes || [];
    if (!procs.length) return toast("请先添加工序模板");
    const qty = val("sc-qty");
    if (!qty) return toast("请填写完成数量");
    const styleId = val("sc-style");
    await run(() => api("POST", "/scan", {
      processId: val("sc-proc"), styleId: styleId || undefined, date: state.scan.date, qty: Number(qty)
    }), "已打点");
  },
  delScan(id) { run(() => api("DELETE", "/scan/" + id), "已删除"); },

  /* ---- 工序模板 ---- */
  toggleProcessForm() {
    procForm = procForm ? null : { id: "", name: "", unit: "", stdQty: "", hourQuota: "", unitPrice: "" };
    render();
  },
  editProcess(id) {
    const p = (state.processes || []).find(x => x.id === id); if (!p) return;
    procForm = {
      id: p.id, name: p.name, unit: p.unit || "", stdQty: String(p.std_qty),
      hourQuota: String(p.hour_quota), unitPrice: p.unit_price === null || p.unit_price === undefined ? "" : String(p.unit_price)
    };
    render(); window.scrollTo(0, document.body.scrollHeight);
  },
  async saveProcess() {
    const name = val("pf-name"), stdQty = val("pf-std"), hourQuota = val("pf-hour"), price = val("pf-price");
    if (!name || !stdQty || !hourQuota) return toast("请填写完整");
    const body = { name, unit: val("pf-unit"), stdQty: Number(stdQty), hourQuota: Number(hourQuota) };
    if (price !== "") body.unitPrice = Number(price);
    const id = procForm.id;
    await run(() => api(id ? "PATCH" : "POST", id ? "/processes/" + id : "/processes", body).then(() => { procForm = null; }), "已保存");
  },
  delProcess(id) {
    modal({
      title: "删除工序", body: "确定删除这个工序模板吗？", danger: true, okText: "删除",
      onOk: () => run(() => api("DELETE", "/processes/" + id), "已删除")
    });
  },

  /* ---- 款式 ---- */
  newStyle() {
    photoDraft = { style: [] };
    styleForm = { id: "", name: "", code: "", customer: "", size: {}, color: {}, err: {} };
    state.pe = { styleId: null, mode: "default", sizes: [], roles: [], items: [] };
    render(); window.scrollTo(0, 0);
    // 新建款式也可能要按岗位设可见性，异步把岗位列表补上（普通员工没有权限就留空，不阻塞表单）
    api("GET", "/roles").then(r => { if (state.pe) { state.pe.roles = r.roles || []; render(); } }).catch(() => {});
  },
  async editStyle(id) {
    const s = (state.styles || []).find(x => x.id === id); if (!s) return;
    photoDraft = { style: styleImages(s) };
    const size = {}, color = {};
    String(s.size || "").split(",").forEach(x => { if (x) size[x] = true; });
    String(s.color || "").split(",").forEach(x => { if (x) color[x] = true; });
    styleForm = { id: s.id, name: s.name, code: s.code || "", customer: s.customer || "", size, color, err: {} };
    state.pe = { styleId: s.id, mode: "default", sizes: String(s.size || "").split(",").filter(Boolean), roles: [], items: [] };
    render(); window.scrollTo(0, 0);
    try {
      const [r, roleRes] = await Promise.all([
        api("GET", `/styles/${id}/processes`),
        api("GET", "/roles").catch(() => ({ roles: [] }))
      ]);
      state.pe = {
        styleId: s.id,
        mode: (r.list[0] && r.list[0].price_mode) || "default",
        sizes: String(s.size || "").split(",").filter(Boolean),
        roles: roleRes.roles || [],
        items: r.list.map((x) => ({
          name: x.name, unitPrice: x.unit_price, prices: x.prices || {},
          showPrice: x.show_price !== false, visibleRoles: x.visible_roles || []
        }))
      };
      render();
    } catch (e) { toast((e && e.error) || "工序加载失败"); }
  },
  cancelStyle() { styleForm = null; state.pe = null; photoDraft = {}; render(); },
  // 表单里有多处操作会触发重绘（选尺码/颜色、加工序…），重绘前先把输入框里的内容存回 styleForm
  syncStyleForm() {
    if (!styleForm) return;
    if ($("sf-name")) styleForm.name = val("sf-name");
    if ($("sf-code")) styleForm.code = val("sf-code");
  },

  /* ---- 款式尺码/颜色/客户 选项控件 ---- */
  setStyleKw(v) {
    // 只改 state 不重绘：重绘会让输入框失焦，中文输入法直接被打断
    state.styleKw = v;
    clearTimeout(A._stT);
    A._stT = setTimeout(() => { render(); const el = $("st-kw"); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } }, 250);
  },

  // 同步工序：把款式当前的工序整套推到选中的裁床单上。
  // 裁床单的工序是下单时的快照，改款式工序默认不影响已建的单（否则改一次价会追溯改掉历史工资），
  // 所以要在这里显式选床次。
  async openSyncProcs(styleId) {
    let r;
    try { r = await api("GET", `/styles/${styleId}/syncable-orders`); }
    catch (e) { return toast((e && e.error) || "取裁床单失败"); }
    const list = r.list || [];
    if (!list.length) return toast("这个款式还没有裁床单，不需要同步");
    state.syncPick = new Set(list.map(o => o.id));   // 默认全选，跟参考系统一致
    state.syncList = list;
    state.syncStyleId = styleId;
    A.renderSyncModal();
  },
  renderSyncModal() {
    const html = `<div class="card" style="margin-top:0">${state.syncList.map(o => `
      <label class="row-item sync-row">
        <input type="checkbox" ${state.syncPick.has(o.id) ? "checked" : ""}
          onchange="A.toggleSyncPick('${o.id}',this.checked)">
        <div class="row-main">
          <div class="row-label">床次：${o.bed_no}</div>
          <div class="row-sub">制单号 ${esc(o.doc_no || "—")} · 工序数 ${o.process_count} · 工价 ${num(o.total_price)}</div>
          <div class="row-sub">裁单日期 ${esc(o.cut_date || "—")} · 已完成件数 ${num(o.completed_qty)}</div>
          <div class="pbar"><i style="width:${o.percent}%"></i></div>
        </div>
      </label>`).join("")}</div>`;
    modal({
      title: "选择需要同步的裁床单", html, okText: "同步", onOk: () => {
        const ids = [...state.syncPick];
        if (!ids.length) { toast("至少选一张裁床单"); return false; }
        run(() => api("POST", `/styles/${state.syncStyleId}/processes/sync`, { orderIds: ids }), `已同步 ${ids.length} 张裁床单`);
        return true;
      }
    });
  },
  toggleSyncPick(id, on) { if (on) state.syncPick.add(id); else state.syncPick.delete(id); },

  // 单张款式图的灯箱：卡片上的缩略图点开看大图，复用已有的画廊机制
  lightboxOne(el) {
    const k = regGallery([el.getAttribute("src")]);
    el.setAttribute("data-gallery", k); el.setAttribute("data-i", "0");
    A.lightboxFromEl(el);
  },

  /* ---------- 扫菲打点（按扎） ---------- */
  setTicketInput(v) { state.scan.ticketInput = v; },
  async lookupTicket() {
    // DOM 里有值就以 DOM 为准（用户刚打的字还没失焦）；DOM 是空的就用 state
    // ——摄像头扫到码时是直接写 state 的，不能被空输入框清掉
    const el = $("sc-ticket");
    if (el && el.value.trim()) state.scan.ticketInput = el.value;
    // 扫出来的是 JJ:36440 这种带前缀的，手输的可能只有数字，两种都收
    const raw = String(state.scan.ticketInput || "").trim().replace(/^JJ:/i, "");
    if (!raw) return toast("请输入扎号或菲票号");
    try {
      const r = await api("GET", "/bundles/by-ticket/" + encodeURIComponent(raw));
      state.scan.bundle = r.bundle; state.scan.bundleOrder = r.order; state.scan.bundleProcs = r.processes;
    } catch (e) {
      state.scan.bundle = null; state.scan.bundleOrder = null; state.scan.bundleProcs = null;
      toast((e && e.error) || "查不到这张菲票");
    }
    render();
  },
  async scanBundleSubmit(orderProcessId) {
    const el = $("sq-" + orderProcessId);
    const raw = el ? el.value.trim() : "";
    try {
      await api("POST", "/scan", {
        ticketNo: state.scan.bundle.ticket_no, orderProcessId,
        qty: raw === "" ? undefined : Number(raw),   // 不填就是完成整扎剩余
        date: state.scan.date
      });
      toast("已打点");
      await A.lookupTicket();          // 重新拉一次，剩余件数立刻刷新
      await loadView("scan"); render();
    } catch (e) { toast((e && e.error) || "打点失败"); }
  },
  async startCamera() {
    const sc = state.scan;
    if (sc.camOn) { A.stopCamera(); return; }
    sc.camOn = true; render();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      A._camStream = stream;
      const video = $("scan-cam");
      if (!video) { A.stopCamera(); return; }
      video.srcObject = stream; await video.play();
      const det = new window.BarcodeDetector({ formats: ["qr_code"] });
      const tick = async () => {
        if (!state.scan.camOn || !video.srcObject) return;
        try {
          const codes = await det.detect(video);
          const hit = codes.find(c => /^JJ:\d+$/i.test(c.rawValue || ""));
          if (hit) {
            state.scan.ticketInput = hit.rawValue.replace(/^JJ:/i, "");
            A.stopCamera();
            return A.lookupTicket();
          }
        } catch (e) { /* 单帧识别失败无所谓，下一帧继续 */ }
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      A.stopCamera();
      toast("打不开摄像头，请检查权限，或直接手动输入扎号");
    }
  },
  stopCamera() {
    if (A._camStream) { A._camStream.getTracks().forEach(t => t.stop()); A._camStream = null; }
    state.scan.camOn = false; render();
  },

  /* ---------- 打印菲票 ---------- */
  cpSet(k, v) {
    state.cp[k] = (k === "from" || k === "to" || k === "copies") ? Math.max(1, Number(v) || 1) : v;
    if (k === "copies") state.cp.copies = Math.min(10, state.cp.copies);
    render();
  },
  cpToggle(k) { state.cp[k] = !state.cp[k]; render(); },
  cpStep(d) { A.cpSet("copies", (Number(state.cp.copies) || 1) + d); },

  async doPrint() {
    const cp = state.cp;
    const q = new URLSearchParams();
    if (cp.usePicks) {
      if (!String(cp.picks).trim()) return toast("请填写要打印的扎号");
      q.set("picks", String(cp.picks).trim());
    } else { q.set("from", cp.from); q.set("to", cp.to); }

    let data;
    try { data = await api("GET", `/cut-orders/${cp.orderId}/print-data?${q}`); }
    catch (e) { return toast((e && e.error) || "取打印数据失败"); }

    const { order: o, processes, bundles } = data;
    const company = cp.companyName || o.company_name || "";
    const copies = Math.max(1, Math.min(10, Number(cp.copies) || 1));

    const ticket = (b) => `<div class="ticket${cp.rotate ? " rot" : ""}">
      <div class="tk-top"><span>${esc(company)}</span><span>${esc(o.style_code || o.style_name || "")}</span></div>
      <div class="tk-mid">
        <div class="tk-bundle"><div class="tk-bundle-n">${b.bundle_no}</div><div class="tk-bundle-l">扎号</div></div>
        <div class="tk-qr">${b.qrSvg}</div>
      </div>
      <div class="tk-rows">
        <span>菲票 ${b.ticket_no}</span><span>床次 ${o.bed_no}</span>
        <span>${esc(b.color || "")}</span><span>${esc(b.size || "")}</span>
        <span><b>${num(b.qty)} 件</b></span>
        ${b.vat_no ? `<span>缸号 ${esc(b.vat_no)}</span>` : ""}
        ${o.doc_no ? `<span>制单 ${esc(o.doc_no)}</span>` : ""}
        ${o.customer ? `<span>${esc(o.customer)}</span>` : ""}
      </div>
      <div class="tk-procs">${processes.map(p =>
        `<span>${esc(p.name)}${p.show_price ? ` ${num(p.unit_price)}` : ""}</span>`).join("")}</div>
      ${(cp.perNote ? b.note : cp.note) ? `<div class="tk-note">${esc(cp.perNote ? (b.note || "") : cp.note)}</div>` : ""}
    </div>`;

    const html = [];
    for (const b of bundles) for (let i = 0; i < copies; i++) html.push(ticket(b));

    // @page 的尺寸不能用 CSS 变量、也没法靠 class 切换，只能在打印前把这段样式换掉
    const PAGE_SIZES = { label60x40: "60mm 40mm", label80x60: "80mm 60mm", a4grid: "A4" };
    let pageStyle = document.getElementById("page-size");
    if (!pageStyle) {
      pageStyle = document.createElement("style");
      pageStyle.id = "page-size";
      document.head.appendChild(pageStyle);
    }
    pageStyle.textContent = `@page { size: ${PAGE_SIZES[cp.template] || "A4"}; margin: 0 }`;

    const root = $("print-root");
    root.className = "tpl-" + cp.template;
    root.innerHTML = html.join("");
    toast(`已排版 ${bundles.length} 张菲票 × ${copies} 份`);
    // 等浏览器完成排版再调打印，否则部分浏览器印出来是空白。
    // rAF 在后台标签页里不触发，所以再挂一个 setTimeout 兜底，两者谁先到算谁（只打一次）。
    let printed = false;
    const fire = () => { if (printed) return; printed = true; window.print(); };
    requestAnimationFrame(() => requestAnimationFrame(fire));
    setTimeout(fire, 300);
  },

  /* ---------- 生产进度 ---------- */
  setPgKw(v) {
    state.pgKw = v;
    clearTimeout(A._pgT);
    A._pgT = setTimeout(() => {
      render();
      const el = $("pg-kw"); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); }
    }, 250);
  },
  // 改的是"这一扎裁了多少件"（分母），不碰打点记录（分子）。
  // 改到比已完成数还小会造出"做了12件却只裁了3件"的鬼数据，后端会拦，这里把它的提示原样弹出来。
  editBundleQty(id, curQty) {
    modal({
      title: "修改裁床件数", input: true, value: String(curQty), okText: "保存",
      onOk: (v) => {
        const qty = Number(v);
        if (!(qty > 0)) { toast("件数要大于 0"); return false; }
        run(() => api("PATCH", "/bundles/" + id, { qty }), "已修改");
        return true;
      }
    });
  },

  /* ---------- 裁床编菲 ---------- */
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
    ["bedNo", "docNo", "customer", "orderNo", "bedNote", "ticketNote", "companyName"].forEach(k => {
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

  /* ---------- 生产管理 ---------- */
  setCoRange(k) { state.co.range = k; run(() => Promise.resolve()); },
  setCoTab(k) { state.co.tab = k; render(); },
  setCoKw(v) {
    // 跟款式搜索一样：先只改 state，防抖之后再重绘，否则每敲一个字输入框就失焦
    state.co.kw = v;
    clearTimeout(A._coT);
    A._coT = setTimeout(async () => {
      await loadView("cutorders"); render();
      const el = $("co-kw"); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); }
    }, 300);
  },
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
      okText: "取消", onOk: () => true
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
    modal({
      title: "删除裁床单", danger: true, okText: "删除",
      body: o ? `确定删除「${o.style_code || o.style_name} · 床次${o.bed_no}」吗？这张单的 ${num(o.total_bundles)} 张菲票和进度都会一起看不到。` : "确定删除吗？",
      onOk: () => { run(() => api("DELETE", "/cut-orders/" + id), "已删除"); return true; }
    });
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

  optOpen(type) { A.syncStyleForm(); const u = state.optUI[type]; u.open = !u.open; u.kw = ""; render(); },
  optSearch(type, kw) {
    A.syncStyleForm();
    state.optUI[type].kw = kw; render();
    const el = document.querySelector(".optbox.open .opt-search");
    if (el) { el.focus(); el.setSelectionRange(kw.length, kw.length); }
  },
  optToggle(type, encV) {
    const v = decodeURIComponent(encV);
    A.syncStyleForm();
    if (type === "customer") { styleForm.customer = styleForm.customer === v ? "" : v; state.optUI[type].open = false; }
    else { const m = type === "size" ? styleForm.size : styleForm.color; if (m[v]) delete m[v]; else m[v] = true; }
    render();
  },
  optRemove(type, encV) {
    const v = decodeURIComponent(encV);
    A.syncStyleForm();
    if (type === "customer") styleForm.customer = "";
    else { const m = type === "size" ? styleForm.size : styleForm.color; delete m[v]; }
    render();
  },
  async optCreate(type) {
    const value = (state.optUI[type].kw || "").trim();
    if (!value) return;
    A.syncStyleForm();
    try {
      await api("POST", "/style-options", { type, value });
      const o = await api("GET", "/style-options");
      state.styleOptions = { sizes: o.sizes || [], colors: o.colors || [], customers: o.customers || [] };
      if (type === "customer") styleForm.customer = value;
      else (type === "size" ? styleForm.size : styleForm.color)[value] = true;
      state.optUI[type].kw = "";
      render(); toast("已新增");
    } catch (e) { toast((e && e.error) || "新增失败"); }
  },
  async optDeleteOption(type, encV) {
    const value = decodeURIComponent(encV);
    A.syncStyleForm();
    try {
      await api("DELETE", "/style-options", { type, value });
      const o = await api("GET", "/style-options");
      state.styleOptions = { sizes: o.sizes || [], colors: o.colors || [], customers: o.customers || [] };
      // 删掉的选项如果正被这张款式选中，一并清掉，免得留下一个选不到的"幽灵"选中态
      if (type === "size") delete styleForm.size[value];
      else if (type === "color") delete styleForm.color[value];
      else if (styleForm.customer === value) styleForm.customer = "";
      render(); toast("已删除");
    } catch (e) { toast((e && e.error) || "删除失败"); }
  },

  /* ---- 工序编辑器（款式表单 与 修改工序页 共用） ---- */
  // 下面这一串 peXxx 都会触发 render() 整页重绘，而款号/款式名称的输入框没有 onchange，
  // 不先把 DOM 里的值同步回 state，用户刚打的字会被重绘出来的旧值悄悄覆盖。
  peSetMode(mode) {
    A.syncStyleForm();
    if (mode !== state.pe.mode && peHasMultiPrices()) return toast("请先删除多单价再改变单价模式");
    state.pe.mode = mode; render();
  },
  peAdd() { A.syncStyleForm(); A.peSyncNames(); state.pe.items.push({ name: "", unitPrice: 0, prices: {}, showPrice: true, visibleRoles: [] }); render(); },
  peDel(i) { A.syncStyleForm(); A.peSyncNames(); state.pe.items.splice(i, 1); render(); },
  // 工序名和工价用的也是 onchange，用户没失焦时 state 还是旧值；重绘前先从 DOM 兜一次。
  // 跟 peCollect() 是同一件事，抽出来给那些"会触发重绘"的 handler 复用。
  peSyncNames() {
    const rows = [...document.querySelectorAll(".pe-tbl tr")].slice(1);
    rows.forEach((tr, i) => {
      const it = state.pe.items[i]; if (!it) return;
      const nameEl = tr.querySelector("td:nth-child(3) input");
      if (nameEl) it.name = nameEl.value;
      const priceEl = tr.querySelector(".stepper input");
      if (priceEl) it.unitPrice = Number(priceEl.value) || 0;
    });
  },
  peSetName(i, v) { state.pe.items[i].name = v; },
  peSetPrice(i, v) { A.syncStyleForm(); state.pe.items[i].unitPrice = Number(v) || 0; render(); },
  peStep(i, d) {
    A.syncStyleForm(); A.peSyncNames();
    const it = state.pe.items[i];
    it.unitPrice = Math.max(0, Math.round(((Number(it.unitPrice) || 0) + d * 0.1) * 10000) / 10000);
    render();
  },
  peSetSizePrice(i, encSize, v) {
    const k = decodeURIComponent(encSize), it = state.pe.items[i];
    it.prices = it.prices || {};
    if (v === "") delete it.prices[k]; else it.prices[k] = Number(v) || 0;
  },
  peSetRolePrice(i, encRole, v) { A.peSetSizePrice(i, encRole, v); },
  peToggleShow(i) { A.syncStyleForm(); A.peSyncNames(); state.pe.items[i].showPrice = !state.pe.items[i].showPrice; render(); },
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
    modal({ title: "选择模板", html: `<div class="card" style="margin-top:0">${html}</div>`, okText: "关闭", onOk: () => true });
  },
  peApplyTemplate(id) {
    const t = (state.pe.templates || []).find((x) => x.id === id);
    if (!t) return;
    state.pe.items = t.items.map((it) => ({
      name: it.name || "", unitPrice: Number(it.unitPrice) || 0, prices: it.prices || {},
      showPrice: it.showPrice !== false, visibleRoles: it.visibleRoles || []
    }));
    A.modalCancel(); render(); toast("已套用模板");
  },
  async peDelTemplate(id) {
    await run(() => api("DELETE", "/process-templates/" + id), "已删除");
    A.pePickTemplate();
  },
  // 从 DOM 兜一次最新值：工序名/工价用的是 onchange，用户没失焦时 state 里还是旧值
  peCollect() {
    const rows = [...document.querySelectorAll(".pe-tbl tr")].slice(1);
    rows.forEach((tr, i) => {
      const it = state.pe.items[i]; if (!it) return;
      const nameEl = tr.querySelector("td:nth-child(3) input");
      if (nameEl) it.name = nameEl.value;
      const priceEl = tr.querySelector(".stepper input");
      if (priceEl) it.unitPrice = Number(priceEl.value) || 0;
    });
    return state.pe.items.filter((it) => String(it.name || "").trim()).map((it) => ({
      name: String(it.name).trim(),
      priceMode: state.pe.mode,
      unitPrice: Number(it.unitPrice) || 0,
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
  async saveStyle() {
    A.syncStyleForm();
    const f = styleForm;
    f.err = {};
    if (!f.name) f.err.name = "请填写款式名称";
    if (!f.code) f.err.code = "请填写款号";
    if (f.err.name || f.err.code) { render(); return; }
    const images = photoDraft.style || [];
    const body = {
      name: f.name, code: f.code, image: images[0] || "", images,
      size: Object.keys(f.size).join(","), color: Object.keys(f.color).join(","), customer: f.customer
    };
    try {
      toast("保存中…", true);
      const r = await api(f.id ? "PATCH" : "POST", f.id ? "/styles/" + f.id : "/styles", body);
      const styleId = f.id || (r.style && r.style.id);
      state.pe.styleId = styleId;
      await api("PUT", `/styles/${styleId}/processes`, { items: A.peCollect() });
      styleForm = null; state.pe = null; photoDraft = {};
      await loadView("styles"); render(); toast("已保存");
    } catch (e) { toast((e && e.error) || "保存失败"); }
  },
  delStyle(id) {
    modal({
      title: "删除款式", body: "确定删除这个款式吗？", danger: true, okText: "删除",
      onOk: () => run(() => api("DELETE", "/styles/" + id), "已删除")
    });
  },

  /* ---- 考勤 ---- */
  setAttUser(v) { state.att.userId = v; state.att.records = null; go("attendance"); },
  setAttDate(v) { if (!v) return; state.att.date = v; state.att.records = null; go("attendance"); },
  async saveAttendance() {
    if (!state.att.userId) return toast("请先添加员工");
    const hours = val("at-hours");
    if (!hours) return toast("请填写工时");
    await run(() => api("POST", "/attendance", { userId: state.att.userId, date: state.att.date, hours: Number(hours) }), "已保存");
  },

  /* ---- 效率 ---- */
  setEffMonth(v) { if (!v) return; state.eff.month = v; state.eff.list = null; go("efficiency"); },

  /* ---- 扫菲记录 ---- */
  setSlogDate(v) { if (!v) return; state.slog.date = v; state.slog.records = null; go("scanlog"); },

  /* ---- 管理：员工 ---- */
  setEmpKw(v) {
    state.empKw = v; state.empPage = 1;   // 换关键词就回到第 1 页
    clearTimeout(A._empT);
    A._empT = setTimeout(() => {
      render();
      const el = $("emp-kw"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }, 300);
  },
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

  /* ---- 薪资管理 ---- */
  setPayMonth(v) { if (!v) return; state.pay.month = v; state.pay.list = null; state.pay.editing = ""; go("payroll"); },
  editPay(userId) { state.pay.editing = state.pay.editing === userId ? "" : userId; render(); },
  async savePay(userId) {
    const body = {
      userId, month: state.pay.month,
      mealSubsidy: Number(val("pa-meal")) || 0, penalty: Number(val("pa-pen")) || 0, bonus: Number(val("pa-bonus")) || 0
    };
    await run(() => api("POST", "/payroll/adjustments", body).then(() => { state.pay.editing = ""; }), "已保存");
  },

  /* ---- 我的 ---- */
  setMyPayMonth(v) { if (!v) return; state.pay.month = v; state.pay.mine = null; go("mine"); },
  async changeMyPw() {
    const p1 = ($("my-p1") || {}).value || "", p2 = ($("my-p2") || {}).value || "";
    if (!p1 || p1 !== p2) return toast("两次输入的新密码不一致");
    try {
      await api("POST", "/password/change", { newPassword: p1 });
      $("my-p1").value = ""; $("my-p2").value = ""; toast("密码修改成功");
    } catch (e) { toast((e && e.error) || "修改失败"); }
  }
};

/* ================= 下拉刷新 ================= */
// 在页面顶部往下拉可以强制刷新一次当前页数据，不用退出重进
(function setupPullRefresh() {
  const THRESHOLD = 62;
  let startY = null, dragging = false, dist = 0, refreshing = false;
  const canPull = () => !refreshing && me() && !modalState && !lightbox && window.scrollY === 0;
  document.addEventListener("touchstart", (e) => {
    if (!canPull()) { startY = null; return; }
    startY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) return;
    dragging = true; dist = dy;
  }, { passive: true });
  document.addEventListener("touchend", async () => {
    if (!dragging) { startY = null; return; }
    dragging = false; startY = null;
    if (dist < THRESHOLD) return;
    refreshing = true;
    try { await loadView(route.v); render(); toast("已刷新"); } catch (e) { }
    refreshing = false;
  });
})();

/* ================= 启动 ================= */
window.go = go; window.A = A;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; });
window.addEventListener("appinstalled", () => { deferredInstall = null; toast("已添加到手机主屏"); });

(async function boot() {
  // 每次打开只要本来是登录状态，都先过一遍欢迎界面（logo/公司名称/计件跟踪）。
  // index.html 里已经有一份静态的欢迎界面兜底，JS 跑起来之前手机屏幕就不会是空的。
  // 本地有 token 就直接用它拉数据进工作台（token 不过期，只有 401 或主动退出才会清掉）
  if (state.token) {
    showWelcome = true; render();
    const p = api("GET", "/me").then(r => { state.me = r.user; return loadView("home").catch(() => { }); })
      .catch(() => { state.token = null; state.me = null; localStorage.removeItem(TOKEN_KEY); });
    await Promise.all([p, new Promise(r => setTimeout(r, 1200))]);
    if (state.token) startNotifPoll();
  }
  showWelcome = false;
  render();
})();
