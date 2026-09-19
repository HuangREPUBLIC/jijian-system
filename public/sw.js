// 改了前端就把版本号 +1，旧缓存会被丢弃
const CACHE = "jijian-v9";
const SHELL = [
  "/", "/index.html", "/styles.css", "/js/util.js", "/js/brand.js", "/js/state.js", "/js/api.js",
  "/js/ui.js", "/js/parts.js", "/js/photos.js", "/js/viewer.js", "/js/router.js", "/js/shell.js",
  "/js/auth.js", "/js/home.js", "/js/scan.js", "/js/notifs.js", "/js/processes.js", "/js/proc_editor.js",
  "/js/styles.js", "/js/style_options.js", "/js/cut_form.js", "/js/cut_orders.js", "/js/cut_print.js",
  "/js/cut_progress.js", "/js/attendance.js", "/js/efficiency.js", "/js/scanlog.js", "/js/admin.js",
  "/js/payroll.js", "/js/mine.js", "/js/pull_refresh.js", "/js/pwa.js", "/js/boot.js", "/jsQR.js",
  "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 只处理本站的 GET；API、上传一律走网络，不缓存
  if (req.method !== "GET" || url.origin !== location.origin ||
      url.pathname.startsWith("/api") || url.pathname.startsWith("/uploads")) return;
  // 静态资源：优先网络（拿到最新），失败（离线）再用缓存
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match("/index.html")))
  );
});

/* ---------- 系统推送：tag 相同的通知互相覆盖，同一张单只留最新一条 ---------- */
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || "计件跟踪", {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.tag || "jijian",
    data: { url: d.url || "/" }
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  // 已开着的窗口直接跳转并聚焦，没有再新开
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
