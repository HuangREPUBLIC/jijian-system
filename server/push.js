"use strict";
// 系统推送（Web Push）：只管怎么送达，谁该收到由 notify.js 决定。
// 通道有限（iOS 需加到主屏，微信内不支持），所以页面红点轮询必须保留，推送只是锦上添花。
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const { db, uid, DATA_DIR } = require("./db");

// VAPID 密钥换了等于所有人的订阅全部作废，必须持久化，不能每次启动重新生成。
// 沿用 .jwt_secret_jijian 的做法：存在 DATA_DIR 下，权限 600。
function loadKeys() {
  const p = path.join(DATA_DIR, ".vapid.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(p, JSON.stringify(keys), { mode: 0o600 });
    console.log("[push] 已生成 VAPID 密钥");
    return keys;
  }
}
const KEYS = loadKeys();
// mailto 是 VAPID 规范要求的联系方式，推送服务出问题时用来联系服务方
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@glorytianjin.com",
  KEYS.publicKey, KEYS.privateKey);

const publicKey = () => KEYS.publicKey;

/* ---------- 订阅存取 ---------- */
// 同一台设备重复订阅（关了又开）endpoint 是同一个，按 endpoint 覆盖，不会攒出重复行
async function saveSubscription(userId, sub, ua) {
  const endpoint = String((sub || {}).endpoint || "");
  const keys = (sub || {}).keys || {};
  if (!endpoint || !keys.p256dh || !keys.auth) return false;
  await db.prepare(
    `INSERT INTO jj_push_subscriptions(id,user_id,endpoint,p256dh,auth,ua,created_at,fail_count)
     VALUES(?,?,?,?,?,?,?,0)
     ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), p256dh=VALUES(p256dh),
       auth=VALUES(auth), ua=VALUES(ua), fail_count=0`)
    .run(uid(), userId, endpoint, keys.p256dh, keys.auth, String(ua || "").slice(0, 200), Date.now());
  return true;
}
const removeSubscription = (endpoint) =>
  db.prepare("DELETE FROM jj_push_subscriptions WHERE endpoint = ?").run(String(endpoint || ""));
const subscriptionsOf = (userId) =>
  db.prepare("SELECT * FROM jj_push_subscriptions WHERE user_id = ?").all(userId);
const countOf = async (userId) =>
  (await db.prepare("SELECT COUNT(*) c FROM jj_push_subscriptions WHERE user_id = ?").get(userId)).c;

/* ---------- 发送 ---------- */
const MAX_FAIL = 3;   // 连续失败这么多次就认为这个订阅废了，清掉，免得每次都白发一遍

// 单条发送。失败不抛错——推送只是提醒，任何情况下都不该连累主流程（单子已经存好了）。
async function sendOne(row, payload) {
  const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
    await db.prepare("UPDATE jj_push_subscriptions SET fail_count=0, last_ok_at=? WHERE endpoint=?")
      .run(Date.now(), row.endpoint);
  } catch (e) {
    // 410 Gone / 404：用户卸载了、清了数据、或订阅已过期，这个 endpoint 永远不会再通，直接删
    if (e && (e.statusCode === 410 || e.statusCode === 404)) return removeSubscription(row.endpoint);
    // 其它错误（网络抖动、推送服务 5xx）先累计，连续失败够多次再清理，避免一次抖动就丢订阅
    const n = (row.fail_count || 0) + 1;
    if (n >= MAX_FAIL) await removeSubscription(row.endpoint);
    else await db.prepare("UPDATE jj_push_subscriptions SET fail_count=? WHERE endpoint=?").run(n, row.endpoint);
  }
}

// 推给这些用户的所有设备，payload = { title, body, url, tag }；失败在内部咽掉，调用方不用 await
async function sendToUsers(userIds, payload) {
  try {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return;
    const rows = [];
    for (const id of ids) rows.push(...await subscriptionsOf(id));
    if (!rows.length) return;
    await Promise.all(rows.map((r) => sendOne(r, payload)));
  } catch (e) { console.error("[push] 发送失败", e); }
}

module.exports = { publicKey, saveSubscription, removeSubscription, countOf, sendToUsers };
