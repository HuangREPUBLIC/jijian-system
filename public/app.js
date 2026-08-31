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
  processes: null, styles: null, styleOptions: null,
  home: { today: 0, mgr: null, emp: null },
  scan: { date: todayStr(), records: null, eff: null },
  att: { userId: "", date: todayStr(), records: null },
  eff: { month: monthStr(), list: null },
  cut: { range: "today", tab: "sheet", kw: "", overview: null, sheets: null, byStyle: null },
  slog: { date: todayStr(), records: null },
  pay: { month: monthStr(), list: null, mine: null, editing: "" },
  empKw: "", empPage: 1,
  notif: { unread: 0, list: null }
};
const EMP_PAGE_SIZE = 10;       // 管理页员工列表每页条数
let route = { v: "home", id: null };
let showWelcome = false;        // 打开 App 时短暂展示的欢迎界面（logo/公司名称/计件跟踪）
let modalState = null;
let deferredInstall = null;     // 安卓/桌面 Chrome 的原生安装事件
let notifPanelOpen = false;     // 桌面端顶部铃铛下拉面板是否展开
let procForm = null;            // 工序模板表单
let styleForm = null;           // 款式表单
let sheetForm = null;           // 裁床单表单

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
  bell: `<path d="M6 9.5a6 6 0 0 1 12 0c0 4 1.4 5.6 1.4 5.6H4.6S6 13.5 6 9.5Z"/><path d="M10 19a2 2 0 0 0 4 0"/>`
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
async function run(fn, okMsg) {
  try { await fn(); await loadView(route.v); render(); if (okMsg) toast(okMsg); }
  catch (e) { toast((e && e.error) || "操作失败"); }
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
  if (v === "cutting") {
    const q = state.cut.kw.trim() ? "?q=" + encodeURIComponent(state.cut.kw.trim()) : "";
    const [st, ov, list] = await Promise.all([
      api("GET", "/styles"),
      api("GET", "/cutting/overview?range=" + state.cut.range),
      state.cut.tab === "sheet" ? api("GET", "/cutting-sheets" + q) : api("GET", "/cutting-sheets/by-style" + q)
    ]);
    state.styles = st.styles || []; state.cut.overview = ov;
    if (state.cut.tab === "sheet") state.cut.sheets = list.sheets || []; else state.cut.byStyle = list.list || [];
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
const SUB_VIEWS = { processes: "home", styles: "home", attendance: "home", efficiency: "home", cutting: "home", scanlog: "home", payroll: "home", notifs: "mine" };
function go(v, id) {
  route = { v, id: id || null };
  lightbox = null; renderLightbox();
  if (v !== "styles") { styleForm = null; photoDraft = {}; }
  if (v !== "processes") procForm = null;
  if (v !== "cutting") sheetForm = null;
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
    processes: "工序模板", styles: "款式管理", attendance: "考勤录入",
    efficiency: "效率看板", cutting: "生产管理", scanlog: "扫菲记录", payroll: "薪资管理", notifs: "消息通知"
  };
  const parent = SUB_VIEWS[route.v];
  return {
    title: T[route.v] || APP_NAME,
    left: parent ? back(T[parent], parent) : "",
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
      ...(isManager() ? [["attendance", "考勤录入", "attendance"]] : []), ["efficiency", "效率看板", "efficiency"],
      ["cutting", "生产管理", "cutting"], ["scanlog", "扫菲记录", "scanlog"]
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
      <div class="dbell-panel-list">${list.length ? list.map(x => `
        <div class="dbell-item${x.read ? "" : " unread"}" onclick="A.openNotif('${x.id}','${x.link || ""}')">
          <div class="dbell-text">${esc(x.text)}</div><div class="dbell-time">${fmtNotifTime(x.createdAt)}</div>
        </div>`).join("") : `<div class="empty" style="padding:24px 16px">暂无通知</div>`}</div>
    </div>`;
}
function render() {
  const app = $("app");
  galleryReg = {};                 // 缩略图分组注册表跟着这次渲染重新登记，避免越攒越多
  if (showWelcome) { app.innerHTML = vWelcome(); return; }
  if (!me()) { app.innerHTML = vLogin(); return; }
  const meta = pageMeta();
  const views = {
    home: vHome, scan: vScan, processes: vProcesses, styles: vStyles, attendance: vAttendance,
    efficiency: vEfficiency, cutting: vCutting, scanlog: vScanlog, payroll: vPayroll, admin: vAdmin, mine: vMine,
    notifs: vNotifs
  };
  app.innerHTML = `
    ${sidebarHtml()}
    ${route.v === "home" ? `<div class="home-brand"><div class="co">${esc(COMPANY_NAME)}</div><div class="app">${esc(APP_NAME)}</div></div>` : ""}
    ${meta.crumb ? `<nav class="dbreadcrumb"><button class="dbc-link" onclick="${meta.crumb.fn}">${esc(meta.crumb.label)}</button><span class="dbc-sep">›</span><span class="dbc-current">${esc(meta.title)}</span></nav>` : ""}
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
      <div class="card">${recent.length ? recent.map(x => `
        <div class="row-item" style="cursor:pointer" onclick="A.openNotif('${x.id}','${x.link || ""}')">
          <div class="row-main"><div class="row-label">${esc(x.text)}</div><div class="row-sub">${fmtNotifTime(x.createdAt)}</div></div>
        </div>`).join("") : `<div class="empty">暂无动态</div>`}</div>
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
        ${isManager() ? tool("attendance", "考勤录入", "attendance") : ""}
        ${tool("efficiency", "效率看板", "efficiency")}
        ${tool("cutting", "生产管理", "cutting")}
        ${tool("scanlog", "扫菲记录", "scanlog")}
        ${isManager() ? tool("payroll", "薪资管理", "payroll") : ""}
        ${isManager() ? tool("admin", "管理", "admin") : ""}
      </div>
    </section>`;
}

/* ---------- 打点 ---------- */
function vScan() {
  const procs = state.processes || [], styles = state.styles || [], eff = state.scan.eff;
  const recs = state.scan.records;
  const pct = eff && eff.percent !== null && eff.percent !== undefined ? eff.percent : null;
  return `<section class="group"><div class="card">
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
        return `<div class="row-item">
          <div class="row-main"><div class="row-label">${esc(p ? p.name : r.process_id)}</div>
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
  return `<section class="group"><div class="card">
    ${list === null ? `<div class="empty">加载中…</div>` : list.length ? list.map(s => {
      const imgs = styleImages(s);
      const cover = imgs.filter(showable)[0];
      const g = regGallery(imgs.filter(showable));
      return `<div class="row-item tap" onclick="A.editStyle('${s.id}')">
        ${cover ? `<img class="thumb-sm" src="${esc(cover)}" data-gallery="${g}" data-i="0"
          onclick="event.stopPropagation();A.lightboxFromEl(this)" alt="款式图">` : ""}
        <div class="row-main"><div class="row-label">${esc(s.name)}${s.code ? " · " + esc(s.code) : ""}</div>
          <div class="row-sub">${[s.size, s.color, s.customer].filter(Boolean).map(esc).join(" · ") || "未填尺码/颜色/客户"}</div></div>
        <div class="row-acts"><button class="act-btn danger" onclick="event.stopPropagation();A.delStyle('${s.id}')">删除</button></div>
      </div>`;
    }).join("") : `<div class="empty">还没有款式</div>`}
  </div></section>
  <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn block" onclick="A.newStyle()">新增款式</button></div></section>`;
}
// 某条款式工序的"模板默认单价"：新加的本地暂存项从工序模板里取，已保存的用接口返回的 template_price
function tplPriceOf(it) {
  if (it.template_price !== null && it.template_price !== undefined) return it.template_price;
  const p = (state.processes || []).find(x => x.id === it.process_id);
  return p && p.unit_price ? p.unit_price : 0;
}
function vStyleForm() {
  const f = styleForm, o = state.styleOptions || { sizes: [], colors: [], customers: [] };
  const procs = state.processes || [];
  const total = num(f.procs.reduce((s, it) => s + (Number(it.effectivePrice) || 0), 0));
  const chip = (type, v, on) => `<button type="button" class="chip ${on ? "on" : ""}" onclick="A.toggleOpt('${type}','${encodeURIComponent(v)}')">${esc(v)}</button>`;
  return `<section class="group"><div class="sum-bar">
      <div class="sum-item"><div class="sum-num num">${total}</div><div class="sum-label">默认工价合计</div></div>
      <div class="sum-item"><div class="sum-num num">${f.procs.length}</div><div class="sum-label">工序数量合计</div></div>
    </div></section>

  <section class="group">
    <div class="group-title">基础信息</div>
    <div class="card">
      <div class="field"><span>款式图片</span>${photoPicker("style")}</div>
      <label class="field"><span>款号<span class="req">*</span></span>
        <input class="in ${f.err.code ? "bad" : ""}" id="sf-code" value="${esc(f.code)}" placeholder="请输入款号">
        ${f.err.code ? `<div class="field-err">${esc(f.err.code)}</div>` : ""}</label>
      <label class="field"><span>款式名称<span class="req">*</span></span>
        <input class="in ${f.err.name ? "bad" : ""}" id="sf-name" value="${esc(f.name)}" placeholder="请输入款式名称">
        ${f.err.name ? `<div class="field-err">${esc(f.err.name)}</div>` : ""}</label>
      <div class="field"><span>款式尺码（可多选）<button class="act-btn ghost" style="float:right" onclick="A.addStyleOption('size')">+ 新增</button></span>
        <div class="chips">${o.sizes.length ? o.sizes.map(s => chip("size", s, !!f.size[s])).join("")
      : `<span class="row-sub">还没有尺码，点右上"+ 新增"</span>`}</div></div>
      <div class="field"><span>款式颜色（可多选）<button class="act-btn ghost" style="float:right" onclick="A.addStyleOption('color')">+ 新增</button></span>
        <div class="chips">${o.colors.length ? o.colors.map(c => chip("color", c, !!f.color[c])).join("")
      : `<span class="row-sub">还没有颜色，点右上"+ 新增"</span>`}</div></div>
      <label class="field"><span>客户名称<button class="act-btn ghost" style="float:right" onclick="A.addStyleOption('customer')">+ 新增</button></span>
        ${selectHtml("sf-customer", o.customers.map(c => [c, c]), f.customer, "", "请选择客户")}</label>
    </div>
  </section>

  <section class="group">
    <div class="group-title">生产工序</div>
    <div class="card"><div class="tbl-wrap"><table class="tbl sp-tbl">
      <tr><th>序号</th><th>工序名称</th><th>工价（元）</th><th>操作</th></tr>
      ${f.procs.length ? f.procs.map((it, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td style="white-space:nowrap">${esc(it.process_name)}</td>
        <td><input class="in sp-price" type="number" inputmode="decimal" step="any"
          value="${it.unit_price === null || it.unit_price === undefined ? "" : esc(it.unit_price)}"
          placeholder="${num(tplPriceOf(it))}" onchange="A.setSpPrice('${it.id}',this.value)"></td>
        <td><button class="act-btn danger" onclick="A.delSp('${it.id}')">删除</button></td></tr>`).join("")
      : `<tr><td colspan="4"><div class="empty">还没有工序，用下面这行添加</div></td></tr>`}
    </table></div></div>
    <div class="card" style="margin-top:10px">${procs.length ? `<div class="sp-add">
      ${selectHtml("ap-proc", procs.map(p => [p.id, p.name]), (procs[0] || {}).id)}
      <input class="in" id="ap-price" type="number" inputmode="decimal" step="any" placeholder="工价">
      <button class="btn mini" onclick="A.confirmAddProc()">＋ 新增工序</button>
    </div>` : `<div class="empty">还没有工序模板，请先去「工序模板」里添加工序，再回来选</div>`}</div>
  </section>

  <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn block" onclick="A.saveStyle()">提交</button>
    <button class="btn ghost block" onclick="A.cancelStyle()">取消</button></div></section>`;
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

/* ---------- 生产管理（裁床单） ---------- */
function vCutting() {
  const ov = state.cut.overview || { completed: 0, inProduction: 0 };
  const rangeBtn = (k, t) => `<button class="${state.cut.range === k ? "on" : ""}" onclick="A.setCutRange('${k}')">${t}</button>`;
  const f = sheetForm, styles = state.styles || [];
  return `<div class="ov-card">
      <div class="ov-tabs">${rangeBtn("today", "今日")}${rangeBtn("yesterday", "昨日")}${rangeBtn("month", "本月")}</div>
      <div class="ov-label">已完成件数</div>
      <div class="ov-value num">${num(ov.completed)}</div>
      <div class="ov-sub">当前生产中件数 ${num(ov.inProduction)} 件</div>
    </div>

    <section class="group">
      <div class="group-title">生产明细</div>
      <div class="seg">
        <button class="${state.cut.tab === "sheet" ? "on" : ""}" onclick="A.setCutTab('sheet')">按裁床单看</button>
        <button class="${state.cut.tab === "style" ? "on" : ""}" onclick="A.setCutTab('style')">按款看</button>
      </div>
      <div class="searchbar"><input id="cut-kw" placeholder="搜索款号 / 款名" value="${esc(state.cut.kw)}"
        oninput="A.setCutKw(this.value)"></div>
      <div class="card">${state.cut.tab === "sheet" ? (
      state.cut.sheets === null ? `<div class="empty">加载中…</div>` : state.cut.sheets.length
        ? state.cut.sheets.map(s => `<div class="row-item">
            <div class="row-main"><div class="row-label">${esc(s.style_name)} × ${num(s.qty)}</div>
              <div class="row-sub">该款已完成 ${num(s.style_completed)} 件${s.note ? " · " + esc(s.note) : ""}</div></div>
            <div class="row-acts"><button class="act-btn danger" onclick="A.delSheet('${s.id}')">删除</button></div></div>`).join("")
        : `<div class="empty">还没有裁床单</div>`
    ) : (
      state.cut.byStyle === null ? `<div class="empty">加载中…</div>` : state.cut.byStyle.length
        ? state.cut.byStyle.map(x => `<div class="row-item">
            <div class="row-main"><div class="row-label">${esc(x.style_name)}${x.style_code ? ` (${esc(x.style_code)})` : ""}</div>
              <div class="row-sub">裁床 ${num(x.total_qty)} 件 · 已完成 ${num(x.completed_qty)} 件 · ${x.sheet_count} 张裁床单</div></div></div>`).join("")
        : `<div class="empty">暂无数据</div>`
    )}</div>
    </section>

    <section class="group">
      <div class="btn-row" style="padding-left:0;padding-right:0">
        <button class="btn ${f ? "ghost" : ""} block" onclick="A.toggleSheetForm()">${f ? "取消" : "新增裁床单"}</button></div>
      ${f ? `<div class="card">
        <label class="field"><span>款式<span class="req">*</span></span>
          ${styles.length ? selectHtml("cs-style", styles.map(s => [s.id, s.name + (s.code ? " · " + s.code : "")]), "")
        : `<div class="row-sub">还没有款式，请先去「款式管理」添加</div>`}</label>
        <label class="field"><span>数量<span class="req">*</span></span><input class="in" id="cs-qty" type="number" inputmode="decimal" step="any"></label>
        <label class="field"><span>备注（选填）</span><input class="in" id="cs-note"></label>
        <div class="btn-row"><button class="btn block" onclick="A.saveSheet()">保存</button></div>
      </div>` : ""}
    </section>`;
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
    <div class="card">${list.length ? list.map(x => `
      <div class="row-item"${x.read ? "" : ' style="background:var(--sky-soft)"'} onclick="A.openNotif('${x.id}','${x.link || ""}')">
        <div class="row-main"><div class="row-label">${esc(x.text)}</div><div class="row-sub">${fmtNotifTime(x.createdAt)}</div></div>
      </div>`).join("") : `<div class="empty">暂无通知</div>`}</div>
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
    state.cut.overview = state.cut.sheets = state.cut.byStyle = null;
    state.pay.list = state.pay.mine = null; state.pay.editing = "";
    styleForm = procForm = sheetForm = null; photoDraft = {};
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
    styleForm = { id: "", name: "", code: "", customer: "", size: {}, color: {}, procs: [], err: {} };
    render(); window.scrollTo(0, 0);
  },
  async editStyle(id) {
    const s = (state.styles || []).find(x => x.id === id); if (!s) return;
    photoDraft = { style: styleImages(s) };
    const size = {}, color = {};
    String(s.size || "").split(",").forEach(x => { if (x) size[x] = true; });
    String(s.color || "").split(",").forEach(x => { if (x) color[x] = true; });
    styleForm = { id: s.id, name: s.name, code: s.code || "", customer: s.customer || "", size, color, procs: [], err: {} };
    render(); window.scrollTo(0, 0);
    try {
      const r = await api("GET", `/styles/${id}/processes`);
      styleForm.procs = r.list || []; render();
    } catch (e) { toast((e && e.error) || "工序加载失败"); }
  },
  cancelStyle() { styleForm = null; photoDraft = {}; render(); },
  // 表单里有多处操作会触发重绘（选尺码/颜色、加工序…），重绘前先把输入框里的内容存回 styleForm
  syncStyleForm() {
    if (!styleForm) return;
    if ($("sf-name")) styleForm.name = val("sf-name");
    if ($("sf-code")) styleForm.code = val("sf-code");
    if ($("sf-customer")) styleForm.customer = val("sf-customer");
  },
  toggleOpt(type, encV) {
    const v = decodeURIComponent(encV);
    A.syncStyleForm();
    const map = type === "size" ? styleForm.size : styleForm.color;
    if (map[v]) delete map[v]; else map[v] = true;
    render();
  },
  addStyleOption(type) {
    const titles = { size: "新增尺码", color: "新增颜色", customer: "新增客户" };
    A.syncStyleForm();
    modal({
      title: titles[type], input: true, okText: "确认", onOk: (v) => {
        const value = String(v || "").trim(); if (!value) return false;
        api("POST", "/style-options", { type, value })
          .then(() => api("GET", "/style-options"))
          .then(o => {
            state.styleOptions = { sizes: o.sizes || [], colors: o.colors || [], customers: o.customers || [] };
            if (type === "customer") styleForm.customer = value; else (type === "size" ? styleForm.size : styleForm.color)[value] = true;
            render(); toast("已添加");
          })
          .catch(e => toast((e && e.error) || "添加失败"));
      }
    });
  },
  // 表格下面那一行「工序下拉 + 工价 + ＋新增工序」，随时可用，不需要先展开什么
  async confirmAddProc() {
    const procs = state.processes || [];
    if (!procs.length) return toast("请先到「工序模板」里添加工序");
    const pid = val("ap-proc"), priceStr = val("ap-price");
    const proc = procs.find(p => p.id === pid); if (!proc) return toast("请选择工序");
    const unitPrice = priceStr !== "" ? Number(priceStr) : null;
    A.syncStyleForm();
    if (styleForm.procs.some(x => x.process_id === pid)) return toast(`「${proc.name}」已经在列表里了`);
    if (styleForm.id) {
      try {
        await api("POST", `/styles/${styleForm.id}/processes`, { processId: pid, unitPrice: unitPrice === null ? undefined : unitPrice });
        const r = await api("GET", `/styles/${styleForm.id}/processes`);
        styleForm.procs = r.list || []; render(); toast("已添加");
      } catch (e) { toast((e && e.error) || "添加失败"); }
      return;
    }
    // 新建款式时还没有 styleId，先在本地暂存，提交时一起写进去
    styleForm.procs.push({
      id: "pending-" + Date.now(), pending: true, process_id: pid, process_name: proc.name,
      unit_price: unitPrice, effectivePrice: unitPrice !== null ? unitPrice : (proc.unit_price || 0)
    });
    render(); toast("已添加");
  },
  // 工价直接在表格里改：输入框失焦就存（留空 = 用工序模板默认价）
  async setSpPrice(id, v) {
    const priceStr = String(v || "").trim();
    const unitPrice = priceStr !== "" ? Number(priceStr) : null;
    A.syncStyleForm();
    const it = styleForm.procs.find(x => x.id === id); if (!it) return;
    if (it.pending) {
      it.unit_price = unitPrice;
      it.effectivePrice = unitPrice !== null ? unitPrice : tplPriceOf(it);
      render(); return;
    }
    try {
      await api("PATCH", "/style-processes/" + id, { unitPrice: unitPrice === null ? "" : unitPrice });
      const r = await api("GET", `/styles/${styleForm.id}/processes`);
      styleForm.procs = r.list || []; render(); toast("工价已保存");
    } catch (e) { toast((e && e.error) || "保存失败"); }
  },
  async delSp(id) {
    A.syncStyleForm();
    const it = styleForm.procs.find(x => x.id === id); if (!it) return;
    if (it.pending) { styleForm.procs = styleForm.procs.filter(x => x.id !== id); render(); return; }
    try {
      await api("DELETE", "/style-processes/" + id);
      const r = await api("GET", `/styles/${styleForm.id}/processes`);
      styleForm.procs = r.list || []; render();
    } catch (e) { toast((e && e.error) || "删除失败"); }
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
      if (!f.id && f.procs.length) {
        for (const it of f.procs) {
          await api("POST", `/styles/${styleId}/processes`, {
            processId: it.process_id, unitPrice: it.unit_price === null ? undefined : it.unit_price
          });
        }
      }
      styleForm = null; photoDraft = {};
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

  /* ---- 生产管理 ---- */
  setCutRange(k) { state.cut.range = k; go("cutting"); },
  setCutTab(k) { state.cut.tab = k; state.cut.sheets = null; state.cut.byStyle = null; go("cutting"); },
  setCutKw(v) {
    state.cut.kw = v; clearTimeout(A._kwT);
    A._kwT = setTimeout(() => {
      loadView("cutting").then(() => {
        render();
        const el = $("cut-kw"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      }).catch(e => toast((e && e.error) || "加载失败"));
    }, 350);
  },
  toggleSheetForm() { sheetForm = sheetForm ? null : {}; render(); },
  async saveSheet() {
    if (!(state.styles || []).length) return toast("请先添加款式");
    const qty = val("cs-qty");
    if (!qty) return toast("请填写数量");
    const body = { styleId: val("cs-style"), qty: Number(qty), note: val("cs-note") };
    await run(() => api("POST", "/cutting-sheets", body).then(() => { sheetForm = null; }), "已新增");
  },
  delSheet(id) {
    modal({
      title: "删除裁床单", body: "确定删除吗？", danger: true, okText: "删除",
      onOk: () => run(() => api("DELETE", "/cutting-sheets/" + id), "已删除")
    });
  },

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
