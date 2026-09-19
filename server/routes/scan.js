"use strict";
// 打点：扫菲票记录的新增 / 查询 / 删除，以及全员打点流水。
const express = require("express");
const { db, pool, uid } = require("../db");
const A = require("../auth");
const { notifyManagers } = require("../notify");
const cutting = require("../routes_cutting");
const { resolvePrice } = require("../pricing");
const { cnToday } = require("../daytime");
const { wrapAsync } = require("../async_router");

const router = express.Router();
wrapAsync(router, ["get", "post", "put", "patch", "delete", "all"]);

// 件数/金额进通知文案前先收一下小数：裁床件数是 DOUBLE，30 有可能读成 30.000000000000004
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/* ---------------- 打点 ---------------- */
// 两种形态：扫扎（ticketNo 或 orderId+bundleNo+orderProcessId，不给 qty=完成剩余，单价按
// 尺码/岗位解析后存快照）；或自由打点（processId+qty，单价留空回落全局单价）
router.post("/scan", A.authRequired, async (req, res) => {
  const { ticketNo, orderId, bundleNo, orderProcessId, processId, styleId, userId } = req.body || {};
  // 日期按中国时区算，不能截 UTC 日期——凌晨 0-8 点会被算成"昨天"，跨月时错记工资月份
  const date = (req.body && req.body.date) || cnToday();

  let targetUserId = req.user.id;
  if (userId && userId !== req.user.id) {
    if (!A.canActAsAdmin(req.user)) return res.status(403).json({ error: "没有权限代别人打点" });
    targetUserId = userId;
  }
  const actor = targetUserId === req.user.id ? req.user : await A.userById(targetUserId);
  if (!actor) return res.status(400).json({ error: "员工不存在" });

  // 只传 orderId 或只传 bundleNo：不能掉进自由打点分支，报错会跟真正缺的东西对不上
  if (orderId !== undefined && bundleNo === undefined) {
    return res.status(400).json({ error: "按扎打点需要同时给 orderId 和 bundleNo，缺少 bundleNo" });
  }
  if (bundleNo !== undefined && orderId === undefined) {
    return res.status(400).json({ error: "按扎打点需要同时给 orderId 和 bundleNo，缺少 orderId" });
  }

  const isBundleScan = ticketNo !== undefined || (orderId !== undefined && bundleNo !== undefined);
  if (!isBundleScan) {
    // —— 老的自由打点 ——
    if (!processId || req.body.qty === undefined) return res.status(400).json({ error: "缺少工序/数量" });
    const proc = await db.prepare("SELECT * FROM jj_processes WHERE id = ? AND deleted = 0").get(processId);
    if (!proc) return res.status(400).json({ error: "工序不存在" });
    const id = uid();
    await db.prepare(
      "INSERT INTO jj_scan_records(id,user_id,style_id,process_id,date,qty,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, targetUserId, styleId || null, processId, date, Number(req.body.qty), Date.now());
    return res.json({ record: await db.prepare("SELECT * FROM jj_scan_records WHERE id=?").get(id) });
  }

  // —— 扫扎打点 ——
  const bundle = ticketNo !== undefined
    ? await db.prepare("SELECT * FROM jj_cut_bundles WHERE ticket_no = ?").get(Number(ticketNo))
    : await db.prepare("SELECT * FROM jj_cut_bundles WHERE order_id = ? AND bundle_no = ?").get(orderId, Number(bundleNo));
  if (!bundle) return res.status(400).json({ error: "找不到这张菲票，请确认扎号/菲票号" });

  const order = await db.prepare("SELECT * FROM jj_cut_orders WHERE id=? AND deleted=0").get(bundle.order_id);
  if (!order) return res.status(400).json({ error: "这张菲票所属的裁床单已删除" });

  const proc = await db.prepare("SELECT * FROM jj_cut_order_processes WHERE id=? AND order_id=?")
    .get(orderProcessId, bundle.order_id);
  if (!proc) return res.status(400).json({ error: "工序不存在或不属于这张裁床单" });

  // 查已完成数→校验超额→插入 必须在事务里用 FOR UPDATE 锁住这一扎串行化，否则并发打点会超额；
  // 事务内只能用 conn.query，db.prepare 跑在事务外锁不住
  const conn = await pool.getConnection();
  let id, qty, unitPrice, remaining;
  try {
    await conn.beginTransaction();
    await conn.query("SELECT * FROM jj_cut_bundles WHERE id = ? FOR UPDATE", [bundle.id]);

    const [doneRows] = await conn.query(
      "SELECT COALESCE(SUM(qty),0) AS done FROM jj_scan_records WHERE bundle_id=? AND order_process_id=?",
      [bundle.id, proc.id]);
    const done = Number(doneRows[0].done) || 0;
    const left = bundle.qty - done;
    if (left <= 0) {
      await conn.rollback();
      return res.status(400).json({ error: `扎号 ${bundle.bundle_no} 的「${proc.name}」已经做完了` });
    }

    qty = req.body.qty === undefined || req.body.qty === "" ? left : Number(req.body.qty);
    if (!(qty > 0)) {
      await conn.rollback();
      return res.status(400).json({ error: "件数要大于 0" });
    }
    if (qty > left) {
      await conn.rollback();
      return res.status(400).json({ error: `超了，扎号 ${bundle.bundle_no} 的「${proc.name}」只剩 ${left} 件` });
    }

    // 单价在打点这一刻定死：之后改工价不会追溯改动已经算过的工资
    unitPrice = resolvePrice(proc, { size: bundle.size, role: actor.role });
    remaining = left - qty;

    id = uid();
    await conn.query(
      `INSERT INTO jj_scan_records(id,user_id,style_id,process_id,date,qty,created_at,order_id,bundle_id,order_process_id,unit_price)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [id, targetUserId, bundle.style_id, proc.style_process_id || null, date, qty, Date.now(),
        order.id, bundle.id, proc.id, unitPrice]);

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  res.json({
    record: await db.prepare("SELECT * FROM jj_scan_records WHERE id=?").get(id),
    bundle, remaining
  });

  // 响应后异步处理通知（不拖慢扫码响应）：整扎某工序做完才发通知（不逐笔发，避免刷屏），
  // 整单到 100% 再发完工通知
  (async () => {
    try {
      const st = await db.prepare("SELECT code, name FROM jj_styles WHERE id=?").get(order.style_id);
      const styleLabel = (st && (st.code || st.name)) || "";

      if (remaining === 0) {
        const target = `${styleLabel} · 扎号${bundle.bundle_no}`;
        const what = `完成「${proc.name}」${round2(bundle.qty)}件`;
        await notifyManagers(`${actor.name} ${target} ${what}`, "/cutprogress/" + order.id, req.user.id,
          { actorName: actor.name, targetLabel: target, what,
            tag: "scan-" + bundle.id + "-" + proc.id });
      }

      const done = await cutting.completedByOrder(order.id);
      if (order.total_qty > 0 && done >= order.total_qty) {
        const label = `${styleLabel} · 床次${order.bed_no}`;
        await notifyManagers(`${label} 已全部完工`, "/cutprogress/" + order.id, null,
          { actorName: "系统", targetLabel: label,
            what: `已全部完工（${Math.round(order.total_qty)}件）`, tag: "cut-" + order.id });
      }
    } catch (e) { console.error("[notify] 打点后续通知失败", e); }
  })();
});

router.get("/scan", A.authRequired, async (req, res) => {
  const { date } = req.query;
  let userId = req.query.userId;
  if (!userId) userId = req.user.id;
  if (userId !== req.user.id && !A.canActAsAdmin(req.user)) return res.status(403).json({ error: "没有权限查看他人记录" });
  // 带出可读的工序名：扫扎产生的记录 process_id 指向 jj_style_processes，
  // 在 jj_processes 里没有对应行，只查工序模板的话前端只能显示一串 id。
  const SEL = `SELECT r.*, cop.name AS cop_name, sp.name AS sp_name, p.name AS proc_name,
      b.bundle_no, b.ticket_no, b.color, b.size
    FROM jj_scan_records r
    LEFT JOIN jj_cut_order_processes cop ON cop.id = r.order_process_id
    LEFT JOIN jj_style_processes sp ON sp.id = r.process_id
    LEFT JOIN jj_processes p ON p.id = r.process_id
    LEFT JOIN jj_cut_bundles b ON b.id = r.bundle_id
    WHERE r.user_id = ?`;
  const rows = date
    ? await db.prepare(SEL + " AND r.date = ? ORDER BY r.created_at DESC").all(userId, date)
    : await db.prepare(SEL + " ORDER BY r.created_at DESC LIMIT 200").all(userId);
  res.json({ records: rows.map((r) => Object.assign(r, {
    process_name: r.cop_name || r.sp_name || r.proc_name || null
  })) });
});

router.delete("/scan/:id", A.authRequired, async (req, res) => {
  const r = await db.prepare("SELECT * FROM jj_scan_records WHERE id=?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "记录不存在" });
  if (r.user_id !== req.user.id && !A.canActAsAdmin(req.user)) return res.status(403).json({ error: "没有权限删除" });
  await db.prepare("DELETE FROM jj_scan_records WHERE id=?").run(r.id);
  res.json({ ok: true });
});

// 打点记录：计件工/临时工只看自己的，主管/管理员看全员（可带 userId 查一人）；
// 工序名靠 LEFT JOIN 取：扫扎记录 process_id 指向 jj_style_processes，在 jj_processes 里没有对应行
router.get("/scan-all", A.authRequired, async (req, res) => {
  const { date, month } = req.query;
  if (!date && !month) return res.status(400).json({ error: "缺少日期或月份" });
  const seeAll = A.isManager(req.user);
  const onlyUserId = seeAll ? (req.query.userId || null) : req.user.id;

  const SEL = `SELECT s.*, u.name AS user_name, u.role AS user_role,
      cop.name AS cop_name, cop.show_price, sp.name AS sp_name, p.name AS proc_name,
      b.bundle_no, b.ticket_no, b.color, b.size,
      st.code AS style_code, st.name AS style_name, o.bed_no
    FROM jj_scan_records s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN jj_cut_order_processes cop ON cop.id = s.order_process_id
    LEFT JOIN jj_style_processes sp ON sp.id = s.process_id
    LEFT JOIN jj_processes p ON p.id = s.process_id
    LEFT JOIN jj_cut_bundles b ON b.id = s.bundle_id
    LEFT JOIN jj_cut_orders o ON o.id = s.order_id
    LEFT JOIN jj_styles st ON st.id = s.style_id
    WHERE `;
  const where = [], args = [];
  if (date) { where.push("s.date = ?"); args.push(date); }
  else { where.push("s.date LIKE ?"); args.push(month + "%"); }
  if (onlyUserId) { where.push("s.user_id = ?"); args.push(onlyUserId); }
  const rows = await db.prepare(
    SEL + where.join(" AND ") + " ORDER BY s.created_at DESC LIMIT " + (date ? 500 : 300)).all(...args);

  res.json({
    scope: seeAll ? "all" : "mine",
    records: rows.map((r) => Object.assign(r, {
      process_name: r.cop_name || r.sp_name || r.proc_name || "自由打点",
      // 工序上关了"显示工价"就连带不报金额，跟打点页/菲票上的口径保持一致
      amount: r.show_price === 0 ? null
        : Math.round((Number(r.qty) || 0) * (Number(r.unit_price) || 0) * 100) / 100
    }))
  });
});

module.exports = router;
