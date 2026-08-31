"use strict";
/**
 * 账号跟「跟单系统」共用同一张 users 表（同一批人），这里只是给这个
 * 独立部署的服务自己签发/校验 JWT，密钥跟 daka-system 分开存
 * （.jwt_secret_jijian，不会跟 daka-system 自己的 .jwt_secret 冲突）。
 */
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, DATA_DIR } = require("./db");

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const p = path.join(DATA_DIR, ".jwt_secret_jijian");
  try { return fs.readFileSync(p, "utf8"); }
  catch (e) {
    const s = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(p, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();

const hashPassword = (pw) => bcrypt.hashSync(String(pw), 10);
const verifyPassword = (pw, hash) => bcrypt.compareSync(String(pw), hash);
const signToken = (user) => jwt.sign({ id: user.id }, SECRET);

function userPublic(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, phone: u.phone, role: u.role, deleted: !!u.deleted };
}
// 现在走 MySQL（异步），返回 Promise，调用处需 await。
const userById = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);

async function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "未登录" });
  try {
    const payload = jwt.verify(token, SECRET);
    const u = await userById(payload.id);
    if (!u || u.deleted) return res.status(401).json({ error: "账号不存在或已被删除" });
    req.user = u;
    next();
  } catch (e) {
    return res.status(401).json({ error: "登录已失效，请重新登录" });
  }
}

function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "仅管理员可操作" });
  next();
}
const isAdmin = (u) => !!u && u.role === "admin";

// ===== 测试阶段权限放宽（临时）=====
// 规则：管理员 + 两个主管(技术主管/业务主管)= 完全权限（含员工管理/操作记录/薪资管理）；
// 其他所有登录用户 = 跟管理员一样，唯独看不到那 3 块。
// 主管角色键：daka 导入的是 r1785125327446(技术主管)/r1785125333976(业务主管)，
// 同时兼容 jijian 原生的 tech_lead/biz_lead。测试结束想收紧：把 TEST_OPEN_ALL 改成 false，
// 并把 routes.js 里用 managerRequired/authRequired 放开的路由按需改回 adminRequired 即可。
const SUPERVISOR_ROLES = new Set(["r1785125327446", "r1785125333976", "tech_lead", "biz_lead"]);
const isManager = (u) => isAdmin(u) || (!!u && SUPERVISOR_ROLES.has(u.role));

// 完全权限门槛：员工管理/操作记录/薪资管理这 3 块用它（管理员+主管）。
function managerRequired(req, res, next) {
  if (!req.user || !isManager(req.user)) return res.status(403).json({ error: "仅管理员或主管可操作" });
  next();
}

// 测试阶段“人人如管理员”：其余功能（工序/款式/考勤/生产/效率/扫菲/代打点/看他人数据）对所有
// 登录用户开放。收紧时把 TEST_OPEN_ALL 改 false，行为回到"仅管理员"。
const TEST_OPEN_ALL = true;
const canActAsAdmin = (u) => TEST_OPEN_ALL || isAdmin(u);

module.exports = {
  hashPassword, verifyPassword, signToken, userPublic, userById,
  authRequired, adminRequired, isAdmin,
  isManager, managerRequired, canActAsAdmin
};
