"use strict";
/**
 * 数据层：微信云托管 Serverless MySQL（mysql2/promise 连接池，异步）。
 *
 * 连接信息全部走环境变量（在云托管「服务设置 → 环境变量」里配，CLI 的 --envParams 有 bug）：
 *   MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
 *   也兼容云托管有时注入的 MYSQL_ADDRESS("host:port") / MYSQL_USERNAME。
 * 本地测试用 MYSQL_* 指向一个本地实例，跑一份全新的库（表结构在这里建齐）。
 *
 * 历史：本项目原先用 node:sqlite（跟 daka-system 共用一个 sqlite 文件），云托管不支持
 * 持久化文件卷，sqlite 重部署即清空，故迁到云托管 MySQL。daka 员工一次性导入（daka_seed.json）。
 */
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 款式图上传目录（云托管里是临时的；本地测试用 DATA_DIR）。DATA_DIR 不再放数据库，只放上传文件。
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOAD_DIR = path.join(DATA_DIR, "jj_uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function parseConf() {
  let host = process.env.MYSQL_HOST;
  let port = process.env.MYSQL_PORT;
  const addr = process.env.MYSQL_ADDRESS; // 云托管可能注入 "10.3.101.101:3306"
  if (addr && !host) {
    const [h, p] = String(addr).split(":");
    host = h; if (p && !port) port = p;
  }
  let database = process.env.MYSQL_DATABASE || process.env.MYSQL_DB || "jijian";
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error("非法的数据库名：" + database);
  return {
    host: host || "127.0.0.1",
    port: Number(port || 3306),
    user: process.env.MYSQL_USER || process.env.MYSQL_USERNAME || "root",
    password: process.env.MYSQL_PASSWORD || process.env.MYSQL_PWD || "",
    database
  };
}
const CONF = parseConf();

const pool = mysql.createPool({
  host: CONF.host,
  port: CONF.port,
  user: CONF.user,
  password: CONF.password,
  database: CONF.database,
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 10,
  enableKeepAlive: true
});

/**
 * 兼容层：保留原代码 `db.prepare(sql).get/all/run(...positionalArgs)` 的调用形状，
 * 只是全部返回 Promise（调用处加 await、handler 改 async 即可），SQL 里 `?` 占位跟
 * sqlite 一致。get 返回首行或 undefined，all 返回数组，run 返回 mysql2 结果对象。
 */
const db = {
  prepare(sql) {
    return {
      get: async (...args) => { const [rows] = await pool.query(sql, args); return rows[0]; },
      all: async (...args) => { const [rows] = await pool.query(sql, args); return rows; },
      run: async (...args) => { const [res] = await pool.query(sql, args); return res; }
    };
  }
};

const uid = () => crypto.randomBytes(9).toString("base64url");

// settings 表的 key 是 MySQL 保留字，必须反引号。value 存 JSON 字符串。
async function getSetting(key, fallback) {
  const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = ?", [key]);
  return rows[0] ? JSON.parse(rows[0].value) : fallback;
}
async function setSetting(key, value) {
  await pool.query(
    "INSERT INTO settings(`key`,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    [key, JSON.stringify(value)]
  );
}

// 建表（sqlite → MySQL 语法差异已处理：TEXT主键→VARCHAR(限长)、REAL→DOUBLE(mysql2 才返回 number，
// 用 DECIMAL 会返回字符串破坏计算)、INTEGER 毫秒时间戳→BIGINT、`WHERE deleted=0` 部分唯一索引 MySQL
// 不支持，phone 唯一性改由应用层判重，考勤/薪资的复合唯一键改成真正的 UNIQUE KEY 以支持 upsert）。
const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(32) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(64) NOT NULL,
    deleted TINYINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    KEY idx_users_phone (phone)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS settings (
    \`key\` VARCHAR(191) PRIMARY KEY,
    value MEDIUMTEXT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_wx_bindings (
    openid VARCHAR(128) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    created_at BIGINT NOT NULL,
    KEY idx_jjwx_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_join_requests (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    phone VARCHAR(32) NOT NULL,
    name VARCHAR(255) NOT NULL,
    method VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    handled_at BIGINT,
    handled_by VARCHAR(64),
    openid VARCHAR(128),
    KEY idx_jjjoin_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_processes (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    unit VARCHAR(32),
    std_qty DOUBLE NOT NULL,
    hour_quota DOUBLE NOT NULL,
    unit_price DOUBLE,
    deleted TINYINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_styles (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(128),
    image MEDIUMTEXT,
    images MEDIUMTEXT,
    size VARCHAR(128),
    color VARCHAR(128),
    customer VARCHAR(255),
    deleted TINYINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_style_processes (
    id VARCHAR(64) PRIMARY KEY,
    style_id VARCHAR(64) NOT NULL,
    process_id VARCHAR(64) NOT NULL,
    seq INT NOT NULL DEFAULT 0,
    unit_price DOUBLE,
    created_at BIGINT NOT NULL,
    KEY idx_jjsp_style (style_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_scan_records (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    style_id VARCHAR(64),
    process_id VARCHAR(64) NOT NULL,
    date VARCHAR(16) NOT NULL,
    qty DOUBLE NOT NULL,
    created_at BIGINT NOT NULL,
    KEY idx_jjscan_user_date (user_id, date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_attendance (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    date VARCHAR(16) NOT NULL,
    hours DOUBLE NOT NULL,
    source VARCHAR(32) NOT NULL DEFAULT 'manual',
    created_at BIGINT NOT NULL,
    UNIQUE KEY uq_jjatt_user_date (user_id, date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_cutting_sheets (
    id VARCHAR(64) PRIMARY KEY,
    style_id VARCHAR(64) NOT NULL,
    qty DOUBLE NOT NULL,
    note VARCHAR(1000),
    deleted TINYINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_payroll_adjustments (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    month VARCHAR(16) NOT NULL,
    meal_subsidy DOUBLE NOT NULL DEFAULT 0,
    penalty DOUBLE NOT NULL DEFAULT 0,
    bonus DOUBLE NOT NULL DEFAULT 0,
    note VARCHAR(1000),
    created_at BIGINT NOT NULL,
    UNIQUE KEY uq_jjpay_user_month (user_id, month)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_operation_log (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64),
    action VARCHAR(1000) NOT NULL,
    created_at BIGINT NOT NULL,
    KEY idx_jjoplog_time (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_notifications (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    text VARCHAR(500) NOT NULL,
    link VARCHAR(255),
    created_at BIGINT NOT NULL,
    read_at BIGINT,
    KEY idx_jjnotif_user (user_id, created_at),
    KEY idx_jjnotif_unread (user_id, read_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

// 内置引导管理员（手机号+真实姓名）：无 env 覆盖时始终确保这两位是管理员（缺则建、有则提升）。
// 吴佳霖是账号主人、周彦民是 daka 里的原管理员——daka 导入后周彦民已是 admin，但吴佳霖不在 daka
// 名单里，所以不能用"仅当零管理员才种子"的旧逻辑（会漏掉吴佳霖），改成始终 ensure，幂等。
const BOOTSTRAP_ADMINS = [
  { phone: "15522417606", name: "吴佳霖" },
  { phone: "13920822110", name: "周彦民" },
  { phone: "13034394098", name: "张立娓" }
];
// 种子/导入进来的账号统一给这个初始密码（网页版是手机号+密码登录，随机密码谁都不知道就登不进去）。
// 跟「跟单系统」后台新建账号的默认密码一个约定；员工首次登录后请管理员按需重置。
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || "123456";
const nameByPhone = Object.fromEntries(BOOTSTRAP_ADMINS.map((a) => [a.phone, a.name]));

// 一次性导入 daka 生产服务器的在职员工 + 岗位（server/daka_seed.json，随部署包带上）。
// 幂等：按手机号判重，已存在在职账号跳过，不覆盖后续在小程序里的改动。岗位保留 daka 原始 role
// 键（否则导入的 users.role 找不到对应 label 会显示原始键）。测试环境（NODE_ENV=test）不导入。
async function importDakaSeed() {
  const p = path.join(__dirname, "daka_seed.json");
  if (!fs.existsSync(p)) return;
  let seed;
  try { seed = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { console.warn("[import] daka_seed.json 解析失败，跳过导入"); return; }

  const existingRoles = await getSetting("roles", null);
  if ((existingRoles === null || (Array.isArray(existingRoles) && existingRoles.length === 0)) &&
      Array.isArray(seed.roles) && seed.roles.length) {
    await setSetting("roles", seed.roles.map((r) => ({ k: r.k, label: r.label })));
    console.log(`[import] 已从 daka 导入 ${seed.roles.length} 个岗位`);
  }

  let created = 0;
  for (const u of (seed.users || [])) {
    const phone = String(u.phone || "").trim();
    const name = String(u.name || "").trim();
    if (!phone || !name) continue;
    const [rows] = await pool.query("SELECT id FROM users WHERE phone=? AND deleted=0", [phone]);
    if (rows[0]) continue;
    await pool.query(
      "INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)",
      [uid(), name, phone, bcrypt.hashSync(DEFAULT_PASSWORD, 10), u.role || "worker", Date.now()]
    );
    created++;
  }
  if (created) console.log(`[import] 已从 daka 导入 ${created} 名员工`);
}

async function seedAdmins() {
  const envPhonesRaw = process.env.ADMIN_PHONES || process.env.ADMIN_PHONE || "";
  let adminPhones = String(envPhonesRaw).split(",").map((s) => s.trim()).filter(Boolean);
  if (adminPhones.length === 0) adminPhones = BOOTSTRAP_ADMINS.map((a) => a.phone);
  for (const phone of adminPhones) {
    const [rows] = await pool.query("SELECT id, role FROM users WHERE phone = ? AND deleted = 0", [phone]);
    const existing = rows[0];
    const nm = nameByPhone[phone] || "管理员";
    if (!existing) {
      await pool.query(
        "INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)",
        [uid(), nm, phone, bcrypt.hashSync(DEFAULT_PASSWORD, 10), "admin", Date.now()]
      );
      console.log(`[seed] 已创建种子管理员：${nm} (${phone})，初始密码 ${DEFAULT_PASSWORD}`);
    } else if (existing.role !== "admin") {
      await pool.query("UPDATE users SET role = 'admin' WHERE id = ?", [existing.id]);
      console.log(`[seed] 已把 ${phone} 提升为管理员`);
    }
  }
}

// 一次性补救：小程序时期建的账号（含 daka 导入的、种子管理员）密码是随机生成、谁都不知道的，
// 换成网页版的手机号+密码登录后就登不进去了。带 SEED_RESET_PASSWORDS=1 启动一次，
// 把库里所有在职账号的密码统一重置成初始密码，之后再正常启动即可（平时不要开着）。
async function resetAllPasswords() {
  if (process.env.SEED_RESET_PASSWORDS !== "1") return;
  const [r] = await pool.query("UPDATE users SET password_hash = ? WHERE deleted = 0", [bcrypt.hashSync(DEFAULT_PASSWORD, 10)]);
  console.log(`[seed] ⚠ 已把 ${r.affectedRows} 个在职账号的密码重置为初始密码 ${DEFAULT_PASSWORD}（SEED_RESET_PASSWORDS=1）`);
}

// 岗位兜底：仅当还完全没设置过 roles 时写入默认两个岗位（生产环境已由 daka 导入填过，这里通常跳过；
// 测试环境不导入 daka，就靠这里种下技术主管/业务主管）。
async function seedRoles() {
  const existing = await getSetting("roles", null);
  if (existing === null || (Array.isArray(existing) && existing.length === 0)) {
    await setSetting("roles", [
      { k: "tech_lead", label: "技术主管" },
      { k: "biz_lead", label: "业务主管" }
    ]);
    console.log("[seed] 已写入默认岗位：技术主管、业务主管");
  }
}

// 启动初始化：建库 → 建表 → 导入 daka → 种子管理员 → 岗位兜底。index.js 在 listen 前 await 调用。
async function init() {
  // 1. 确保目标库存在（连接时不指定 database）
  const conn = await mysql.createConnection({
    host: CONF.host, port: CONF.port, user: CONF.user, password: CONF.password
  });
  await conn.query("CREATE DATABASE IF NOT EXISTS `" + CONF.database + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci");
  await conn.end();
  // 2. 建表
  for (const ddl of DDL) await pool.query(ddl);
  // 2b. 迁移：jj_styles.image 原为 VARCHAR(512)，改成存 base64 图片需放宽到 MEDIUMTEXT（幂等，只在还是 varchar 时改一次）
  const [imgCol] = await pool.query(
    "SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='jj_styles' AND COLUMN_NAME='image'",
    [CONF.database]
  );
  if (imgCol[0] && String(imgCol[0].DATA_TYPE).toLowerCase() === "varchar") {
    await pool.query("ALTER TABLE jj_styles MODIFY image MEDIUMTEXT");
    console.log("[migrate] jj_styles.image → MEDIUMTEXT（支持存图片）");
  }
  // 2c. 迁移：jj_styles 增加 images 列（多图，存 fileID 数组的 JSON）
  const [imgsCol] = await pool.query(
    "SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='jj_styles' AND COLUMN_NAME='images'",
    [CONF.database]
  );
  if (!imgsCol[0]) {
    await pool.query("ALTER TABLE jj_styles ADD COLUMN images MEDIUMTEXT");
    console.log("[migrate] jj_styles 增加 images 列（多图）");
  }
  // 3. 一次性导入 daka 员工（仅生产）
  if (process.env.NODE_ENV !== "test") await importDakaSeed();
  // 4. 种子管理员
  await seedAdmins();
  // 5. 岗位兜底
  await seedRoles();
  // 6. 可选：一次性把老账号的随机密码重置成初始密码
  await resetAllPasswords();
  console.log(`[db] MySQL 就绪：${CONF.user}@${CONF.host}:${CONF.port}/${CONF.database}`);
}

module.exports = { db, pool, uid, getSetting, setSetting, DATA_DIR, UPLOAD_DIR, init };
