"use strict";
// 考勤、效率、工资：三者共用同一套工时口径（EFF_HOURS_EXPR、effectiveHours 等），所以放在一个文件里。
const express = require("express");
const { db, uid, getSetting } = require("../db");
const A = require("../auth");
const { logOp } = require("../oplog");
const { notifyUsers } = require("../notify");
const { wrapAsync } = require("../async_router");
const { roleLabelWith } = require("./shared");

const router = express.Router();
wrapAsync(router, ["get", "post", "put", "patch", "delete", "all"]);

const PAYROLL_FIELD_LABELS = { mealSubsidy: "餐补", penalty: "扣罚", bonus: "奖金" };

/* ---------------- 考勤（管理员手动录入，给打卡机对接留口子） ---------------- */
router.post("/attendance", A.authRequired, async (req, res) => {
  const { userId, date, hours } = req.body || {};
  if (!userId || !date || hours === undefined) return res.status(400).json({ error: "缺少员工/日期/工时" });
  const id = uid();
  await db.prepare(`INSERT INTO jj_attendance(id,user_id,date,hours,source,created_at) VALUES(?,?,?,?,'manual',?)
    ON DUPLICATE KEY UPDATE hours=VALUES(hours)`)
    .run(id, userId, date, Number(hours), Date.now());
  res.json({ attendance: await db.prepare("SELECT * FROM jj_attendance WHERE user_id=? AND date=?").get(userId, date) });
});

router.get("/attendance", A.authRequired, async (req, res) => {
  const { date, month } = req.query;
  let userId = req.query.userId;
  if (!userId) userId = req.user.id;
  if (userId !== req.user.id && !A.canActAsAdmin(req.user)) return res.status(403).json({ error: "没有权限查看他人考勤" });
  let rows;
  if (date) rows = [await db.prepare("SELECT * FROM jj_attendance WHERE user_id=? AND date=?").get(userId, date)].filter(Boolean);
  else if (month) rows = await db.prepare("SELECT * FROM jj_attendance WHERE user_id=? AND date LIKE ? ORDER BY date").all(userId, month + "%");
  else rows = await db.prepare("SELECT * FROM jj_attendance WHERE user_id=? ORDER BY date DESC LIMIT 60").all(userId);
  res.json({ attendance: rows });
});

/* ---------------- 完成百分比：日效率% = 当天 sum(完成件数/工序小时定额) / 当天出勤小时 ---------------- */
// 扫扎打点用 jj_cut_order_processes.daily_quota（日定额/标准工时=小时定额），自由打点直接用 hour_quota；
// 必须 LEFT JOIN jj_processes：扫扎记录 process_id 指向款式工序，在工序模板表里没有对应行
const STD_WORK_HOURS = 8;   // 标准工作日 8 小时，日定额↔小时定额换算基准
const EFF_HOURS_EXPR = `CASE
    WHEN cop.daily_quota > 0 THEN s.qty * ${STD_WORK_HOURS} / cop.daily_quota
    WHEN p.hour_quota > 0 THEN s.qty * 1.0 / p.hour_quota
    ELSE 0 END`;
const EFF_FROM = `FROM jj_scan_records s
    LEFT JOIN jj_cut_order_processes cop ON cop.id = s.order_process_id
    LEFT JOIN jj_processes p ON p.id = s.process_id`;
async function effectiveHours(userId, datePattern, exact) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(${EFF_HOURS_EXPR}),0) AS eh ${EFF_FROM}
    WHERE s.user_id = ? AND s.date ${exact ? "=" : "LIKE"} ?`).get(userId, datePattern);
  return row ? row.eh : 0;
}
async function attendanceSum(userId, datePattern) {
  const row = await db.prepare("SELECT COALESCE(SUM(hours),0) AS h FROM jj_attendance WHERE user_id=? AND date LIKE ?").get(userId, datePattern);
  return row ? row.h : 0;
}

router.get("/efficiency/daily", A.authRequired, async (req, res) => {
  const { date } = req.query;
  let userId = req.query.userId;
  if (!date) return res.status(400).json({ error: "缺少日期" });
  if (!userId) userId = req.user.id;
  if (userId !== req.user.id && !A.canActAsAdmin(req.user)) return res.status(403).json({ error: "没有权限查看他人效率" });
  const eh = await effectiveHours(userId, date, true);
  const att = await db.prepare("SELECT hours FROM jj_attendance WHERE user_id=? AND date=?").get(userId, date);
  const attHours = att ? att.hours : 0;
  res.json({ date, userId, effectiveHours: eh, attendanceHours: attHours, percent: attHours > 0 ? eh / attHours : null });
});

router.get("/efficiency/monthly", A.authRequired, async (req, res) => {
  const { month } = req.query;
  let userId = req.query.userId;
  if (!month) return res.status(400).json({ error: "缺少月份" });
  if (!userId) userId = req.user.id;
  if (userId !== req.user.id && !A.canActAsAdmin(req.user)) return res.status(403).json({ error: "没有权限查看他人效率" });
  const eh = await effectiveHours(userId, month + "%", false);
  const attHours = await attendanceSum(userId, month + "%");
  res.json({ month, userId, effectiveHours: eh, attendanceHours: attHours, percent: attHours > 0 ? eh / attHours : null });
});

// 全员一次性按人 GROUP BY 聚合（固定 3 条 SQL，不随人数增长）
async function monthlyAggByUser(month) {
  const pattern = month + "%";
  const [effRows, qtyRows, attRows] = await Promise.all([
    db.prepare(`
      SELECT s.user_id, COALESCE(SUM(${EFF_HOURS_EXPR}),0) AS eh ${EFF_FROM}
      WHERE s.date LIKE ? GROUP BY s.user_id`).all(pattern),
    db.prepare("SELECT user_id, COALESCE(SUM(qty),0) AS q FROM jj_scan_records WHERE date LIKE ? GROUP BY user_id").all(pattern),
    db.prepare("SELECT user_id, COALESCE(SUM(hours),0) AS h FROM jj_attendance WHERE date LIKE ? GROUP BY user_id").all(pattern)
  ]);
  const toMap = (rows, k) => Object.fromEntries(rows.map((r) => [r.user_id, Number(r[k]) || 0]));
  return { eh: toMap(effRows, "eh"), qty: toMap(qtyRows, "q"), att: toMap(attRows, "h") };
}

// 管理员看板：全员某月完成百分比
// 管理员自己不是计件工、不参与考勤，所以不列在效率榜里（跟薪资汇总/员工列表口径一致）
router.get("/efficiency/summary", A.authRequired, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: "缺少月份" });
  const [users, roles, agg] = await Promise.all([
    db.prepare("SELECT id, name, role FROM users WHERE deleted = 0 AND role <> 'admin'").all(),
    getSetting("roles", []),
    monthlyAggByUser(month)
  ]);
  // 看板不带工资：工资是「薪资管理」的内容，只给管理员/主管看，效率榜所有人都能开
  const list = users.map((u) => {
    const eh = agg.eh[u.id] || 0, attHours = agg.att[u.id] || 0;
    return {
      userId: u.id, name: u.name, role: u.role, roleLabel: roleLabelWith(roles, u.role),
      qty: agg.qty[u.id] || 0,
      effectiveHours: eh, attendanceHours: attHours,
      percent: attHours > 0 ? eh / attHours : null
    };
  });
  res.json({ month, list });
});

/* ---------------- 薪资管理：计件工资 = Σ(打点数量 × 工序单价) + 餐补/奖金 - 扣罚 ---------------- */
// 单价优先用打点快照，没快照的老记录才回落全局单价（改工价不追溯历史工资）；
// LEFT JOIN：扫扎记录 process_id 指向款式工序，在 jj_processes 里没有对应行
async function pieceWage(userId, datePattern) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(s.qty * COALESCE(s.unit_price, p.unit_price, 0)), 0) AS w
    FROM jj_scan_records s LEFT JOIN jj_processes p ON p.id = s.process_id
    WHERE s.user_id = ? AND s.date LIKE ?
  `).get(userId, datePattern);
  return row ? row.w : 0;
}
// 应发 = 计件 + 餐补 + 奖金 - 扣罚（adj 是 jj_payroll_adjustments 的一行，可为空）
function payTotals(wage, adj) {
  const mealSubsidy = adj ? adj.meal_subsidy : 0, penalty = adj ? adj.penalty : 0, bonus = adj ? adj.bonus : 0;
  return { pieceWage: wage, mealSubsidy, penalty, bonus, total: wage + mealSubsidy + bonus - penalty };
}
async function payrollFor(userId, month) {
  const adj = await db.prepare("SELECT * FROM jj_payroll_adjustments WHERE user_id=? AND month=?").get(userId, month);
  return payTotals(await pieceWage(userId, month + "%"), adj);
}

router.get("/payroll/mine", A.authRequired, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: "缺少月份" });
  res.json(Object.assign({ month, userId: req.user.id }, await payrollFor(req.user.id, month)));
});

router.get("/payroll/summary", A.authRequired, A.managerRequired, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: "缺少月份" });
  // 薪资表不列管理员；按人 GROUP BY 一次聚合完，公式跟 payrollFor 一致
  const [users, roles, wageRows, adjRows] = await Promise.all([
    db.prepare("SELECT id, name, role FROM users WHERE deleted = 0 AND role <> 'admin'").all(),
    getSetting("roles", []),
    db.prepare(`
      SELECT s.user_id, COALESCE(SUM(s.qty * COALESCE(s.unit_price, p.unit_price, 0)), 0) AS w
      FROM jj_scan_records s LEFT JOIN jj_processes p ON p.id = s.process_id
      WHERE s.date LIKE ? GROUP BY s.user_id`).all(month + "%"),
    db.prepare("SELECT * FROM jj_payroll_adjustments WHERE month=?").all(month)
  ]);
  const wageOf = Object.fromEntries(wageRows.map((r) => [r.user_id, Number(r.w) || 0]));
  const adjOf = Object.fromEntries(adjRows.map((r) => [r.user_id, r]));
  const list = users.map((u) => Object.assign(
    { userId: u.id, name: u.name, role: u.role, roleLabel: roleLabelWith(roles, u.role) },
    payTotals(wageOf[u.id] || 0, adjOf[u.id])));
  res.json({ month, list });
});

// 2026-06 -> "6月"，通知里的胶囊标签用，跟 fmtMonth(年月都带) 是两个格式，这里更短
function monthChip(m) {
  const mm = String(m).match(/^(\d{4})-(\d{1,2})$/);
  return mm ? `${+mm[2]}月薪资` : `${m}薪资`;
}
router.post("/payroll/adjustments", A.authRequired, A.managerRequired, async (req, res) => {
  const { userId, month, mealSubsidy, penalty, bonus, note } = req.body || {};
  if (!userId || !month) return res.status(400).json({ error: "缺少员工/月份" });
  const old = await db.prepare("SELECT * FROM jj_payroll_adjustments WHERE user_id=? AND month=?").get(userId, month);
  const newVals = { mealSubsidy: Number(mealSubsidy) || 0, penalty: Number(penalty) || 0, bonus: Number(bonus) || 0 };
  const oldVals = payTotals(0, old);
  const id = uid();
  await db.prepare(`INSERT INTO jj_payroll_adjustments(id,user_id,month,meal_subsidy,penalty,bonus,note,created_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE meal_subsidy=VALUES(meal_subsidy), penalty=VALUES(penalty), bonus=VALUES(bonus), note=VALUES(note)`)
    .run(id, userId, month, newVals.mealSubsidy, newVals.penalty, newVals.bonus, note || null, Date.now());
  await logOp(req.user.id, `调整 ${month} 薪资项：员工 ${userId}`);
  // 只报实际变了的字段
  const changedKeys = Object.keys(PAYROLL_FIELD_LABELS).filter((k) => newVals[k] !== oldVals[k]);
  let what;
  if (!changedKeys.length) what = "调整了你的薪资项(数值未变)";
  else if (changedKeys.length === 1) what = `把「${PAYROLL_FIELD_LABELS[changedKeys[0]]}」改成了${newVals[changedKeys[0]]}元`;
  else {
    const names = changedKeys.map((k) => PAYROLL_FIELD_LABELS[k]);
    what = names.length > 3 ? `修改了「${names.slice(0, 3).join("、")}」等${names.length}项` : `修改了「${names.join("、")}」`;
  }
  const targetLabel = monthChip(month);
  await notifyUsers([userId], `${req.user.name} 在你${targetLabel}里${what}`, "/payroll", req.user.id,
    { actorName: req.user.name, targetLabel, what });
  res.json(Object.assign({ month, userId }, await payrollFor(userId, month)));
});

module.exports = router;
