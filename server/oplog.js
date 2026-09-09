"use strict";
/**
 * 操作日志：谁在什么时间做了什么，写 jj_operation_log。
 *
 * 从 routes.js 抽出来单独一个文件：routes.js 要 require("./routes_cutting") 挂子路由，
 * 如果 logOp 留在 routes.js 里，routes_cutting.js 想调用它就要反向 require routes.js，
 * 两个文件互相 require 会成环（Node 的 circular require 会让其中一边拿到未初始化完的
 * module.exports）。抽成独立文件后两边都从这里 require，没有环。
 */
const { db, uid } = require("./db");

async function logOp(userId, action) {
  await db.prepare("INSERT INTO jj_operation_log(id,user_id,action,created_at) VALUES(?,?,?,?)")
    .run(uid(), userId || null, action, Date.now());
}

module.exports = { logOp };
