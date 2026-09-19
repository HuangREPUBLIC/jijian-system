"use strict";
// 通用小工具：转义、日期、金额、提示条、防重复提交、搜索匹配、骨架屏/空状态。

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

/* ---------- 打点记录 ----------
 * 范围由后端按岗位定：计件工/临时工只看自己的点；分厂主管/管理员看全员，多一列"谁打的"和人员筛选。 */
const HHMM = (ms) => { const d = new Date(ms), p = n => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
const shortName = (s) => (s || "").length > 2 ? s.slice(-2) : (s || "");
