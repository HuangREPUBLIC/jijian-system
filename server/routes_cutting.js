"use strict";
/**
 * 裁床单 / 扎（菲票）/ 生产进度 / 生产管理 路由。
 *
 * 从 routes.js 拆出来：这块的表、聚合口径、事务自成一体，跟考勤/薪资/员工没有共享状态，
 * 放一起只会让 routes.js 涨到读不动。
 *
 * 进度不落表：某扎某工序完成多少一律从 jj_scan_records 聚合。打点记录是唯一真相，
 * 免得出现"进度表说做完了、工资表说没打点"这种对不上账的情况。
 */
const express = require("express");
const { db, pool, uid } = require("./db");
const A = require("./auth");
const { planBundles, duplicateBundleNos } = require("./cutting");

const router = express.Router();
// 跟 routes.js 一样包一层 async 异常捕获（express4 不会自动捕获 async handler 的 reject）
for (const m of ["get", "post", "put", "patch", "delete"]) {
  const orig = router[m].bind(router);
  router[m] = (p, ...hs) => orig(p, ...hs.map((h) =>
    (typeof h === "function" && h.length < 4)
      ? function (req, res, next) { return Promise.resolve(h(req, res, next)).catch(next); }
      : h));
}

const jsonParse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; } };

/* ---------------- 菲票号：全局自增，存在 settings 里 ---------------- */
// 用连接内的 FOR UPDATE 取号，避免两张单同时生成时撞号。起始 36000 贴近现场纸质票的量级。
const TICKET_SEQ_KEY = "jj_ticket_seq";
async function nextTicketRange(conn, count) {
  const [rows] = await conn.query("SELECT value FROM settings WHERE `key` = ? FOR UPDATE", [TICKET_SEQ_KEY]);
  const cur = rows[0] ? Number(JSON.parse(rows[0].value)) || 36000 : 36000;
  await conn.query(
    "INSERT INTO settings(`key`,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    [TICKET_SEQ_KEY, JSON.stringify(cur + count)]);
  return cur; // 调用方用 [cur, cur+count)
}

/* ---------------- 进度聚合（派生式，唯一真相是打点记录） ---------------- */
// { [bundleId]: { [orderProcessId]: 已完成件数 } }
async function progressMap(orderId) {
  const rows = await db.prepare(
    `SELECT bundle_id, order_process_id, SUM(qty) AS done FROM jj_scan_records
     WHERE order_id = ? AND bundle_id IS NOT NULL GROUP BY bundle_id, order_process_id`).all(orderId);
  const m = {};
  for (const r of rows) (m[r.bundle_id] || (m[r.bundle_id] = {}))[r.order_process_id] = Number(r.done) || 0;
  return m;
}
// 某扎的"已完成件数" = 各道工序完成件数的最小值（所有工序都过了的件数）
function bundleDone(procIds, doneOfBundle) {
  if (!procIds.length) return 0;
  return Math.min(...procIds.map((pid) => (doneOfBundle && doneOfBundle[pid]) || 0));
}
async function completedByOrder(orderId) {
  return (await completedByOrders([orderId]))[orderId] || 0;
}
// 批量版：列表页一次算很多单，逐单查会 N+1
async function completedByOrders(orderIds) {
  if (!orderIds.length) return {};
  const ph = orderIds.map(() => "?").join(",");
  const procRows = await db.prepare(`SELECT id, order_id FROM jj_cut_order_processes WHERE order_id IN (${ph})`).all(...orderIds);
  const bundleRows = await db.prepare(`SELECT id, order_id FROM jj_cut_bundles WHERE order_id IN (${ph})`).all(...orderIds);
  const scanRows = await db.prepare(
    `SELECT bundle_id, order_process_id, SUM(qty) AS done FROM jj_scan_records
     WHERE order_id IN (${ph}) AND bundle_id IS NOT NULL
     GROUP BY bundle_id, order_process_id`).all(...orderIds);
  const procsOf = {}, bundlesOf = {}, doneOf = {};
  procRows.forEach((r) => (procsOf[r.order_id] || (procsOf[r.order_id] = [])).push(r.id));
  bundleRows.forEach((r) => (bundlesOf[r.order_id] || (bundlesOf[r.order_id] = [])).push(r.id));
  scanRows.forEach((r) => ((doneOf[r.bundle_id] || (doneOf[r.bundle_id] = {}))[r.order_process_id] = Number(r.done) || 0));
  const out = {};
  for (const oid of orderIds) {
    const pids = procsOf[oid] || [];
    out[oid] = (bundlesOf[oid] || []).reduce((s, bid) => s + bundleDone(pids, doneOf[bid]), 0);
  }
  return out;
}

/* ---------------- 裁床汇总表：颜色×尺码矩阵 ---------------- */
function buildSummary(order, bundles) {
  const colors = jsonParse(order.colors, []), sizes = jsonParse(order.sizes, []);
  const matrix = {}, colorTotals = {}, sizeTotals = {};
  colors.forEach((c) => { matrix[c] = {}; colorTotals[c] = 0; sizes.forEach((s) => (matrix[c][s] = 0)); });
  sizes.forEach((s) => (sizeTotals[s] = 0));
  let total = 0;
  for (const b of bundles) {
    if (matrix[b.color] && matrix[b.color][b.size] !== undefined) matrix[b.color][b.size] += b.qty;
    colorTotals[b.color] = (colorTotals[b.color] || 0) + b.qty;
    sizeTotals[b.size] = (sizeTotals[b.size] || 0) + b.qty;
    total += b.qty;
  }
  return { colors, sizes, matrix, colorTotals, sizeTotals, total };
}

/* ---------------- 创建裁床单 + 生成菲票（一个事务） ---------------- */
router.post("/cut-orders", A.authRequired, A.managerRequired, async (req, res) => {
  const b = req.body || {};
  const style = await db.prepare("SELECT * FROM jj_styles WHERE id=? AND deleted=0").get(b.styleId);
  if (!style) return res.status(400).json({ error: "款式不存在" });
  const bedNo = Math.floor(Number(b.bedNo));
  if (!bedNo || bedNo < 1) return res.status(400).json({ error: "请填写床次" });
  if (!b.cutDate) return res.status(400).json({ error: "请选择裁床日期" });
  const colors = Array.isArray(b.colors) ? b.colors : [];
  const sizes = Array.isArray(b.sizes) ? b.sizes : [];
  if (!colors.length || !sizes.length) return res.status(400).json({ error: "请选择颜色和尺码" });

  // 床次在同款式下唯一：MySQL 不支持 WHERE deleted=0 的部分唯一索引，跟 users.phone 一样应用层判重
  const dupBed = await db.prepare(
    "SELECT id FROM jj_cut_orders WHERE style_id=? AND bed_no=? AND deleted=0").get(style.id, bedNo);
  if (dupBed) return res.status(400).json({ error: `床次 ${bedNo} 已存在，请换一个` });

  const plan = planBundles({
    colors, sizes, cells: b.cells || {},
    startNo: b.startNo, multiple: b.multiple !== false,
    customNos: b.customNos, vatNos: b.vatNos
  });
  if (!plan.totalBundles) return res.status(400).json({ error: "裁床表还没填件数" });
  const dups = duplicateBundleNos(plan.bundles);
  if (dups.length) return res.status(400).json({ error: `扎号重复：${dups.join("、")}` });

  const orderId = uid(), now = Date.now();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const startTicket = await nextTicketRange(conn, plan.totalBundles);

    await conn.query(
      `INSERT INTO jj_cut_orders(id,style_id,bed_no,doc_no,customer,cut_date,ship_date,order_no,
        bed_note,ticket_note,company_name,colors,sizes,total_bundles,total_qty,source,created_by,created_at,deleted)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [orderId, style.id, bedNo, b.docNo || null, b.customer || null, b.cutDate, b.shipDate || null,
        b.orderNo || null, b.bedNote || null, b.ticketNote || null, b.companyName || null,
        JSON.stringify(colors), JSON.stringify(sizes), plan.totalBundles, plan.totalQty,
        "self", req.user.id, now]);

    await conn.query(
      `INSERT INTO jj_cut_bundles(id,order_id,style_id,bundle_no,ticket_no,color,size,qty,vat_no,note,created_at)
       VALUES ?`,
      [plan.bundles.map((x, i) =>
        [uid(), orderId, style.id, x.bundleNo, startTicket + i, x.color, x.size, x.qty, x.vatNo, null, now])]);

    // 工序快照：改款式工序不影响已建的单，要生效得走「同步工序」
    const [spRows] = await conn.query(
      "SELECT * FROM jj_style_processes WHERE style_id = ? ORDER BY seq ASC", [style.id]);
    if (spRows.length) {
      await conn.query(
        `INSERT INTO jj_cut_order_processes(id,order_id,seq,name,price_mode,unit_price,prices,show_price,visible_roles,style_process_id,created_at)
         VALUES ?`,
        [spRows.map((sp, i) => [uid(), orderId, sp.seq || i + 1, sp.name || "工序" + (i + 1),
          sp.price_mode || "default", Number(sp.unit_price) || 0, sp.prices || null,
          sp.show_price === 0 ? 0 : 1, sp.visible_roles || null, sp.id, now])]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  res.json({
    order: await db.prepare("SELECT * FROM jj_cut_orders WHERE id=?").get(orderId),
    bundles: await db.prepare("SELECT * FROM jj_cut_bundles WHERE order_id=? ORDER BY bundle_no ASC").all(orderId)
  });
});

/* ---------------- 列表 ---------------- */
router.get("/cut-orders", A.authRequired, async (req, res) => {
  const { kw, from, to, styleId } = req.query;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const where = ["o.deleted = 0"], args = [];
  if (styleId) { where.push("o.style_id = ?"); args.push(styleId); }
  if (from) { where.push("o.cut_date >= ?"); args.push(from); }
  if (to) { where.push("o.cut_date <= ?"); args.push(to); }
  if (kw) {
    where.push("(s.code LIKE ? OR s.name LIKE ? OR o.bed_no = ? OR o.doc_no LIKE ?)");
    args.push(`%${kw}%`, `%${kw}%`, Number(kw) || -1, `%${kw}%`);
  }
  const tail = `FROM jj_cut_orders o JOIN jj_styles s ON s.id = o.style_id WHERE ${where.join(" AND ")}`;
  const rows = await db.prepare(
    `SELECT o.*, s.name AS style_name, s.code AS style_code, s.image AS style_image
     ${tail} ORDER BY o.cut_date DESC, o.created_at DESC LIMIT ${limit} OFFSET ${offset}`).all(...args);
  const total = (await db.prepare(`SELECT COUNT(*) c ${tail}`).get(...args)).c;
  const done = await completedByOrders(rows.map((r) => r.id));
  res.json({ list: rows.map((r) => Object.assign(r, { completed_qty: done[r.id] || 0 })), total });
});

/* ---------------- 详情 ---------------- */
router.get("/cut-orders/:id", A.authRequired, async (req, res) => {
  const order = await db.prepare(
    `SELECT o.*, s.name AS style_name, s.code AS style_code, s.image AS style_image
     FROM jj_cut_orders o JOIN jj_styles s ON s.id = o.style_id WHERE o.id=? AND o.deleted=0`).get(req.params.id);
  if (!order) return res.status(404).json({ error: "裁床单不存在" });
  const bundles = await db.prepare("SELECT * FROM jj_cut_bundles WHERE order_id=? ORDER BY bundle_no ASC").all(order.id);
  const processes = await db.prepare("SELECT * FROM jj_cut_order_processes WHERE order_id=? ORDER BY seq ASC").all(order.id);
  res.json({ order, bundles, processes, summary: buildSummary(order, bundles) });
});

/* ---------------- 改单头 ---------------- */
const ORDER_PATCH_FIELDS = {
  docNo: "doc_no", customer: "customer", cutDate: "cut_date", shipDate: "ship_date",
  orderNo: "order_no", bedNote: "bed_note", ticketNote: "ticket_note", companyName: "company_name"
};
router.patch("/cut-orders/:id", A.authRequired, A.managerRequired, async (req, res) => {
  const order = await db.prepare("SELECT * FROM jj_cut_orders WHERE id=? AND deleted=0").get(req.params.id);
  if (!order) return res.status(404).json({ error: "裁床单不存在" });
  const sets = [], args = [];
  for (const [k, col] of Object.entries(ORDER_PATCH_FIELDS)) {
    if (req.body[k] !== undefined) { sets.push(`${col}=?`); args.push(req.body[k] === "" ? null : req.body[k]); }
  }
  if (!sets.length) return res.json({ order });
  args.push(order.id);
  await db.prepare(`UPDATE jj_cut_orders SET ${sets.join(",")} WHERE id=?`).run(...args);
  res.json({ order: await db.prepare("SELECT * FROM jj_cut_orders WHERE id=?").get(order.id) });
});

/* ---------------- 复制成新床次 ---------------- */
router.post("/cut-orders/:id/copy", A.authRequired, A.managerRequired, async (req, res) => {
  const src = await db.prepare("SELECT * FROM jj_cut_orders WHERE id=? AND deleted=0").get(req.params.id);
  if (!src) return res.status(404).json({ error: "裁床单不存在" });
  const bedNo = Math.floor(Number(req.body && req.body.bedNo));
  if (!bedNo || bedNo < 1) return res.status(400).json({ error: "请填写新的床次" });
  const dupBed = await db.prepare(
    "SELECT id FROM jj_cut_orders WHERE style_id=? AND bed_no=? AND deleted=0").get(src.style_id, bedNo);
  if (dupBed) return res.status(400).json({ error: `床次 ${bedNo} 已存在，请换一个` });

  const srcBundles = await db.prepare("SELECT * FROM jj_cut_bundles WHERE order_id=? ORDER BY bundle_no ASC").all(src.id);
  const srcProcs = await db.prepare("SELECT * FROM jj_cut_order_processes WHERE order_id=? ORDER BY seq ASC").all(src.id);
  const newId = uid(), now = Date.now();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 菲票号必须重取：复制出来的是另一批实体票，跟原单的票不能同号
    const startTicket = await nextTicketRange(conn, srcBundles.length);
    await conn.query(
      `INSERT INTO jj_cut_orders(id,style_id,bed_no,doc_no,customer,cut_date,ship_date,order_no,
        bed_note,ticket_note,company_name,colors,sizes,total_bundles,total_qty,source,created_by,created_at,deleted)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [newId, src.style_id, bedNo, src.doc_no, src.customer,
        (req.body && req.body.cutDate) || src.cut_date, src.ship_date, src.order_no,
        src.bed_note, src.ticket_note, src.company_name, src.colors, src.sizes,
        src.total_bundles, src.total_qty, "self", req.user.id, now]);
    if (srcBundles.length) {
      await conn.query(
        `INSERT INTO jj_cut_bundles(id,order_id,style_id,bundle_no,ticket_no,color,size,qty,vat_no,note,created_at)
         VALUES ?`,
        [srcBundles.map((b, i) => [uid(), newId, b.style_id, b.bundle_no, startTicket + i,
          b.color, b.size, b.qty, b.vat_no, b.note, now])]);
    }
    if (srcProcs.length) {
      await conn.query(
        `INSERT INTO jj_cut_order_processes(id,order_id,seq,name,price_mode,unit_price,prices,show_price,visible_roles,style_process_id,created_at)
         VALUES ?`,
        [srcProcs.map((p) => [uid(), newId, p.seq, p.name, p.price_mode, p.unit_price,
          p.prices, p.show_price, p.visible_roles, p.style_process_id, now])]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

  res.json({ order: await db.prepare("SELECT * FROM jj_cut_orders WHERE id=?").get(newId) });
});

/* ---------------- 软删 ---------------- */
router.delete("/cut-orders/:id", A.authRequired, A.managerRequired, async (req, res) => {
  const order = await db.prepare("SELECT * FROM jj_cut_orders WHERE id=? AND deleted=0").get(req.params.id);
  if (!order) return res.status(404).json({ error: "裁床单不存在" });
  await db.prepare("UPDATE jj_cut_orders SET deleted=1 WHERE id=?").run(order.id);
  res.json({ ok: true });
});

module.exports = {
  router, progressMap, bundleDone, completedByOrder, completedByOrders,
  buildSummary, jsonParse, nextTicketRange
};
