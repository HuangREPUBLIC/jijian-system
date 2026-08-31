"use strict";
const express = require("express");
const path = require("path");
const api = require("./routes");
const { UPLOAD_DIR, init } = require("./db");

const app = express();
app.use(express.json({ limit: "8mb" })); // 款式图片以 base64 存库，放宽请求体上限
app.use("/api", api);
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d" }));

// 前端静态资源（手机网页版 / PWA，挂法跟「跟单系统」一致）
const PUBLIC = path.join(__dirname, "..", "public");
// Service Worker 和 manifest 不能被缓存，否则前端更新推不下去
app.get(["/sw.js", "/manifest.webmanifest"], (req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  next();
});
app.use(express.static(PUBLIC));
// 单页应用兜底：非 /api、非 /uploads 的路径都回 index.html
app.get(/^\/(?!api|uploads).*/, (req, res) => res.sendFile(path.join(PUBLIC, "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "服务器出错" });
});

const PORT = process.env.PORT || 3001;

// 先初始化 MySQL（建库/建表/导入 daka/种子管理员），就绪后再开始监听。
init()
  .then(() => app.listen(PORT, () => console.log(`计件跟踪系统已启动： http://localhost:${PORT}`)))
  .catch((e) => { console.error("[启动失败] 数据库初始化出错：", e); process.exit(1); });
