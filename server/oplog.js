"use strict";
// 操作日志：谁在什么时间做了什么，写 jj_operation_log。
// 单独一个文件：留在 routes.js 里会让 routes_cutting.js 反向 require 它，成环。
const { db, uid } = require("./db");

async function logOp(userId, action) {
  await db.prepare("INSERT INTO jj_operation_log(id,user_id,action,created_at) VALUES(?,?,?,?)")
    .run(uid(), userId || null, action, Date.now());
}

module.exports = { logOp };
