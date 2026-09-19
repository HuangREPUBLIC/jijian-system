"use strict";
const express = require("express");
const multer = require("multer");
const path = require("path");
const { db, pool, uid, getSetting, setSetting, UPLOAD_DIR } = require("./db");
const A = require("./auth");
const { logOp } = require("./oplog");
const { notifyUsers, notifyManagers } = require("./notify");
const P = require("./push");
const cutting = require("./routes_cutting");
const { resolvePrice } = require("./pricing");
const { cnToday } = require("./daytime");
const { wrapAsync } = require("./async_router");

const router = express.Router();
wrapAsync(router, ["get", "post", "put", "patch", "delete", "all"]);

const jsonParseSafe = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; } };
// 件数/金额进通知文案前先收一下小数：裁床件数是 DOUBLE，30 有可能读成 30.000000000000004
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// 通知文案："改了1个字段"带新值，改了多个就列字段名（超3个截断+总数）；
// skipValueKeys 给图片这类字段用，只报字段名不带值
const PROCESS_FIELD_LABELS = { name: "工序名", unit: "计量单位", stdQty: "标准定额", hourQuota: "小时定额", unitPrice: "单价" };
const STYLE_FIELD_LABELS = { name: "款式名称", code: "款号", image: "封面图", images: "款式图片", size: "尺码", color: "颜色", customer: "客户", hasCutting: "是否裁床", note: "款式备注" };
const PAYROLL_FIELD_LABELS = { mealSubsidy: "餐补", penalty: "扣罚", bonus: "奖金" };
function changeWhat(labels, body, skipValueKeys) {
  const changedKeys = Object.keys(labels).filter((k) => body[k] !== undefined);
  if (!changedKeys.length) return null;
  if (changedKeys.length === 1) {
    const k = changedKeys[0], v = body[k];
    if ((skipValueKeys || []).includes(k)) return `修改了「${labels[k]}」`;
    if (v === null || String(v).trim() === "") return `把「${labels[k]}」改成了（清空）`;
    return `把「${labels[k]}」改成了${v}`;
  }
  const names = changedKeys.map((k) => labels[k]);
  return names.length > 3 ? `修改了「${names.slice(0, 3).join("、")}」等${names.length}项` : `修改了「${names.join("、")}」`;
}

// 职位显示名：车间岗位存的是 settings.roles，遍历用户列表前先加载好再用这个同步版查表。
// 从跟单系统导入的老岗位键没有这张表的话会显示原始键（如 r1785125327446）
const LEGACY_ROLE_LABELS = {
  sales: "业务员（跟单系统）", follower: "下厂员（跟单系统）",
  tech_lead: "技术主管（跟单系统）", biz_lead: "业务主管（跟单系统）",
  r1785125327446: "技术主管（跟单系统）", r1785125333976: "业务主管（跟单系统）"
};
function roleLabelWith(roles, roleKey) {
  if (roleKey === "admin") return "工厂管理员";
  if (roleKey === "worker") return "计件工";
  const r = roles.find((x) => x.k === roleKey);
  if (r) return r.label;
  return LEGACY_ROLE_LABELS[roleKey] || roleKey;
}

// 给 user 附上岗位中文名和管理权限（前端据此显示入口，岗位名单只在后端维护一份）
async function userPublicFull(u) {
  const roles = await getSetting("roles", []);
  return Object.assign(A.userPublic(u), { roleLabel: roleLabelWith(roles, u.role), canManage: A.isManager(u) });
}

router.get("/me", A.authRequired, async (req, res) => res.json({ user: await userPublicFull(req.user) }));

// 改自己的密码：只要求已登录，改的是 req.user 自己那条
router.post("/password/change", A.authRequired, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: "新密码至少 4 位" });
  await db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(A.hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

/* ---------------- 手机号 + 密码登录 ---------------- */
// 账号只能由管理员创建，员工不能自助注册
router.post("/login", async (req, res) => {
  const { phone, password } = req.body || {};
  const u = await db.prepare("SELECT * FROM users WHERE phone = ? AND deleted = 0").get(String(phone || "").trim());
  if (!u || !A.verifyPassword(password || "", u.password_hash))
    return res.status(400).json({ error: "手机号或密码不正确" });
  res.json({ token: A.signToken(u), user: await userPublicFull(u) });
});

/* ---------------- 员工管理 ---------------- */
router.get("/users", A.authRequired, A.managerRequired, async (req, res) => {
  const roles = await getSetting("roles", []);
  const list = await db.prepare("SELECT * FROM users WHERE deleted = 0 ORDER BY created_at DESC").all();
  res.json({
    users: list.map((u) => Object.assign(A.userPublic(u), { roleLabel: roleLabelWith(roles, u.role), createdAt: u.created_at }))
  });
});

// 可选职位列表（不含管理员），设置里没有 worker 才补，避免重复
router.get("/roles", A.authRequired, A.managerRequired, async (req, res) => {
  const saved = (await getSetting("roles", [])).map((r) => ({ k: r.k, label: r.label }));
  const roles = saved.some((r) => r.k === "worker")
    ? saved : [{ k: "worker", label: "计件工" }].concat(saved);
  res.json({ roles });
});

// 管理员手动建号，初始密码默认 123456
router.post("/users", A.authRequired, A.managerRequired, async (req, res) => {
  const { name, phone, role, password } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "请填写姓名和手机号" });
  const phoneT = String(phone).trim();
  const exists = await db.prepare("SELECT id FROM users WHERE phone = ? AND deleted = 0").get(phoneT);
  if (exists) return res.status(400).json({ error: "该手机号已存在账号" });
  const id = uid();
  await db.prepare("INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
    .run(id, String(name).trim(), phoneT, A.hashPassword(password || "123456"), role || "worker", Date.now());
  await logOp(req.user.id, `手动添加员工：${String(name).trim()}（${phoneT}）`);
  res.json({ user: A.userPublic(await A.userById(id)) });
});

// 重置密码：员工忘记密码时管理员在「管理」页面里重置，不传就是默认的 123456
router.post("/users/:id/reset-password", A.authRequired, A.managerRequired, async (req, res) => {
  const u = await A.userById(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
  const { password } = req.body || {};
  await db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(A.hashPassword(password || "123456"), u.id);
  await logOp(req.user.id, `重置员工密码：${u.name}（${u.phone}）`);
  res.json({ ok: true });
});

router.patch("/users/:id", A.authRequired, A.managerRequired, async (req, res) => {
  const u = await A.userById(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
  const { name, phone, role } = req.body || {};
  if (name !== undefined) await db.prepare("UPDATE users SET name=? WHERE id=?").run(String(name).trim(), u.id);
  if (phone !== undefined && String(phone).trim()) {
    const dup = await db.prepare("SELECT id FROM users WHERE phone=? AND id<>? AND deleted=0").get(String(phone).trim(), u.id);
    if (dup) return res.status(400).json({ error: "该手机号已存在账号" });
    await db.prepare("UPDATE users SET phone=? WHERE id=?").run(String(phone).trim(), u.id);
  }
  if (role !== undefined && role !== u.role) {
    await db.prepare("UPDATE users SET role=? WHERE id=?").run(role, u.id);
    const roles = await getSetting("roles", []);
    await notifyUsers([u.id], `${req.user.name} 把你的岗位改成了「${roleLabelWith(roles, role)}」`, "/mine", req.user.id);
  }
  res.json({ user: A.userPublic(await A.userById(u.id)) });
});

router.delete("/users/:id", A.authRequired, A.managerRequired, async (req, res) => {
  const u = await A.userById(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
  await db.prepare("UPDATE users SET deleted=1 WHERE id=?").run(u.id);
  await logOp(req.user.id, `删除员工：${u.name}（${u.phone}）`);
  res.json({ ok: true });
});

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

/* ---------------- 款式管理 ---------------- */
// 列表只带缩略图不带原图（原图 base64 一张两三百KB，否则列表接口几十MB）：
// image=缩略图或回退原图，has_thumb 标记是否为缩略图，image_count 供点开大图时按需取原图
// 列表只读缩略图和张数，不碰原图列（原图一张几百 KB，读全表会拖慢整个库）
const STYLE_LIST_COLS = `s.id, s.name, s.code, s.size, s.color, s.customer, s.has_cutting, s.note, s.created_at,
      s.thumb AS image, s.image_count`;
router.get("/styles", A.authRequired, async (req, res) => {
  // 子查询一次带出工序数/总工价，避免按款逐个查（N+1）
  const list = await db.prepare(`
    SELECT ${STYLE_LIST_COLS},
      (SELECT COUNT(*) FROM jj_style_processes sp WHERE sp.style_id = s.id) AS process_count,
      (SELECT COALESCE(SUM(sp.unit_price), 0) FROM jj_style_processes sp WHERE sp.style_id = s.id) AS total_price
    FROM jj_styles s WHERE s.deleted = 0 ORDER BY s.created_at DESC`).all();
  list.forEach((s) => { s.has_thumb = !!s.image; });
  await cutting.fillMissingCovers(list, "id", "image", "image_count");
  res.json({ styles: list });
});
// 单个款式的完整数据（含全部原图）：编辑款式、点开大图时才取
router.get("/styles/:id", A.authRequired, async (req, res) => {
  const s = await db.prepare("SELECT * FROM jj_styles WHERE id=? AND deleted=0").get(req.params.id);
  if (!s) return res.status(404).json({ error: "款式不存在" });
  res.json({ style: s });
});
// 缩略图只收 data:image/ 开头、不超过 200KB 的串，免得有人把原图塞进缩略图列、把列表接口又撑大
const validThumb = (t) => typeof t === "string" && /^data:image\//.test(t) && t.length <= 200 * 1024;
// 给老款式补缩略图（静默，不发通知/不进操作日志）：只补空的，而且 srcLen 要跟当前封面长度一致，
// 免得后台补图期间封面被人换了，把旧封面的缩略图写进去
router.put("/styles/:id/thumb", A.authRequired, async (req, res) => {
  const thumb = req.body && req.body.thumb, srcLen = Number(req.body && req.body.srcLen);
  if (!validThumb(thumb) || !(srcLen > 0)) return res.status(400).json({ error: "缩略图格式不对" });
  const r = await db.prepare(
    "UPDATE jj_styles SET thumb=? WHERE id=? AND deleted=0 AND thumb IS NULL AND CHAR_LENGTH(image) = ?")
    .run(thumb, req.params.id, srcLen);
  if (!r.affectedRows) return res.status(409).json({ error: "封面已变或已有缩略图" });
  res.json({ ok: true });
});
router.post("/styles", A.authRequired, async (req, res) => {
  const { name, code, image, images, size, color, customer, hasCutting, note, thumb } = req.body || {};
  if (!name) return res.status(400).json({ error: "请填写款式名" });
  if (!code) return res.status(400).json({ error: "请填写款号" });
  const id = uid();
  const imgs = Array.isArray(images) ? images : [];   // 多图：fileID 数组
  const cover = image || imgs[0] || null;             // 封面 = 传入的 image，或第一张
  // 是否裁床默认为"是"：车间绝大多数款都要裁床，不裁床的是少数（外发/来料）
  await db.prepare("INSERT INTO jj_styles(id,name,code,image,images,image_count,thumb,size,color,customer,has_cutting,note,deleted,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)")
    .run(id, String(name).trim(), String(code).trim(), cover, JSON.stringify(imgs), imgs.length || (cover ? 1 : 0),
      cover && validThumb(thumb) ? thumb : null,
      size || null, color || null, customer || null, hasCutting === false ? 0 : 1, note || null, Date.now());
  await logOp(req.user.id, `新增款式：${String(name).trim()}`);
  await notifyManagers(`${req.user.name} 新增了款式「${String(name).trim()}」`, "/styles", req.user.id);
  res.json({ style: await db.prepare("SELECT * FROM jj_styles WHERE id=?").get(id) });
});
router.patch("/styles/:id", A.authRequired, async (req, res) => {
  const s = await db.prepare("SELECT * FROM jj_styles WHERE id=?").get(req.params.id);
  if (!s || s.deleted) return res.status(404).json({ error: "款式不存在" });
  const body = req.body || {};
  const { name, code, image, images, size, color, customer, hasCutting, note, thumb } = body;
  if (name !== undefined) await db.prepare("UPDATE jj_styles SET name=? WHERE id=?").run(String(name).trim(), s.id);
  if (code !== undefined) await db.prepare("UPDATE jj_styles SET code=? WHERE id=?").run(String(code).trim(), s.id);
  if (image !== undefined && images === undefined) {
    await db.prepare(`UPDATE jj_styles SET image=?, image_count=${image ? "GREATEST(image_count, 1)" : "0"} WHERE id=?`).run(image, s.id);
  }
  if (images !== undefined) {
    const imgs = Array.isArray(images) ? images : [];
    await db.prepare("UPDATE jj_styles SET images=?, image=?, image_count=? WHERE id=?")
      .run(JSON.stringify(imgs), imgs[0] || null, imgs.length, s.id);
  }
  // 封面一动旧缩略图就失效：带新缩略图就换上，没带就清掉，不留旧封面的缩略图
  if (image !== undefined || images !== undefined) {
    await db.prepare("UPDATE jj_styles SET thumb = CASE WHEN image IS NULL OR image = '' THEN NULL ELSE ? END WHERE id=?")
      .run(validThumb(thumb) ? thumb : null, s.id);
  }
  if (size !== undefined) await db.prepare("UPDATE jj_styles SET size=? WHERE id=?").run(size, s.id);
  if (color !== undefined) await db.prepare("UPDATE jj_styles SET color=? WHERE id=?").run(color, s.id);
  if (customer !== undefined) await db.prepare("UPDATE jj_styles SET customer=? WHERE id=?").run(customer, s.id);
  if (hasCutting !== undefined) await db.prepare("UPDATE jj_styles SET has_cutting=? WHERE id=?").run(hasCutting ? 1 : 0, s.id);
  if (note !== undefined) await db.prepare("UPDATE jj_styles SET note=? WHERE id=?").run(note || null, s.id);
  await logOp(req.user.id, `修改款式：${s.name}`);
  const what = changeWhat(STYLE_FIELD_LABELS, body, ["image", "images"]) || `修改了款式「${s.name}」`;
  await notifyManagers(`${req.user.name} 在「${s.name}」${what}`, "/styles", req.user.id,
    { actorName: req.user.name, targetLabel: s.name, what });
  res.json({ style: await db.prepare("SELECT * FROM jj_styles WHERE id=?").get(s.id) });
});
router.delete("/styles/:id", A.authRequired, async (req, res) => {
  const s = await db.prepare("SELECT * FROM jj_styles WHERE id=?").get(req.params.id);
  if (!s || s.deleted) return res.status(404).json({ error: "款式不存在" });
  await db.prepare("UPDATE jj_styles SET deleted=1 WHERE id=?").run(s.id);
  await logOp(req.user.id, `删除款式：${s.name}`);
  res.json({ ok: true });
});

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

/* ---------------- 操作记录 / 全员扫菲记录 ---------------- */
router.get("/operations", A.authRequired, A.managerRequired, async (req, res) => {
  const rows = await db.prepare(`
    SELECT l.*, u.name AS user_name FROM jj_operation_log l
    LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.created_at DESC LIMIT 100
  `).all();
  res.json({ logs: rows });
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

/* ---------------- 款式图上传 ---------------- */
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uid() + (path.extname(file.originalname || "").toLowerCase() || ".jpg"))
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});
router.post("/upload", A.authRequired, upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择图片文件" });
  res.json({ url: "/uploads/" + req.file.filename });
});

/* ---------------- 款式尺码/颜色/客户 选项池（管理员自己维护） ---------------- */
const STYLE_OPTION_KEYS = { size: "jjStyleSizes", color: "jjStyleColors", customer: "jjStyleCustomers" };
router.get("/style-options", A.authRequired, async (req, res) => {
  res.json({
    sizes: await getSetting(STYLE_OPTION_KEYS.size, []),
    colors: await getSetting(STYLE_OPTION_KEYS.color, []),
    customers: await getSetting(STYLE_OPTION_KEYS.customer, [])
  });
});
// 取出 { type, value } 对应的设置键，参数不对就直接回 400
function optionKey(req, res) {
  const { type, value } = req.body || {};
  const key = STYLE_OPTION_KEYS[type];
  if (!key || !value) { res.status(400).json({ error: "参数不对" }); return null; }
  return { key, value };
}
router.post("/style-options", A.authRequired, async (req, res) => {
  const o = optionKey(req, res); if (!o) return;
  const { key, value } = o;
  const list = await getSetting(key, []);
  const v = String(value).trim();
  if (v && !list.includes(v)) { list.push(v); await setSetting(key, list); }
  res.json({ list });
});
router.delete("/style-options", A.authRequired, async (req, res) => {
  const o = optionKey(req, res); if (!o) return;
  const { key, value } = o;
  const list = (await getSetting(key, [])).filter((x) => x !== value);
  await setSetting(key, list);
  res.json({ list });
});

/* ---------------- 款式关联的生产工序（从工序模板选，可单独改价） ---------------- */
// GET/PUT 共用同一种形状。LEFT JOIN：process_id 可空（自由输入的工序没有模板行）
async function styleProcessList(styleId) {
  const rows = await db.prepare(`
    SELECT sp.*, p.name AS process_name, p.unit AS process_unit, p.unit_price AS template_price
    FROM jj_style_processes sp LEFT JOIN jj_processes p ON p.id = sp.process_id
    WHERE sp.style_id = ? ORDER BY sp.seq ASC`).all(styleId);
  return rows.map((r) => {
    // 生效价：自己设过用自己的，没设过回落工序模板价
    const effective = (r.unit_price !== null && r.unit_price !== undefined)
      ? Number(r.unit_price) : (Number(r.template_price) || 0);
    return {
      id: r.id, style_id: r.style_id, process_id: r.process_id, seq: r.seq,
      name: r.name || r.process_name || "",
      price_mode: r.price_mode || "default",
      // 必须给生效价，不能回 0：否则读-改-写会把"回落模板价"的行永久写死成 0
      unit_price: effective,
      prices: jsonParseSafe(r.prices, {}),
      show_price: r.show_price !== 0,
      visible_roles: jsonParseSafe(r.visible_roles, []),
      // 没设过回空串，避免读-改-写把"没设"变成 0
      daily_quota: (r.daily_quota === null || r.daily_quota === undefined) ? "" : Number(r.daily_quota),
      process_unit: r.process_unit || null,
      effectivePrice: effective   // 跟 unit_price 同值，字段保留给旧调用方
    };
  });
}
// 工序名可自由输入（name 列）也可从模板挑（process_id）；styleProcessList 兜底老数据的空 name
router.get("/styles/:id/processes", A.authRequired, async (req, res) => {
  res.json({ list: await styleProcessList(req.params.id) });
});
// 整套覆盖（先清空再重写）：逐条增删改序混在一起很难保证一致，覆盖天然幂等
router.put("/styles/:id/processes", A.authRequired, async (req, res) => {
  const style = await db.prepare("SELECT * FROM jj_styles WHERE id=? AND deleted=0").get(req.params.id);
  if (!style) return res.status(404).json({ error: "款式不存在" });
  // 没传 items（字段拼错/漏传）跟显式传 [] 必须区分：前者是客户端出错，不能悄悄把全部工序删空
  if (!req.body || req.body.items === undefined) return res.status(400).json({ error: "缺少工序列表" });
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  for (const it of items) {
    if (!String(it.name || "").trim()) return res.status(400).json({ error: "工序名称不能为空" });
    if (it.priceMode && !["default", "size", "role"].includes(it.priceMode)) {
      return res.status(400).json({ error: "价格模式不对" });
    }
  }
  const now = Date.now();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM jj_style_processes WHERE style_id = ?", [style.id]);
    if (items.length) {
      await conn.query(
        `INSERT INTO jj_style_processes(id,style_id,process_id,seq,name,price_mode,unit_price,prices,show_price,visible_roles,daily_quota,created_at)
         VALUES ?`,
        [items.map((it, i) => [uid(), style.id, it.processId || null, i + 1,
          String(it.name).trim(), it.priceMode || "default", Number(it.unitPrice) || 0,
          it.prices ? JSON.stringify(it.prices) : null,
          it.showPrice === false ? 0 : 1,
          Array.isArray(it.visibleRoles) && it.visibleRoles.length ? JSON.stringify(it.visibleRoles) : null,
          it.dailyQuota === "" || it.dailyQuota === undefined || it.dailyQuota === null ? null : Number(it.dailyQuota),
          now])]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

  await logOp(req.user.id, `款式「${style.name}」保存工序：${items.length} 道`);
  res.json({ list: await styleProcessList(style.id) });
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

/* ---------------- 同步工序：把款式当前工序推到指定的几张裁床单 ---------------- */
// 裁床单工序是下单时的快照，改款式工序不影响已建的单；要生效需在此显式选单同步
router.get("/styles/:id/syncable-orders", A.authRequired, A.managerRequired, async (req, res) => {
  const style = await db.prepare("SELECT * FROM jj_styles WHERE id=? AND deleted=0").get(req.params.id);
  if (!style) return res.status(404).json({ error: "款式不存在" });
  const rows = await db.prepare(`
    SELECT o.id, o.bed_no, o.doc_no, o.cut_date, o.total_qty,
           (SELECT COUNT(*) FROM jj_cut_order_processes p WHERE p.order_id = o.id) AS process_count,
           (SELECT COALESCE(SUM(p.unit_price),0) FROM jj_cut_order_processes p WHERE p.order_id = o.id) AS total_price
    FROM jj_cut_orders o WHERE o.style_id = ? AND o.deleted = 0
    ORDER BY o.bed_no DESC`).all(req.params.id);
  const prog = await cutting.progressByOrders(rows.map((r) => r.id));
  res.json({ list: rows.map((r) => {
    const g = prog[r.id] || { completed: 0, percent: 0 };
    return Object.assign({}, r, { completed_qty: g.completed, percent: g.percent });
  }) });
});

router.post("/styles/:id/processes/sync", A.authRequired, A.managerRequired, async (req, res) => {
  const style = await db.prepare("SELECT * FROM jj_styles WHERE id=? AND deleted=0").get(req.params.id);
  if (!style) return res.status(404).json({ error: "款式不存在" });
  const ids = Array.isArray(req.body && req.body.orderIds) ? req.body.orderIds.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: "请选择要同步的裁床单" });
  const ph = ids.map(() => "?").join(",");
  const orders = await db.prepare(
    `SELECT id, bed_no FROM jj_cut_orders WHERE id IN (${ph}) AND style_id = ? AND deleted = 0`).all(...ids, style.id);
  if (!orders.length) return res.status(400).json({ error: "选中的裁床单不属于这个款式" });

  const sps = await db.prepare("SELECT * FROM jj_style_processes WHERE style_id=? ORDER BY seq ASC").all(style.id);
  const now = Date.now();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const o of orders) {
      // 整套替换（不做增量 diff）：旧打点记录挂在旧 order_process_id 上，替换后进度归零，
      // 这是有意的——工序表换了，旧进度对不上新工序
      await conn.query("DELETE FROM jj_cut_order_processes WHERE order_id = ?", [o.id]);
      await cutting.insertProcessRows(conn, cutting.styleProcSnapshot(o.id, sps, now));
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

  const label = `${style.code || style.name}`;
  await logOp(req.user.id, `款式「${style.name}」同步工序到 ${orders.length} 张裁床单`);
  await notifyManagers(`${req.user.name} 把 ${label} 的工序同步到了 ${orders.length} 张裁床单`, "/cutorders", req.user.id,
    { actorName: req.user.name, targetLabel: label, what: `同步工序到 ${orders.length} 张裁床单（床次 ${orders.map(o => o.bed_no).join("、")}）` });
  res.json({ synced: orders.length });
});

router.use(cutting.router);

/* ---------------- 系统推送订阅 ---------------- */
// 送达受通道限制（iOS 需加到主屏，微信内不支持），页面内红点轮询仍要保留
router.get("/push/public-key", A.authRequired, (req, res) => res.json({ key: P.publicKey() }));
router.post("/push/subscribe", A.authRequired, async (req, res) => {
  const saved = await P.saveSubscription(req.user.id, req.body && req.body.subscription, req.headers["user-agent"]);
  if (!saved) return res.status(400).json({ error: "订阅信息不完整" });
  res.json({ ok: true, count: await P.countOf(req.user.id) });
});
router.post("/push/unsubscribe", A.authRequired, async (req, res) => {
  await P.removeSubscription(req.body && req.body.endpoint);
  res.json({ ok: true });
});

/* ---------------- 应用内通知（跟跟单系统一致：最近 50 条、单条删除、清空已读） ---------------- */
const NOTIF_LIMIT = 50;
router.get("/notifications", A.authRequired, async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM jj_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${NOTIF_LIMIT}`)
    .all(req.user.id);
  // actorName/targetLabel/what 老通知为 NULL，前端退回纯文本
  res.json({ list: rows.map((r) => ({
    id: r.id, text: r.text, link: r.link, createdAt: r.created_at, read: !!r.read_at,
    actorName: r.actor_name, targetLabel: r.target_label, what: r.what
  })) });
});
router.get("/notifications/unread-count", A.authRequired, async (req, res) => {
  const c = (await db.prepare("SELECT COUNT(*) c FROM jj_notifications WHERE user_id = ? AND read_at IS NULL").get(req.user.id)).c;
  res.json({ total: c });
});
router.post("/notifications/read-all", A.authRequired, async (req, res) => {
  await db.prepare("UPDATE jj_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(Date.now(), req.user.id);
  res.json({ ok: true });
});
// 只能动自己的通知
async function ownNotif(req, res) {
  const row = await db.prepare("SELECT * FROM jj_notifications WHERE id = ?").get(req.params.id);
  if (!row) res.status(404).json({ error: "通知不存在" });
  else if (row.user_id !== req.user.id) res.status(403).json({ error: "无权操作这条通知" });
  else return row;
}
router.post("/notifications/:id/read", A.authRequired, async (req, res) => {
  const row = await ownNotif(req, res); if (!row) return;
  if (!row.read_at) await db.prepare("UPDATE jj_notifications SET read_at = ? WHERE id = ?").run(Date.now(), row.id);
  res.json({ ok: true });
});
// ?read=1 清空自己的已读通知
router.delete("/notifications", A.authRequired, async (req, res) => {
  if (req.query.read !== "1") return res.status(400).json({ error: "只支持清空已读通知" });
  const r = await db.prepare("DELETE FROM jj_notifications WHERE user_id = ? AND read_at IS NOT NULL").run(req.user.id);
  res.json({ ok: true, deleted: r.affectedRows });
});
router.delete("/notifications/:id", A.authRequired, async (req, res) => {
  const row = await ownNotif(req, res); if (!row) return;
  await db.prepare("DELETE FROM jj_notifications WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

module.exports = router;
