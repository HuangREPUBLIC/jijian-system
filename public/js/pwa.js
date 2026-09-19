"use strict";
// 装到手机主屏（安装引导），以及前端发新版本时提示刷新。

/* ---- 页面渲染 ---- */
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

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
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
});
