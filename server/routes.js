"use strict";
const express = require("express");
const multer = require("multer");
const path = require("path");
const { db, uid, getSetting, setSetting, UPLOAD_DIR } = require("./db");
const A = require("./auth");

const router = express.Router();

// 包裹 async handler：express4 不会自动捕获 async handler 里 reject 的异常（会让请求挂起），
// 这里改写路由注册方法，把每个 handler 用 Promise.resolve().catch(next) 包一层，
// 异常统一交给 index.js 的错误中间件返回 500。arity>=4 的错误中间件不包裹。
for (const m of ["get", "post", "put", "patch", "delete", "all"]) {
  const orig = router[m].bind(router);
  router[m] = (routePath, ...handlers) => orig(routePath, ...handlers.map((h) =>
    (typeof h === "function" && h.length < 4)
      ? function (req, res, next) { return Promise.resolve(h(req, res, next)).catch(next); }
      : h
  ));
}

async function logOp(userId, action) {
  await db.prepare("INSERT INTO jj_operation_log(id,user_id,action,created_at) VALUES(?,?,?,?)")
    .run(uid(), userId || null, action, Date.now());
}

// 应用内通知：写失败不影响主流程，全部包在 try 里；不通知操作者自己
// meta 是可选的结构化字段(actorName/targetLabel/what)，给前端拼"头像+姓名+对象胶囊+改动说明"
// 的卡片式展示用；不传就是 null，老式调用点(不需要这套展示)不用改
async function notifyUsers(userIds, text, link, excludeUserId, meta) {
  try {
    const targets = [...new Set((userIds || []).filter((id) => id && id !== excludeUserId))];
    for (const uid_ of targets) {
      await db.prepare("INSERT INTO jj_notifications(id,user_id,text,link,created_at,read_at,actor_name,target_label,what) VALUES(?,?,?,?,?,NULL,?,?,?)")
        .run(uid(), uid_, text, link || null, Date.now(),
          meta ? meta.actorName : null, meta ? meta.targetLabel : null, meta ? meta.what : null);
    }
  } catch (e) { console.error("[notify] 写通知失败", e); }
}
// 通知所有管理员/主管(款式/工序/裁床单这类共享主数据被改动时，让其他管理层知道)，不通知操作者自己
async function notifyManagers(text, link, excludeUserId, meta) {
  try {
    const rows = await db.prepare("SELECT id, role FROM users WHERE deleted = 0").all();
    const mgrIds = rows.filter((u) => A.isManager(u)).map((u) => u.id);
    await notifyUsers(mgrIds, text, link, excludeUserId, meta);
  } catch (e) { console.error("[notify] 通知管理员失败", e); }
}
// 字段被改动时通知里"改成了 XX"这句该怎么拼：只改一个字段就带上新值；改了好几个字段就把
// 字段名都列出来(超过3个截断+总数)，不再统一说一句看不出改了啥的"修改了XX"。
// skipValueKeys 给图片这类不适合塞进一句话通知的字段用，只报字段名不带值。
const PROCESS_FIELD_LABELS = { name: "工序名", unit: "计量单位", stdQty: "标准定额", hourQuota: "小时定额", unitPrice: "单价" };
const STYLE_FIELD_LABELS = { name: "款式名称", code: "款号", image: "封面图", images: "款式图片", size: "尺码", color: "颜色", customer: "客户" };
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

// 职位显示名：跟单系统自己的角色(业务员/下厂员/主管等)存在 settings.roles 里，
// 车间计件工人是 jijian 自己发明的角色，不在那张表里，这里特殊处理一下。
// 走 MySQL 后 getSetting 是异步的，遍历用户列表时先把 roles 预加载好，再用这个同步版查表。
function roleLabelWith(roles, roleKey) {
  if (roleKey === "admin") return "管理员";
  if (roleKey === "worker") return "计件工";
  const r = roles.find((x) => x.k === roleKey);
  return r ? r.label : roleKey;
}

// 给登录 / 我的接口返回的 user 带上岗位中文名（前端"我的"页职位显示用；职位==岗位，同一个东西）。
async function userPublicFull(u) {
  const roles = await getSetting("roles", []);
  return Object.assign(A.userPublic(u), { roleLabel: roleLabelWith(roles, u.role) });
}

/* ---------------- 微信登录 ---------------- */
async function code2Session(code) {
  const appid = process.env.WX_APPID;
  const secret = process.env.WX_SECRET;
  if (!appid || !secret) {
    throw Object.assign(new Error("尚未配置微信小程序 AppID/AppSecret，请先在微信公众平台注册"), { status: 500 });
  }
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j || j.errcode) throw Object.assign(new Error((j && j.errmsg) || "微信登录失败"), { status: 400 });
  return j.openid;
}

// 小程序打开后先调这个：拿 openid，如果已经绑定过员工账号直接登录成功，
// 没绑定的话前端转去"加入"流程（扫码/等待审批）
router.post("/wx/login", async (req, res) => {
  const { code, testOpenid, switchAccount } = req.body || {};
  const cloudOpenid = req.headers["x-wx-openid"]; // 云托管 callContainer 自动注入的真实 openid
  let openid;
  if (process.env.NODE_ENV === "test" && testOpenid) {
    openid = testOpenid; // 测试环境用假 openid，避免真的打微信接口
  } else if (cloudOpenid) {
    openid = cloudOpenid; // 云托管环境：直接用微信注入的 openid，无需 code2session/AppSecret
  } else {
    if (!code) return res.status(400).json({ error: "缺少 code" });
    try { openid = await code2Session(code); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  }
  // 换账号模式（退出登录后）：不自动登录，直接返回 openid 让前端显示填信息表单，可绑到别的账号。
  if (switchAccount) return res.json({ needJoin: true, openid });
  const bound = await db.prepare("SELECT user_id FROM jj_wx_bindings WHERE openid = ?").get(openid);
  if (!bound) return res.json({ needJoin: true, openid });
  const u = await A.userById(bound.user_id);
  if (!u || u.deleted) return res.status(401).json({ error: "账号不存在或已被删除" });
  res.json({ token: A.signToken(u), user: await userPublicFull(u) });
});

router.get("/me", A.authRequired, async (req, res) => res.json({ user: await userPublicFull(req.user) }));

// 改自己的密码（「我的」页面里用）：只要求已登录，改的永远是 req.user 自己那条，
// 跟「跟单系统」的 /password/change 一个逻辑，不涉及任何权限判断。
router.post("/password/change", A.authRequired, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: "新密码至少 4 位" });
  await db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(A.hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

/* ---------------- 手机号 + 密码登录（网页版 / PWA 用） ----------------
 * 网页在普通浏览器里跑，没有 wx.login 拿 openid 那套能力，所以跟「跟单系统」一样走
 * 手机号+密码：账号只能由管理员在「管理」页面手动创建（初始密码默认 123456），员工自己不能注册。
 * 只是多了一种登录方式，谁能操作什么(isManager/managerRequired/TEST_OPEN_ALL)完全没动。
 */
router.post("/login", async (req, res) => {
  const { phone, password } = req.body || {};
  const u = await db.prepare("SELECT * FROM users WHERE phone = ? AND deleted = 0").get(String(phone || "").trim());
  if (!u || !A.verifyPassword(password || "", u.password_hash))
    return res.status(400).json({ error: "手机号或密码不正确" });
  res.json({ token: A.signToken(u), user: await userPublicFull(u) });
});

/* ---------------- 加入 / 审批 ---------------- */
// 扫码加入：命中已有手机号就用那个账号，没有就新建一行，都要走审批
router.post("/join/scan", async (req, res) => {
  const { openid, phone, name } = req.body || {};
  if (!openid || !phone || !name) return res.status(400).json({ error: "缺少 openid/手机号/姓名" });
  const phoneT = String(phone).trim();
  let u = await db.prepare("SELECT * FROM users WHERE phone = ? AND deleted = 0").get(phoneT);
  const preExisted = !!u; // 手机号已在库里 = 管理员早就手动加过这个人（等于已批准）
  if (!u) {
    const id = uid();
    await db.prepare("INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
      .run(id, String(name).trim(), phoneT, A.hashPassword(uid()), "worker", Date.now());
    u = await A.userById(id);
  }
  // 已存在的账号（管理员手动加过，或本就是管理员）扫码时直接绑定登录、免审批；
  // 只有查无此人（真·新人自助扫码）才生成待审批申请。
  // 绑定用 upsert：同一个微信 openid 换登录别的账号时，把绑定覆盖到新账号。
  if (preExisted || A.isAdmin(u)) {
    await db.prepare("INSERT INTO jj_wx_bindings(openid,user_id,created_at) VALUES(?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), created_at=VALUES(created_at)")
      .run(openid, u.id, Date.now());
    await logOp(u.id, `${A.isAdmin(u) ? "管理员" : "已有员工"}账号自动绑定登录：${u.name}`);
    return res.json({ status: "approved", token: A.signToken(u), user: await userPublicFull(u) });
  }
  const reqId = uid();
  await db.prepare("INSERT INTO jj_join_requests(id,user_id,phone,name,method,status,created_at,openid) VALUES(?,?,?,?,?,?,?,?)")
    .run(reqId, u.id, phoneT, String(name).trim(), "scan", "pending", Date.now(), openid);
  res.json({ status: "pending", requestId: reqId });
});

router.get("/join/requests", A.authRequired, A.managerRequired, async (req, res) => {
  const list = await db.prepare("SELECT * FROM jj_join_requests WHERE status = 'pending' ORDER BY created_at DESC").all();
  res.json({ requests: list });
});

router.post("/join/requests/:id/approve", A.authRequired, A.managerRequired, async (req, res) => {
  const r = await db.prepare("SELECT * FROM jj_join_requests WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "申请不存在" });
  if (r.status !== "pending") return res.status(400).json({ error: "已经处理过了" });
  await db.prepare("INSERT INTO jj_wx_bindings(openid,user_id,created_at) VALUES(?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), created_at=VALUES(created_at)")
    .run(r.openid, r.user_id, Date.now());
  await db.prepare("UPDATE jj_join_requests SET status='approved', handled_at=?, handled_by=? WHERE id=?")
    .run(Date.now(), req.user.id, r.id);
  await logOp(req.user.id, `审批通过员工加入：${r.name}（${r.phone}）`);
  res.json({ ok: true });
});

router.post("/join/requests/:id/reject", A.authRequired, A.managerRequired, async (req, res) => {
  const r = await db.prepare("SELECT * FROM jj_join_requests WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "申请不存在" });
  if (r.status !== "pending") return res.status(400).json({ error: "已经处理过了" });
  await db.prepare("UPDATE jj_join_requests SET status='rejected', handled_at=?, handled_by=? WHERE id=?")
    .run(Date.now(), req.user.id, r.id);
  await logOp(req.user.id, `拒绝员工加入申请：${r.name}（${r.phone}）`);
  res.json({ ok: true });
});

/* ---------------- 员工管理 ---------------- */
router.get("/users", A.authRequired, A.managerRequired, async (req, res) => {
  const roles = await getSetting("roles", []);
  const list = await db.prepare("SELECT * FROM users WHERE deleted = 0 ORDER BY created_at DESC").all();
  res.json({
    users: list.map((u) => Object.assign(A.userPublic(u), { roleLabel: roleLabelWith(roles, u.role), createdAt: u.created_at }))
  });
});

// 可选的职位列表，给"设置岗位"选择器用（不含管理员，避免顺手就把人设成管理员）
router.get("/roles", A.authRequired, A.managerRequired, async (req, res) => {
  const roles = [{ k: "worker", label: "计件工" }].concat((await getSetting("roles", [])).map((r) => ({ k: r.k, label: r.label })));
  res.json({ roles });
});

// 手动添加：管理员直接建号（员工不能自助注册）。初始密码可以传，不传就是默认的 123456，
// 员工拿手机号+这个密码在网页登录页进入。
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
router.get("/styles", A.authRequired, async (req, res) => {
  const list = await db.prepare("SELECT * FROM jj_styles WHERE deleted = 0 ORDER BY created_at DESC").all();
  res.json({ styles: list });
});
router.post("/styles", A.authRequired, async (req, res) => {
  const { name, code, image, images, size, color, customer } = req.body || {};
  if (!name) return res.status(400).json({ error: "请填写款式名" });
  if (!code) return res.status(400).json({ error: "请填写款号" });
  const id = uid();
  const imgs = Array.isArray(images) ? images : [];   // 多图：fileID 数组
  const cover = image || imgs[0] || null;             // 封面 = 传入的 image，或第一张
  await db.prepare("INSERT INTO jj_styles(id,name,code,image,images,size,color,customer,deleted,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)")
    .run(id, String(name).trim(), String(code).trim(), cover, JSON.stringify(imgs), size || null, color || null, customer || null, Date.now());
  await logOp(req.user.id, `新增款式：${String(name).trim()}`);
  await notifyManagers(`${req.user.name} 新增了款式「${String(name).trim()}」`, "/styles", req.user.id);
  res.json({ style: await db.prepare("SELECT * FROM jj_styles WHERE id=?").get(id) });
});
router.patch("/styles/:id", A.authRequired, async (req, res) => {
  const s = await db.prepare("SELECT * FROM jj_styles WHERE id=?").get(req.params.id);
  if (!s || s.deleted) return res.status(404).json({ error: "款式不存在" });
  const body = req.body || {};
  const { name, code, image, images, size, color, customer } = body;
  if (name !== undefined) await db.prepare("UPDATE jj_styles SET name=? WHERE id=?").run(String(name).trim(), s.id);
  if (code !== undefined) await db.prepare("UPDATE jj_styles SET code=? WHERE id=?").run(String(code).trim(), s.id);
  if (image !== undefined) await db.prepare("UPDATE jj_styles SET image=? WHERE id=?").run(image, s.id);
  if (images !== undefined) {
    const imgs = Array.isArray(images) ? images : [];
    await db.prepare("UPDATE jj_styles SET images=?, image=? WHERE id=?").run(JSON.stringify(imgs), imgs[0] || null, s.id);
  }
  if (size !== undefined) await db.prepare("UPDATE jj_styles SET size=? WHERE id=?").run(size, s.id);
  if (color !== undefined) await db.prepare("UPDATE jj_styles SET color=? WHERE id=?").run(color, s.id);
  if (customer !== undefined) await db.prepare("UPDATE jj_styles SET customer=? WHERE id=?").run(customer, s.id);
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

/* ---------------- 打点（计件记录） ---------------- */
router.post("/scan", A.authRequired, async (req, res) => {
  const { styleId, processId, date, qty, userId } = req.body || {};
  if (!processId || !date || qty === undefined) return res.status(400).json({ error: "缺少工序/日期/数量" });
  const proc = await db.prepare("SELECT * FROM jj_processes WHERE id = ? AND deleted = 0").get(processId);
  if (!proc) return res.status(400).json({ error: "工序不存在" });
  let targetUserId = req.user.id;
  if (userId && userId !== req.user.id) {
    if (!A.canActAsAdmin(req.user)) return res.status(403).json({ error: "没有权限代别人打点" });
    targetUserId = userId;
  }
  const id = uid();
  await db.prepare("INSERT INTO jj_scan_records(id,user_id,style_id,process_id,date,qty,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, targetUserId, styleId || null, processId, date, Number(qty), Date.now());
  res.json({ record: await db.prepare("SELECT * FROM jj_scan_records WHERE id=?").get(id) });
});

router.get("/scan", A.authRequired, async (req, res) => {
  const { date } = req.query;
  let userId = req.query.userId;
  if (!userId) userId = req.user.id;
  if (userId !== req.user.id && !A.canActAsAdmin(req.user)) return res.status(403).json({ error: "没有权限查看他人记录" });
  const rows = date
    ? await db.prepare("SELECT * FROM jj_scan_records WHERE user_id=? AND date=? ORDER BY created_at DESC").all(userId, date)
    : await db.prepare("SELECT * FROM jj_scan_records WHERE user_id=? ORDER BY created_at DESC LIMIT 200").all(userId);
  res.json({ records: rows });
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
async function effectiveHours(userId, datePattern, exact) {
  const sql = exact
    ? "SELECT COALESCE(SUM(qty * 1.0 / p.hour_quota),0) AS eh FROM jj_scan_records s JOIN jj_processes p ON p.id = s.process_id WHERE s.user_id=? AND s.date=?"
    : "SELECT COALESCE(SUM(qty * 1.0 / p.hour_quota),0) AS eh FROM jj_scan_records s JOIN jj_processes p ON p.id = s.process_id WHERE s.user_id=? AND s.date LIKE ?";
  const row = await db.prepare(sql).get(userId, datePattern);
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

// 管理员看板：全员某月完成百分比
// 管理员自己不是计件工、不参与考勤，所以不列在效率榜里（跟薪资汇总/员工列表口径一致）
router.get("/efficiency/summary", A.authRequired, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: "缺少月份" });
  const users = await db.prepare("SELECT * FROM users WHERE deleted = 0 AND role <> 'admin'").all();
  const list = await Promise.all(users.map(async (u) => {
    const eh = await effectiveHours(u.id, month + "%", false);
    const attHours = await attendanceSum(u.id, month + "%");
    return { userId: u.id, name: u.name, effectiveHours: eh, attendanceHours: attHours, percent: attHours > 0 ? eh / attHours : null };
  }));
  res.json({ month, list });
});

/* ---------------- 裁床单 / 生产管理 ---------------- */
function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
router.get("/cutting-sheets", A.authRequired, async (req, res) => {
  const q = (req.query.q || "").trim();
  const rows = await db.prepare(`
    SELECT c.*, s.name AS style_name, s.code AS style_code,
      COALESCE((SELECT SUM(r.qty) FROM jj_scan_records r WHERE r.style_id = s.id), 0) AS style_completed
    FROM jj_cutting_sheets c JOIN jj_styles s ON s.id = c.style_id
    WHERE c.deleted = 0
    ${q ? "AND (s.name LIKE ? OR s.code LIKE ?)" : ""}
    ORDER BY c.created_at DESC
  `).all(...(q ? [`%${q}%`, `%${q}%`] : []));
  res.json({ sheets: rows });
});
// 按款汇总：同一款式多张裁床单合并统计（裁床总量 = 该款所有未删除裁床单之和，已完成 = 该款所有打点记录之和）
router.get("/cutting-sheets/by-style", A.authRequired, async (req, res) => {
  const q = (req.query.q || "").trim();
  const rows = await db.prepare(`
    SELECT s.id AS style_id, s.name AS style_name, s.code AS style_code,
      COALESCE((SELECT SUM(c.qty) FROM jj_cutting_sheets c WHERE c.style_id = s.id AND c.deleted = 0), 0) AS total_qty,
      COALESCE((SELECT SUM(r.qty) FROM jj_scan_records r WHERE r.style_id = s.id), 0) AS completed_qty,
      (SELECT COUNT(*) FROM jj_cutting_sheets c WHERE c.style_id = s.id AND c.deleted = 0) AS sheet_count
    FROM jj_styles s
    WHERE s.deleted = 0
      AND EXISTS (SELECT 1 FROM jj_cutting_sheets c WHERE c.style_id = s.id AND c.deleted = 0)
      ${q ? "AND (s.name LIKE ? OR s.code LIKE ?)" : ""}
    ORDER BY s.created_at DESC
  `).all(...(q ? [`%${q}%`, `%${q}%`] : []));
  res.json({ list: rows });
});
// 生产管理首页统计卡：已完成件数按今日/昨日/本月的打点总量算，生产中件数是当前时点的快照（不分日期）＝ 裁床总量－全部历史已完成
router.get("/cutting/overview", A.authRequired, async (req, res) => {
  const range = req.query.range === "yesterday" || req.query.range === "month" ? req.query.range : "today";
  let pattern, like;
  if (range === "yesterday") {
    const d = new Date(); d.setDate(d.getDate() - 1);
    pattern = ymd(d); like = false;
  } else if (range === "month") {
    const d = new Date();
    pattern = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "%"; like = true;
  } else {
    pattern = ymd(new Date()); like = false;
  }
  const completed = (await db.prepare(`SELECT COALESCE(SUM(qty),0) AS v FROM jj_scan_records WHERE date ${like ? "LIKE ?" : "= ?"}`).get(pattern)).v;
  const totalCut = (await db.prepare("SELECT COALESCE(SUM(qty),0) AS v FROM jj_cutting_sheets WHERE deleted=0").get()).v;
  const totalDone = (await db.prepare("SELECT COALESCE(SUM(qty),0) AS v FROM jj_scan_records").get()).v;
  res.json({ range, completed, inProduction: Math.max(0, totalCut - totalDone) });
});
router.post("/cutting-sheets", A.authRequired, async (req, res) => {
  const { styleId, qty, note } = req.body || {};
  if (!styleId || !qty) return res.status(400).json({ error: "请选择款式并填写数量" });
  const style = await db.prepare("SELECT * FROM jj_styles WHERE id=? AND deleted=0").get(styleId);
  if (!style) return res.status(400).json({ error: "款式不存在" });
  const id = uid();
  await db.prepare("INSERT INTO jj_cutting_sheets(id,style_id,qty,note,deleted,created_at) VALUES(?,?,?,?,0,?)")
    .run(id, styleId, Number(qty), note || null, Date.now());
  await logOp(req.user.id, `新增裁床单：${style.name} × ${qty}`);
  await notifyManagers(`${req.user.name} 新增了裁床单「${style.name} × ${qty}」`, "/cutting", req.user.id);
  res.json({ sheet: await db.prepare("SELECT c.*, s.name AS style_name, s.code AS style_code FROM jj_cutting_sheets c JOIN jj_styles s ON s.id=c.style_id WHERE c.id=?").get(id) });
});
router.patch("/cutting-sheets/:id", A.authRequired, async (req, res) => {
  const c = await db.prepare("SELECT * FROM jj_cutting_sheets WHERE id=?").get(req.params.id);
  if (!c || c.deleted) return res.status(404).json({ error: "裁床单不存在" });
  const { qty, note } = req.body || {};
  if (qty !== undefined) await db.prepare("UPDATE jj_cutting_sheets SET qty=? WHERE id=?").run(Number(qty), c.id);
  if (note !== undefined) await db.prepare("UPDATE jj_cutting_sheets SET note=? WHERE id=?").run(note, c.id);
  await logOp(req.user.id, `修改裁床单：${c.id}`);
  res.json({ sheet: await db.prepare("SELECT c.*, s.name AS style_name, s.code AS style_code FROM jj_cutting_sheets c JOIN jj_styles s ON s.id=c.style_id WHERE c.id=?").get(c.id) });
});
router.delete("/cutting-sheets/:id", A.authRequired, async (req, res) => {
  const c = await db.prepare("SELECT * FROM jj_cutting_sheets WHERE id=?").get(req.params.id);
  if (!c || c.deleted) return res.status(404).json({ error: "裁床单不存在" });
  await db.prepare("UPDATE jj_cutting_sheets SET deleted=1 WHERE id=?").run(c.id);
  await logOp(req.user.id, `删除裁床单：${c.id}`);
  await notifyManagers(`${req.user.name} 删除了一张裁床单`, "/cutting", req.user.id);
  res.json({ ok: true });
});

/* ---------------- 薪资管理：计件工资 = sum(打点数量 × 工序单价)，再加餐补/奖金/扣罚 ---------------- */
async function pieceWage(userId, datePattern) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(s.qty * COALESCE(p.unit_price, 0)), 0) AS w
    FROM jj_scan_records s JOIN jj_processes p ON p.id = s.process_id
    WHERE s.user_id = ? AND s.date LIKE ?
  `).get(userId, datePattern);
  return row ? row.w : 0;
}
async function payrollFor(userId, month) {
  const wage = await pieceWage(userId, month + "%");
  const adj = await db.prepare("SELECT * FROM jj_payroll_adjustments WHERE user_id=? AND month=?").get(userId, month);
  const mealSubsidy = adj ? adj.meal_subsidy : 0;
  const penalty = adj ? adj.penalty : 0;
  const bonus = adj ? adj.bonus : 0;
  return { pieceWage: wage, mealSubsidy, penalty, bonus, total: wage + mealSubsidy + bonus - penalty };
}

router.get("/payroll/mine", A.authRequired, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: "缺少月份" });
  res.json(Object.assign({ month, userId: req.user.id }, await payrollFor(req.user.id, month)));
});

router.get("/payroll/summary", A.authRequired, A.managerRequired, async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: "缺少月份" });
  // 薪资表不列管理员（管理员不是计件工，没有计件工资），跟员工列表口径一致
  const users = await db.prepare("SELECT * FROM users WHERE deleted = 0 AND role <> 'admin'").all();
  const list = await Promise.all(users.map(async (u) => Object.assign({ userId: u.id, name: u.name }, await payrollFor(u.id, month))));
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
  const oldVals = { mealSubsidy: old ? old.meal_subsidy : 0, penalty: old ? old.penalty : 0, bonus: old ? old.bonus : 0 };
  const id = uid();
  await db.prepare(`INSERT INTO jj_payroll_adjustments(id,user_id,month,meal_subsidy,penalty,bonus,note,created_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE meal_subsidy=VALUES(meal_subsidy), penalty=VALUES(penalty), bonus=VALUES(bonus), note=VALUES(note)`)
    .run(id, userId, month, newVals.mealSubsidy, newVals.penalty, newVals.bonus, note || null, Date.now());
  await logOp(req.user.id, `调整 ${month} 薪资项：员工 ${userId}`);
  // 只报实际变了的那几项，不再每次都笼统列出"餐补/扣罚/奖金"三个名字，不管到底动没动
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

router.get("/scan-all", A.authRequired, async (req, res) => {
  const { date, month } = req.query;
  if (!date && !month) return res.status(400).json({ error: "缺少日期或月份" });
  const rows = date
    ? await db.prepare(`
        SELECT s.*, u.name AS user_name, p.name AS process_name FROM jj_scan_records s
        JOIN users u ON u.id = s.user_id JOIN jj_processes p ON p.id = s.process_id
        WHERE s.date = ? ORDER BY s.created_at DESC
      `).all(date)
    : await db.prepare(`
        SELECT s.*, u.name AS user_name, p.name AS process_name FROM jj_scan_records s
        JOIN users u ON u.id = s.user_id JOIN jj_processes p ON p.id = s.process_id
        WHERE s.date LIKE ? ORDER BY s.created_at DESC LIMIT 300
      `).all(month + "%");
  res.json({ records: rows });
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
router.post("/style-options", A.authRequired, async (req, res) => {
  const { type, value } = req.body || {};
  const key = STYLE_OPTION_KEYS[type];
  if (!key || !value) return res.status(400).json({ error: "参数不对" });
  const list = await getSetting(key, []);
  const v = String(value).trim();
  if (v && !list.includes(v)) { list.push(v); await setSetting(key, list); }
  res.json({ list });
});
router.delete("/style-options", A.authRequired, async (req, res) => {
  const { type, value } = req.body || {};
  const key = STYLE_OPTION_KEYS[type];
  if (!key || !value) return res.status(400).json({ error: "参数不对" });
  const list = (await getSetting(key, [])).filter((x) => x !== value);
  await setSetting(key, list);
  res.json({ list });
});

/* ---------------- 款式关联的生产工序（从工序模板选，可单独改价） ---------------- */
router.get("/styles/:id/processes", A.authRequired, async (req, res) => {
  const rows = await db.prepare(`
    SELECT sp.*, p.name AS process_name, p.unit AS process_unit, p.unit_price AS template_price
    FROM jj_style_processes sp JOIN jj_processes p ON p.id = sp.process_id
    WHERE sp.style_id = ? ORDER BY sp.seq ASC
  `).all(req.params.id);
  const list = rows.map((r) => Object.assign({}, r, {
    effectivePrice: r.unit_price !== null && r.unit_price !== undefined ? r.unit_price : r.template_price
  }));
  res.json({ list });
});
router.post("/styles/:id/processes", A.authRequired, async (req, res) => {
  const style = await db.prepare("SELECT * FROM jj_styles WHERE id=? AND deleted=0").get(req.params.id);
  if (!style) return res.status(404).json({ error: "款式不存在" });
  const { processId, unitPrice } = req.body || {};
  const proc = await db.prepare("SELECT * FROM jj_processes WHERE id=? AND deleted=0").get(processId);
  if (!proc) return res.status(400).json({ error: "工序不存在" });
  const maxSeq = (await db.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM jj_style_processes WHERE style_id=?").get(style.id)).m;
  const id = uid();
  await db.prepare("INSERT INTO jj_style_processes(id,style_id,process_id,seq,unit_price,created_at) VALUES(?,?,?,?,?,?)")
    .run(id, style.id, processId, maxSeq + 1, unitPrice !== undefined && unitPrice !== "" ? Number(unitPrice) : null, Date.now());
  await logOp(req.user.id, `款式「${style.name}」新增工序：${proc.name}`);
  res.json({ item: await db.prepare("SELECT * FROM jj_style_processes WHERE id=?").get(id) });
});
router.patch("/style-processes/:id", A.authRequired, async (req, res) => {
  const sp = await db.prepare("SELECT * FROM jj_style_processes WHERE id=?").get(req.params.id);
  if (!sp) return res.status(404).json({ error: "记录不存在" });
  const { unitPrice, seq } = req.body || {};
  if (unitPrice !== undefined) await db.prepare("UPDATE jj_style_processes SET unit_price=? WHERE id=?").run(unitPrice === "" || unitPrice === null ? null : Number(unitPrice), sp.id);
  if (seq !== undefined) await db.prepare("UPDATE jj_style_processes SET seq=? WHERE id=?").run(Number(seq), sp.id);
  res.json({ item: await db.prepare("SELECT * FROM jj_style_processes WHERE id=?").get(sp.id) });
});
router.delete("/style-processes/:id", A.authRequired, async (req, res) => {
  const sp = await db.prepare("SELECT * FROM jj_style_processes WHERE id=?").get(req.params.id);
  if (!sp) return res.status(404).json({ error: "记录不存在" });
  await db.prepare("DELETE FROM jj_style_processes WHERE id=?").run(sp.id);
  res.json({ ok: true });
});

/* ---------------- 应用内通知 ---------------- */
const NOTIF_LIMIT = 50;   // 只给最近 50 条，够用又不会让列表无限长
router.get("/notifications", A.authRequired, async (req, res) => {
  const rows = await db.prepare(`SELECT * FROM jj_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${NOTIF_LIMIT}`)
    .all(req.user.id);
  // actorName/targetLabel/what 是给更精致的通知卡片用的结构化字段；老通知这几列可能是 NULL，
  // 前端遇到 NULL 时会退回纯文本 text 展示，这里原样传，不用兜底成空字符串
  res.json({ list: rows.map((r) => ({
    id: r.id, text: r.text, link: r.link, createdAt: r.created_at, read: !!r.read_at,
    actorName: r.actor_name, targetLabel: r.target_label, what: r.what
  })) });
});
// 未读总数(给红点轮询用)
router.get("/notifications/unread-count", A.authRequired, async (req, res) => {
  const c = (await db.prepare("SELECT COUNT(*) c FROM jj_notifications WHERE user_id = ? AND read_at IS NULL").get(req.user.id)).c;
  res.json({ total: c });
});
router.post("/notifications/read-all", A.authRequired, async (req, res) => {
  await db.prepare("UPDATE jj_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(Date.now(), req.user.id);
  res.json({ ok: true });
});
router.post("/notifications/:id/read", A.authRequired, async (req, res) => {
  const row = await db.prepare("SELECT * FROM jj_notifications WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "通知不存在" });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: "无权操作这条通知" });
  if (!row.read_at) await db.prepare("UPDATE jj_notifications SET read_at = ? WHERE id = ?").run(Date.now(), row.id);
  res.json({ ok: true });
});

module.exports = router;
