"use strict";
// 款式：款式增删改、缩略图、款式图片上传、尺码 / 颜色 / 客户选项、款式工序（含同步到裁床单）。
const express = require("express");
const multer = require("multer");
const path = require("path");
const { db, pool, uid, getSetting, setSetting, UPLOAD_DIR } = require("../db");
const A = require("../auth");
const { logOp } = require("../oplog");
const { notifyManagers } = require("../notify");
const cutting = require("../routes_cutting");
const { wrapAsync } = require("../async_router");
const { jsonParseSafe, changeWhat } = require("./shared");

const router = express.Router();
wrapAsync(router, ["get", "post", "put", "patch", "delete", "all"]);

const STYLE_FIELD_LABELS = { name: "款式名称", code: "款号", image: "封面图", images: "款式图片", size: "尺码", color: "颜色", customer: "客户", hasCutting: "是否裁床", note: "款式备注" };

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

module.exports = router;
