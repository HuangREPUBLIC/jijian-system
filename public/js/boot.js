"use strict";
// 启动：把 go / A 暴露给 onclick，恢复登录态，落到 URL 对应的页面。必须最后加载。

window.go = go; window.A = A;

if ("scrollRestoration" in history) history.scrollRestoration = "manual";   // 滚动位置自己按页面数据加载完再恢复

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
