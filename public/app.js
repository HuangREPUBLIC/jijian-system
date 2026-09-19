"use strict";
// 计件跟踪前端（无构建的原生 JS PWA）：state 存数据，go(view,id) 切页，A.* 是 onclick 处理，v* 函数返回 HTML。
// 权限由服务端校验，这里只管隐藏入口；token 存 localStorage，只有 401 或主动退出才清掉。

/* ================= 状态 ================= */
const TOKEN_KEY = "jj_token";

let state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  me: null,
  users: null, roles: null,
  processes: null, styles: null,
  dailyWage: 100,
  tplList: null, tplEditing: null,   // 工序模板（整套工序清单） styleOptions: null, styleKw: "",
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
    ticketInput: "", bundle: null, bundleOrder: null, bundleProcs: null, camOn: false, camMsg: "" },
  att: { userId: "", date: todayStr(), records: null },
  eff: { month: monthStr(), list: null },
  // 打点记录：scope 是后端按岗位定的范围（mine=只有自己 / all=全员），who 是管理层加的人员筛选
  slog: { date: todayStr(), records: null, scope: "mine", who: "" },
  pay: { month: monthStr(), list: null, mine: null, editing: "" },
  empKw: "", empPage: 1,
  pushOn: false,
  notif: { unread: 0, list: null, recent: null },   // list：通知页/铃铛面板；recent：首页"最近动态"
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
// 通知时间分级显示：刚刚 / x分钟前 / 今天 14:05 / 昨天 14:05 / 周三 14:05 / 今年 9月3日 / 往年 2025年9月3日
const pad2 = n => String(n).padStart(2, "0");
const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
function fmtNotifTime(ms) {
  const now = Date.now(), diff = now - ms;
  const d = new Date(ms), hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + "分钟前";
  const days = Math.round((dayStart(now) - dayStart(ms)) / 86400000);
  if (days <= 0) return hm;
  if (days === 1) return "昨天 " + hm;
  if (days < 7) return "周" + "日一二三四五六"[d.getDay()] + " " + hm;
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
// 通知条目：铃铛面板、通知页、首页"最近动态"共用；有结构化字段时显示"谁 + 对象 + 改了什么"，老通知退回纯文本
function notifItemHtml(n, opt) {
  const o = opt || {};
  const rich = !!(n.actorName && n.targetLabel && n.what);
  return `<div class="notif-item${o.desk ? " desk" : ""}${n.read ? "" : " unread"}" onclick="A.openNotif('${n.id}','${jsArg(n.link || "")}')">
    ${rich ? `<span class="avatar sm">${esc(shortName(n.actorName))}</span>` : `<span class="avatar sm sys">${icon("bell")}</span>`}
    <div class="notif-main">${rich ? `
      <div class="notif-top"><span class="notif-actor">${esc(n.actorName)}</span><span class="tag">${esc(n.targetLabel)}</span></div>
      <div class="notif-what">${esc(n.what)}</div>` : `
      <div class="notif-plain">${esc(n.text)}</div>`}
      <div class="notif-time">${fmtNotifTime(n.createdAt)}</div>
    </div>
    ${o.del ? `<button class="notif-x" type="button" aria-label="删除这条通知"
      onclick="event.stopPropagation();A.deleteNotif('${n.id}')">${icon("close")}</button>` : ""}
  </div>`;
}
const num = n => Math.round(Number(n || 0) * 100) / 100;
// 塞进 onclick="A.x('…')" 的参数：encodeURIComponent 不转 ' ( ) 等字符，值里带单引号就能跳出字符串执行代码，
// 所以补转一遍；处理函数里 decodeURIComponent 还原
const jsArg = v => encodeURIComponent(String(v == null ? "" : v)).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const pctText = p => (p === null || p === undefined) ? "" : Math.round(p * 1000) / 10 + "%";
// 金额：千分位 + 固定两位小数（¥12,345.60）。工资单上 1234.5 和 12345 并排时，没有千分位一眼看不出差了十倍
function money(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  try { return "¥" + v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  catch (e) { return "¥" + v.toFixed(2); }
}
// 提示条。带 action 时右边多一个按钮（撤销），停留时间拉长到 5 秒——跟 Gmail/微信删除后的"撤销"一个做法
function toast(s, sticky, action) {
  const m = $("msg");
  m.textContent = "";
  const t = document.createElement("span"); t.textContent = s; m.appendChild(t);
  if (action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "msg-act"; b.textContent = action.label;
    b.onclick = () => { m.classList.remove("show"); clearTimeout(toast._t); action.fn(); };
    m.appendChild(b);
  }
  m.classList.toggle("has-act", !!action);
  m.classList.add("show");
  clearTimeout(toast._t);
  if (!sticky) toast._t = setTimeout(() => m.classList.remove("show"), action ? 5000 : 2400);
}
// 触感反馈：扫到码、打点成功时轻震一下（只有安卓支持 Vibration API，iOS 上静默跳过）
function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { } }
// 防重复提交：动作还在跑时再点直接忽略，按钮同时禁用转圈（车间手机卡顿时容易连点两次）
const busyKeys = {};
async function guard(key, fn) {
  if (busyKeys[key]) return undefined;
  busyKeys[key] = true;
  const ev = window.event;
  const btn = ev && ev.target && ev.target.closest ? ev.target.closest("button") : null;
  if (btn) { btn.disabled = true; btn.classList.add("is-busy"); }
  try { return await fn(); }
  finally {
    busyKeys[key] = false;
    if (btn && btn.isConnected) { btn.disabled = false; btn.classList.remove("is-busy"); }
  }
}

/* ---- 搜索：归一化（全角转半角/小写/压空格）+ 按空格分词都要命中 + 按相关度打分排序 ---- */
function normText(s) {
  return String(s == null ? "" : s)
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, " ").toLowerCase().replace(/\s+/g, " ").trim();
}
// fields[0] 是主字段（款号/扎号/姓名），命中它分更高。返回 -1 表示不匹配
function matchScore(fields, q) {
  const words = normText(q).split(" ").filter(Boolean);
  if (!words.length) return 0;
  const fs = fields.map(normText), all = fs.join(" ");
  let score = 0;
  for (const w of words) {
    if (all.indexOf(w) < 0) return -1;
    const main = fs[0] || "";
    score += main === w ? 100 : main.indexOf(w) === 0 ? 60 : main.indexOf(w) >= 0 ? 35 : 10;
  }
  return score;
}
function rankFilter(list, q, fieldsOf) {
  if (!normText(q)) return list;
  return list.map((x, i) => ({ x, i, s: matchScore(fieldsOf(x), q) }))
    .filter(r => r.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)      // 同分保持原顺序（稳定排序）
    .map(r => r.x);
}
// 搜索结果里把命中的词标出来
function hl(text, q) {
  const raw = String(text == null ? "" : text);
  const words = normText(q).split(" ").filter(Boolean);
  if (!words.length) return esc(raw);
  const norm = normText(raw);
  // 归一化后长度不变（全角→半角一对一、只压了空格）时才能按下标回填；压过空格的就不标了，宁缺毋错
  if (norm.length !== raw.length) return esc(raw);
  const mark = new Array(raw.length).fill(false);
  words.forEach(w => { let k = norm.indexOf(w); while (k >= 0) { for (let j = k; j < k + w.length; j++) mark[j] = true; k = norm.indexOf(w, k + w.length); } });
  let out = "", open = false;
  for (let i = 0; i < raw.length; i++) {
    if (mark[i] && !open) { out += "<mark>"; open = true; }
    if (!mark[i] && open) { out += "</mark>"; open = false; }
    out += esc(raw[i]);
  }
  return out + (open ? "</mark>" : "");
}
// 中文输入法拼音还在组字时不要触发搜索重绘（重绘会把输入框换掉，拼了一半的字直接没了）
const IME_ATTRS = `oncompositionstart="A._ime=true" oncompositionend="A._ime=false;this.dispatchEvent(new Event('input'))"`;

/* ---- 加载中用骨架屏，空状态带图标和下一步提示 ---- */
function skeletonHtml(rows, card) {
  const n = rows || 3;
  const inner = Array.from({ length: n }, () => `<div class="sk-row"><span class="sk sk-av"></span>
    <span class="sk-lines"><span class="sk sk-l1"></span><span class="sk sk-l2"></span></span></div>`).join("");
  return card === false ? inner : `<section class="group"><div class="card" aria-busy="true" aria-label="加载中">${inner}</div></section>`;
}
function emptyHtml(text, ic, actionHtml) {
  return `<div class="empty">${ic ? `<span class="empty-ic">${icon(ic)}</span>` : ""}<div>${esc(text)}</div>${actionHtml || ""}</div>`;
}
const me = () => state.me;
// 管理员/主管才看得到「管理」「薪资管理」等入口；名单只在服务端维护（/me 返回 canManage）
const isManager = () => !!me() && !!me().canManage;
const roleLabelOf = u => u ? (u.roleLabel || (u.role === "admin" ? "工厂管理员" : "员工")) : "";
// 员工名单：管理员不算计件工人，考勤录入的选人、管理页的员工表格都不列他们
const staffUsers = () => (state.users || []).filter(u => u.role !== "admin");
const COMPANY_NAME = "惠锦制衣有限公司";
const APP_NAME = "计件跟踪";
const APP_LOGO = `
  <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="lg-bg" x1="60" y1="30" x2="440" y2="490" gradientUnits="userSpaceOnUse">
        <stop stop-color="#8E63E6"/><stop offset=".55" stop-color="#6A3FC1"/><stop offset="1" stop-color="#422384"/>
      </linearGradient>
      <linearGradient id="lg-gloss" x1="90" y1="60" x2="300" y2="300" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FFFFFF" stop-opacity=".22"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="512" height="512" rx="116" fill="url(#lg-bg)"/>
    <path d="M116 0h280a116 116 0 0 1 116 116v70C420 96 300 40 176 40 152 40 128 42 106 46A116 116 0 0 1 116 0Z" fill="url(#lg-gloss)"/>
    <path d="M174 92H338A24 24 0 0 1 362 116V282H150V116A24 24 0 0 1 174 92Z" fill="#FFFFFF"/>
    <rect x="202" y="133" width="108" height="108" rx="16" stroke="#6A3FC1" stroke-width="22"/>
    <rect x="237" y="168" width="38" height="38" rx="6" fill="#6A3FC1"/>
    <path d="M150 316H362V396A24 24 0 0 1 338 420H174A24 24 0 0 1 150 396Z" fill="#FFFFFF" transform="rotate(9 256 368)"/>
  </svg>`;

// 工具格子图标：统一的线条图标，用 currentColor 以便跟主题色走
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
  close: `<path d="M6 6l12 12M18 6L6 18"/>`,
  search: `<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>`,
  camera: `<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.4-2h6.2l1.4 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/>`,
  image: `<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="9" cy="10" r="1.7"/><path d="M4 17l4.8-4.6 3.4 3.2 2.6-2.4L20 17.6"/>`,
  torch: `<path d="M8 3h8v4l-2 3v10h-4V10L8 7z"/><path d="M8 7h8"/>`,
  inbox: `<path d="M4 13l2.2-7.2A1.5 1.5 0 0 1 7.6 4.7h8.8a1.5 1.5 0 0 1 1.4 1.1L20 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M4 13h4.5l1 2h5l1-2H20"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7.5"/>`,
  refresh: `<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19 4.5V8h-3.5"/>`,
};
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;

/* ================= API ================= */
// 断网 / 超时要给人话提示，不能落到"操作失败"：车间 Wi-Fi 时好时坏，工人得知道是网的问题、重试就行。
// 超时按请求体大小放宽：带图保存款式动辄几 MB，弱网下 20 秒传不完。
async function api(method, path, body) {
  const headers = {};
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const opts = { method, headers };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const big = opts.body && opts.body.length > 200 * 1024;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), big ? 120000 : 20000) : null;
  if (ctrl) opts.signal = ctrl.signal;
  let r;
  try { r = await fetch("/api" + path, opts); }
  catch (e) {
    throw { error: e && e.name === "AbortError" ? "请求超时，请检查网络后重试" : "网络连接失败，请检查网络后重试", network: true };
  } finally { if (timer) clearTimeout(timer); }
  if (r.status === 401 && state.token) { A.forceLogout(); throw { error: "登录已失效，请重新登录" }; }
  let j = null; try { j = await r.json(); } catch (e) { }
  if (!r.ok) throw (j || { error: r.status >= 500 ? "服务器开小差了，请稍后再试" : "请求失败" });
  if (j === null) throw { error: "数据没收全，请检查网络后重试", network: true };
  return j;
}
// 执行一个动作 → 重新拉当前页数据 → 重绘；返回 fn() 的结果（成功）或 undefined（失败并已 toast 提示）
async function run(fn, okMsg) {
  try { const result = await fn(); await loadView(route.v); render(); if (okMsg) toast(okMsg); return result; }
  catch (e) { toast((e && e.error) || "操作失败"); return undefined; }
}

/* ---- 通知未读数轮询：只更新红点不整页重绘（免得冲掉正在填的表单），后台暂停，失败退避 ---- */
const POLL_MS = 15000;
let notifTimer = null, pollFails = 0, polling = false;
const badgeText = n => n > 99 ? "99+" : String(n);
function badgeHtml(cls) {
  const n = state.notif.unread;
  return `<span class="${cls || "badge"}" data-badge="notif"${n ? "" : " hidden"}>${badgeText(n)}</span>`;
}
function updateBadges() {
  const n = state.notif.unread;
  document.querySelectorAll("[data-badge=notif]").forEach(el => { el.textContent = badgeText(n); el.hidden = !n; });
}
async function refreshNotifUnread() {
  const r = await api("GET", "/notifications/unread-count");
  const grew = r.total > state.notif.unread;
  if (r.total === state.notif.unread) return;
  state.notif.unread = r.total; updateBadges();
  // 正看着通知列表时来了新消息，重新拉一次
  if (grew && (route.v === "notifs" || notifPanelOpen)) A.loadNotifs();
}
function schedulePoll(ms) { clearTimeout(notifTimer); notifTimer = setTimeout(pollTick, ms); }
async function pollTick() {
  if (!polling || document.hidden) return;         // 后台不轮询，visibilitychange 回来时再续上
  try { await refreshNotifUnread(); pollFails = 0; } catch (e) { pollFails++; }
  schedulePoll(Math.min(120000, POLL_MS * Math.pow(2, pollFails)));
}
function startNotifPoll() {
  if (polling) return;
  polling = true; pollFails = 0; pollTick();
}
function stopNotifPoll() { polling = false; clearTimeout(notifTimer); notifTimer = null; }
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (state.scan.camOn) A.stopCamera(); return; }   // 切后台顺手关摄像头，别在兜里亮着
  if (polling) { pollFails = 0; schedulePoll(0); }
});

// /style-options 接口拉回来的尺码/颜色/客户选项池，取值时兜底成空数组
function setStyleOptions(o) { state.styleOptions = { sizes: o.sizes || [], colors: o.colors || [], customers: o.customers || [] }; }
const getDailyWage = () => api("GET", "/settings/daily-wage").catch(() => ({ value: 100 }));

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
      state.notif.recent = ((await api("GET", "/notifications").catch(() => ({ list: [] }))).list || []).slice(0, 5);
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
  if (v === "processes") {
    const [t, roleRes, w] = await Promise.all([
      api("GET", "/process-templates"),
      api("GET", "/roles").catch(() => ({ roles: [] })),  // 普通员工取不到岗位列表就留空，不阻塞页面
      getDailyWage()
    ]);
    state.tplList = t.list || [];
    state.dailyWage = w.value || 100;
    state.tplRoles = roleRes.roles || [];
    return;
  }
  if (v === "styles") {
    const [s, o, p, w] = await Promise.all([
      api("GET", "/styles"), api("GET", "/style-options").catch(() => ({})), api("GET", "/processes"),
      getDailyWage()
    ]);
    state.dailyWage = w.value || 100;
    state.styles = s.styles || []; state.processes = p.processes || [];
    setStyleOptions(o);
    backfillThumbs();
    return;
  }
  if (v === "mine") { await A.refreshPushState(); }
  if (v === "cutform") {
    const [s2, o] = await Promise.all([
      state.styles ? Promise.resolve({ styles: state.styles }) : api("GET", "/styles"),
      api("GET", "/style-options").catch(() => ({}))
    ]);
    state.styles = s2.styles || [];
    setStyleOptions(o);
    const st = state.styles.find((x) => x.id === route.id);
    // 换了款式就重建表单；同一个款式来回进出保留用户填了一半的内容
    if (!state.cf || state.cf.styleId !== route.id) {
      state.cf = {
        styleId: route.id, styleName: st ? (st.code || st.name) : "",
        bedNo: "", docNo: "", customer: (st && st.customer) || "", cutDate: todayStr(), shipDate: "",
        orderNo: "", bedNote: "", ticketNote: "", companyName: COMPANY_NAME,
        // 候选 = 这个款式已选的颜色/尺码；默认全部带上，省得每张单重选一遍
        styleColors: String((st && st.color) || "").split(",").map(x => x.trim()).filter(Boolean),
        styleSizes: String((st && st.size) || "").split(",").map(x => x.trim()).filter(Boolean),
        colors: String((st && st.color) || "").split(",").map(x => x.trim()).filter(Boolean),
        sizes: String((st && st.size) || "").split(",").map(x => x.trim()).filter(Boolean),
        cells: {}, startNo: 1,
        // multiple 默认开：车间的说法是"件数=每张菲票多少件，扎数=打几张菲票"，
        // 关掉是"把总件数按扎数平分"，那是少数情况。
        customNo: false, customVat: false, rowCopy: true, colCopy: false, multiple: true, sameBundles: false,
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
      copies: 1, template: "label60x40", rotate: false, perNote: false, showPrice: false,
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
    const [r, roleRes, w] = await Promise.all([
      api("GET", `/styles/${route.id}/processes`),
      api("GET", "/roles").catch(() => ({ roles: [] })),  // 普通员工没有管理权限，取不到岗位列表就留空，不阻塞页面
      getDailyWage()
    ]);
    state.dailyWage = w.value || 100;
    if (!state.styles) state.styles = (await api("GET", "/styles")).styles || [];
    const style = state.styles.find((s) => s.id === route.id) || {};
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
    return;
  }
  if (v === "efficiency") {
    state.eff.list = (await api("GET", "/efficiency/summary?month=" + state.eff.month)).list || [];
    return;
  }
  if (v === "scanlog") {
    const r = await api("GET", "/scan-all?date=" + state.slog.date);
    state.slog.records = r.records || [];
    state.slog.scope = r.scope || "mine";
    return;
  }
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

/* ================= 图片：选择 / 压缩 / 缩略图 / 大图查看 ================= */
// 款式图 base64 存库，另存 360px 缩略图给列表用。压缩逐张排队（防老安卓内存不够），
// 不会按 EXIF 摆正的老 WebView 手动转正，透明 PNG 先铺白底。
const PHOTO_MAX = 9;                    // 一个款式最多 9 张（跟微信发图一样）
const PHOTO_EDGE = 1600;                // 原图最长边
const PHOTO_TARGET = 380 * 1024;        // 单张原图目标体积
const THUMB_EDGE = 360;                 // 缩略图最长边（卡片上 84px × 3 倍屏 ≈ 252px，留点余量）
const IMG_LIMIT = 6 * 1024 * 1024;      // 一个款式所有原图 data URI 总长上限（服务端 JSON 上限 8MB）
const CANVAS_MAX_AREA = 16 * 1000 * 1000;
const HEIC_MSG = "这张是 HEIC 格式，当前浏览器打不开。iPhone 可在「设置 › 相机 › 格式」选「兼容性最佳」，或截个图再传";
let photoDraft = {};            // { 上下文key: [{ key, src, data, status, file, err }] } 表单里正在编辑的照片
let photoSeq = 0;
let lightbox = null;            // 大图查看器状态 { photos:[{src,thumb}], i, ctx?, styleId?, loading? }

// 历史数据里个别款式图地址不是浏览器能加载的格式（不是 data:/http(s):/站内路径），只显示占位
const showable = u => /^(data:|https?:|\/|blob:)/.test(String(u || ""));
function normalizePhotos(v) {
  if (Array.isArray(v)) return v.filter(x => typeof x === "string" && x);
  if (typeof v === "string" && v) return [v];
  return [];
}
const photoItem = url => ({ key: "p" + (++photoSeq), src: url, data: url, status: "ready" });
const draftReady = ctx => (photoDraft[ctx] || []).filter(p => p.status === "ready");

// 浏览器画 <img> 到 canvas 时会不会自动按 EXIF 摆正（Chrome 81+ / Safari 13.1+ / Firefox 77+ 会）
const AUTO_ORIENT = (function () {
  try { return !!(window.CSS && CSS.supports && CSS.supports("image-orientation", "from-image")); } catch (e) { return false; }
})();
function readHead(blob, n) {
  const part = blob.slice(0, n);
  if (part.arrayBuffer) return part.arrayBuffer();
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(part); });
}
// 读 JPEG 的 EXIF 方向（1~8），读不到一律当 1。EXIF 都在文件开头，只扫前 128KB
async function exifOrientation(file) {
  try {
    const v = new DataView(await readHead(file, 128 * 1024));
    if (v.getUint16(0) !== 0xFFD8) return 1;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xFF00) !== 0xFF00) return 1;
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) {      // APP1 段，"Exif"
        const tiff = off + 10, little = v.getUint16(tiff) === 0x4949;
        const ifd = tiff + v.getUint32(tiff + 4, little);
        const count = v.getUint16(ifd, little);
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (v.getUint16(e, little) === 0x0112) return v.getUint16(e + 8, little) || 1;
        }
        return 1;
      }
      off += 2 + v.getUint16(off + 2);
    }
  } catch (e) { }
  return 1;
}
function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode"));
    img.src = src;
  });
}
function makeCanvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
// EXIF 方向 → 画布变换（w×h 是摆正后的输出尺寸）
function orientTransform(ctx, o, w, h) {
  const T = { 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, w, 0], 7: [0, -1, -1, 0, w, h], 8: [0, -1, 1, 0, 0, h] }[o];
  if (T) ctx.transform(T[0], T[1], T[2], T[3], T[4], T[5]);
}
// 缩到最长边 maxEdge：先对半缩（每步 2 倍以内插值才不出锯齿/摩尔纹），最后一步带方向变换落到目标尺寸
function drawScaled(img, maxEdge, orient) {
  const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  const rot = orient >= 5 && orient <= 8;
  const ow = rot ? sh : sw, oh = rot ? sw : sh;                     // 摆正后的宽高
  const k = Math.min(1, maxEdge / Math.max(ow, oh));
  const tw = Math.max(1, Math.round(ow * k)), th = Math.max(1, Math.round(oh * k));
  const dw = rot ? th : tw, dh = rot ? tw : th;                     // 在"未旋转"坐标系里要画的尺寸
  let src = img, cw = sw, ch = sh;
  while (cw > dw * 2 && ch > dh * 2) {
    let nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    if (nw * nh > CANVAS_MAX_AREA) { const f = Math.sqrt(CANVAS_MAX_AREA / (cw * ch)); nw = Math.floor(cw * f); nh = Math.floor(ch * f); }
    const c = makeCanvas(nw, nh), x = c.getContext("2d");
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.drawImage(src, 0, 0, nw, nh);
    if (src !== img) src.width = src.height = 0;                     // 中间画布用完就释放，iOS 画布内存很紧
    src = c; cw = nw; ch = nh;
  }
  const out = makeCanvas(tw, th), ctx = out.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, tw, th);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  orientTransform(ctx, orient, tw, th);
  ctx.drawImage(src, 0, 0, dw, dh);
  if (src !== img) src.width = src.height = 0;
  return out;
}
function dataUrlToBlob(u) {
  const parts = u.split(","), bin = atob(parts[1]), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: (parts[0].match(/data:([^;]+)/) || [])[1] || "image/jpeg" });
}
function canvasToBlob(c, q) {
  return new Promise((resolve) => {
    if (c.toBlob) c.toBlob(b => resolve(b), "image/jpeg", q);
    else resolve(dataUrlToBlob(c.toDataURL("image/jpeg", q)));
  });
}
function blobToDataUrl(b) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
}
// 先用 0.86 编一次，没超目标体积就用它；超了再二分找"不超标的最高质量"，最多再编 5 次
async function encodeJpeg(c, target) {
  const first = await canvasToBlob(c, 0.86);
  if (!first) throw new Error("encode");
  if (first.size <= target) return first;
  let lo = 0.45, hi = 0.86, best = null;
  for (let k = 0; k < 5; k++) {
    const mid = (lo + hi) / 2, t = await canvasToBlob(c, mid);
    if (t && t.size <= target) { best = t; lo = mid; } else hi = mid;
  }
  return best || (await canvasToBlob(c, 0.45)) || first;
}
async function compressPhoto(file) {
  const heic = /hei[cf]/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || "");
  if (file.type && !/^image\//.test(file.type)) throw { error: "不是图片文件", short: "不是图片" };
  const url = URL.createObjectURL(file);
  try {
    let img;
    try { img = await loadImg(url); }
    catch (e) { throw { error: heic ? HEIC_MSG : "这张图片打不开，可能已损坏或格式不支持", short: heic ? "HEIC 格式" : "打不开" }; }
    const orient = AUTO_ORIENT ? 1 : await exifOrientation(file);
    const c = drawScaled(img, PHOTO_EDGE, orient);
    const blob = await encodeJpeg(c, PHOTO_TARGET);
    c.width = c.height = 0;
    return await blobToDataUrl(blob);
  } finally { URL.revokeObjectURL(url); }
}
// 缩略图：从原图再压一张小的（最长边 360，控制在 60KB 以内）
async function makeThumb(src) {
  const img = await loadImg(src);
  const c = drawScaled(img, THUMB_EDGE, 1);
  let q = 0.74, out = c.toDataURL("image/jpeg", q);
  while (out.length > 60 * 1024 && q > 0.4) { q -= 0.12; out = c.toDataURL("image/jpeg", q); }
  c.width = c.height = 0;
  return out;
}
// 压缩排队：一次只处理一张，避免同时解码多张大图把内存吃爆
let photoQueue = Promise.resolve();
function queuePhoto(ctx, item) {
  photoQueue = photoQueue.then(async () => {
    if ((photoDraft[ctx] || []).indexOf(item) < 0) return;          // 排队期间被删掉了
    try {
      const data = await compressPhoto(item.file);
      if ((photoDraft[ctx] || []).indexOf(item) < 0) return;
      const used = draftReady(ctx).reduce((s, p) => s + p.data.length, 0);
      if (used + data.length > IMG_LIMIT) throw { error: "图片总量超出上限，请删掉几张再加", short: "超出上限", fatal: true };
      if (String(item.src).indexOf("blob:") === 0) URL.revokeObjectURL(item.src);
      item.src = item.data = data; item.status = "ready"; item.file = null;
    } catch (e) {
      item.status = "error"; item.err = (e && e.short) || "处理失败";
      if (e && e.fatal) item.file = null;
      toast((e && e.error) || "图片处理失败");
    }
    refreshPicker(ctx);
  });
  return photoQueue;
}
function clearPhotoDraft() {
  Object.keys(photoDraft).forEach(k => (photoDraft[k] || []).forEach(p => {
    if (String(p.src).indexOf("blob:") === 0) URL.revokeObjectURL(p.src);
  }));
  photoDraft = {};
}
function refreshPicker(ctx) { const el = $("pe-" + ctx); if (el) el.innerHTML = pickerInner(ctx); }
// 拍照和相册拆成两个独立入口：部分手机(尤其华为)系统选择器在 <input multiple> 上会隐藏"拍照"选项
// (一次拍照只能出一张图，跟多选语义冲突)，只拆开两个按钮才能保证两条路都能用。电脑上没有"拍照"这回事，只留一个。
function pickerInner(ctx) {
  if (ctx === "style" && styleForm && styleForm.imagesLocked) {
    return `<div class="ph-hint">原图没加载出来，图片暂时不能改。<button type="button" class="link-btn" onclick="A.loadStyleImages()">重新加载</button></div>`;
  }
  const list = photoDraft[ctx] || [];
  const mobile = isMobileDevice();
  const thumbs = list.map((p, i) => `<div class="ph-thumb is-${p.status}">
      ${showable(p.src) ? `<img src="${esc(p.src)}" alt="款式图 ${i + 1}" decoding="async" onclick="A.viewDraft('${ctx}','${p.key}')">`
        : p.status === "processing" ? `<div class="ph-na sk"></div>` : `<div class="ph-na">图片已失效<br>请重新上传</div>`}
      ${i === 0 && p.status === "ready" ? `<span class="ph-cover">封面</span>` : ""}
      ${p.status === "processing" ? `<span class="ph-state" aria-label="处理中"><i class="spin"></i></span>` : ""}
      ${p.status === "error" ? `<button type="button" class="ph-state err" ${p.file ? `onclick="A.retryPhoto('${ctx}','${p.key}')"` : "disabled"}>
          <span>${esc(p.err || "失败")}</span>${p.file ? "<b>点击重试</b>" : ""}</button>` : ""}
      <button type="button" class="ph-x" onclick="A.removeDraftPhoto('${ctx}','${p.key}')" aria-label="移除第 ${i + 1} 张">${icon("close")}</button>
    </div>`).join("");
  const adders = list.length >= PHOTO_MAX ? "" :
    (mobile ? `<label class="ph-add"><input type="file" accept="image/*" capture="environment" hidden onchange="A.addDraftPhotos('${ctx}',this)">
      ${icon("camera")}<span>拍照</span></label>` : "") +
    `<label class="ph-add"><input type="file" accept="image/*" multiple hidden onchange="A.addDraftPhotos('${ctx}',this)">
      ${icon("image")}<span>${mobile ? "相册" : "添加图片"}</span></label>`;
  return thumbs + adders + `<div class="ph-hint">${list.length}/${PHOTO_MAX} 张 · 第一张是封面，点开大图可以换封面${mobile ? "" : " · 也可以把图片拖进来或直接粘贴"}</div>`;
}
function photoPicker(ctx) { return `<div class="photos-grid editable" id="pe-${ctx}" data-ctx="${ctx}">${pickerInner(ctx)}</div>`; }
function styleImages(s) {
  let imgs = [];
  try { imgs = s.images ? JSON.parse(s.images) : []; } catch (e) { imgs = []; }
  if ((!imgs || !imgs.length) && s.image) imgs = [s.image];
  return normalizePhotos(imgs);
}
// 卡片里的键值格（value 须已转义）与"裁床 → 交货"日期行
const kv = (k, v) => `<span class="sc-cell"><span class="sc-k">${k}：</span><span class="sc-v">${v}</span></span>`;
const datesCell = o => `<span class="sc-cell sc-dates"><span class="sc-k">裁床</span><span class="sc-v">${esc(o.cut_date || "—")}</span>
  <span class="sc-arrow">→</span><span class="sc-k">交货</span><span class="sc-v">${esc(o.ship_date || "—")}</span></span>`;
// 工序进度条那一行
const progRowHtml = (pct, style) => `<div class="cc-prog"${style ? ` style="${style}"` : ""}>
  <span class="cc-prog-t">工序进度</span>
  <div class="pbar"><i style="width:${pct}%"></i></div><span class="cc-pct num">${pct}%</span></div>`;
// 扎的颜色 / 件数 / 尺码
const bundleCells = b => kv("颜色", esc(b.color || "—")) + kv("件数", num(b.qty)) + kv("尺码", esc(b.size || "—"));
// 带款式缩略图的裁床单单头
function orderHeadHtml(o, cells) {
  return `<div class="sc-head">${styleThumbHtml(o.style_id, o.style_image)}
    <div class="sc-info"><div class="sc-title">款号 ${esc(o.style_code || o.style_name || "—")}</div>
      <div class="sc-grid">${cells}</div></div></div>`;
}
// 卡片上的款式缩略图：点开看大图（先用缩略图垫着，原图到了再换上）
function styleThumbHtml(styleId, src, count, cls) {
  return showable(src)
    ? `<img class="${cls || "sc-thumb"}" src="${esc(src)}" alt="款式图" loading="lazy" decoding="async"
        data-count="${Number(count) || 1}" onclick="event.stopPropagation();A.viewStyle('${styleId}',this)">`
    : `<div class="${cls || "sc-thumb"} sc-noimg" aria-hidden="true">${icon("image")}</div>`;
}
// 点开大图时按款式取原图，留最近 8 个款的原图在内存里，来回看不重复下载
const fullImgCache = new Map();
function cacheFullImgs(id, imgs) {
  fullImgCache.delete(id);
  if (imgs) fullImgCache.set(id, imgs);
  while (fullImgCache.size > 8) fullImgCache.delete(fullImgCache.keys().next().value);
}
// 老款式没有缩略图：列表拿到的是封面原图，趁空闲在后台压一张缩略图补上，以后列表就轻了
const thumbTried = {};
function backfillThumbs() {
  const todo = (state.styles || []).filter(s => s.image && !s.has_thumb && showable(s.image) && !thumbTried[s.id]);
  if (!todo.length) return;
  todo.forEach(s => { thumbTried[s.id] = true; });
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 800));
  idle(async () => {
    for (const s of todo) {
      const src = s.image;
      // 列表可能已经刷新过，按最新数据判断还要不要补
      const cur = (state.styles || []).find(x => x.id === s.id);
      if (!cur || cur.has_thumb || cur.image !== src) continue;
      try {
        const t = await makeThumb(src);
        await api("PUT", `/styles/${s.id}/thumb`, { thumb: t, srcLen: src.length });
        if (cur.image === src) { cur.image = t; cur.has_thumb = true; }
      } catch (e) { }
      await new Promise(r => setTimeout(r, 80));
    }
  });
}

/* ---- 大图查看器 ----
 * 手势跟微信/系统相册一致：双指缩放、拖动带阻尼惯性、双击缩放、左右滑切图、下拉关闭；电脑上滚轮缩放、←→切图、Esc 关闭。
 * 所有动画都从当前值+松手速度起步，用临界阻尼弹簧收尾，任何时候都能按住打断，不用等动画播完。 */
const REDUCED_MOTION = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
// 越界阻尼：拉得越远跟得越少（iOS 橡皮筋的同一个公式）
function rubber(over, dim) { return (over * dim * 0.55) / (dim + 0.55 * over); }
// 按当前速度（px/s）"扔出去"最终会滑多远：跟系统滚动减速同一个指数衰减模型
function project(v, d) { return (v / 1000) * d / (1 - d); }
// 临界阻尼弹簧：每个通道 { from, to, v }，带初速度收敛到目标
function spring(ch, onFrame, onDone, response) {
  const keys = Object.keys(ch);
  if (REDUCED_MOTION) { const o = {}; keys.forEach(k => { o[k] = ch[k].to; }); onFrame(o); if (onDone) onDone(); return () => { }; }
  const w = 2 * Math.PI / (response || 0.38), t0 = performance.now();
  const C = keys.map(k => { const c = ch[k], a0 = c.from - c.to; return { k, to: c.to, a: a0, b: (c.v || 0) + w * a0, eps: c.eps || 0.4 }; });
  let raf = 0, stopped = false;
  const frame = (now) => {
    if (stopped) return;
    const t = (now - t0) / 1000, e = Math.exp(-w * t), o = {};
    let settled = true;
    C.forEach(c => {
      const x = c.to + (c.a + c.b * t) * e, v = (c.b - w * (c.a + c.b * t)) * e;
      o[c.k] = x;
      if (Math.abs(x - c.to) > c.eps || Math.abs(v) > c.eps * 20) settled = false;
    });
    if (settled || t > 2.5) { C.forEach(c => { o[c.k] = c.to; }); onFrame(o); if (onDone) onDone(); return; }
    onFrame(o); raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => { stopped = true; cancelAnimationFrame(raf); };
}

const V = { el: null, stop: null, s: 1, tx: 0, ty: 0, page: 0, ptrs: new Map(), mode: null, st: null, mid: null,
  hist: [], tapT: 0, tapX: 0, tapY: 0, tapTimer: 0, gap: 18 };
function openViewer(photos, i, extra) {
  if (!photos || !photos.length) return;
  lightbox = Object.assign({ photos, i: Math.max(0, Math.min(i || 0, photos.length - 1)) }, extra || {});
  renderLightbox();
}
function buildViewer() {
  const el = document.createElement("div");
  el.id = "lightbox"; el.className = "lightbox";
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "查看图片");
  el.innerHTML = `<div class="lb-bg"></div>
    <div class="lb-track">${[-1, 0, 1].map(k => `<div class="lb-slide" data-k="${k}">
      <div class="lb-frame"><img class="lb-low" alt="" aria-hidden="true" draggable="false"><img class="lb-img" alt="" draggable="false"></div>
      <i class="spin lb-spin" aria-hidden="true"></i>
      <button type="button" class="lb-err">图片加载失败，点这里重试</button></div>`).join("")}</div>
    <div class="lb-top"><span class="lb-count num"></span>
      <button type="button" class="lb-btn lb-close" aria-label="关闭">${icon("close")}</button></div>
    <button type="button" class="lb-nav prev" aria-label="上一张">‹</button>
    <button type="button" class="lb-nav next" aria-label="下一张">›</button>
    <div class="lb-bottom"><div class="lb-dots"></div><div class="lb-acts"></div></div>`;
  document.body.appendChild(el);
  V.el = el;
  el.querySelector(".lb-close").onclick = () => A.closeLightbox();
  el.querySelector(".lb-nav.prev").onclick = () => A.lbStep(-1);
  el.querySelector(".lb-nav.next").onclick = () => A.lbStep(1);
  el.querySelectorAll(".lb-err").forEach(b => {
    b.onclick = () => {
      const sl = b.closest(".lb-slide"), img = sl.querySelector(".lb-img"), u = img.getAttribute("src");
      sl.classList.remove("err");
      if (u) { img.removeAttribute("src"); sl.classList.add("loading"); img.src = u; }
    };
  });
  el.addEventListener("pointerdown", lbDown);
  el.addEventListener("pointermove", lbMove);
  el.addEventListener("pointerup", lbUp);
  el.addEventListener("pointercancel", lbUp);
  el.addEventListener("wheel", lbWheel, { passive: false });
  document.documentElement.classList.add("lb-lock");
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
  return el;
}
function renderLightbox() {
  let el = $("lightbox");
  if (!lightbox) {
    if (el && !el._closing) {
      el._closing = true; el.classList.add("out"); vStop();
      setTimeout(() => { el.remove(); if (V.el === el) V.el = null; }, REDUCED_MOTION ? 0 : 200);
    }
    document.documentElement.classList.remove("lb-lock");
    V.ptrs.clear(); clearTimeout(V.tapTimer);
    syncOverlayHistory();
    return;
  }
  if (!el || el._closing) { if (el) el.remove(); el = buildViewer(); }
  layoutViewer();
  syncOverlayHistory();
}
const vSize = () => ({ W: V.el.clientWidth || window.innerWidth, H: V.el.clientHeight || window.innerHeight });
const curSlide = () => V.el.querySelector('.lb-slide[data-k="0"]');
const curFrame = () => curSlide().querySelector(".lb-frame");
function layoutViewer() {
  const lb = lightbox, n = lb.photos.length, W = vSize().W;
  vStop();
  V.el.querySelectorAll(".lb-slide").forEach(sl => {
    const k = +sl.dataset.k, idx = lb.i + k;
    sl.style.transform = `translate3d(${k * (W + V.gap)}px,0,0)`;
    fillSlide(sl, idx >= 0 && idx < n ? lb.photos[idx] : null);
  });
  V.s = 1; V.tx = 0; V.ty = 0; V.page = 0;
  vApplyTrack(); vApplyImg(); vBg(1);
  V.el.querySelector(".lb-count").textContent = n > 1 ? `${lb.i + 1} / ${n}` : "";
  V.el.querySelector(".lb-dots").innerHTML = n > 1 && n <= 9 ? lb.photos.map((_, k) => `<i class="${k === lb.i ? "on" : ""}"></i>`).join("") : "";
  V.el.querySelector(".lb-nav.prev").hidden = lb.i <= 0;
  V.el.querySelector(".lb-nav.next").hidden = lb.i >= n - 1;
  V.el.querySelector(".lb-acts").innerHTML = lb.ctx ? `
    <button type="button" class="lb-act" ${lb.i === 0 ? "disabled" : ""} onclick="A.lbSetCover()">${lb.i === 0 ? "当前是封面" : "设为封面"}</button>
    <button type="button" class="lb-act danger" onclick="A.lbDelete()">${icon("trash")}<span>删除</span></button>` : "";
}
function fillSlide(sl, ph) {
  sl.hidden = !ph;
  if (!ph) return;
  const low = sl.querySelector(".lb-low"), img = sl.querySelector(".lb-img");
  const setSrc = (el, u) => { if ((el.getAttribute("src") || "") !== (u || "")) { if (u) el.src = u; else el.removeAttribute("src"); } };
  sl.classList.remove("err");
  low.onload = () => fitFrame(sl);
  low.hidden = !ph.thumb;
  setSrc(low, ph.thumb || "");
  if (ph.src) {
    const ready = () => { sl.classList.remove("loading"); sl.classList.add("full"); fitFrame(sl); };
    img.onload = ready;
    img.onerror = () => { sl.classList.remove("loading"); sl.classList.add("err"); };
    sl.classList.remove("full");
    setSrc(img, ph.src);
    if (img.complete && img.naturalWidth) ready(); else sl.classList.add("loading");
  } else { img.removeAttribute("src"); sl.classList.remove("full"); sl.classList.add("loading"); }
  fitFrame(sl);
}
// 让图片"刚好塞满屏幕"（contain），记下这个尺寸，缩放/拖动的边界都以它为准
function fitFrame(sl) {
  const img = sl.querySelector(".lb-img"), low = sl.querySelector(".lb-low"), frame = sl.querySelector(".lb-frame");
  const src = img.getAttribute("src") && img.naturalWidth ? img : (low.getAttribute("src") && low.naturalWidth ? low : null);
  const { W, H } = vSize();
  let fw = Math.min(W, H) * 0.7, fh = fw;
  if (src) { const k = Math.min(W / src.naturalWidth, H / src.naturalHeight); fw = src.naturalWidth * k; fh = src.naturalHeight * k; }
  frame.style.width = fw + "px"; frame.style.height = fh + "px";
  frame._fw = fw; frame._fh = fh;
}
function vApplyImg() { const f = curFrame(); if (f) f.style.transform = `translate3d(${V.tx}px,${V.ty}px,0) scale(${V.s})`; }
function vApplyTrack() { V.el.querySelector(".lb-track").style.transform = `translate3d(${V.page}px,0,0)`; }
function vBg(a) { V.el.querySelector(".lb-bg").style.opacity = Math.max(0, Math.min(1, a)); V.el.classList.toggle("dragging", a < 1); }
function vBounds(s) {
  const f = curFrame(), { W, H } = vSize();
  return { x: Math.max(0, ((f._fw || W) * s - W) / 2), y: Math.max(0, ((f._fh || H) * s - H) / 2) };
}
function vClamp(s, tx, ty) { const b = vBounds(s); return { tx: Math.max(-b.x, Math.min(b.x, tx)), ty: Math.max(-b.y, Math.min(b.y, ty)) }; }
function vStop() { if (V.stop) { V.stop(); V.stop = null; } }
function vAnim(to, vel, done, resp) {
  vStop();
  const ch = {};
  ["s", "tx", "ty", "page"].forEach(k => {
    if (to[k] !== undefined) ch[k] = { from: V[k], to: to[k], v: (vel && vel[k]) || 0, eps: k === "s" ? 0.002 : 0.4 };
  });
  V.stop = spring(ch, o => { Object.assign(V, o); vApplyImg(); vApplyTrack(); }, () => { V.stop = null; if (done) done(); }, resp);
}
// 以屏幕上 (mx,my) 这一点为中心把缩放从 V.s 换到 s：保证手指/鼠标底下那一点不动
function vZoomAt(s, mx, my) {
  const { W, H } = vSize(), cx = W / 2, cy = H / 2;
  const px = (mx - cx - V.tx) / V.s, py = (my - cy - V.ty) / V.s;
  return { tx: mx - cx - s * px, ty: my - cy - s * py };
}
function vVelocity() {
  const h = V.hist; if (h.length < 2) return { x: 0, y: 0 };
  const a = h[0], b = h[h.length - 1], dt = b.t - a.t;
  return dt < 8 ? { x: 0, y: 0 } : { x: (b.x - a.x) / dt * 1000, y: (b.y - a.y) / dt * 1000 };
}
function lbDown(e) {
  if (!lightbox || e.target.closest("button")) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  try { V.el.setPointerCapture(e.pointerId); } catch (x) { }
  vStop();
  V.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (V.ptrs.size === 1) {
    V.mode = "pending";
    V.st = { x: e.clientX, y: e.clientY, s: V.s, tx: V.tx, ty: V.ty };
    V.hist = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
  } else if (V.ptrs.size === 2) {
    const pts = [...V.ptrs.values()], a = pts[0], b = pts[1];
    if (V.page) { V.page = 0; vApplyTrack(); }
    if (V.mode === "drop") { V.s = 1; V.tx = 0; V.ty = 0; vBg(1); }
    V.mode = "pinch"; clearTimeout(V.tapTimer); V.tapT = 0;
    V.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    V.st = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: V.mid.x, my: V.mid.y, s: V.s, tx: V.tx, ty: V.ty };
  }
}
function lbMove(e) {
  if (!V.ptrs.has(e.pointerId) || !lightbox) return;
  V.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const { W, H } = vSize(), cx = W / 2, cy = H / 2;
  if (V.mode === "pinch") {
    if (V.ptrs.size < 2) return;
    const pts = [...V.ptrs.values()], a = pts[0], b = pts[1];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    let s = V.st.s * d / V.st.d;
    if (s > 5) s = 5 + (s - 5) * 0.25; else if (s < 1) s = Math.max(0.5, 1 - (1 - s) * 0.5);    // 超出范围有阻尼
    const px = (V.st.mx - cx - V.st.tx) / V.st.s, py = (V.st.my - cy - V.st.ty) / V.st.s;
    V.s = s; V.tx = mx - cx - s * px; V.ty = my - cy - s * py; V.mid = { x: mx, y: my };
    vApplyImg(); return;
  }
  const p = V.ptrs.get(e.pointerId), dx = p.x - V.st.x, dy = p.y - V.st.y, now = performance.now();
  V.hist.push({ x: p.x, y: p.y, t: now });
  while (V.hist.length > 2 && now - V.hist[0].t > 100) V.hist.shift();
  if (V.mode === "pending") {
    if (Math.hypot(dx, dy) < 8) return;                   // 8px 以内算手抖，不判方向
    clearTimeout(V.tapTimer); V.tapT = 0;
    V.mode = V.s > 1.01 ? "pan" : Math.abs(dx) > Math.abs(dy) ? "page" : dy > 0 ? "drop" : "pan";
  }
  if (V.mode === "pan") {
    const b = vBounds(V.s);
    const soft = (v, lim, dim) => v > lim ? lim + rubber(v - lim, dim) : v < -lim ? -lim - rubber(-lim - v, dim) : v;
    V.tx = soft(V.st.tx + dx, b.x, W); V.ty = soft(V.st.ty + dy, b.y, H); vApplyImg();
  } else if (V.mode === "page") {
    const n = lightbox.photos.length, i = lightbox.i;
    let off = dx;
    if ((i === 0 && off > 0) || (i === n - 1 && off < 0)) off = (off > 0 ? 1 : -1) * rubber(Math.abs(off), W);
    V.page = off; vApplyTrack();
  } else if (V.mode === "drop") {
    const k = Math.max(0, Math.min(1, dy / H));
    V.s = 1 - k * 0.35; V.tx = dx * 0.6; V.ty = dy > 0 ? dy : -rubber(-dy, H); vApplyImg(); vBg(1 - k * 1.6);
  }
}
function lbUp(e) {
  if (!V.ptrs.has(e.pointerId) || !lightbox) { V.ptrs.delete(e.pointerId); return; }
  V.ptrs.delete(e.pointerId);
  const { W, H } = vSize();
  if (V.mode === "pinch") {
    if (V.ptrs.size === 1) {                               // 抬起一根手指：剩下那根接着拖，不跳
      const p = [...V.ptrs.values()][0];
      V.mode = V.s > 1.01 ? "pan" : "pending";
      V.st = { x: p.x, y: p.y, s: V.s, tx: V.tx, ty: V.ty };
      V.hist = [{ x: p.x, y: p.y, t: performance.now() }];
    } else if (!V.ptrs.size) {
      V.mode = null;
      const s = Math.max(1, Math.min(5, V.s));
      const m = V.mid || { x: W / 2, y: H / 2 };
      const t0 = s === V.s ? { tx: V.tx, ty: V.ty } : vZoomAt(s, m.x, m.y);
      const t = s <= 1.001 ? { tx: 0, ty: 0 } : vClamp(s, t0.tx, t0.ty);
      vAnim({ s, tx: t.tx, ty: t.ty }, null, null, 0.35);
    }
    return;
  }
  if (V.ptrs.size) return;
  const mode = V.mode, v = vVelocity();
  V.mode = null;
  if (mode === "pending") { if (e.type === "pointerup") lbTap(e.clientX, e.clientY); return; }
  if (mode === "pan") {
    // 松手按速度预判最终停在哪（再夹回边界内），带着松手速度滑过去
    const t = vClamp(V.s, V.tx + project(v.x, 0.998), V.ty + project(v.y, 0.998));
    vAnim({ tx: t.tx, ty: t.ty }, { tx: v.x, ty: v.y }, null, 0.55);
  } else if (mode === "page") {
    const n = lightbox.photos.length, i = lightbox.i;
    const land = V.page + project(v.x, 0.99);            // 轻轻一甩也能翻页，慢慢拖过一半也能翻页
    const d = land < -W / 2 && i < n - 1 ? 1 : land > W / 2 && i > 0 ? -1 : 0;
    vAnim({ page: -d * (W + V.gap) }, { page: v.x }, () => { if (d && lightbox) { lightbox.i += d; layoutViewer(); } }, 0.32);
  } else if (mode === "drop") {
    if (V.ty > H * 0.16 || v.y > 700) { vDismiss(v); return; }
    vBg(1);
    vAnim({ s: 1, tx: 0, ty: 0 }, { tx: v.x, ty: v.y }, null, 0.35);
  }
}
function vDismiss(v) {
  const { H } = vSize();
  V.el.classList.add("out");
  vAnim({ ty: V.ty + Math.max(H * 0.35, project(v ? v.y : 0, 0.99)), s: V.s * 0.9 }, { ty: v ? v.y : 0 }, null, 0.3);
  setTimeout(() => A.closeLightbox(), 160);
}
// 单击关闭、双击放大/还原。单击要等 300ms 确认不是双击的第一下
function lbTap(x, y) {
  const now = performance.now();
  if (now - V.tapT < 300 && Math.hypot(x - V.tapX, y - V.tapY) < 30) {
    clearTimeout(V.tapTimer); V.tapT = 0;
    if (V.s > 1.01) { vAnim({ s: 1, tx: 0, ty: 0 }, null, null, 0.35); return; }
    const s = 2.5, t0 = vZoomAt(s, x, y), t = vClamp(s, t0.tx, t0.ty);
    vAnim({ s, tx: t.tx, ty: t.ty }, null, null, 0.35);
    return;
  }
  V.tapT = now; V.tapX = x; V.tapY = y;
  clearTimeout(V.tapTimer);
  V.tapTimer = setTimeout(() => { V.tapT = 0; if (lightbox) A.closeLightbox(); }, 300);
}
function lbWheel(e) {
  if (!lightbox) return;
  e.preventDefault(); vStop();
  const s = Math.max(1, Math.min(5, V.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
  const t0 = vZoomAt(s, e.clientX, e.clientY), t = s <= 1.001 ? { tx: 0, ty: 0 } : vClamp(s, t0.tx, t0.ty);
  V.s = s; V.tx = t.tx; V.ty = t.ty; vApplyImg();
}
window.addEventListener("resize", () => { if (lightbox && V.el && !V.el._closing) layoutViewer(); });

/* ================= 弹窗 =================
 * 窄屏从底部升起（可拖拽关闭），宽屏居中对话框；Esc 关闭、回车=确定、安卓返回键关弹窗（见 syncOverlayHistory）。 */
const isNarrow = () => !!(window.matchMedia && matchMedia("(max-width: 640px)").matches);
function modal(opts) { modalState = opts; renderModal(); }
function renderModal() {
  const mask = $("mask");
  if (!modalState) {
    if (mask.classList.contains("show") && !mask.classList.contains("closing")) {
      mask.classList.add("closing");
      clearTimeout(renderModal._t);
      renderModal._t = setTimeout(() => {
        if (!modalState) { mask.classList.remove("show", "closing"); mask.innerHTML = ""; }
      }, REDUCED_MOTION ? 0 : 200);
    }
    syncOverlayHistory();
    return;
  }
  clearTimeout(renderModal._t);
  const o = modalState;
  mask.classList.remove("closing");
  mask.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
    <div class="m-grab" aria-hidden="true"></div>
    <div class="m-title" id="m-title">${esc(o.title)}</div>
    ${o.body ? `<div class="m-body">${esc(o.body)}</div>` : ""}
    ${o.html ? `<div class="m-html">${o.html}</div>` : ""}
    ${o.input ? `<input class="in m-input" id="m-input" ${o.inputMode ? `inputmode="${o.inputMode}"` : ""} enterkeyhint="done" autocomplete="off">` : ""}
    <div class="m-actions">
      <button class="btn ghost" onclick="A.modalCancel()">${esc(o.cancelText || (o.cancelOnly ? "关闭" : "取消"))}</button>
      ${o.cancelOnly ? "" : `<button class="btn ${o.danger ? "danger" : ""}" onclick="A.modalOk()">${esc(o.okText || "确定")}</button>`}
    </div></div>`;
  // 点遮罩关闭；但弹窗里有输入框时不这么做，免得手一滑把填了一半的内容丢了
  mask.onclick = (e) => {
    if (e.target === mask && !mask.querySelector(".modal input:not([type=checkbox]), .modal textarea")) A.modalCancel();
  };
  mask.classList.add("show");
  if (o.input) {
    const i = $("m-input");
    i.value = o.value || "";
    i.onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) A.modalOk(); };
    setTimeout(() => { i.focus(); try { i.select(); } catch (x) { } }, 60);
  }
  attachSheetDrag(mask.querySelector(".modal"));
  syncOverlayHistory();
}
// 底部面板下拉关闭：只在把手和标题上按住才算拖面板，面板里的列表照常滚动
function attachSheetDrag(sheet) {
  if (!sheet || !isNarrow()) return;
  const mask = $("mask");
  let y0 = null, dy = 0, pid = null, hist = [];
  const down = (e) => {
    if (e.pointerType === "mouse") return;
    y0 = e.clientY; dy = 0; pid = e.pointerId; hist = [{ y: y0, t: performance.now() }];
    try { e.currentTarget.setPointerCapture(pid); } catch (x) { }
    sheet.classList.add("dragging");
  };
  const move = (e) => {
    if (y0 === null || e.pointerId !== pid) return;
    const d = e.clientY - y0;
    dy = d > 0 ? d : -rubber(-d, 240);                       // 往上拉有阻尼，往下跟手
    sheet.style.transform = `translate3d(0,${dy}px,0)`;
    mask.style.setProperty("--mask-a", String(Math.max(0, 1 - Math.max(0, dy) / (sheet.offsetHeight || 400))));
    const now = performance.now();
    hist.push({ y: e.clientY, t: now });
    while (hist.length > 2 && now - hist[0].t > 100) hist.shift();
  };
  const up = (e) => {
    if (y0 === null || e.pointerId !== pid) return;
    y0 = null;
    const a = hist[0], b = hist[hist.length - 1];
    const v = b.t - a.t > 8 ? (b.y - a.y) / (b.t - a.t) * 1000 : 0;
    sheet.classList.remove("dragging");
    mask.style.removeProperty("--mask-a");
    if (dy + project(v, 0.99) > sheet.offsetHeight * 0.4 || v > 900) { sheet.style.transform = "translate3d(0,110%,0)"; A.modalCancel(); }
    else sheet.style.transform = "";
  };
  sheet.querySelectorAll(".m-grab, .m-title").forEach(h => {
    h.addEventListener("pointerdown", down); h.addEventListener("pointermove", move);
    h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
  });
}

/* ================= 表单小控件 ================= */
// 真正的 input[type=date] 透明盖满按钮区域接收点击（部分手机不支持 showPicker() 会点了没反应），下面露出中文日期按钮
function dateFieldHtml(id, v, onChange) {
  return `<div class="datefield">
    <button type="button" class="in date-btn ${v ? "" : "is-empty"}" id="${id}--label" tabindex="-1">${v ? esc(fmtDate(v)) : "选择日期"}</button>
    <input type="date" id="${id}" class="date-native" value="${esc(v || "")}" autocomplete="off"
      onchange="A.syncDateLabel('${id}');${onChange}" onclick="A.openDate(this)" onfocus="A.openDate(this)"></div>`;
}
// 月份同日期做法；不支持 input[type=month] 的老浏览器会退化成文本框，改用「年+月」两个下拉兜底
const MONTH_INPUT_OK = (function () {
  const i = document.createElement("input");
  i.setAttribute("type", "month");
  return i.type === "month";
})();
function monthFieldHtml(id, v, onChange) {
  if (MONTH_INPUT_OK) {
    return `<div class="datefield">
      <button type="button" class="in date-btn ${v ? "" : "is-empty"}" id="${id}--label" tabindex="-1">${v ? esc(fmtMonth(v)) : "选择月份"}</button>
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
const VIEW_SET = { home: 1, scan: 1, mine: 1, admin: 1, processes: 1, styles: 1, styleprocs: 1, attendance: 1,
  efficiency: 1, scanlog: 1, payroll: 1, notifs: 1, cutorders: 1, cutform: 1, cutview: 1, cutprint: 1,
  cutprogress: 1, bundleprogress: 1, procprogress: 1 };
// 这几个页面离了 id 没东西可看，URL 里缺 id 时退回上级
const NEEDS_ID = { styleprocs: 1, cutform: 1, cutview: 1, cutprint: 1, cutprogress: 1, bundleprogress: 1, procprogress: 1 };

/* ================= 路由 · 返回键：每页记一条历史，浮层（弹窗/大图/表单）多垫一条，返回键先关浮层 ================= */
// history.back() 是异步的，紧跟着的历史操作要排到它完成之后，H.exec 负责排队
const H = {
  pending: 0, queue: [],
  exec(fn) { if (H.pending) H.queue.push(fn); else fn(); },
  back() {
    H.pending++; history.back();
    clearTimeout(H._t);
    H._t = setTimeout(() => { if (H.pending) { H.pending = 0; const q = H.queue; H.queue = []; q.forEach(f => f()); } }, 1000);
  }
};
const routeUrl = (v, id) => v === "home" ? "/" : "/" + v + (id ? "/" + encodeURIComponent(id) : "");
function parseLocation() {
  const parts = location.pathname.replace(/^\/+|\/+$/g, "").split("/");
  let id = null;
  try { id = parts[1] ? decodeURIComponent(parts[1]) : null; } catch (e) { }
  const v = parts[0] || "home";
  if (!VIEW_SET[v]) return { v: "home", id: null };
  if (NEEDS_ID[v] && !id) return { v: SUB_VIEWS[v] || "home", id: null };
  return { v, id };
}
const overlayOpen = () => !!(lightbox || modalState || styleForm || state.tplEditing);
function syncOverlayHistory() {
  if (!history.pushState) return;
  H.exec(() => {
    const st = history.state || {};
    if (overlayOpen() && !st.overlay) history.pushState(Object.assign({}, st, { overlay: 1 }), "");
    else if (!overlayOpen() && st.overlay) H.back();
  });
}
// 表单"改没改过"：打开时拍一张快照，按返回时对比，改过才问要不要放弃
function formSnap() {
  const pe = state.pe || {};
  return JSON.stringify([styleForm && [styleForm.name, styleForm.code, styleForm.customer, styleForm.size, styleForm.color],
    state.tplEditing && state.tplEditing.name, pe.mode, pe.items, (photoDraft.style || []).map(p => p.key)]);
}
function formDirty() {
  syncPeForms();
  return !!formSnap.base && formSnap() !== formSnap.base;
}
// 重绘前先把款式名/模板名/工序表输入框的值兜回 state，否则重绘会用旧值覆盖用户刚打的字
// 模板里存的工序条目 → 工序编辑器条目
const tplItemsToPe = items => items.map((it) => ({
  name: it.name || "", unitPrice: Number(it.unitPrice) || 0,
  dailyQuota: it.dailyQuota === undefined ? "" : it.dailyQuota,
  prices: it.prices || {}, showPrice: it.showPrice !== false, visibleRoles: it.visibleRoles || []
}));
function syncPeForms() { A.syncStyleForm(); A.syncTplName(); A.peSyncNames(); }
// 防抖搜索框：中文输入法组字时不重绘（会打断输入），停顿后再重绘并把光标定位回原处。
// apply 先改 state，reload（可选）在重绘前跑一次异步请求，比如按关键词重新拉列表。
function debouncedSearch(timerKey, elId, delay, apply, reload) {
  return (v) => {
    if (A._ime) return;
    apply(v);
    clearTimeout(A[timerKey]);
    A[timerKey] = setTimeout(async () => {
      if (reload) await reload();
      render();
      const el = $(elId); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); }
    }, delay);
  };
}
// 返回键落到这里：先关最上面那层浮层；表单改过的先问一句
function closeTopOverlay(fromBack) {
  if (lightbox) { lightbox = null; renderLightbox(); return true; }
  if (modalState) { modalState = null; renderModal(); return true; }
  if (styleForm || state.tplEditing) {
    const leave = () => { if (styleForm) A.cancelStyle(); else A.tplCancel(); };
    if (fromBack && formDirty()) {
      modal({ title: "放弃这次修改？", body: "填了的内容还没保存，离开就没了。", danger: true,
        okText: "放弃", cancelText: "继续编辑", onOk: () => { setTimeout(leave, 0); return true; } });
    } else leave();
    return true;
  }
  return false;
}
window.addEventListener("popstate", (e) => {
  if (H.pending) {
    H.pending--;
    if (!H.pending) { const q = H.queue; H.queue = []; q.forEach(f => f()); }
    return;
  }
  // 浮层那条记录已经被系统弹掉了。关掉最上面一层；还剩别的浮层的话 syncOverlayHistory 会再垫回一条
  if (overlayOpen()) { closeTopOverlay(true); syncOverlayHistory(); return; }
  if (!me()) return;
  const st = e.state && e.state.v ? e.state : parseLocation();
  go(st.v, st.id, { fromPop: true, y: st.y });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (lightbox || modalState) { closeTopOverlay(false); e.preventDefault(); }
    else if (notifPanelOpen) A.toggleNotifPanel();
    return;
  }
  if (lightbox && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { A.lbStep(e.key === "ArrowLeft" ? -1 : 1); e.preventDefault(); }
});

function go(v, id, opt) {
  const o = opt || {};
  if (!VIEW_SET[v]) { v = "home"; id = null; }
  id = id || null;
  const same = route.v === v && route.id === id, y = window.scrollY;
  if (state.scan.camOn && v !== "scan") A.stopCamera();
  if (v !== "processes") { state.tplEditing = null; }
  if (v !== "styles") { styleForm = null; clearPhotoDraft(); }
  if (!same) Object.keys(state.optUI).forEach(k => { state.optUI[k] = { open: false, kw: "" }; });
  notifPanelOpen = false;
  route = { v, id };
  lightbox = null; renderLightbox();
  modalState = null; renderModal();
  if (!o.fromPop && history.pushState) {
    const url = routeUrl(v, id);
    H.exec(() => {
      const cur = history.state || {}, depth = cur.depth || 0;
      if (same || o.replace) history.replaceState({ v, id, depth }, "", url);
      else {
        history.replaceState(Object.assign({}, cur, { y }), "");      // 记下离开时滚到哪了，回来时恢复
        history.pushState({ v, id, depth: depth + 1 }, "", url);
      }
    });
  }
  render(); window.scrollTo(0, 0);
  // 出错也要重绘一次：loadView 里出错时已经把对应数据清空了，别让页面继续显示上一次的旧内容
  loadView(v).then(() => { render(); if (o.y) window.scrollTo(0, o.y); })
    .catch(e => { render(); toast((e && e.error) || "加载失败"); });
}
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

/* ---------- 打点 ---------- */
// 原生 BarcodeDetector 只有 Chrome/安卓有，iOS 全系 WebKit 内核没有，没有原生实现时退回 jsQR；
// 两条路都基于 getUserMedia，需要 https（或 localhost）安全上下文，否则浏览器不给摄像头。
const HAS_NATIVE_SCAN = typeof window !== "undefined" && "BarcodeDetector" in window;
const CAN_SCAN = typeof navigator !== "undefined" &&
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

function scanBundleHtml() {
  const sc = state.scan, b = sc.bundle;
  return `<section class="group">
    <div class="group-title">扫菲打点</div>
    <div class="card scan-card">
      ${sc.camOn ? `<div class="scan-viewport">
          <video id="scan-cam" class="scan-cam" playsinline muted autoplay></video>
          <div class="scan-frame" aria-hidden="true"><i class="scan-line"></i></div>
          <div class="scan-tools">
            <button type="button" class="scan-tool${A._torchOn ? " on" : ""}" id="scan-torch" ${A._torchCap ? "" : "hidden"} onclick="A.toggleTorch()" aria-pressed="${!!A._torchOn}">${icon("torch")}<span>手电筒</span></button>
            <button type="button" class="scan-tool" onclick="A.stopCamera()">${icon("close")}<span>关闭</span></button>
          </div></div>
        <div class="scan-hint" role="status">${esc(sc.camMsg || "把菲票上的二维码放进框里")}</div>`
      : CAN_SCAN ? `<button type="button" class="scan-cta" onclick="A.startCamera()">
          <span class="scan-cta-ic">${icon("scan")}</span>
          <span><b>扫码打点</b><small>对准菲票上的二维码，自动识别</small></span></button>` : ""}
      <div class="scan-manual">
        <input class="in" id="sc-ticket" value="${esc(sc.ticketInput)}" placeholder="或手动输入扎号 / 菲票号"
          inputmode="numeric" enterkeyhint="search" autocomplete="off"
          onchange="A.setTicketInput(this.value)" onkeydown="if(event.key==='Enter')A.lookupTicket()">
        <button class="btn mini" onclick="A.lookupTicket()">查找</button>
      </div>
      ${!CAN_SCAN ? `<div class="scan-note">${
        location.protocol === "https:" || location.hostname === "localhost"
          ? "这个浏览器不给用摄像头，请手动输入扎号或菲票号"
          : "摄像头需要 https 才能用（当前是 http），请手动输入扎号或菲票号"}</div>` : ""}
    </div>

    ${b ? `<div class="card style-card scan-result" id="scan-result" style="margin-top:10px">
      <div class="sc-head">
        ${styleThumbHtml(sc.bundleOrder.style_id, sc.bundleOrder.style_image)}
        <div class="sc-info">
          <div class="sc-title">扎号 ${b.bundle_no}　菲票 ${b.ticket_no}</div>
          <div class="sc-grid">
            ${kv("款号", esc(sc.bundleOrder.style_code || sc.bundleOrder.style_name || "—"))}
            ${kv("床次", sc.bundleOrder.bed_no)}
            ${bundleCells(b)}
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
                placeholder="${num(p.remaining)}" aria-label="${esc(p.name)} 打点件数，不填就是做完剩下的 ${num(p.remaining)} 件">
              <button class="act-btn" onclick="A.scanBundleSubmit('${p.id}')">打点</button>`
            : `<span class="tag ok">已完成</span>`}
          </div></div>`).join("")}
        <div class="scan-tip">件数不填 = 这一扎剩下的全部做完</div>
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
    <div class="card">${recs === null ? skeletonHtml(3, false) : recs.length ? recs.map(r => {
        const p = (state.processes || []).find(x => x.id === r.process_id);
        const name = r.process_name || (p ? p.name : "工序");
        // 扫扎产生的记录带扎号/颜色/尺码，自由打点的没有，两种都要能读
        const sub = r.bundle_no
          ? `扎号 ${r.bundle_no}${r.color ? " · " + esc(r.color) : ""}${r.size ? " · " + esc(r.size) : ""}`
          : "自由打点";
        return `<div class="row-item">
          <div class="row-main"><div class="row-label">${esc(name)}</div>
            <div class="row-sub">${sub} · ${HHMM(r.created_at)}</div></div>
          <div class="slog-qty num">${num(r.qty)}<span class="slog-unit">件</span></div>
          <div class="row-acts"><button class="act-btn danger ghost" onclick="A.delScan('${r.id}')">删除</button></div></div>`;
      }).join("") : emptyHtml("这天还没有打点记录", "scan")}</div>
  </section>`;
}

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

/* ---------- 款式管理 ---------- */
// 搜索框：左边放大镜，有字时右边一个清除按钮（手机上删一长串款号很烦）
function searchbarHtml(id, value, ph, handler) {
  return `<div class="searchbar"><span class="sb-ic">${icon("search")}</span>
    <input id="${id}" type="search" placeholder="${esc(ph)}" value="${esc(value || "")}" enterkeyhint="search"
      autocomplete="off" oninput="${handler}(this.value)" ${IME_ATTRS}>
    ${value ? `<button type="button" class="sb-clear" aria-label="清除" onclick="${handler}('');var i=document.getElementById('${id}');if(i){i.value='';i.focus()}">${icon("close")}</button>` : ""}</div>`;
}
function vStyles() {
  if (styleForm) return vStyleForm();
  const list = state.styles;
  const kw = state.styleKw || "";
  // 搜索放在前端做：款式总量是几十到几百条，一次拉全再本地过滤，比每敲一个字打一次接口跟手。
  // 按相关度排序：款号完全相同的排第一，其次款号开头、款号包含、款名/客户包含
  const shown = list === null ? null : rankFilter(list, kw, s => [s.code, s.name, s.customer]);
  return `${searchbarHtml("st-kw", kw, "搜款号 / 款名 / 客户，空格隔开可组合", "A.setStyleKw")}
  ${list && list.length ? `<div class="list-meta">${normText(kw) ? `找到 ${shown.length} 个款式` : `共 ${list.length} 个款式`}</div>` : ""}

  ${shown === null ? skeletonHtml(4)
      : shown.length ? shown.map(s => {
        return `<section class="group"><div class="card style-card">
        <div class="sc-head">
          <span class="sc-thumb-wrap">${styleThumbHtml(s.id, s.image, s.image_count)}
            ${s.image_count > 1 ? `<span class="sc-imgn num" aria-label="共 ${s.image_count} 张图">${s.image_count}</span>` : ""}</span>
          <div class="sc-info">
            <div class="sc-title">款号 ${hl(s.code || "—", kw)}</div>
            <div class="sc-grid">
              ${kv("款名", hl(s.name || "—", kw))}
              ${kv("工序", `${num(s.process_count || 0)} 道`)}
              ${kv("工价", `¥${Number(s.total_price || 0).toFixed(4)}`)}
              ${kv("是否裁床", s.has_cutting === 0 ? "否" : "是")}
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
      : `<section class="group"><div class="card">${normText(kw)
        ? emptyHtml(`没有找到「${kw.trim()}」相关的款式，换个关键词试试`, "search")
        : emptyHtml("还没有款式，点下面「新建款式」加第一个", "styles")}</div></section>`}

  <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn block" onclick="A.newStyle()">新建款式</button></div></section>`;
}

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
function optPickerHtml(type) {
  const meta = OPT_META[type];
  const all = ((state.styleOptions || {})[meta.listKey]) || [];
  const ui = state.optUI[type];
  const sel = optSelected(type);
  const kw = (ui.kw || "").trim();
  const cand = rankFilter(all, kw, (v) => [v]);
  const exact = all.some((v) => normText(v) === normText(kw));
  return `<div class="field optbox${ui.open ? " open" : ""}">
    <span>${esc(meta.label)}${meta.multi ? "（可多选）" : ""}</span>
    <div class="opt-chips">
      ${sel.length ? sel.map((v) => `<span class="chip on">${esc(v)}<button class="chip-x" type="button"
          onclick="event.stopPropagation();A.optRemove('${type}','${jsArg(v)}')" aria-label="移除${esc(v)}">×</button></span>`).join("")
      : `<span class="row-sub">还没有选${esc(meta.label)}</span>`}
      <button class="chip add" type="button" onclick="A.optOpen('${type}')">＋ 选择</button>
    </div>
    ${ui.open ? `<div class="opt-panel">
      <input class="in opt-search" placeholder="${esc(meta.ph)}" value="${esc(ui.kw)}"
        oninput="A.optSearch('${type}',this.value)" autocomplete="off" enterkeyhint="done" ${IME_ATTRS}>
      <div class="opt-list">
        ${cand.length ? cand.map((v) => `<div class="opt-row${sel.includes(v) ? " on" : ""}"
            onclick="A.optToggle('${type}','${jsArg(v)}')">
            <span class="opt-name">${esc(v)}</span>
            <button class="act-btn danger ghost" type="button"
              onclick="event.stopPropagation();A.optDeleteOption('${type}','${jsArg(v)}')">删除</button>
          </div>`).join("") : `<div class="empty">没有匹配的${esc(meta.label)}</div>`}
        ${kw && !exact ? `<div class="opt-row create" onclick="A.optCreate('${type}')">＋ 新建「${esc(kw)}」</div>` : ""}
      </div>
      <div class="btn-row"><button class="btn ghost mini block" type="button" onclick="A.optOpen('${type}')">收起</button></div>
    </div>` : ""}
  </div>`;
}

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
  if (!state.pe || state.pe.styleId !== route.id) return skeletonHtml(4);
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
    <div class="card">${recs === null ? skeletonHtml(3, false) : recs.length ? recs.map(r => `
      <div class="row-item"><div class="row-main"><div class="row-label">${esc(fmtDate(r.date))}</div></div>
        <div class="row-value num">${num(r.hours)} 小时</div></div>`).join("")
      : emptyHtml("这个月还没有考勤记录", "attendance")}</div>
  </section>`;
}

/* ---------- 效率看板：完成度 = 时效小时 / 出勤小时；没考勤的人单独列出，不当 0% ---------- */
function effBarPct(p) { return Math.max(0, Math.min(100, Math.round((p || 0) * 100))); }
function effTone(p) { return p >= 1 ? "ok" : p >= 0.8 ? "warn" : "bad"; }

function vEfficiency() {
  const raw = state.eff.list;
  const head = `<section class="group"><div class="card">
    <label class="field"><span>月份</span>${monthFieldHtml("ef-month", state.eff.month, "A.setEffMonth(this.value)")}</label>
  </div></section>`;
  if (raw === null) return head + skeletonHtml(4);

  // 这个月完全没动静的人（没打点也没考勤）不占榜单位置
  const list = raw.filter(x => x.qty > 0 || x.attendanceHours > 0);
  const rated = list.filter(x => x.percent !== null).sort((a, b) => b.percent - a.percent);
  const unrated = list.filter(x => x.percent === null).sort((a, b) => (b.qty || 0) - (a.qty || 0));

  const totalQty = list.reduce((n, x) => n + (Number(x.qty) || 0), 0);
  const totalAtt = list.reduce((n, x) => n + (Number(x.attendanceHours) || 0), 0);
  const totalEff = rated.reduce((n, x) => n + (Number(x.effectiveHours) || 0), 0);
  const avg = totalAtt > 0 ? totalEff / totalAtt : null;

  const card = (x, rank) => {
    const p = x.percent;
    const tone = p === null ? "none" : effTone(p);
    return `<div class="rank-item">
      <span class="rank-no${rank !== null && rank <= 3 ? " top" + rank : ""}">${rank === null ? "—" : rank}</span>
      <div class="rank-main">
        <div class="rank-top">
          <span class="rank-name">${esc(x.name)}</span>
          <span class="tag role">${esc(x.roleLabel || "")}</span>
        </div>
        <div class="pbar lg"><i class="${tone}" style="width:${p === null ? 0 : effBarPct(p)}%"></i></div>
        <div class="rank-sub">打点 ${num(x.qty)} 件 · 出勤 ${num(x.attendanceHours)} 小时 · 时效 ${num(x.effectiveHours)} 小时</div>
      </div>
      <div class="rank-right">
        <div class="rank-pct num ${tone}">${p === null ? "—" : pctText(p)}</div>
        <div class="rank-pct-l">${p === null ? "缺考勤" : "完成度"}</div>
      </div>
    </div>`;
  };

  return head + `
  <section class="group"><div class="sum-bar">
    <div class="sum-item"><div class="sum-num num">${num(totalQty)}</div><div class="sum-label">打点件数</div></div>
    <div class="sum-item"><div class="sum-num num">${num(totalAtt)}</div><div class="sum-label">出勤小时</div></div>
    <div class="sum-item"><div class="sum-num num ${avg === null ? "" : effTone(avg)}">${avg === null ? "—" : pctText(avg)}</div>
      <div class="sum-label">整体完成度</div></div>
  </div></section>

  <section class="group">
    <div class="group-title">完成度排行 · ${esc(fmtMonth(state.eff.month))}</div>
    <div class="card">${rated.length ? rated.map((x, i) => card(x, i + 1)).join("")
      : emptyHtml("这个月还没有能算完成度的人（要先录考勤）", "efficiency")}</div>
  </section>

  ${unrated.length ? `<section class="group">
    <div class="group-title">缺考勤，算不出完成度</div>
    <div class="card">${unrated.map(x => card(x, null)).join("")}</div>
    <div class="pe-hint">完成度 = 时效小时 ÷ 出勤小时，这些人本月没有考勤记录，
      去「考勤录入」补上工时就能进排行。</div>
  </section>` : ""}`;
}



/* ---------- 裁床编菲：行=颜色、列=尺码，每格填件数+扎数 ---------- */
// colors/sizes 用数组保序：顺序就是扎号编号的遍历顺序
const CF_SWITCHES = [
  ["customNo", "自定义扎号"], ["customVat", "自定义缸号"],
  ["rowCopy", "行复制"], ["colCopy", "列复制"],
  ["multiple", "件数=每扎件数"], ["sameBundles", "每格扎数相同"]
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
function cfPickRow(kind) {
  const cf = state.cf;
  // 候选只来自这个款式已选的颜色/尺码，不是全局选项池——全局池里别的款用的颜色摆在这里会让人误以为这一款也能裁那个色
  const all = kind === "color" ? cf.styleColors : cf.styleSizes;
  const cur = kind === "color" ? cf.colors : cf.sizes;
  const label = kind === "color" ? "添加颜色" : "添加尺码";
  const what = kind === "color" ? "颜色" : "尺码";
  return `<div class="field"><span>${label}</span>
    <div class="chips">${all.length ? all.map(v => {
      const on = cur.includes(v);
      return `<button type="button" class="chip ${on ? "on" : ""}"
        onclick="A.cfToggleAxis('${kind}','${jsArg(v)}')">${esc(v)}${on ? "" : " ＋"}</button>`;
    }).join("")
    : `<span class="row-sub">这个款式还没有选${what}，先去款式管理里给它加上</span>`}</div></div>`;
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
        <input class="in num" type="number" inputmode="numeric" placeholder="${cf.multiple ? "每扎件数" : "该格总件数"}"
          value="${esc(cfCell(c, z).input)}"
          onchange="A.cfSetCell('${jsArg(c)}','${jsArg(z)}','input',this.value)">
        <input class="in num" type="number" inputmode="numeric" placeholder="菲票张数"
          value="${esc(cfCell(c, z).bundles)}" ${cf.sameBundles ? "disabled" : ""}
          onchange="A.cfSetCell('${jsArg(c)}','${jsArg(z)}','bundles',this.value)">
      </div></td>`).join("")}
      <td class="num">${num(cf.sizes.reduce((t, z) => t + cfCellTotal(c, z), 0))}</td></tr>`).join("")}
    <tr><th class="mx-head">合计</th>${cf.sizes.map(z => `<td class="num">${num(sizeTotal(z))}</td>`).join("")}
      <td class="num">${num(grand)}</td></tr>
  </table></div>
  <div class="mx-sum">总扎数：<b class="num">${num(cfBundleCount())}</b>　总件数：<b class="num">${num(grand)}</b></div>
  <div class="mx-hint">${cf.multiple
    ? "上格填每张菲票多少件，下格填打几张。例如 S 码填「20 / 2」＝打出 2 张各 20 件的菲票。"
    : "上格填这一格总共多少件，下格填打几张，系统按张数平分（除不尽的余数补到最后一张）。"}</div>`;
}
function vCutForm() {
  const cf = state.cf;
  if (!cf) return skeletonHtml(5);
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
        ${optPickerHtml("customer")}
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
 * 两张表：裁床汇总表（颜色×尺码件数矩阵）和裁床编菲表（每扎扎号+件数，按尺码分组，双列扎号/数量）。 */
function vCutView() {
  const d = state.cv;
  if (!d) return skeletonHtml(4);
  const { order: o, bundles, processes, summary: sm } = d;

  // 编菲表：先按 (颜色,尺码) 把扎归堆，同一格里可能有好几扎，列数取最多的那一格
  const byCell = {};
  bundles.forEach(b => (byCell[b.color + "|" + b.size] || (byCell[b.color + "|" + b.size] = [])).push(b));
  const maxPer = Math.max(1, ...Object.values(byCell).map(a => a.length));

  return `<section class="group"><div class="card style-card">
      ${orderHeadHtml(o, kv("款名", esc(o.style_name || "—")) + kv("床次", o.bed_no)
        + kv("总扎数", num(o.total_bundles)) + kv("总件数", num(o.total_qty)) + datesCell(o))}
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
    </div>
    ${isManager() ? `<div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn ghost block" onclick="A.editCutOrderFrom('${o.id}')">修改裁床单</button>
      <button class="btn ghost danger block" onclick="A.delCutOrderFrom('${o.id}')">删除这张裁床单</button>
    </div>` : ""}</section>`;
}



/* ---------- 打印菲票：只有扎号范围传给后端，其余是前端排版参数；打印机由系统对话框选 ---------- */
const PRINT_TEMPLATES = [["label60x40", "标签 60×40mm"], ["label80x60", "标签 80×60mm"], ["a4grid", "A4 一页多张"]];
function vCutPrint() {
  const cp = state.cp;
  if (!cp) return skeletonHtml(5);
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
        <input type="checkbox" ${cp.showPrice ? "checked" : ""} onchange="A.cpToggle('showPrice')">
        <span>打印工价</span></label>
        <div class="row-sub">默认不印。开启后只印那些在工序里勾了「显示价格」的工序。</div></div>
      <div class="field"><label class="chkline">
        <input type="checkbox" ${cp.rotate ? "checked" : ""} onchange="A.cpToggle('rotate')">
        <span>打印方向旋转 180°</span></label></div>
      <div class="field"><label class="chkline">
        <input type="checkbox" ${cp.perNote ? "checked" : ""} onchange="A.cpToggle('perNote')">
        <span>逐个备注打印（用每一扎自己的备注）</span></label></div>
    </div></section>

    <section class="group">
      ${cp.ready ? `<div class="card print-ready">
          <div class="row-item"><div class="row-main">
            <div class="row-label">已排版 ${cp.ready.count} 张菲票 × ${cp.ready.copies} 份</div>
            <div class="row-sub">点下面的按钮调起系统打印对话框，在那里选打印机和纸张</div>
          </div></div>
        </div>
        <div class="btn-row" style="padding-left:0;padding-right:0">
          <button class="btn block" id="do-print-btn" onclick="A.firePrint()">开始打印</button>
          <button class="btn ghost block" onclick="A.cpReset()">重新排版</button>
        </div>`
      : `<div class="btn-row" style="padding-left:0;padding-right:0">
          <button class="btn block" onclick="A.doPrint()">排版并打印</button></div>`}
    </section>`;
}

/* ---------- 生产进度（按扎） ---------- */
// 已完成数 = 各工序完成件数的最小值（能出货的）；进度条 = 工序件数 / 总工作量；x/y 道 = 整扎做完的工序数
function vCutProgress() {
  const d = state.pg;
  if (!d) return skeletonHtml(4);
  const o = d.order, procs = d.processes;
  const kw = (state.pgKw || "").trim();
  const list = rankFilter(d.bundles, kw, b => [b.bundle_no, b.ticket_no, b.color, b.size]);
  const pct = d.work_percent || 0;                              // 进度条：工序件数进度
  const shipPct = o.total_qty > 0 ? Math.round((d.completed_qty / o.total_qty) * 100) : 0;  // 能出货的件数占比
  return `<section class="group"><div class="card style-card">
      ${orderHeadHtml(o, kv("床次", o.bed_no) + kv("件数", num(o.total_qty))
        + kv("客户", esc(o.customer || "—")) + kv("工序", `${procs.length} 道`) + datesCell(o))}
      ${progRowHtml(pct)}
      <div class="cc-note">已做 ${num(d.work_done)} / ${num(d.work_total)} 工序件
        · 全工序做完 ${num(d.completed_qty)} 件（${shipPct}%）</div>
    </div></section>

    <section class="group"><div class="card">
      <button class="row-item tap w-row" onclick="go('procprogress','${o.id}')">
        <div class="row-main"><div class="row-label">查看工序进展</div>
          <div class="row-sub">每道工序做了多少、还剩多少，按颜色尺码分解</div></div>
        <span class="chev">›</span></button>
    </div></section>

    <section class="group">
      <div class="group-title">每扎进展</div>
      ${searchbarHtml("pg-kw", state.pgKw, "扎号 / 菲票号 / 颜色 / 尺码", "A.setPgKw")}
      ${list.length ? list.map(b => `<div class="card bundle-card">
        <button class="row-item tap w-row" onclick="go('bundleprogress','${b.id}')">
          <div class="row-main">
            <div class="row-label">扎号：${b.bundle_no}</div>
            <div class="sc-grid" style="margin-top:4px">
              ${kv("菲票ID", b.ticket_no)}${bundleCells(b)}
            </div>
            <div class="cc-prog" style="padding:8px 0 0">
              <span class="cc-prog-t">已完成数 ${num(b.done)}</span>
              <div class="pbar"><i style="width:${b.percent}%"></i></div>
              <span class="cc-pct num">${b.percent}%</span>
              <span class="cc-pct cc-pct-sub">${b.finished_procs}/${procs.length} 道</span></div>
          </div><span class="chev">›</span></button>
        ${isManager() ? `<div class="qty-edit-row">
          <button class="act-btn" onclick="A.editBundleQty('${b.id}',${b.qty})">修改裁床件数</button>
          <button class="act-btn danger" onclick="A.delBundle('${b.id}',${b.bundle_no},${b.qty})">删除这一扎</button></div>` : ""}
      </div>`).join("") : `<div class="card">${kw ? emptyHtml("没有匹配的扎号", "search") : emptyHtml("这张单还没有菲票", "cutting")}</div>`}
    </section>`;
}

/* ---------- 生产进度详情：一扎的每道工序 ---------- */
function vBundleProgress() {
  const d = state.bp;
  if (!d) return skeletonHtml(4);
  const b = d.bundle, o = d.order, procs = d.processes;
  const doneProcs = d.finished_procs, pct = d.work_percent || 0;
  return `<section class="group"><div class="card">
      <div class="row-item"><div class="row-main">
        <div class="row-label">扎号：${b.bundle_no}</div>
        <div class="sc-grid" style="margin-top:6px">
          ${kv("菲票号", b.ticket_no)}${bundleCells(b)}
        </div>
        ${progRowHtml(pct, "padding:10px 0 0")}
        <div class="cc-note">已做 ${num(d.work_done)} / ${num(d.work_total)} 工序件
          · 整扎做完 ${doneProcs} / ${procs.length} 道 · 全工序做完 ${num(d.done)} 件</div>
      </div></div>
    </div></section>

    <section class="group">
      <div class="group-title">每道工序进展</div>
      <div class="card">
        ${isManager() ? `<div class="qty-edit-row">
          <button class="act-btn" onclick="A.editBundleQty('${b.id}',${b.qty})">修改裁床件数</button>
          <button class="act-btn danger" onclick="A.delBundle('${b.id}',${b.bundle_no},${b.qty},'${o.id}')">删除这一扎</button></div>` : ""}
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
  if (!d) return skeletonHtml(4);
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
    </section>`).join("") : `<section class="group"><div class="card">${emptyHtml("这张单还没有工序", "processes")}</div></section>`;
}

/* ---------- 生产管理 ----------
 * 已完成件数＝这段时间打点了多少件（车间日产出口径），不同于单张裁床单"全工序做完"的完工口径。 */
function vCutOrders() {
  const co = state.co;
  const ov = co.overview || { completed: 0, inProduction: 0 };
  const rangeBtn = (k, t) => `<button class="${co.range === k ? "on" : ""}" onclick="A.setCoRange('${k}')">${t}</button>`;
  const list = co.list, byStyle = co.byStyle;
  const totalQty = (list || []).reduce((n, o) => n + Number(o.total_qty || 0), 0);
  const doneQty = (list || []).reduce((n, o) => n + Number(o.completed_qty || 0), 0);

  const orderCard = (o) => {
    // 进度条走后端算的工序件数进度，跟"生产进度"页同一个口径；
    // completed_qty（全工序做完、能出货的件数）另外用文字报，两个数不互相顶替
    const pct = Number(o.percent) || 0;
    return `<section class="group"><div class="card cut-card">
      <div class="cc-head tap" onclick="go('cutprogress','${o.id}')">
        ${styleThumbHtml(o.style_id, o.style_image)}
        <div class="sc-info">
          <div class="sc-title">款号：${esc(o.style_code || o.style_name || "—")}</div>
          <div class="sc-grid">
            ${kv("床次", o.bed_no)}
            ${kv("件数", num(o.total_qty))}
            ${kv("类型", o.source === "self" ? "自建" : esc(o.source))}
            ${datesCell(o)}
          </div>
        </div>
        <span class="chev">›</span>
      </div>
      ${progRowHtml(pct)}
      <div class="cc-note">全工序做完 ${num(o.completed_qty)} / ${num(o.total_qty)} 件</div>
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
      ${searchbarHtml("co-kw", co.kw, "款号 / 款名 / 床次 / 制单号", "A.setCoKw")}
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
      ${list === null ? skeletonHtml(3)
      : list.length ? list.map(orderCard).join("")
        : `<section class="group"><div class="card">${emptyHtml("还没有裁床单，去「款式管理」里点「裁床编菲」新建", "cutting")}</div></section>`}`
    : `<section class="group"><div class="card">
        ${byStyle === null ? skeletonHtml(3, false) : byStyle.length ? byStyle.map(x => `
          <div class="row-item">
            <div class="row-main"><div class="row-label">${esc(x.style_code || x.style_name)}</div>
              <div class="row-sub">${esc(x.style_name || "")} · ${x.sheet_count} 张裁床单</div></div>
            <div class="row-value num">${num(x.completed_qty)} / ${num(x.total_qty)}</div>
          </div>`).join("") : emptyHtml("这段时间没有裁床单", "cutting")}
      </div></section>`}`;
}

/* ---------- 打点记录 ----------
 * 范围由后端按岗位定：计件工/临时工只看自己的点；分厂主管/管理员看全员，多一列"谁打的"和人员筛选。 */
const HHMM = (ms) => { const d = new Date(ms), p = n => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
const shortName = (s) => (s || "").length > 2 ? s.slice(-2) : (s || "");

function slogRowHtml(r, withWho) {
  // 扫扎打点带得出扎号/菲票/颜色尺码；自由打点这些都是空的，那一行就只剩工序名
  const where = [
    r.bundle_no ? `扎号 ${r.bundle_no}` : "",
    r.ticket_no ? `菲票 ${r.ticket_no}` : "",
    r.color || "", r.size || ""
  ].filter(Boolean).join(" · ");
  const styleTag = r.style_code || r.style_name
    ? `<span class="tag">${esc(r.style_code || r.style_name)}${r.bed_no ? ` · 床次${r.bed_no}` : ""}</span>` : "";
  return `<div class="slog-item">
    ${withWho ? `<span class="avatar mini">${esc(shortName(r.user_name))}</span>` : ""}
    <div class="slog-main">
      <div class="slog-top">
        ${withWho ? `<span class="slog-who">${esc(r.user_name)}</span>` : ""}
        <span class="slog-proc">${esc(r.process_name)}</span>${styleTag}
      </div>
      ${where ? `<div class="slog-sub">${esc(where)}</div>` : ""}
      <div class="slog-time">${HHMM(r.created_at)}</div>
    </div>
    <div class="slog-right">
      <div class="slog-qty num">${num(r.qty)}<span class="slog-unit">件</span></div>
      ${r.amount === null || r.amount === undefined ? "" : `<div class="slog-amt num">¥${num(r.amount)}</div>`}
    </div>
  </div>`;
}

function vScanlog() {
  const sl = state.slog, all = sl.records, seeAll = sl.scope === "all";
  const head = `<section class="group"><div class="card">
    <label class="field"><span>日期</span>${dateFieldHtml("sl-date", sl.date, "A.setSlogDate(this.value)")}</label>
  </div></section>`;
  if (all === null) return head + skeletonHtml(4);
  // 人员筛选只列当天真打过点的人，不拉整张员工表——没打点的人摆在这里只会碍事
  const people = [];
  for (const r of all) if (!people.some(x => x.id === r.user_id)) people.push({ id: r.user_id, name: r.user_name });
  const who = people.some(x => x.id === sl.who) ? sl.who : "";
  const recs = who ? all.filter(r => r.user_id === who) : all;

  const qty = recs.reduce((n, r) => n + (Number(r.qty) || 0), 0);
  const amt = recs.reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const hasAmt = recs.some(r => r.amount !== null && r.amount !== undefined);

  return head + `
  <section class="group"><div class="sum-bar">
    <div class="sum-item"><div class="sum-num num">${num(qty)}</div><div class="sum-label">打点件数</div></div>
    <div class="sum-item"><div class="sum-num num">${seeAll && !who ? people.length : recs.length}</div>
      <div class="sum-label">${seeAll && !who ? "打点人数" : "打点笔数"}</div></div>
    <div class="sum-item"><div class="sum-num num">${hasAmt ? num(amt) : "—"}</div><div class="sum-label">计件金额（元）</div></div>
  </div></section>

  ${seeAll && people.length > 1 ? `<section class="group">
    <div class="chiprow">
      <button class="chip${who ? "" : " on"}" onclick="A.setSlogWho('')">全部</button>
      ${people.map(x => `<button class="chip${who === x.id ? " on" : ""}"
        onclick="A.setSlogWho('${x.id}')">${esc(x.name)}</button>`).join("")}
    </div>
  </section>` : ""}

  <section class="group">
    <div class="group-title">${seeAll ? (who ? esc((people.find(x => x.id === who) || {}).name) + " 的打点" : "全员打点") : "我的打点"}
      · ${esc(fmtDate(sl.date))}${recs.length ? ` · ${recs.length} 笔` : ""}</div>
    <div class="card">${recs.length ? recs.map(r => slogRowHtml(r, seeAll && !who)).join("")
      : emptyHtml(seeAll ? "这天还没有人打点" : "这天你还没有打点记录", "scanlog")}</div>
  </section>`;
}

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

/* ---------- 我的 ---------- */
// 消息通知整页（桌面端等价的是顶部铃铛面板）
function vNotifs() {
  const list = state.notif.list;
  return `<section class="group">
    <div class="group-title">消息通知${list ? ` · 共 ${list.length} 条` : ""}
      ${(list || []).some(x => !x.read) ? `<button class="link-btn right" onclick="A.markAllNotifRead()">全部已读</button>` : ""}</div>
    <div class="card">${list === null ? skeletonHtml(4, false) : list.length
      ? list.map(n => notifItemHtml(n, { del: true })).join("") : emptyHtml("暂无通知", "inbox")}</div>
    ${(list || []).some(x => x.read) ? `<div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn ghost block" onclick="A.clearReadNotifs()">清空已读通知</button></div>` : ""}
  </section>`;
}
function vMine() {
  const m = me(), p = state.pay.mine;
  const nm = m.name || "";
  return `<section class="group"><div class="card"><div class="card-pad me-card">
      <span class="avatar">${esc(shortName(nm))}</span>
      <div><div class="me-name">${esc(nm)}</div>
        <div class="row-sub">${esc(COMPANY_NAME)}</div></div>
    </div></div></section>

  <section class="group"><div class="card">
    <div class="row-item"><div class="row-main"><div class="row-label">职位</div></div><div class="row-value">${esc(roleLabelOf(m))}</div></div>
    <div class="row-item"><div class="row-main"><div class="row-label">手机</div></div><div class="row-value num">${esc(m.phone)}</div></div>
    <button class="row-item tap w-row" onclick="go('notifs')"><div class="row-main"><div class="row-label">消息通知</div></div>
      <div class="row-value row-value-flex">${badgeHtml()}<span class="chev">›</span></div></button>
  </div></section>

  <section class="group">
    <div class="group-title">系统推送</div>
    <div class="card">
      <div class="row-item">
        <div class="row-main"><div class="row-label">在这台设备上接收通知</div>
          <div class="row-sub">App 没打开时也能弹手机通知</div></div>
        <button class="sw ${state.pushOn ? "on" : ""}" role="switch" aria-checked="${!!state.pushOn}"
          onclick="A.togglePush()"><i></i></button>
      </div>
      <div class="field"><div class="row-sub">iPhone 需要先把网页「添加到主屏幕」、从图标打开才收得到；
        微信内置浏览器不支持。收不到时页面里的红点和未读数照常工作。</div></div>
    </div>

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
      <div class="row-item"><div class="row-main"><div class="row-label">合计</div></div><span class="tag hl num">${money(p.total)}</span></div>`
      : skeletonHtml(3, false)}</div>
  </section>`}

  <section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    ${(isStandalone() || !isMobileDevice()) ? "" : `<button class="btn ghost block" style="margin-bottom:10px" onclick="A.install()">📲 安装到手机</button>`}
    <button class="btn danger ghost block" onclick="A.logout()">退出登录</button>
  </div></section>`;
}

// 删除裁床单的确认弹窗，delCutOrder / delCutOrderFrom 共用，只是拿到 order 的方式和删除后的落点不同
function confirmDelCutOrder(o, onDeleted) {
  modal({
    title: "删除裁床单", danger: true, okText: "删除",
    body: o ? `确定删除「${o.style_code || o.style_name} · 床次${o.bed_no}」吗？这张单的 ${num(o.total_bundles)} 张菲票和进度都会一起看不到。` : "确定删除吗？",
    onOk: () => { onDeleted(); return true; }
  });
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
  addDraftPhotos(ctx, input) {
    const files = [...(input.files || [])]; input.value = "";
    A.addPhotoFiles(ctx, files);
  },
  // 选图 / 拖进来 / 粘贴 都走这里：先把缩略图占位摆上，压缩在后台排队做
  addPhotoFiles(ctx, files) {
    files = (files || []).filter(f => !f.type || /^image\//.test(f.type) || /\.(hei[cf]|jpe?g|png|webp|gif|bmp)$/i.test(f.name || ""));
    if (!files.length) return;
    const list = photoDraft[ctx] = photoDraft[ctx] || [];
    const room = PHOTO_MAX - list.length;
    if (room <= 0) return toast(`最多 ${PHOTO_MAX} 张，先删掉几张再加`);
    if (files.length > room) toast(`最多 ${PHOTO_MAX} 张，这次只加了前 ${room} 张`);
    files.slice(0, room).forEach(f => {
      let preview = "";
      try { preview = URL.createObjectURL(f); } catch (e) { }
      const it = { key: "p" + (++photoSeq), src: preview, data: "", status: "processing", file: f };
      list.push(it);
      queuePhoto(ctx, it);
    });
    refreshPicker(ctx);
  },
  retryPhoto(ctx, key) {
    const it = (photoDraft[ctx] || []).find(p => p.key === key);
    if (!it || !it.file) return;
    it.status = "processing"; it.err = "";
    refreshPicker(ctx); queuePhoto(ctx, it);
  },
  removeDraftPhoto(ctx, key) {
    const list = photoDraft[ctx] || [], k = list.findIndex(p => p.key === key);
    if (k < 0) return;
    const it = list[k];
    if (String(it.src).indexOf("blob:") === 0) URL.revokeObjectURL(it.src);
    list.splice(k, 1); refreshPicker(ctx);
  },
  viewDraft(ctx, key) {
    const it = (photoDraft[ctx] || []).find(p => p.key === key);
    if (!it) return;
    if (it.status !== "ready") return openViewer([{ src: it.src }], 0);
    const ready = draftReady(ctx);
    openViewer(ready.map(p => ({ src: p.src })), ready.indexOf(it), { ctx });
  },
  // 列表里的款式图：先拿缩略图垫着立刻打开，原图取回来再换上（跟微信看图一样先糊后清）
  viewStyle(styleId, el) {
    const thumb = (el && el.getAttribute("src")) || "";
    const count = Math.max(1, Number(el && el.getAttribute("data-count")) || 1);
    const cached = fullImgCache.get(styleId);
    if (cached && cached.length) return openViewer(cached.map((src, k) => ({ src, thumb: k === 0 ? thumb : "" })), 0, { styleId });
    openViewer(Array.from({ length: count }, (_, k) => ({ src: "", thumb: k === 0 ? thumb : "" })), 0, { styleId });
    api("GET", "/styles/" + encodeURIComponent(styleId)).then(r => {
      const imgs = styleImages(r.style || {}).filter(showable);
      cacheFullImgs(styleId, imgs);
      if (!lightbox || lightbox.styleId !== styleId) return;
      lightbox.photos = imgs.length ? imgs.map((src, k) => ({ src, thumb: k === 0 ? thumb : "" })) : [{ src: thumb }];
      lightbox.i = Math.min(lightbox.i, lightbox.photos.length - 1);
      renderLightbox();
    }).catch(e => {
      if (!lightbox || lightbox.styleId !== styleId) return;
      toast((e && e.error) || "原图没取到，先看缩略图");
      lightbox.photos = [{ src: thumb }]; lightbox.i = 0; renderLightbox();
    });
  },
  lbStep(d) {
    if (!lightbox || !V.el) return;
    const j = lightbox.i + d;
    if (j < 0 || j >= lightbox.photos.length) return;
    vAnim({ page: -d * (vSize().W + V.gap) }, null, () => { if (lightbox) { lightbox.i = j; layoutViewer(); } }, 0.3);
  },
  closeLightbox() { lightbox = null; renderLightbox(); },
  lbSetCover() {
    const lb = lightbox; if (!lb || !lb.ctx) return;
    const it = draftReady(lb.ctx)[lb.i], list = photoDraft[lb.ctx] || [], k = list.indexOf(it);
    if (k > 0) { list.splice(k, 1); list.unshift(it); }
    refreshPicker(lb.ctx);
    lb.photos = draftReady(lb.ctx).map(p => ({ src: p.src })); lb.i = 0;
    layoutViewer(); toast("已设为封面");
  },
  lbDelete() {
    const lb = lightbox; if (!lb || !lb.ctx) return;
    const it = draftReady(lb.ctx)[lb.i];
    if (it) A.removeDraftPhoto(lb.ctx, it.key);
    const ready = draftReady(lb.ctx);
    if (!ready.length) return A.closeLightbox();
    lb.photos = ready.map(p => ({ src: p.src })); lb.i = Math.min(lb.i, ready.length - 1);
    layoutViewer();
  },

  /* ---- 导航 ---- */
  // 左上角"‹ 返回"：历史里有上一页就真的后退（跟手机返回键同一条路，滚动位置也能恢复），
  // 是直接打开的深链接（没有上一页）就去逻辑上的上级页
  navBack(parent) {
    const st = history.state || {};
    if ((st.depth || 0) > 0 && !H.pending) history.back();
    else go(parent, null, { replace: true });
  },

  /* ---- 登录 ---- */
  login() {
    return guard("login", async () => {
      const phone = val("lg-phone"), pass = ($("lg-pass") || {}).value || "";
      if (!phone || !pass) return toast("请填写手机号和密码");
      try {
        const r = await api("POST", "/login", { phone, password: pass });
        await A.enter(r.token, r.user);
      } catch (e) {
        if (showWelcome) { showWelcome = false; render(); }
        toast((e && e.error) || "登录失败");
      }
    });
  },
  async enter(token, user) {
    state.token = token; state.me = user;
    localStorage.setItem(TOKEN_KEY, token);
    showWelcome = true; render();           // 密码验证通过就先顶上欢迎界面，不用等数据回来
    // 没登录时点了推送/深链接进来的，登录完直接去那一页
    const target = bootTarget || { v: "home", id: null };
    bootTarget = null;
    route = target;
    H.exec(() => history.replaceState({ v: target.v, id: target.id, depth: 0 }, "", routeUrl(target.v, target.id)));
    await Promise.all([loadView(target.v).catch(() => { }), new Promise(r => setTimeout(r, 1200))]);
    showWelcome = false; render();
    startNotifPoll();
  },
  dismissWelcome() { if (!showWelcome) return; showWelcome = false; render(); },

  /* ---- 应用内通知 ---- */
  async loadNotifs() {
    try { state.notif.list = (await api("GET", "/notifications")).list || []; }
    catch (e) { if (!state.notif.list) state.notif.list = []; }
    render();
  },
  toggleNotifPanel() {
    notifPanelOpen = !notifPanelOpen;
    render();
    if (notifPanelOpen) A.loadNotifs();
  },
  // 点一条通知：标已读（先改界面，请求在后台发），有链接就跳过去
  openNotif(id, link) {
    notifPanelOpen = false;
    const item = (state.notif.list || []).concat(state.notif.recent || []).find(x => x.id === id);
    if (item && !item.read) {
      [state.notif.list, state.notif.recent].forEach(l => (l || []).forEach(x => { if (x.id === id) x.read = true; }));
      state.notif.unread = Math.max(0, state.notif.unread - 1); updateBadges();
      api("POST", `/notifications/${id}/read`).catch(() => { });
    }
    link = decodeURIComponent(link || "");
    if (link) { const parts = link.replace(/^\//, "").split("/"); go(parts[0], parts[1] || null); }
    else render();
  },
  async markAllNotifRead() {
    try {
      await api("POST", "/notifications/read-all");
      [state.notif.list, state.notif.recent].forEach(l => (l || []).forEach(x => { x.read = true; }));
      state.notif.unread = 0; updateBadges();
      render(); toast("已全部标为已读");
    } catch (e) { toast((e && e.error) || "操作失败"); }
  },
  // 删除只影响自己：通知本来就是一人一份
  async deleteNotif(id) {
    try {
      await api("DELETE", "/notifications/" + id);
      const n = (state.notif.list || []).concat(state.notif.recent || []).find(x => x.id === id);
      if (n && !n.read) { state.notif.unread = Math.max(0, state.notif.unread - 1); updateBadges(); }
      if (state.notif.list) state.notif.list = state.notif.list.filter(x => x.id !== id);
      if (state.notif.recent) state.notif.recent = state.notif.recent.filter(x => x.id !== id);
      render();
    } catch (e) { toast((e && e.error) || "删除失败"); }
  },
  clearReadNotifs() {
    modal({
      title: "清空已读通知？", body: "只删除你自己已读过的通知，未读的会保留。", danger: true, okText: "清空",
      onOk: () => {
        api("DELETE", "/notifications?read=1").then(() => {
          state.notif.list = (state.notif.list || []).filter(x => !x.read);
          if (state.notif.recent) state.notif.recent = state.notif.recent.filter(x => !x.read);
          render(); toast("已清空已读通知");
        }).catch(e => toast((e && e.error) || "操作失败"));
        return true;
      }
    });
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
    if (state.scan.camOn) A.stopCamera();
    state.token = null; state.me = null;
    // 把上一个账号的数据一并清掉，换账号登录时不会先闪一下别人的数据
    state.users = state.roles = state.processes = state.styles = state.styleOptions = null;
    state.home = { today: 0 };
    state.notif = { unread: 0, list: null, recent: null };
    state.scan.records = state.scan.eff = null;
    state.att.userId = ""; state.att.records = null;
    state.eff.list = null; state.slog.records = null;
    state.pay.list = state.pay.mine = null; state.pay.editing = "";
    styleForm = null; clearPhotoDraft(); state.tplEditing = null;
    lightbox = null; renderLightbox(); modalState = null; renderModal();
    fullImgCache.clear();
    localStorage.removeItem(TOKEN_KEY);
    route = { v: "home", id: null };
    H.exec(() => history.replaceState({ v: "home", id: null, depth: 0 }, "", "/"));
    render();
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
    lab.classList.toggle("is-empty", !el.value);
  },
  syncMonthLabel(id) {
    const el = $(id), lab = $(id + "--label"); if (!el || !lab) return;
    lab.textContent = el.value ? fmtMonth(el.value) : "选择月份";
    lab.classList.toggle("is-empty", !el.value);
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
  submitScan() {
    return guard("submitScan", async () => {
      const procs = state.processes || [];
      if (!procs.length) return toast("请先添加工序模板");
      const qty = val("sc-qty");
      if (!qty) return toast("请填写完成数量");
      if (!(Number(qty) > 0)) return toast("完成数量要大于 0");
      const styleId = val("sc-style");
      const r = await run(() => api("POST", "/scan", {
        processId: val("sc-proc"), styleId: styleId || undefined, date: state.scan.date, qty: Number(qty)
      }), "已打点");
      if (r) buzz(30);
    });
  },
  // 删打点记录会直接影响工资，先确认，而且把删的是哪一笔说清楚
  delScan(id) {
    const r = (state.scan.records || []).find(x => x.id === id);
    modal({
      title: "删除这条打点？", danger: true, okText: "删除",
      body: r ? `${r.process_name || "工序"} ${num(r.qty)} 件${r.bundle_no ? `（扎号 ${r.bundle_no}）` : ""}，删除后对应的计件工资也会扣掉。` : "删除后对应的计件工资也会扣掉。",
      onOk: () => { run(() => api("DELETE", "/scan/" + id), "已删除"); return true; }
    });
  },

  /* ---- 工序模板 ---- */

  /* ---- 款式 ---- */
  newStyle() {
    clearPhotoDraft(); photoDraft.style = [];
    styleForm = { id: "", name: "", code: "", customer: "", size: {}, color: {}, err: {}, origImages: [] };
    state.pe = { styleId: null, mode: "default", sizes: [], roles: [], items: [], loaded: true };
    formSnap.base = formSnap();
    render(); window.scrollTo(0, 0);
    // 新建款式也可能要按岗位设可见性，异步把岗位列表补上（普通员工没有权限就留空，不阻塞表单）
    api("GET", "/roles").then(r => { if (state.pe) { state.pe.roles = r.roles || []; render(); } }).catch(() => {});
  },
  // 编辑款式：工序和原图分开取。工序没取到之前不许提交（否则会用空列表把库里的工序整套覆盖掉）；
  // 原图没取到时图片区锁住并给"重新加载"，保存时不带图片字段
  async editStyle(id) {
    const s = (state.styles || []).find(x => x.id === id); if (!s) return;
    const size = {}, color = {};
    String(s.size || "").split(",").forEach(x => { if (x) size[x] = true; });
    String(s.color || "").split(",").forEach(x => { if (x) color[x] = true; });
    clearPhotoDraft();
    styleForm = { id: s.id, name: s.name, code: s.code || "", customer: s.customer || "", size, color, err: {}, origImages: null, imageCount: s.image_count || 0 };
    state.pe = { styleId: s.id, mode: "default", sizes: String(s.size || "").split(",").filter(Boolean), roles: [], items: [], loaded: false };
    formSnap.base = null;
    A.loadStyleImages();
    render(); window.scrollTo(0, 0);
    try {
      const [r, roleRes] = await Promise.all([
        api("GET", `/styles/${id}/processes`),
        api("GET", "/roles").catch(() => ({ roles: [] }))
      ]);
      if (!styleForm || styleForm.id !== id) return;          // 等的时候已经退出了编辑
      state.pe = {
        styleId: s.id, loaded: true,
        mode: (r.list[0] && r.list[0].price_mode) || "default",
        sizes: String(s.size || "").split(",").filter(Boolean),
        roles: roleRes.roles || [],
        items: r.list.map((x) => ({
          name: x.name, unitPrice: x.unit_price, dailyQuota: x.daily_quota,
          prices: x.prices || {}, showPrice: x.show_price !== false, visibleRoles: x.visible_roles || []
        }))
      };
      formSnap.base = formSnap();
      render();
    } catch (e) { render(); toast(((e && e.error) || "加载失败") + "，工序没取到，请返回重新打开"); }
  },
  // 取编辑中款式的原图（失败可重试）；取回之前按张数摆占位
  async loadStyleImages() {
    const f = styleForm; if (!f || !f.id) return;
    f.imagesLocked = false;
    photoDraft.style = Array.from({ length: f.imageCount }, () => ({ key: "p" + (++photoSeq), src: "", data: "", status: "processing" }));
    refreshPicker("style");
    try {
      const full = await api("GET", "/styles/" + f.id);
      if (styleForm !== f) return;
      const imgs = styleImages(full.style || {});
      cacheFullImgs(f.id, imgs.filter(showable));
      f.origImages = imgs;
      photoDraft.style = imgs.map(photoItem);
      if (formSnap.base && state.pe && state.pe.loaded) formSnap.base = formSnap();
    } catch (e) {
      if (styleForm !== f) return;
      photoDraft.style = []; f.imagesLocked = true;
      toast((e && e.error) || "原图没加载出来");
    }
    refreshPicker("style");
  },
  cancelStyle() { styleForm = null; state.pe = null; clearPhotoDraft(); formSnap.base = null; render(); },
  // 表单里有多处操作会触发重绘（选尺码/颜色、加工序…），重绘前先把输入框里的内容存回 styleForm
  syncStyleForm() {
    if (!styleForm) return;
    if ($("sf-name")) styleForm.name = val("sf-name");
    if ($("sf-code")) styleForm.code = val("sf-code");
  },

  /* ---- 款式尺码/颜色/客户 选项控件 ---- */
  setStyleKw: debouncedSearch("_stT", "st-kw", 250, (v) => { state.styleKw = v; }),

  // 同步工序：裁床单的工序是下单时的快照（改价不追溯历史工资），要生效得在这里选单同步
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


  /* ---------- 工序模板（整套工序清单） ---------- */
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

  /* ---------- 系统推送订阅 ---------- */
  // VAPID 公钥是 base64url，要转成 Uint8Array 才能传给 pushManager.subscribe
  async togglePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return toast("这个浏览器不支持系统推送");
    try {
      const reg = await navigator.serviceWorker.ready;
      const cur = await reg.pushManager.getSubscription();
      if (cur) {
        await api("POST", "/push/unsubscribe", { endpoint: cur.endpoint }).catch(() => {});
        await cur.unsubscribe();
        state.pushOn = false; render(); return toast("已关闭系统推送");
      }
      if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") {
        return toast("你拒绝了通知权限，可以在浏览器设置里改回来");
      }
      const { key } = await api("GET", "/push/public-key");
      const pad = "=".repeat((4 - key.length % 4) % 4);
      const raw = atob((key + pad).replace(/-/g, "+").replace(/_/g, "/"));
      const appKey = Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
      await api("POST", "/push/subscribe", { subscription: sub });
      state.pushOn = true; render(); toast("已开启系统推送");
    } catch (e) { toast((e && e.error) || "开启失败，请检查通知权限"); }
  },
  // 进「我的」页时同步一下开关的真实状态（用户可能在系统设置里关掉了）
  async refreshPushState() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      const reg = await navigator.serviceWorker.ready;
      state.pushOn = !!(await reg.pushManager.getSubscription());
    } catch (e) { state.pushOn = false; }
  },

  /* ---------- 扫菲打点（按扎） ---------- */
  setTicketInput(v) { state.scan.ticketInput = v; },
  async lookupTicket(opt) {
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
      buzz([40, 60, 40]);
      toast((e && e.error) || "查不到这张菲票");
    }
    render();
    // 扫码进来的：把结果卡片滚到眼前，不用自己往下找
    if (opt && opt.scroll && state.scan.bundle) {
      setTimeout(() => { const el = $("scan-result"); if (el) el.scrollIntoView({ block: "start", behavior: REDUCED_MOTION ? "auto" : "smooth" }); }, 60);
    }
  },
  scanBundleSubmit(orderProcessId) {
    return guard("scan-" + orderProcessId, async () => {
      const el = $("sq-" + orderProcessId);
      const raw = el ? el.value.trim() : "";
      if (raw !== "" && !(Number(raw) > 0)) return toast("件数要大于 0");
      try {
        const r = await api("POST", "/scan", {
          ticketNo: state.scan.bundle.ticket_no, orderProcessId,
          qty: raw === "" ? undefined : Number(raw),   // 不填就是完成整扎剩余
          date: state.scan.date
        });
        buzz(30);
        toast(r && r.remaining === 0 ? `已打点 ${num(r.record.qty)} 件，这道工序整扎做完了` : `已打点 ${num(r.record.qty)} 件`);
        await A.lookupTicket();          // 重新拉一次，剩余件数立刻刷新
        await loadView("scan"); render();
      } catch (e) { buzz([40, 60, 40]); toast((e && e.error) || "打点失败"); }
    });
  },

  /* 摄像头扫码性能：jsQR 耗时与像素数成正比，先只解取景框附近的裁切区域（ROI，更快也更容易识别小码），
   * 每隔几帧再解整帧兜底；反色（黑底白码）少见，每 4 帧才试一次，省一半耗时。 */
  async startCamera() {
    const sc = state.scan;
    if (sc.camOn) { A.stopCamera(); return; }
    // 先渲染取景区；拿到视频流后不能再 render()（会把绑好流的 <video> 换掉导致黑屏），提示都直接改 DOM
    sc.camOn = true; sc.camMsg = "正在打开摄像头…"; render();
    const session = A._camSession = (A._camSession || 0) + 1;       // 关了又开，旧的那一轮循环要能认出自己已作废
    // 提示音要在用户点按的那一刻创建 AudioContext，否则 iOS 不让出声
    try { if (!A._beepCtx && (window.AudioContext || window.webkitAudioContext)) A._beepCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { }

    const setMsg = (t) => {
      state.scan.camMsg = t;
      const el = document.querySelector(".scan-hint");
      if (el) el.textContent = t;
    };
    // 每次用之前重新拿一次 video 元素并确认流还接着：万一别处触发了重绘，这里能自愈
    const attach = (stream) => {
      const v = $("scan-cam");
      if (!v) return null;
      if (v.srcObject !== stream) {
        v.srcObject = stream;
        v.setAttribute("playsinline", "");   // iOS 不加这个会强制全屏播放
        v.muted = true;
        const pr = v.play();
        if (pr && pr.catch) pr.catch(() => { });
      }
      return v;
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      if (A._camSession !== session || !state.scan.camOn) { stream.getTracks().forEach(t => t.stop()); return; }
      A._camStream = stream;
      if (!attach(stream)) { A.stopCamera(); return; }

      // 手电筒 / 连续对焦：只有部分安卓机型支持，拿得到能力才露出按钮
      const track = stream.getVideoTracks()[0];
      A._torchOn = false;
      try {
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        if (caps.focusMode && caps.focusMode.indexOf("continuous") >= 0) track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => { });
        A._torchCap = !!caps.torch;
        const tb = $("scan-torch"); if (tb && caps.torch) tb.hidden = false;
      } catch (e) { }

      const detector = HAS_NATIVE_SCAN ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
      if (!detector && !window.jsQR) {
        setMsg("正在加载扫码组件…");
        await new Promise((resolve, reject) => {
          const el = document.createElement("script");
          el.src = "/jsQR.js"; el.onload = resolve; el.onerror = reject;
          document.head.appendChild(el);
        }).catch(() => { toast("扫码组件加载失败，请手动输入扎号"); });
      }
      const jsQR = window.jsQR;
      setMsg("把菲票上的二维码放进框里");

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      let lastBad = "", lastBadAt = 0;
      const hit = (raw) => {
        if (!/^JJ:\d+$/i.test(raw || "")) {
          // 扫到了别的码（客户条码、网址）：提示一次，别每帧都刷
          if (raw && (raw !== lastBad || Date.now() - lastBadAt > 3000)) { lastBad = raw; lastBadAt = Date.now(); setMsg("这不是本系统的菲票码，请对准菲票上的二维码"); }
          return false;
        }
        buzz(60); A._beep();
        state.scan.ticketInput = raw.replace(/^JJ:/i, "");
        A.stopCamera();
        A.lookupTicket({ scroll: true });
        return true;
      };

      let frame = 0, waited = 0;
      // 有新帧才解；<video> 被重绘替换后新帧回调不会再来，另挂一个定时器兜底，tick 里的 attach 会把流接回新元素
      const next = (video) => {
        if (A._camSession !== session || !state.scan.camOn) return;
        let armed = true;
        const fire = () => { if (!armed) return; armed = false; clearTimeout(A._camTimer); A._camTimer = setTimeout(tick, detector ? 60 : 90); };
        if (video && video.requestVideoFrameCallback) video.requestVideoFrameCallback(fire);
        A._camTimer = setTimeout(fire, 300);
      };
      const tick = async () => {
        if (A._camSession !== session || !state.scan.camOn) return;
        const video = attach(stream);
        if (!video) { A.stopCamera(); return; }
        // 刚打开时 videoWidth 还是 0，要等第一帧解码出来
        if (!video.videoWidth) {
          waited += 150;
          if (waited === 3000) setMsg("摄像头没出画面，试试关掉再打开，或直接手动输入扎号");
          A._camTimer = setTimeout(tick, 150);
          return;
        }
        frame++;
        try {
          if (detector) {
            const codes = await detector.detect(video);
            if (A._camSession !== session || !state.scan.camOn) return;   // 等检测结果时摄像头已被关掉
            for (const c of codes) if (hit(c.rawValue)) return;
          } else if (jsQR) {
            const vw = video.videoWidth, vh = video.videoHeight;
            // 每 3 帧里 2 帧只解中间的方块（取景框附近，比框大一圈留余量），第 3 帧解整帧兜底
            const roi = frame % 3 !== 0;
            const side = Math.min(vw, vh) * 0.8;
            const sx = roi ? (vw - side) / 2 : 0, sy = roi ? (vh - side) / 2 : 0;
            const sw = roi ? side : vw, sh = roi ? side : vh;
            const scale = Math.min(1, (roi ? 480 : 640) / Math.max(sw, sh));
            canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: frame % 4 === 0 ? "attemptBoth" : "dontInvert" });
            if (code && hit(code.data)) return;
          }
        } catch (e) { /* 单帧解不出来无所谓，下一帧继续 */ }
        next(video);
      };
      tick();
    } catch (e) {
      A.stopCamera();
      // 权限被拒、没有摄像头、被别的应用占用是三回事，分开提示
      const name = e && e.name;
      if (name === "NotAllowedError") toast("摄像头权限被拒绝，请在浏览器设置里允许，或手动输入扎号");
      else if (name === "NotFoundError") toast("这台设备没有可用的摄像头，请手动输入扎号");
      else if (name === "NotReadableError") toast("摄像头被别的程序占用了，关掉它再试");
      else toast("打不开摄像头（" + (name || "未知错误") + "），请手动输入扎号");
    }
  },
  stopCamera() {
    A._camSession = (A._camSession || 0) + 1;
    clearTimeout(A._camTimer); A._camTimer = null;
    if (A._camStream) { A._camStream.getTracks().forEach(t => t.stop()); A._camStream = null; }
    A._torchOn = false; A._torchCap = false;
    state.scan.camOn = false; state.scan.camMsg = ""; render();
  },
  async toggleTorch() {
    const track = A._camStream && A._camStream.getVideoTracks()[0];
    if (!track) return;
    try {
      A._torchOn = !A._torchOn;
      await track.applyConstraints({ advanced: [{ torch: A._torchOn }] });
      const b = $("scan-torch"); if (b) { b.classList.toggle("on", A._torchOn); b.setAttribute("aria-pressed", String(A._torchOn)); }
    } catch (e) { A._torchOn = false; toast("这台手机不支持在网页里开手电筒"); }
  },
  // 扫到码的"嘀"：1.2kHz、80ms，音量压低，车间里听得见又不刺耳
  _beep() {
    const ac = A._beepCtx;
    if (!ac) return;
    try {
      if (ac.state === "suspended") ac.resume();
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
      o.type = "sine"; o.frequency.value = 1200;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.09);
    } catch (e) { }
  },

  /* ---------- 打印菲票 ---------- */
  cpSet(k, v) {
    state.cp[k] = (k === "from" || k === "to" || k === "copies") ? Math.max(1, Number(v) || 1) : v;
    if (k === "copies") state.cp.copies = Math.min(10, state.cp.copies);
    // 改了任何设置，上一次排好的内容就作废，必须重新排——否则会印出跟界面对不上的东西
    state.cp.ready = null;
    render();
  },
  cpToggle(k) { state.cp[k] = !state.cp[k]; state.cp.ready = null; render(); },
  // 必须是同步函数、直接在 onclick 里调 print()，中间不能有 await——
  // 一旦跨过 await，浏览器就不再认为这是用户手势触发的，又会被当成自动打印拦掉
  firePrint() { window.print(); },
  cpStep(d) { A.cpSet("copies", (Number(state.cp.copies) || 1) + d); },
  cpReset() { state.cp.ready = null; $("print-root").innerHTML = ""; render(); },

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
        `<span>${esc(p.name)}${cp.showPrice && p.show_price ? ` ${num(p.unit_price)}` : ""}</span>`).join("")}</div>
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
    // 不自动 print()：Safari 会拦下非用户手势触发的打印，改成露出按钮让用户点
    state.cp.ready = { count: bundles.length, copies };
    render();
    // 滚到按钮那儿，免得用户不知道还要再点一下
    setTimeout(() => { const el = $("do-print-btn"); if (el) el.scrollIntoView({ block: "center", behavior: "smooth" }); }, 80);
  },

  /* ---------- 生产进度 ---------- */
  setPgKw: debouncedSearch("_pgT", "pg-kw", 250, (v) => { state.pgKw = v; }),
  // 删掉裁床单里单独的一扎：排错了一扎、或某个颜色尺码不做了，不用整张单重排。
  // 已经打过点的扎后端会拒（那等于把工人做过的活连工资一起抹掉）。
  delBundle(id, bundleNo, qty, backToOrderId) {
    modal({
      title: "删除这一扎", danger: true, okText: "删除",
      body: `确定删掉扎号 ${bundleNo}（${num(qty)} 件）吗？这张菲票作废，裁床单的总扎数和总件数会跟着减少。`,
      onOk: () => {
        (async () => {
          try {
            await api("DELETE", "/bundles/" + id);
            toast("已删除");
            // 详情页删完就没东西可看了，退回该单的进度页
            if (backToOrderId) go("cutprogress", backToOrderId);
            else { await loadView(route.v); render(); }
          } catch (e) { toast((e && e.error) || "删除失败"); }
        })();
        return true;
      }
    });
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
    // customer 现在是选择器不是输入框，不能再从 DOM 兜（会读成 undefined 把已选的清掉）
    ["bedNo", "docNo", "orderNo", "bedNote", "ticketNote", "companyName"].forEach(k => {
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

  // 从「查看裁床单」进来时 state.co.list 可能是空的（没经过生产管理页），
  // 所以这两个包一层：先保证列表里有这张单的数据，再复用原来的弹窗
  async ensureCoOrder(id) {
    if ((state.co.list || []).some((o) => o.id === id)) return;
    if (state.cv && state.cv.order && state.cv.order.id === id) { state.co.list = [...(state.co.list || []), state.cv.order]; return; }
    try {
      const r = await api("GET", "/cut-orders?limit=200");
      state.co.list = r.list || [];
    } catch (e) { /* 拉不到就退回用详情页已有的数据 */ }
    if (!(state.co.list || []).some((o) => o.id === id) && state.cv) {
      state.co.list = [...(state.co.list || []), state.cv.order];
    }
  },
  async editCutOrderFrom(id) { await A.ensureCoOrder(id); A.editCutOrder(id); },
  async delCutOrderFrom(id) {
    await A.ensureCoOrder(id);
    const o = (state.co.list || []).find((x) => x.id === id);
    confirmDelCutOrder(o, async () => {
      // 删完这张单，详情页已经没有东西可看了，回生产管理列表
      try { await api("DELETE", "/cut-orders/" + id); toast("已删除"); go("cutorders"); }
      catch (e) { toast((e && e.error) || "删除失败"); }
    });
  },

  /* ---------- 生产管理 ---------- */
  setCoRange(k) { state.co.range = k; run(() => Promise.resolve()); },
  setCoTab(k) { state.co.tab = k; render(); },
  setCoKw: debouncedSearch("_coT", "co-kw", 300, (v) => { state.co.kw = v; }, () => loadView("cutorders")),
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
      cancelOnly: true, cancelText: "取消"
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
    confirmDelCutOrder(o, () => run(() => api("DELETE", "/cut-orders/" + id), "已删除"));
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
  async optCreate(type) {
    const value = (state.optUI[type].kw || "").trim();
    if (!value) return;
    A.syncStyleForm();
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

  /* ---- 工序编辑器（款式表单 与 修改工序页 共用） ---- */
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
  saveStyle() {
    return guard("saveStyle", async () => {
      A.syncStyleForm();
      const f = styleForm;
      if (!f) return;
      f.err = {};
      if (!f.name) f.err.name = "请填写款式名称";
      if (!f.code) f.err.code = "请填写款号";
      if (f.err.name || f.err.code) {
        render();
        // 滚到第一个出错的输入框并聚焦，别让人在长表单里自己找
        const bad = document.querySelector(".in.bad"); if (bad) { bad.scrollIntoView({ block: "center" }); bad.focus(); }
        return;
      }
      if (!state.pe || !state.pe.loaded) return toast("工序还没加载出来，不能提交，请返回重新打开");
      const draft = photoDraft.style || [];
      if (draft.some(p => p.status === "processing")) return toast("图片还在处理，请稍等几秒再提交");
      if (draft.some(p => p.status === "error")) return toast("有图片处理失败了，点它重试或者删掉再提交");
      const images = draft.map(p => p.data);
      const body = {
        name: f.name, code: f.code,
        size: Object.keys(f.size).join(","), color: Object.keys(f.color).join(","), customer: f.customer
      };
      // 图片没动过就不带图片字段，避免改个款名也要把几 MB 的图原样再传一遍
      const same = f.origImages && f.origImages.length === images.length && f.origImages.every((u, k) => u === images[k]);
      if (!f.imagesLocked && !(f.id && same)) {
        body.images = images; body.image = images[0] || "";
        if (images[0]) { try { body.thumb = await makeThumb(images[0]); } catch (e) { } }
      }
      try {
        toast("保存中…", true);
        const r = await api(f.id ? "PATCH" : "POST", f.id ? "/styles/" + f.id : "/styles", body);
        const styleId = f.id || (r.style && r.style.id);
        state.pe.styleId = styleId;
        await api("PUT", `/styles/${styleId}/processes`, { items: A.peCollect() });
        if (body.images) cacheFullImgs(styleId, images.filter(showable));
        styleForm = null; state.pe = null; clearPhotoDraft(); formSnap.base = null;
        await loadView("styles"); render(); toast("已保存");
      } catch (e) { toast((e && e.error) || "保存失败"); }
    });
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
  setSlogDate(v) { if (!v) return; state.slog.date = v; state.slog.records = null; state.slog.who = ""; go("scanlog"); },
  // 人员筛选是纯前端的：记录已经全在手上，不用为了切人再跑一趟接口
  setSlogWho(id) { state.slog.who = state.slog.who === id ? "" : id; render(); },

  /* ---- 管理：员工 ---- */
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

/* ================= 下拉刷新 =================
 * 顶部下拉强制刷新当前页，指示器跟手（阻尼）、拉够变色提示、刷新时转圈；横向滑动不误触发。 */
(function setupPullRefresh() {
  const THRESHOLD = 64;
  let startX = 0, startY = null, decided = false, pulling = false, dist = 0, refreshing = false, ind = null;
  const canPull = () => !refreshing && me() && !overlayOpen() && !notifPanelOpen && window.scrollY <= 0 && !state.scan.camOn;
  const node = () => {
    if (!ind) {
      ind = document.createElement("div"); ind.className = "ptr"; ind.setAttribute("aria-hidden", "true");
      ind.innerHTML = `<span class="ptr-ic">${icon("refresh")}</span>`;
      document.body.appendChild(ind);
    }
    return ind;
  };
  const show = (d, spin) => {
    const el = node(), k = Math.min(1, d / THRESHOLD);
    el.classList.remove("back");
    el.style.transform = `translate3d(-50%,${d - 48}px,0)`;
    el.style.opacity = String(k);
    el.classList.toggle("ready", d >= THRESHOLD);
    el.classList.toggle("spin", !!spin);
    el.querySelector(".ptr-ic").style.transform = spin ? "" : `rotate(${k * 300}deg)`;
  };
  const hide = () => {
    if (!ind) return;
    ind.classList.add("back"); ind.classList.remove("spin", "ready");
    ind.style.transform = "translate3d(-50%,-48px,0)"; ind.style.opacity = "0";
  };
  document.addEventListener("touchstart", (e) => {
    startY = null;
    if (!canPull() || e.touches.length > 1) return;
    if (e.target.closest && e.target.closest(".tbl-wrap,.chiprow,.scan-viewport,.opt-list,.lightbox,.mask")) return;
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; decided = false; pulling = false; dist = 0;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY, dx = e.touches[0].clientX - startX;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      if (Math.abs(dx) > Math.abs(dy) || dy < 0 || window.scrollY > 0) { startY = null; return; }
    }
    pulling = true;
    dist = dy > 0 ? rubber(dy, 600) : 0;
    show(dist, false);
  }, { passive: true });
  const end = async () => {
    if (startY === null || !pulling) { startY = null; return; }
    startY = null; pulling = false;
    if (dist < THRESHOLD) { hide(); return; }
    refreshing = true; show(THRESHOLD * 0.8, true); buzz(8);
    try { await loadView(route.v); render(); }
    catch (e) { toast((e && e.error) || "刷新失败"); }
    refreshing = false; hide();
  };
  document.addEventListener("touchend", end);
  document.addEventListener("touchcancel", end);
})();

/* ================= 款式图：拖进来 / 粘贴 =================
 * 电脑上建款式，从文件夹直接拖图进图片区、或者截图后 Ctrl+V 就能加，不用每次点"添加图片"再翻文件夹。 */
const hasFiles = e => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].indexOf("Files") >= 0);
document.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();                                     // 不拦的话浏览器会直接打开这张图、页面就没了
  const g = e.target.closest && e.target.closest(".photos-grid.editable");
  document.querySelectorAll(".photos-grid.drop").forEach(x => { if (x !== g) x.classList.remove("drop"); });
  if (g) { g.classList.add("drop"); e.dataTransfer.dropEffect = "copy"; } else e.dataTransfer.dropEffect = "none";
});
document.addEventListener("dragleave", (e) => {
  const g = e.target.closest && e.target.closest(".photos-grid.editable");
  if (g && !g.contains(e.relatedTarget)) g.classList.remove("drop");
});
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const g = e.target.closest && e.target.closest(".photos-grid.editable");
  document.querySelectorAll(".photos-grid.drop").forEach(x => x.classList.remove("drop"));
  if (g) A.addPhotoFiles(g.getAttribute("data-ctx"), [...(e.dataTransfer.files || [])]);
});
document.addEventListener("paste", (e) => {
  if (e.target && e.target.closest && e.target.closest("input,textarea,[contenteditable]")) return;
  const g = document.querySelector(".photos-grid.editable");
  if (!g || !e.clipboardData) return;
  const files = [...(e.clipboardData.files || [])].filter(f => /^image\//.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  A.addPhotoFiles(g.getAttribute("data-ctx"), files);
});

/* ================= 启动 ================= */
window.go = go; window.A = A;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; });
window.addEventListener("appinstalled", () => { deferredInstall = null; toast("已添加到手机主屏"); });
// 前端发了新版本：Service Worker 一接管就提示刷新（不自动刷，免得把正在填的表单冲掉）
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    toast("有新版本可用", true, { label: "刷新", fn: () => { reloading = true; location.reload(); } });
  });
}
if ("scrollRestoration" in history) history.scrollRestoration = "manual";   // 滚动位置自己按页面数据加载完再恢复

let bootTarget = null;   // 没登录时从深链接 / 推送进来的目标页，登录后直接去
let bootError = "";      // 启动时连不上服务器（不是登录失效），显示重试页而不是把人踢回登录
(async function boot() {
  const target = parseLocation();
  if (history.replaceState) history.replaceState({ v: target.v, id: target.id, depth: 0 }, "", routeUrl(target.v, target.id));
  // index.html 已有静态欢迎界面兜底，JS 跑起来前屏幕不会是空的；
  // 本地有 token 就直接拉数据（token 不过期）；URL 带页面（刷新/推送进来）就落到那一页，不一律回首页
  if (state.token) {
    showWelcome = true; route = target; render();
    const p = api("GET", "/me").then(r => { state.me = r.user; return loadView(target.v).catch(e => { toast((e && e.error) || "加载失败"); }); })
      .catch(e => { bootError = (e && e.error) || "连接服务器失败"; });
    await Promise.all([p, new Promise(r => setTimeout(r, 1200))]);
    if (state.me) startNotifPoll();
    else if (!state.token) { bootTarget = target.v === "home" ? null : target; route = { v: "home", id: null }; }
  } else if (target.v !== "home") bootTarget = target;
  showWelcome = false;
  render();
})();
