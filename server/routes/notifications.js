"use strict";
// 应用内通知，以及浏览器 / 系统推送订阅。
const express = require("express");
const { db } = require("../db");
const A = require("../auth");
const P = require("../push");
const { wrapAsync } = require("../async_router");

const router = express.Router();
wrapAsync(router, ["get", "post", "put", "patch", "delete", "all"]);

/* ---------------- 系统推送订阅 ---------------- */
// 送达受通道限制（iOS 需加到主屏，微信内不支持），页面内红点轮询仍要保留
router.get("/push/public-key", A.authRequired, (req, res) => res.json({ key: P.publicKey() }));
router.post("/push/subscribe", A.authRequired, async (req, res) => {
  const saved = await P.saveSubscription(req.user.id, req.body && req.body.subscription, req.headers["user-agent"]);
  if (!saved) return res.status(400).json({ error: "订阅信息不完整" });
  res.json({ ok: true, count: await P.countOf(req.user.id) });
});
router.post("/push/unsubscribe", A.authRequired, async (req, res) => {
  await P.removeSubscription(req.body && req.body.endpoint);
  res.json({ ok: true });
});

/* ---------------- 应用内通知（跟跟单系统一致：最近 50 条、单条删除、清空已读） ---------------- */
const NOTIF_LIMIT = 50;
router.get("/notifications", A.authRequired, async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM jj_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${NOTIF_LIMIT}`)
    .all(req.user.id);
  // actorName/targetLabel/what 老通知为 NULL，前端退回纯文本
  res.json({ list: rows.map((r) => ({
    id: r.id, text: r.text, link: r.link, createdAt: r.created_at, read: !!r.read_at,
    actorName: r.actor_name, targetLabel: r.target_label, what: r.what
  })) });
});
router.get("/notifications/unread-count", A.authRequired, async (req, res) => {
  const c = (await db.prepare("SELECT COUNT(*) c FROM jj_notifications WHERE user_id = ? AND read_at IS NULL").get(req.user.id)).c;
  res.json({ total: c });
});
router.post("/notifications/read-all", A.authRequired, async (req, res) => {
  await db.prepare("UPDATE jj_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(Date.now(), req.user.id);
  res.json({ ok: true });
});
// 只能动自己的通知
async function ownNotif(req, res) {
  const row = await db.prepare("SELECT * FROM jj_notifications WHERE id = ?").get(req.params.id);
  if (!row) res.status(404).json({ error: "通知不存在" });
  else if (row.user_id !== req.user.id) res.status(403).json({ error: "无权操作这条通知" });
  else return row;
}
router.post("/notifications/:id/read", A.authRequired, async (req, res) => {
  const row = await ownNotif(req, res); if (!row) return;
  if (!row.read_at) await db.prepare("UPDATE jj_notifications SET read_at = ? WHERE id = ?").run(Date.now(), row.id);
  res.json({ ok: true });
});
// ?read=1 清空自己的已读通知
router.delete("/notifications", A.authRequired, async (req, res) => {
  if (req.query.read !== "1") return res.status(400).json({ error: "只支持清空已读通知" });
  const r = await db.prepare("DELETE FROM jj_notifications WHERE user_id = ? AND read_at IS NOT NULL").run(req.user.id);
  res.json({ ok: true, deleted: r.affectedRows });
});
router.delete("/notifications/:id", A.authRequired, async (req, res) => {
  const row = await ownNotif(req, res); if (!row) return;
  await db.prepare("DELETE FROM jj_notifications WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

module.exports = router;
