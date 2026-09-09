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
const { visibleTo } = require("./pricing");
const { logOp } = require("./oplog");
const { cnDayStr } = require("./daytime");
const { qrSvg } = require("./qr");

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

// 操作日志文案用："款号 床次N" 这种口径，跟旧版裁床单日志风格对齐
async function styleLabelOf(styleId) {
  const s = await db.prepare("SELECT code,name FROM jj_styles WHERE id=?").get(styleId);
  return s ? (s.code || s.name || styleId) : styleId;
}
const PATCH_FIELD_LABELS = {
  docNo: "单号", customer: "客户", cutDate: "裁床日期", shipDate: "出货日期",
  orderNo: "订单号", bedNote: "床次备注", ticketNote: "菲票备注", companyName: "公司名称"
};

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

  await logOp(req.user.id, `新建裁床单：${style.code || style.name} 床次${bedNo}（${plan.totalBundles}扎 ${plan.totalQty}件）`);
  res.json({
    order: await db.prepare("SELECT * FROM jj_cut_orders WHERE id=?").get(orderId),
    bundles: await db.prepare("SELECT * FROM jj_cut_bundles WHERE order_id=? ORDER BY bundle_no ASC").all(orderId)
  });
});

/* ---------------- 列表 ---------------- */
router.get("/cut-orders", A.authRequired, async (req, res) => {
  const { kw, from, to, styleId } = req.query;
  // 拼进 SQL 字符串前必须先取整：非数字会回落默认值，但 "2.5" 这种能转成数字的非整数
  // 不会，Math.min/max 夹逼完还是 2.5，拼出 "LIMIT 2.5" 直接 500
  const limit = Math.floor(Math.min(200, Math.max(1, Number(req.query.limit) || 50)));
  const offset = Math.floor(Math.max(0, Number(req.query.offset) || 0));
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
  let processes = await db.prepare("SELECT * FROM jj_cut_order_processes WHERE order_id=? ORDER BY seq ASC").all(order.id);
  // 工价要不要隐藏是给"普通计件工看不看到单价"用的，必须在后端剥掉——前端隐藏字段只是不显示，
  // 接口原文里还在，改个抓包就能看到，跟 show_price/visible_roles 这两列存在的意义相悖
  if (!A.isManager(req.user)) {
    processes = processes.map((p) => {
      if (p.show_price === 0 || !visibleTo(p, req.user.role)) {
        return Object.assign({}, p, { unit_price: null, prices: null });
      }
      return p;
    });
  }
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
  const changedLabels = Object.keys(PATCH_FIELD_LABELS).filter((k) => req.body[k] !== undefined).map((k) => PATCH_FIELD_LABELS[k]);
  await logOp(req.user.id, `修改裁床单：${await styleLabelOf(order.style_id)} 床次${order.bed_no}（改了：${changedLabels.join("、")}）`);
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

  await logOp(req.user.id, `复制裁床单：${await styleLabelOf(src.style_id)} 床次${src.bed_no} → 床次${bedNo}（${srcBundles.length}扎）`);
  res.json({ order: await db.prepare("SELECT * FROM jj_cut_orders WHERE id=?").get(newId) });
});

/* ---------------- 软删 ---------------- */
router.delete("/cut-orders/:id", A.authRequired, A.managerRequired, async (req, res) => {
  const order = await db.prepare("SELECT * FROM jj_cut_orders WHERE id=? AND deleted=0").get(req.params.id);
  if (!order) return res.status(404).json({ error: "裁床单不存在" });
  await db.prepare("UPDATE jj_cut_orders SET deleted=1 WHERE id=?").run(order.id);
  await logOp(req.user.id, `删除裁床单：${await styleLabelOf(order.style_id)} 床次${order.bed_no}`);
  res.json({ ok: true });
});

/* ---------------- 生产进度：按扎 ---------------- */
router.get("/cut-orders/:id/progress", A.authRequired, async (req, res) => {
  const order = await db.prepare(
    `SELECT o.*, s.name AS style_name, s.code AS style_code, s.image AS style_image
     FROM jj_cut_orders o JOIN jj_styles s ON s.id=o.style_id WHERE o.id=? AND o.deleted=0`).get(req.params.id);
  if (!order) return res.status(404).json({ error: "裁床单不存在" });
  const processes = await db.prepare("SELECT * FROM jj_cut_order_processes WHERE order_id=? ORDER BY seq ASC").all(order.id);
  const bundles = await db.prepare("SELECT * FROM jj_cut_bundles WHERE order_id=? ORDER BY bundle_no ASC").all(order.id);
  const pm = await progressMap(order.id);
  const pids = processes.map((p) => p.id);
  let completed = 0;
  const list = bundles.map((b) => {
    const per = pm[b.id] || {};
    const done = bundleDone(pids, per);
    completed += done;
    // 百分比这一栏是"这一扎有几道工序已经整扎做完"，跟"已完成件数"是两个口径，别混
    const finishedProcs = pids.filter((pid) => (per[pid] || 0) >= b.qty).length;
    return Object.assign({}, b, {
      done, perProcess: per,
      percent: pids.length ? Math.round((finishedProcs / pids.length) * 100) : 0
    });
  });
  res.json({ order, processes, bundles: list, completed_qty: completed });
});

/* ---------------- 工序进展：按工序 + 颜色/尺码分解 ---------------- */
router.get("/cut-orders/:id/process-progress", A.authRequired, async (req, res) => {
  const order = await db.prepare("SELECT * FROM jj_cut_orders WHERE id=? AND deleted=0").get(req.params.id);
  if (!order) return res.status(404).json({ error: "裁床单不存在" });
  const processes = await db.prepare("SELECT * FROM jj_cut_order_processes WHERE order_id=? ORDER BY seq ASC").all(order.id);
  const bundles = await db.prepare("SELECT * FROM jj_cut_bundles WHERE order_id=?").all(order.id);
  const pm = await progressMap(order.id);

  // 颜色+尺码 是分解维度；总数按扎的件数汇总，完成数按打点聚合
  const totalOf = {};
  for (const b of bundles) {
    const k = `${b.color}|${b.size}`;
    totalOf[k] = (totalOf[k] || 0) + b.qty;
  }
  res.json({ processes: processes.map((p) => {
    const doneOf = {};
    let done = 0, total = 0;
    for (const b of bundles) {
      const k = `${b.color}|${b.size}`;
      const d = (pm[b.id] || {})[p.id] || 0;
      doneOf[k] = (doneOf[k] || 0) + d;
      done += d; total += b.qty;
    }
    return {
      id: p.id, name: p.name, seq: p.seq, unit_price: p.unit_price, show_price: p.show_price !== 0,
      total, done, remaining: total - done,
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
      breakdown: Object.keys(totalOf).map((k) => {
        const [color, size] = k.split("|");
        return { color, size, total: totalOf[k], done: doneOf[k] || 0, remaining: totalOf[k] - (doneOf[k] || 0) };
      })
    };
  }) });
});

/* ---------------- 生产进度详情：一扎的每道工序 ---------------- */
router.get("/bundles/:id", A.authRequired, async (req, res) => {
  const bundle = await db.prepare("SELECT * FROM jj_cut_bundles WHERE id=?").get(req.params.id);
  if (!bundle) return res.status(404).json({ error: "菲票不存在" });
  const order = await db.prepare(
    `SELECT o.*, s.name AS style_name, s.code AS style_code, s.image AS style_image
     FROM jj_cut_orders o JOIN jj_styles s ON s.id=o.style_id WHERE o.id=?`).get(bundle.order_id);
  const processes = await db.prepare("SELECT * FROM jj_cut_order_processes WHERE order_id=? ORDER BY seq ASC").all(bundle.order_id);
  const rows = await db.prepare(
    "SELECT order_process_id, COALESCE(SUM(qty),0) AS done FROM jj_scan_records WHERE bundle_id=? GROUP BY order_process_id")
    .all(bundle.id);
  const doneOf = Object.fromEntries(rows.map((r) => [r.order_process_id, Number(r.done) || 0]));
  res.json({ bundle, order, processes: processes.map((p) => ({
    id: p.id, name: p.name, seq: p.seq, unit_price: p.unit_price, show_price: p.show_price !== 0,
    done: doneOf[p.id] || 0, remaining: bundle.qty - (doneOf[p.id] || 0)
  })) });
});

/* ---------------- 修改裁床件数 / 缸号 / 备注 ---------------- */
// 改的是分母（这一扎裁了多少件），不碰打点记录（分子）。改到比已完成数还小会让进度
// 变成"做了 12 件但只裁了 3 件"这种鬼数据，直接拒掉。
router.patch("/bundles/:id", A.authRequired, A.managerRequired, async (req, res) => {
  const bundle = await db.prepare("SELECT * FROM jj_cut_bundles WHERE id=?").get(req.params.id);
  if (!bundle) return res.status(404).json({ error: "菲票不存在" });
  const sets = [], args = [];
  if (req.body.qty !== undefined) {
    const qty = Number(req.body.qty);
    if (!(qty > 0)) return res.status(400).json({ error: "裁床件数要大于 0" });
    const maxDone = await db.prepare(
      "SELECT COALESCE(MAX(t.done),0) AS m FROM (SELECT SUM(qty) AS done FROM jj_scan_records WHERE bundle_id=? GROUP BY order_process_id) t")
      .get(bundle.id);
    if (qty < Number(maxDone.m)) {
      return res.status(400).json({ error: `不能改到 ${qty} 件，这一扎已经有工序做了 ${maxDone.m} 件` });
    }
    sets.push("qty=?"); args.push(qty);
  }
  if (req.body.vatNo !== undefined) { sets.push("vat_no=?"); args.push(req.body.vatNo || null); }
  if (req.body.note !== undefined) { sets.push("note=?"); args.push(req.body.note || null); }
  if (!sets.length) return res.json({ bundle });
  args.push(bundle.id);
  await db.prepare(`UPDATE jj_cut_bundles SET ${sets.join(",")} WHERE id=?`).run(...args);

  // 单头的总件数是冗余列，改了扎要跟着重算，否则列表页显示的总数会跟明细对不上
  const agg = await db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(qty),0) AS q FROM jj_cut_bundles WHERE order_id=?").get(bundle.order_id);
  await db.prepare("UPDATE jj_cut_orders SET total_bundles=?, total_qty=? WHERE id=?")
    .run(agg.n, agg.q, bundle.order_id);

  res.json({ bundle: await db.prepare("SELECT * FROM jj_cut_bundles WHERE id=?").get(bundle.id) });
});

/* ---------------- 生产管理概览 ---------------- */
// 日期必须按中国时区算，不能直接截 UTC 的 toISOString()——见 server/daytime.js 的注释。
// 这里换成 cnDayStr 后，yesterday/month 分支的算法不用变：
// cnDayStr(now - 86400000) 就是"中国时区的昨天"（固定偏移不受时区规则影响，减 24 小时
// 等价于日历退一天），month 的 from 同理基于中国日期算。
const dayStr = cnDayStr;
router.get("/production/overview", A.authRequired, async (req, res) => {
  const range = req.query.range || "today";
  const now = new Date();
  let from, to;
  if (range === "yesterday") {
    const y = new Date(now.getTime() - 86400000);
    from = to = dayStr(y);
  } else if (range === "month") {
    from = dayStr(now).slice(0, 8) + "01"; to = dayStr(now);
  } else {
    from = to = dayStr(now);
  }
  // 已完成件数按"这段时间打点了多少件"算：这是车间关心的日产出，跟单张单的完工口径不是一回事
  const doneRow = await db.prepare(
    "SELECT COALESCE(SUM(qty),0) AS q FROM jj_scan_records WHERE date >= ? AND date <= ? AND bundle_id IS NOT NULL")
    .get(from, to);
  // 生产中件数 = 还没全部完工的裁床单的总件数
  const orders = await db.prepare("SELECT id, total_qty FROM jj_cut_orders WHERE deleted=0").all();
  const done = await completedByOrders(orders.map((o) => o.id));
  const inProduction = orders.reduce((s, o) => s + ((done[o.id] || 0) < o.total_qty ? o.total_qty : 0), 0);
  res.json({ range, from, to, completed: Number(doneRow.q) || 0, inProduction });
});

/* ---------------- 生产明细：按款看 ---------------- */
router.get("/production/by-style", A.authRequired, async (req, res) => {
  const { kw, from, to } = req.query;
  const where = ["o.deleted = 0"], args = [];
  if (from) { where.push("o.cut_date >= ?"); args.push(from); }
  if (to) { where.push("o.cut_date <= ?"); args.push(to); }
  if (kw) { where.push("(s.code LIKE ? OR s.name LIKE ?)"); args.push(`%${kw}%`, `%${kw}%`); }
  const rows = await db.prepare(`
    SELECT o.style_id, s.name AS style_name, s.code AS style_code, s.image AS style_image,
           COUNT(*) AS sheet_count, COALESCE(SUM(o.total_qty),0) AS total_qty
    FROM jj_cut_orders o JOIN jj_styles s ON s.id = o.style_id
    WHERE ${where.join(" AND ")} GROUP BY o.style_id ORDER BY total_qty DESC`).all(...args);
  const orderRows = await db.prepare(
    `SELECT o.id, o.style_id FROM jj_cut_orders o JOIN jj_styles s ON s.id=o.style_id WHERE ${where.join(" AND ")}`).all(...args);
  const done = await completedByOrders(orderRows.map((o) => o.id));
  const doneByStyle = {};
  orderRows.forEach((o) => (doneByStyle[o.style_id] = (doneByStyle[o.style_id] || 0) + (done[o.id] || 0)));
  res.json({ list: rows.map((r) => Object.assign(r, { completed_qty: doneByStyle[r.style_id] || 0 })) });
});

/* ---------------- 打印数据 ----------------
 * 不做服务端直出打印页：本系统鉴权是 Authorization: Bearer（token 在 localStorage），
 * window.open 出来的新窗口带不上这个头，直出页面必然 401。所以这里只给数据 + 二维码，
 * 前端在 SPA 里渲染到 #print-root，@media print 只显示它，再 window.print()。
 * 份数/旋转180°/逐个备注 都是纯前端渲染参数，不进这个请求。
 */
router.get("/cut-orders/:id/print-data", A.authRequired, A.managerRequired, async (req, res) => {
  const order = await db.prepare(
    `SELECT o.*, s.name AS style_name, s.code AS style_code, s.image AS style_image
     FROM jj_cut_orders o JOIN jj_styles s ON s.id=o.style_id WHERE o.id=? AND o.deleted=0`).get(req.params.id);
  if (!order) return res.status(404).json({ error: "裁床单不存在" });

  let bundles = await db.prepare("SELECT * FROM jj_cut_bundles WHERE order_id=? ORDER BY bundle_no ASC").all(order.id);
  // picksRaw 有值但一个有效扎号都解析不出来（比如 ?picks=abc、picks=0,-1、用了中文逗号）时必须
  // 400，不能悄悄掉进下面的 from/to 分支——那时 from/to 都是 undefined，会把整单的扎全部返回，
  // 打印场景下就是多打印、贴错票。
  const picksRaw = req.query.picks;
  const picks = String(picksRaw || "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  if (picksRaw !== undefined && picksRaw !== "" && !picks.length) {
    return res.status(400).json({ error: "扎号格式不对，picks 应为逗号分隔的正整数" });
  }
  if (picks.length) {
    const set = new Set(picks);
    bundles = bundles.filter((b) => set.has(b.bundle_no));
  } else {
    const from = req.query.from !== undefined && req.query.from !== "" ? Number(req.query.from) : null;
    const to = req.query.to !== undefined && req.query.to !== "" ? Number(req.query.to) : null;
    if (from !== null) bundles = bundles.filter((b) => b.bundle_no >= from);
    if (to !== null) bundles = bundles.filter((b) => b.bundle_no <= to);
  }
  if (!bundles.length) return res.status(400).json({ error: "这个扎号范围里没有菲票" });

  const processes = await db.prepare("SELECT * FROM jj_cut_order_processes WHERE order_id=? ORDER BY seq ASC").all(order.id);
  // JJ: 前缀用于扫码时区分本系统的码（现场可能同时贴着客户的条码）
  const withQr = await Promise.all(bundles.map(async (b) =>
    Object.assign({}, b, { qrSvg: await qrSvg(`JJ:${b.ticket_no}`) })));

  res.json({ order, processes, bundles: withQr });
});

module.exports = {
  router, progressMap, bundleDone, completedByOrder, completedByOrders,
  buildSummary, jsonParse, nextTicketRange
};
