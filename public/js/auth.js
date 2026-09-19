"use strict";
// 登录页、欢迎页，登录 / 退出。

/* ---- 页面渲染 ---- */
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

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
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
});
