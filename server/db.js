"use strict";
// 数据层：MySQL（mysql2/promise 连接池，异步）。连接信息全部走环境变量
// （MYSQL_HOST/PORT/USER/PASSWORD/DATABASE，也兼容 MYSQL_ADDRESS/MYSQL_USERNAME）。
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 款式图上传目录（本地测试用临时 DATA_DIR）。DATA_DIR 不再放数据库，只放上传文件。
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const UPLOAD_DIR = path.join(DATA_DIR, "jj_uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function parseConf() {
  let host = process.env.MYSQL_HOST;
  let port = process.env.MYSQL_PORT;
  const addr = process.env.MYSQL_ADDRESS; // "10.3.101.101:3306" 这种 host:port 合在一起的写法
  if (addr && !host) {
    const [h, p] = String(addr).split(":");
    host = h; if (p && !port) port = p;
  }
  let database = process.env.MYSQL_DATABASE || process.env.MYSQL_DB || "jijian";
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error("非法的数据库名：" + database);
  // 本机开发/测试走 unix socket（macOS 上的 MariaDB 给当前系统用户配的是 unix_socket 认证，
  // 免密）。设了 MYSQL_SOCKET 就用 socket，host/port 忽略；服务器上不设这个变量，走 host/port。
  const socketPath = process.env.MYSQL_SOCKET || null;
  return {
    host: host || "127.0.0.1",
    port: Number(port || 3306),
    user: process.env.MYSQL_USER || process.env.MYSQL_USERNAME || "root",
    password: process.env.MYSQL_PASSWORD || process.env.MYSQL_PWD || "",
    database,
    socketPath
  };
}
const CONF = parseConf();

// host/port 与 socketPath 二选一：mysql2 两个都传会优先走 socket 但保留无用的 host/port，
// 容易看错实际连法，所以按是否设了 socketPath 显式挑一种传给底层连接。
const netOrSocket = CONF.socketPath
  ? { socketPath: CONF.socketPath }
  : { host: CONF.host, port: CONF.port };

const pool = mysql.createPool(Object.assign({
  user: CONF.user,
  password: CONF.password,
  database: CONF.database,
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 10,
  enableKeepAlive: true
}, netOrSocket));

// db.prepare(sql).get/all/run(...args)：get 首行或 undefined，all 数组，run 结果对象（都返回 Promise）
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

// 数值列用 DOUBLE 不用 DECIMAL：mysql2 对 DECIMAL 返回字符串，会破坏数值计算；
// phone 唯一性由应用层判重（MySQL 不支持 WHERE deleted=0 的部分唯一索引）
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_cut_orders (
    id VARCHAR(64) PRIMARY KEY,
    style_id VARCHAR(64) NOT NULL,
    bed_no INT NOT NULL,
    doc_no VARCHAR(64),
    customer VARCHAR(255),
    cut_date VARCHAR(16) NOT NULL,
    ship_date VARCHAR(16),
    order_no VARCHAR(64),
    bed_note VARCHAR(500),
    ticket_note VARCHAR(500),
    company_name VARCHAR(255),
    colors MEDIUMTEXT,
    sizes MEDIUMTEXT,
    total_bundles INT NOT NULL DEFAULT 0,
    total_qty DOUBLE NOT NULL DEFAULT 0,
    source VARCHAR(16) NOT NULL DEFAULT 'self',
    created_by VARCHAR(64),
    created_at BIGINT NOT NULL,
    deleted TINYINT NOT NULL DEFAULT 0,
    KEY idx_jjco_style (style_id),
    KEY idx_jjco_date (cut_date),
    KEY idx_jjco_deleted (deleted, cut_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_cut_bundles (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    style_id VARCHAR(64) NOT NULL,
    bundle_no INT NOT NULL,
    ticket_no BIGINT NOT NULL,
    color VARCHAR(64),
    size VARCHAR(32),
    qty DOUBLE NOT NULL,
    vat_no VARCHAR(64),
    note VARCHAR(255),
    created_at BIGINT NOT NULL,
    UNIQUE KEY uq_jjcb_ticket (ticket_no),
    UNIQUE KEY uq_jjcb_order_bundle (order_id, bundle_no),
    KEY idx_jjcb_order (order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_cut_order_processes (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    seq INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    price_mode VARCHAR(16) NOT NULL DEFAULT 'default',
    unit_price DOUBLE NOT NULL DEFAULT 0,
    prices MEDIUMTEXT,
    show_price TINYINT NOT NULL DEFAULT 1,
    visible_roles MEDIUMTEXT,
    daily_quota DOUBLE,
    style_process_id VARCHAR(64),
    created_at BIGINT NOT NULL,
    KEY idx_jjcop_order (order_id, seq)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_process_templates (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    items MEDIUMTEXT NOT NULL,
    created_by VARCHAR(64),
    created_at BIGINT NOT NULL,
    deleted TINYINT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS jj_push_subscriptions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    endpoint VARCHAR(512) NOT NULL,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    ua VARCHAR(200),
    fail_count INT NOT NULL DEFAULT 0,
    last_ok_at BIGINT,
    created_at BIGINT NOT NULL,
    UNIQUE KEY uq_jjps_endpoint (endpoint(191)),
    KEY idx_jjps_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

// 内置引导管理员：无 env 覆盖时始终确保这些人是管理员（缺则建、有则提升），幂等
const BOOTSTRAP_ADMINS = [
  { phone: "15522417606", name: "吴佳霖" },
  { phone: "13920822110", name: "周彦民" },
  { phone: "13034394098", name: "张立娓" }
];
// 种子/导入账号的初始密码（手机号+密码登录，随机密码就登不进去了）；员工可由管理员按需重置
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || "123456";
const nameByPhone = Object.fromEntries(BOOTSTRAP_ADMINS.map((a) => [a.phone, a.name]));

// 一次性导入 daka 在职员工+岗位（server/daka_seed.json）。幂等：按手机号判重，已存在的跳过；
// 测试环境（NODE_ENV=test）不导入
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

// 早期账号密码是随机生成、登不进去的补救：带 SEED_RESET_PASSWORDS=1 启动一次，
// 把所有在职账号密码重置成初始密码（平时不要开着）
async function resetAllPasswords() {
  if (process.env.SEED_RESET_PASSWORDS !== "1") return;
  const [r] = await pool.query("UPDATE users SET password_hash = ? WHERE deleted = 0", [bcrypt.hashSync(DEFAULT_PASSWORD, 10)]);
  console.log(`[seed] ⚠ 已把 ${r.affectedRows} 个在职账号的密码重置为初始密码 ${DEFAULT_PASSWORD}（SEED_RESET_PASSWORDS=1）`);
}

// 岗位兜底：还没设置过 roles 时写入默认岗位（生产环境由 daka 导入填过，测试环境靠这里）。
// admin/worker 两个键有特殊含义（admin=超级权限，worker=默认新员工岗位），只改显示名
const JJ_ROLES = [
  { k: "admin", label: "工厂管理员" },
  { k: "branch_lead", label: "分厂主管" },
  { k: "worker", label: "计件工" },
  { k: "temp", label: "临时工" }
];

async function seedRoles() {
  const existing = await getSetting("roles", null);
  if (existing === null || (Array.isArray(existing) && existing.length === 0)) {
    await setSetting("roles", JJ_ROLES);
    console.log("[seed] 已写入默认岗位：" + JJ_ROLES.map((r) => r.label).join("、"));
  }
}

// 启动初始化：建库 → 建表 → 导入 daka → 种子管理员 → 岗位兜底。index.js 在 listen 前 await 调用。
async function init() {
  // 1. 确保目标库存在（连接时不指定 database）
  const conn = await mysql.createConnection(Object.assign({
    user: CONF.user, password: CONF.password
  }, netOrSocket));
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
  // 2d. 迁移：jj_notifications 增加结构化字段(谁/改了哪个对象/具体改了什么)，供前端做更精致的
  // 通知卡片展示；老通知这几列会是 NULL，前端会退回纯文本 text 展示
  const [actorCol] = await pool.query(
    "SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='jj_notifications' AND COLUMN_NAME='actor_name'",
    [CONF.database]
  );
  if (!actorCol[0]) {
    await pool.query("ALTER TABLE jj_notifications ADD COLUMN actor_name VARCHAR(64)");
    await pool.query("ALTER TABLE jj_notifications ADD COLUMN target_label VARCHAR(128)");
    await pool.query("ALTER TABLE jj_notifications ADD COLUMN what VARCHAR(500)");
    console.log("[migrate] jj_notifications 增加 actor_name/target_label/what 列");
  }
  // 2e~2i：裁床编菲子系统需要的新列。全部"查 information_schema → 不存在才 ALTER"，可反复启动。
  const hasCol = async (table, col) => {
    const [r] = await pool.query(
      "SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?",
      [CONF.database, table, col]);
    return !!r[0];
  };
  const addCol = async (table, col, ddl) => {
    if (await hasCol(table, col)) return;
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[migrate] ${table} 增加 ${col} 列`);
  };

  // 2e. 款式：是否裁床 + 款式备注
  await addCol("jj_styles", "has_cutting", "has_cutting TINYINT NOT NULL DEFAULT 1");
  await addCol("jj_styles", "note", "note VARCHAR(500)");

  // 2f. 款式工序：工序名可自由输入（不再强依赖工序模板）+ 三种价格模式 + 显示价格/可见岗位
  await addCol("jj_style_processes", "name", "name VARCHAR(255)");
  await addCol("jj_style_processes", "price_mode", "price_mode VARCHAR(16) NOT NULL DEFAULT 'default'");
  await addCol("jj_style_processes", "prices", "prices MEDIUMTEXT");
  await addCol("jj_style_processes", "show_price", "show_price TINYINT NOT NULL DEFAULT 1");
  await addCol("jj_style_processes", "visible_roles", "visible_roles MEDIUMTEXT");

  // 2g. process_id 放开为可空：自由输入的工序没有对应的工序模板行
  const [spPid] = await pool.query(
    "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='jj_style_processes' AND COLUMN_NAME='process_id'",
    [CONF.database]);
  if (spPid[0] && spPid[0].IS_NULLABLE === "NO") {
    await pool.query("ALTER TABLE jj_style_processes MODIFY process_id VARCHAR(64) NULL");
    console.log("[migrate] jj_style_processes.process_id → 可空");
  }
  // 老行没有 name，从工序模板回填一次，否则新界面上工序名是空白
  await pool.query(`UPDATE jj_style_processes sp JOIN jj_processes p ON p.id = sp.process_id
    SET sp.name = p.name WHERE sp.name IS NULL OR sp.name = ''`);

  // 2h. 打点记录挂到扎+工序上，并存下当时的单价快照（以后改工价不会追溯已发工资）
  await addCol("jj_scan_records", "order_id", "order_id VARCHAR(64)");
  await addCol("jj_scan_records", "bundle_id", "bundle_id VARCHAR(64)");
  await addCol("jj_scan_records", "order_process_id", "order_process_id VARCHAR(64)");
  await addCol("jj_scan_records", "unit_price", "unit_price DOUBLE");

  // 2j. 工序的日定额（一个工人一天做得完多少件）：排产和算效率要用，
  // 款式工序和裁床单的工序快照都要有，快照才能反映"下单那一刻的定额"
  await addCol("jj_style_processes", "daily_quota", "daily_quota DOUBLE");
  await addCol("jj_cut_order_processes", "daily_quota", "daily_quota DOUBLE");

  const addIdx = async (table, name, cols) => {
    const [r] = await pool.query(
      "SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=?",
      [CONF.database, table, name]);
    if (r[0]) return;
    await pool.query(`ALTER TABLE ${table} ADD INDEX ${name} (${cols})`);
    console.log(`[migrate] ${table} 增加 ${name} 索引`);
  };
  // 2i. 索引：进度按 (扎, 工序) 聚合；效率/薪资汇总按月份扫全员
  await addIdx("jj_scan_records", "idx_jjscan_bundle", "bundle_id, order_process_id");
  await addIdx("jj_scan_records", "idx_jjscan_date_user", "date, user_id");
  await addIdx("jj_attendance", "idx_jjatt_date_user", "date, user_id");

  // 2l. 款式缩略图 + 图片张数：列表只读这两列，原图（base64 一张几百 KB）只在编辑/看大图时取
  await addCol("jj_styles", "thumb", "thumb MEDIUMTEXT");
  if (!(await hasCol("jj_styles", "image_count"))) {
    await addCol("jj_styles", "image_count", "image_count INT NOT NULL DEFAULT 0");
    await pool.query(`UPDATE jj_styles SET image_count = CASE
      WHEN images IS NOT NULL AND JSON_VALID(images) THEN (CASE WHEN JSON_LENGTH(images) > 0 THEN JSON_LENGTH(images) ELSE image IS NOT NULL AND image <> '' END)
      ELSE image IS NOT NULL AND image <> '' END`);
  }

  // 预种菲票号起始值：nextTicketRange 用 FOR UPDATE 锁这行取号，锁不了不存在的行；
  // 用 INSERT IGNORE（不是 ON DUPLICATE KEY UPDATE）避免重启时把计数器冲回 36000
  await pool.query(
    "INSERT IGNORE INTO settings(`key`,value) VALUES(?,?)",
    ["jj_ticket_seq", JSON.stringify(36000)]
  );

  // 3. 一次性导入 daka 员工（仅生产）
  if (process.env.NODE_ENV !== "test") await importDakaSeed();
  // 4. 种子管理员
  await seedAdmins();
  // 5. 岗位兜底
  await seedRoles();
  // 5b. 岗位列表换成本系统的四个；只换列表，不动任何人已有的 users.role（判据：有没有 branch_lead）
  const curRoles = await getSetting("roles", []);
  if (!Array.isArray(curRoles) || !curRoles.some((r) => r && r.k === "branch_lead")) {
    await setSetting("roles", JJ_ROLES);
    console.log("[migrate] 岗位列表已换成：" + JJ_ROLES.map((r) => r.label).join("、"));
  }
  // 6. 可选：一次性把老账号的随机密码重置成初始密码
  await resetAllPasswords();
  const connDesc = CONF.socketPath ? `socket:${CONF.socketPath}` : `${CONF.host}:${CONF.port}`;
  console.log(`[db] MySQL 就绪：${CONF.user}@${connDesc}/${CONF.database}`);
}

module.exports = { db, pool, uid, getSetting, setSetting, DATA_DIR, UPLOAD_DIR, init };
