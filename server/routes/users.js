"use strict";
// 账号：登录、当前用户、改密码、员工增删改、岗位列表、操作日志。
const express = require("express");
const { db, uid, getSetting } = require("../db");
const A = require("../auth");
const { logOp } = require("../oplog");
const { notifyUsers } = require("../notify");
const { wrapAsync } = require("../async_router");
const { roleLabelWith } = require("./shared");

const router = express.Router();
wrapAsync(router, ["get", "post", "put", "patch", "delete", "all"]);

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

/* ---------------- 操作记录 / 全员扫菲记录 ---------------- */
router.get("/operations", A.authRequired, A.managerRequired, async (req, res) => {
  const rows = await db.prepare(`
    SELECT l.*, u.name AS user_name FROM jj_operation_log l
    LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.created_at DESC LIMIT 100
  `).all();
  res.json({ logs: rows });
});

module.exports = router;
