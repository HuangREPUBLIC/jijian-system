"use strict";
/**
 * 系统推送（Web Push）：App 没打开时也能弹手机系统通知。
 *
 * 这是"投递"这一层，只管怎么送达；"谁该收到"仍由 notify.js 里的
 * notifyManagers / notifyUsers 决定。以后要加企业微信/服务号通道，只改这个文件。
 *
 * 送达能力的边界（通道限制，不是代码能解决的）：
 *   - iOS：必须"添加到主屏幕"后从图标打开才收得到，Safari 普通标签页收不到
 *   - 微信内置浏览器：完全不支持
 *   - 国产安卓 ROM：支持程度参差，可能延迟或不送达
 * 所以页面内的红点/未读数轮询必须保留，推送是锦上添花不是替代品。
 */
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

/**
 * 给若干用户的所有设备推送。
 * payload: { title, body, url, tag }
 *   url 用于点击通知后跳转；tag 相同的通知会互相覆盖而不是堆一屏。
 * 调用方不用 await：失败已在内部咽掉，不影响主流程。
 */
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

module.exports = { publicKey, saveSubscription, removeSubscription, subscriptionsOf, countOf, sendToUsers };
