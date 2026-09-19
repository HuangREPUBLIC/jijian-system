"use strict";
// 工序：工序增删改、工序模板、每日工资设置。
const express = require("express");
const { db, uid, getSetting, setSetting } = require("../db");
const A = require("../auth");
const { logOp } = require("../oplog");
const { notifyManagers } = require("../notify");
const { wrapAsync } = require("../async_router");
const { jsonParseSafe, changeWhat } = require("./shared");

const router = express.Router();
wrapAsync(router, ["get", "post", "put", "patch", "delete", "all"]);

// 通知文案："改了1个字段"带新值，改了多个就列字段名（超3个截断+总数）；
// skipValueKeys 给图片这类字段用，只报字段名不带值
const PROCESS_FIELD_LABELS = { name: "工序名", unit: "计量单位", stdQty: "标准定额", hourQuota: "小时定额", unitPrice: "单价" };

/* ---------------- 工序模板 ---------------- */
router.get("/processes", A.authRequired, async (req, res) => {
  const list = await db.prepare("SELECT * FROM jj_processes WHERE deleted = 0 ORDER BY created_at DESC").all();
  res.json({ processes: list });
});
router.post("/processes", A.authRequired, async (req, res) => {
  const { name, unit, stdQty, hourQuota, unitPrice } = req.body || {};
  if (!name || !stdQty || !hourQuota) return res.status(400).json({ error: "请填写工序名/标准定额/小时定额" });
  const id = uid();
  await db.prepare("INSERT INTO jj_processes(id,name,unit,std_qty,hour_quota,unit_price,deleted,created_at) VALUES(?,?,?,?,?,?,0,?)")
    .run(id, String(name).trim(), unit || null, Number(stdQty), Number(hourQuota), unitPrice !== undefined ? Number(unitPrice) : null, Date.now());
  await logOp(req.user.id, `新增工序模板：${String(name).trim()}`);
  await notifyManagers(`${req.user.name} 新增了工序模板「${String(name).trim()}」`, "/processes", req.user.id);
  res.json({ process: await db.prepare("SELECT * FROM jj_processes WHERE id=?").get(id) });
});
router.patch("/processes/:id", A.authRequired, async (req, res) => {
  const p = await db.prepare("SELECT * FROM jj_processes WHERE id=?").get(req.params.id);
  if (!p || p.deleted) return res.status(404).json({ error: "工序不存在" });
  const body = req.body || {};
  const { name, unit, stdQty, hourQuota, unitPrice } = body;
  if (name !== undefined) await db.prepare("UPDATE jj_processes SET name=? WHERE id=?").run(String(name).trim(), p.id);
  if (unit !== undefined) await db.prepare("UPDATE jj_processes SET unit=? WHERE id=?").run(unit, p.id);
  if (stdQty !== undefined) await db.prepare("UPDATE jj_processes SET std_qty=? WHERE id=?").run(Number(stdQty), p.id);
  if (hourQuota !== undefined) await db.prepare("UPDATE jj_processes SET hour_quota=? WHERE id=?").run(Number(hourQuota), p.id);
  if (unitPrice !== undefined) await db.prepare("UPDATE jj_processes SET unit_price=? WHERE id=?").run(Number(unitPrice), p.id);
  await logOp(req.user.id, `修改工序模板：${p.name}`);
  const what = changeWhat(PROCESS_FIELD_LABELS, body) || `修改了工序模板「${p.name}」`;
  await notifyManagers(`${req.user.name} 在「${p.name}」${what}`, "/processes", req.user.id,
    { actorName: req.user.name, targetLabel: p.name, what });
  res.json({ process: await db.prepare("SELECT * FROM jj_processes WHERE id=?").get(p.id) });
});
router.delete("/processes/:id", A.authRequired, async (req, res) => {
  const p = await db.prepare("SELECT * FROM jj_processes WHERE id=?").get(req.params.id);
  if (!p || p.deleted) return res.status(404).json({ error: "工序不存在" });
  await db.prepare("UPDATE jj_processes SET deleted=1 WHERE id=?").run(p.id);
  await logOp(req.user.id, `删除工序模板：${p.name}`);
  res.json({ ok: true });
});

/* ---------------- 日工资基数 ---------------- */
// 工价 = 日工资基数 ÷ 日定额，行情变了随时改，不写死在代码里
const DAILY_WAGE_KEY = "jj_daily_wage";
router.get("/settings/daily-wage", A.authRequired, async (req, res) => {
  res.json({ value: Number(await getSetting(DAILY_WAGE_KEY, 100)) || 100 });
});
router.post("/settings/daily-wage", A.authRequired, A.managerRequired, async (req, res) => {
  const v = Number(req.body && req.body.value);
  if (!(v > 0)) return res.status(400).json({ error: "日工资基数要大于 0" });
  const old = Number(await getSetting(DAILY_WAGE_KEY, 100)) || 100;
  await setSetting(DAILY_WAGE_KEY, v);
  await logOp(req.user.id, `日工资基数：${old} → ${v}`);
  await notifyManagers(`${req.user.name} 把日工资基数改成了 ${v} 元`, "/processes", req.user.id,
    { actorName: req.user.name, targetLabel: "日工资基数", what: `从 ${old} 元改成 ${v} 元` });
  res.json({ value: v });
});

/* ---------------- 工序模板（整套工序清单，跟 jj_processes 的单条定额模板是两回事） ---------------- */
router.get("/process-templates", A.authRequired, async (req, res) => {
  const rows = await db.prepare(
    "SELECT * FROM jj_process_templates WHERE deleted=0 ORDER BY created_at DESC").all();
  res.json({ list: rows.map((r) => ({ id: r.id, name: r.name, items: jsonParseSafe(r.items, []), created_at: r.created_at })) });
});
router.post("/process-templates", A.authRequired, async (req, res) => {
  const name = String((req.body && req.body.name) || "").trim();
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!name) return res.status(400).json({ error: "请填写模板名称" });
  if (!items.length) return res.status(400).json({ error: "模板里至少要有一道工序" });
  const id = uid();
  await db.prepare("INSERT INTO jj_process_templates(id,name,items,created_by,created_at,deleted) VALUES(?,?,?,?,?,0)")
    .run(id, name, JSON.stringify(items), req.user.id, Date.now());
  await notifyManagers(`${req.user.name} 新增了工序模板「${name}」`, "/styles", req.user.id,
    { actorName: req.user.name, targetLabel: name, what: `保存了 ${items.length} 道工序的模板` });
  res.json({ template: { id, name, items } });
});
router.delete("/process-templates/:id", A.authRequired, async (req, res) => {
  const t = await db.prepare("SELECT * FROM jj_process_templates WHERE id=? AND deleted=0").get(req.params.id);
  if (!t) return res.status(404).json({ error: "模板不存在" });
  await db.prepare("UPDATE jj_process_templates SET deleted=1 WHERE id=?").run(t.id);
  res.json({ ok: true });
});

module.exports = router;
