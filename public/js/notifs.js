"use strict";
// 消息通知：定时轮询未读数、铃铛红点、通知面板、通知页。

/* ---- 进页面前拉数据 ---- */
LOADERS.notifs = async () => {
  state.notif.list = (await api("GET", "/notifications")).list || [];
};

/* ---- 页面渲染 ---- */
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

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
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
});
