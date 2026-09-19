"use strict";
// 通知投递的统一入口：写站内信 + 发系统推送。单独一个文件避免 routes.js/routes_cutting.js 循环依赖。
// 写通知失败一律咽掉：不该因为通知写不进去而让整个请求 500。
const { db, uid } = require("./db");
const A = require("./auth");
const P = require("./push");

// meta = { actorName, targetLabel, what, tag }：前端拼"谁 + 对象 + 做了什么"；tag 相同的推送互相覆盖
async function notifyUsers(userIds, text, link, excludeUserId, meta) {
  const targets = [...new Set((userIds || []).filter((id) => id && id !== excludeUserId))];
  if (!targets.length) return;
  try {
    for (const to of targets) {
      await db.prepare(
        "INSERT INTO jj_notifications(id,user_id,text,link,created_at,read_at,actor_name,target_label,what) VALUES(?,?,?,?,?,NULL,?,?,?)")
        .run(uid(), to, text, link || null, Date.now(),
          meta ? meta.actorName : null, meta ? meta.targetLabel : null, meta ? meta.what : null);
    }
  } catch (e) { console.error("[notify] 写通知失败", e); }

  // 同一批人再发一次系统推送（App 没打开也能看到）：标题放对象名，正文放"谁做了什么"
  P.sendToUsers(targets, {
    title: (meta && meta.targetLabel) || "计件跟踪",
    body: (meta && meta.actorName ? meta.actorName + " " : "") + ((meta && meta.what) || text),
    url: link || "/",
    tag: (meta && meta.tag) || "jijian"
  });
}

// 通知所有管理员/主管：款式、工序、裁床单这类共享主数据被改动时，让其他管理层知道
async function notifyManagers(text, link, excludeUserId, meta) {
  try {
    const rows = await db.prepare("SELECT id, role FROM users WHERE deleted = 0").all();
    await notifyUsers(rows.filter((u) => A.isManager(u)).map((u) => u.id), text, link, excludeUserId, meta);
  } catch (e) { console.error("[notify] 通知管理员失败", e); }
}

module.exports = { notifyUsers, notifyManagers };
