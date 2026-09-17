// 版本号变了就会丢弃旧缓存。改动前端后 bump 这个数字。
const CACHE = "jijian-v5";
const SHELL = ["/", "/index.html", "/app.js", "/styles.css",
  "/jsQR.js", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

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

/* ---------- 系统推送 ----------
 * App 没打开时也能弹手机系统通知。tag 相同的通知会互相覆盖而不是堆一屏：
 * 同一张裁床单连续改动只留最新一条，免得刷屏。 */
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
  // 已经开着的窗口就直接跳过去并聚焦，没有再开新窗口
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
