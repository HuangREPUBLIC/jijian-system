"use strict";
// 我的：个人信息、本月工资、改密码、系统推送开关。

/* ---- 进页面前拉数据 ---- */
LOADERS.mine = async () => {
  await A.refreshPushState();
  const m = await api("GET", "/me");
  state.me = m.user;
  if (!isManager()) state.pay.mine = await api("GET", "/payroll/mine?month=" + state.pay.month).catch(() => null);
};

/* ---- 页面渲染 ---- */
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

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
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

  setMyPayMonth(v) { if (!v) return; state.pay.month = v; state.pay.mine = null; go("mine"); },
  async changeMyPw() {
    const p1 = ($("my-p1") || {}).value || "", p2 = ($("my-p2") || {}).value || "";
    if (!p1 || p1 !== p2) return toast("两次输入的新密码不一致");
    try {
      await api("POST", "/password/change", { newPassword: p1 });
      $("my-p1").value = ""; $("my-p2").value = ""; toast("密码修改成功");
    } catch (e) { toast((e && e.error) || "修改失败"); }
  },
});
