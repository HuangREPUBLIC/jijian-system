"use strict";
// 路由与返回键：每页记一条历史，浮层（弹窗/大图/表单）多垫一条，返回键先关浮层；go() 切页。

/* ---- 页面渲染 ---- */
const SUB_VIEWS = { processes: "home", styles: "home", styleprocs: "home", attendance: "home", efficiency: "home",
  scanlog: "home", payroll: "home", notifs: "mine",
  cutorders: "home", cutform: "styles", cutview: "cutorders", cutprint: "cutorders",
  cutprogress: "cutorders", bundleprogress: "cutprogress", procprogress: "cutprogress" };
const VIEW_SET = { home: 1, scan: 1, mine: 1, admin: 1, processes: 1, styles: 1, styleprocs: 1, attendance: 1,
  efficiency: 1, scanlog: 1, payroll: 1, notifs: 1, cutorders: 1, cutform: 1, cutview: 1, cutprint: 1,
  cutprogress: 1, bundleprogress: 1, procprogress: 1 };
// 这几个页面离了 id 没东西可看，URL 里缺 id 时退回上级
const NEEDS_ID = { styleprocs: 1, cutform: 1, cutview: 1, cutprint: 1, cutprogress: 1, bundleprogress: 1, procprogress: 1 };

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

function syncPeForms() { A.syncStyleForm(); A.syncTplName(); A.peSyncNames(); }

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

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  // 左上角"‹ 返回"：历史里有上一页就真的后退（跟手机返回键同一条路，滚动位置也能恢复），
  // 是直接打开的深链接（没有上一页）就去逻辑上的上级页
  navBack(parent) {
    const st = history.state || {};
    if ((st.depth || 0) > 0 && !H.pending) history.back();
    else go(parent, null, { replace: true });
  },
});
