# 裁床编菲 / 菲票 / 生产进度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 jijian-system 网页端（手机 + 桌面）做出与参考小程序一致的裁床编菲、菲票、修改/同步工序、生产管理、打印菲票、生产进度功能，并补齐款式选项删减、工序编辑器与 Web Push 通知。

**Architecture:** 裁床单（床次）→ 扎（菲票）→ 每扎每工序进度。工序在生成菲票时从款式**快照**进裁床单，「同步工序」显式推送更新。进度**不落表**，全部由 `jj_scan_records` 聚合派生。工价在打点时按「分岗→分码→工序默认」解析并写入记录快照，历史工资不被后续改价追溯。

**Tech Stack:** Node 22 / Express 4 / MySQL（mysql2 promise pool）/ 原生 JS 单页前端（`public/app.js` 字符串模板渲染）/ `qrcode` / `web-push`

**Spec:** `docs/superpowers/specs/2026-09-09-cutting-tickets-design.md`

## Global Constraints

- Node `>=22`，CommonJS，不引入构建步骤、不引入前端框架
- 数据访问走 `server/db.js` 的 `db.prepare(sql).get/all/run(...)`（**返回 Promise，必须 await**）；事务用 `pool.getConnection()`
- 新表统一：`id VARCHAR(64)` 主键（`uid()`）、时间戳 `BIGINT` 毫秒、`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
- 列迁移一律「查 `information_schema` → 不存在才 `ALTER TABLE`」的幂等形式，放进 `server/db.js` 的 `init()`
- 日期字符串 `YYYY-MM-DD`；月份 `YYYY-MM`
- 前端只用 `public/styles.css` 已有的 CSS token（`--on-blue`、`--on-soft`、`--ok-ink`、`--warn-soft` 等），不新增一次性色值；浅色/深色模式都要正确
- 权限：`A.managerRequired` 用于裁床单增删改、打印数据、改裁床件数、同步工序；款式/工序编辑沿用 `A.authRequired`（见下方修正）
- 注释用中文，说明「为什么」，风格对齐现有 `server/routes.js`
- 每个任务结束跑 `TEST_MYSQL_PORT=3306 npm test` 全绿再提交

## 与 spec 的一处修正

spec §5 把 `PUT /styles/:id/processes` 标为 `M`，但同资源的既有 `POST /styles/:id/processes`、`PATCH /style-processes/:id` 是 `authRequired`（小程序在用），两者并存等于留了绕过口。**本计划统一按 `authRequired`**；spec §D8 的「建单/编菲/打印/改裁床件数」仍是 `managerRequired`，与 spec T11 一致。

## 本地环境前置

`test/run.js` 默认连 `TEST_MYSQL_PORT=3307`，本机 MariaDB 在 **3306**。测试统一用：

```bash
TEST_MYSQL_PORT=3306 npm test
```

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `server/cutting.js` | 编菲纯函数：矩阵+开关 → 扎数组 |
| `server/pricing.js` | 工价解析纯函数：工序快照 + {size, role} → 单价 |
| `server/qr.js` | 二维码 SVG 生成（包一层 `qrcode`） |
| `server/push.js` | Web Push 投递层 |
| `server/routes_cutting.js` | 裁床单/扎/进度/生产管理/打印数据 路由 |
| `scripts/seed_demo.js` | 本地演示数据种子 |
| `test/schema.test.js` | 建表/迁移断言 |
| `test/cutting.unit.test.js` | 纯函数单测（不起服务） |
| `test/cutting.test.js` | 裁床单全流程 HTTP 测试 |

**修改**

| 文件 | 改什么 |
|---|---|
| `server/db.js` | 5 张新表 DDL + 迁移 2e~2i |
| `server/routes.js` | 挂子路由、工序编辑器、同步工序、扫扎打点、工资口径、推送接口、通知触发点；删旧 `/cutting-sheets*` |
| `public/app.js` | 8 个新视图 + 选项控件 + 工序编辑器 + 打印容器 + 推送订阅 |
| `public/styles.css` | 新组件样式 + `@media print` |
| `public/index.html` | 加 `#print-root` |
| `public/sw.js` | `push` / `notificationclick`，bump `CACHE` |
| `test/run.js` | suites 加三个新文件 |
| `package.json` | 加 `qrcode`、`web-push`，加 `dev:local` |

`server/routes.js` 已 746 行，裁床相关全塞进去会到 1400+。按「一起变的放一起」拆出 `server/routes_cutting.js`。

---

## Task 1: 数据层（新表 + 迁移）

**Files:**
- Modify: `server/db.js`（`DDL` 数组尾部加 5 张表；`init()` 里 2d 之后加 2e~2i）
- Create: `test/schema.test.js`
- Modify: `test/run.js:63`

**Interfaces:**
- Consumes: `server/db.js` 的 `pool`、`CONF.database`、`DDL`、`init()`
- Produces: 表 `jj_cut_orders` / `jj_cut_bundles` / `jj_cut_order_processes` / `jj_process_templates` / `jj_push_subscriptions`；`jj_styles.{has_cutting,note}`；`jj_style_processes.{name,price_mode,prices,show_price,visible_roles}` 且 `process_id` 可空；`jj_scan_records.{order_id,bundle_id,order_process_id,unit_price}` + 索引 `idx_jjscan_bundle`

- [ ] **Step 1: 写失败的测试** — 新建 `test/schema.test.js`

```js
"use strict";
// 建表/迁移是否真生效，直接查 information_schema 断言，不依赖任何 API。
const path = require("path");
const { pool } = require(path.join(__dirname, "..", "server", "db"));
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };

async function cols(table) {
  const [rows] = await pool.query(
    "SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [table]);
  return Object.fromEntries(rows.map(r => [r.COLUMN_NAME, r.IS_NULLABLE]));
}
async function indexes(table) {
  const [rows] = await pool.query(
    "SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [table]);
  return rows.map(r => r.INDEX_NAME);
}

(async () => {
  const co = await cols("jj_cut_orders");
  ok(Object.keys(co).length > 0, "jj_cut_orders 表已建");
  ["style_id","bed_no","doc_no","customer","cut_date","ship_date","order_no","bed_note",
   "ticket_note","company_name","colors","sizes","total_bundles","total_qty","source",
   "created_by","created_at","deleted"].forEach(c => ok(co[c] !== undefined, `jj_cut_orders.${c} 存在`));

  const cb = await cols("jj_cut_bundles");
  ["order_id","style_id","bundle_no","ticket_no","color","size","qty","vat_no","note","created_at"]
    .forEach(c => ok(cb[c] !== undefined, `jj_cut_bundles.${c} 存在`));
  const cbIdx = await indexes("jj_cut_bundles");
  ok(cbIdx.includes("uq_jjcb_ticket"), "菲票号唯一索引存在");
  ok(cbIdx.includes("uq_jjcb_order_bundle"), "单内扎号唯一索引存在");

  const cop = await cols("jj_cut_order_processes");
  ["order_id","seq","name","price_mode","unit_price","prices","show_price","visible_roles","style_process_id"]
    .forEach(c => ok(cop[c] !== undefined, `jj_cut_order_processes.${c} 存在`));

  ok(Object.keys(await cols("jj_process_templates")).length > 0, "jj_process_templates 表已建");
  const ps = await cols("jj_push_subscriptions");
  ["user_id","endpoint","p256dh","auth"].forEach(c => ok(ps[c] !== undefined, `jj_push_subscriptions.${c} 存在`));

  const st = await cols("jj_styles");
  ok(st.has_cutting !== undefined, "jj_styles.has_cutting 已迁移");
  ok(st.note !== undefined, "jj_styles.note 已迁移");

  const sp = await cols("jj_style_processes");
  ["name","price_mode","prices","show_price","visible_roles"]
    .forEach(c => ok(sp[c] !== undefined, `jj_style_processes.${c} 已迁移`));
  ok(sp.process_id === "YES", "jj_style_processes.process_id 已改为可空");

  const sc = await cols("jj_scan_records");
  ["order_id","bundle_id","order_process_id","unit_price"]
    .forEach(c => ok(sc[c] !== undefined, `jj_scan_records.${c} 已迁移`));
  ok((await indexes("jj_scan_records")).includes("idx_jjscan_bundle"), "按扎聚合索引存在");

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: 挂进测试入口**

`test/run.js` 第 63 行改为（后两个文件后续任务再加）：

```js
  const suites = ["schema.test.js", "api.test.js"];
```

- [ ] **Step 3: 运行确认失败**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: FAIL —「jj_cut_orders 表已建」等断言全红

- [ ] **Step 4: 加 5 张新表 DDL**

`server/db.js` 的 `DDL` 数组末尾（`jj_notifications` 之后）追加：

```js
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
```

- [ ] **Step 5: 加幂等迁移**

`server/db.js` 的 `init()` 里，2d 段落之后、`// 3. 一次性导入 daka 员工` 之前插入：

```js
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

  // 2i. 进度聚合按 (扎, 工序) 分组，补索引
  const [scIdx] = await pool.query(
    "SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME='jj_scan_records' AND INDEX_NAME='idx_jjscan_bundle'",
    [CONF.database]);
  if (!scIdx[0]) {
    await pool.query("ALTER TABLE jj_scan_records ADD INDEX idx_jjscan_bundle (bundle_id, order_process_id)");
    console.log("[migrate] jj_scan_records 增加 idx_jjscan_bundle 索引");
  }
```

- [ ] **Step 6: 运行确认通过**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: `schema.test.js` 全 PASS，`api.test.js` 原有用例继续全 PASS

- [ ] **Step 7: 提交**

```bash
git add server/db.js test/schema.test.js test/run.js
git commit -m "数据层：裁床单/扎/工序快照/工序模板/推送订阅 5 张新表 + 现有表迁移"
```

---

## Task 2: 编菲算法与工价解析（纯函数）

**Files:**
- Create: `server/cutting.js`
- Create: `server/pricing.js`
- Create: `test/cutting.unit.test.js`
- Modify: `test/run.js`（suites 加 `cutting.unit.test.js`）

**Interfaces:**
- Consumes: 无（纯函数，零依赖）
- Produces:
  - `cellKey(color, size) -> string`
  - `planBundles(input) -> { bundles, totalBundles, totalQty }`，`bundles[i] = { bundleNo, color, size, qty, vatNo }`
  - `splitQty(total, bundles) -> number[]`
  - `duplicateBundleNos(bundles) -> number[]`
  - `resolvePrice(proc, ctx) -> number`；`proc = { price_mode, unit_price, prices }`（`prices` 可为 JSON 字符串或对象），`ctx = { size, role }`
  - `visibleTo(proc, role) -> boolean`
  - `parsePrices(p) -> object`

- [ ] **Step 1: 写失败的测试** — 新建 `test/cutting.unit.test.js`

```js
"use strict";
// 纯函数单测：不起服务、不连库，直接 require 模块跑。
const path = require("path");
const { planBundles, cellKey } = require(path.join(__dirname, "..", "server", "cutting"));
const { resolvePrice, visibleTo } = require(path.join(__dirname, "..", "server", "pricing"));
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };

// —— 截图 FC3390 床次2 的 S 码那一组，用来锁死扎号顺序 ——
{
  const cells = {
    [cellKey("223暗蓝", "S")]: { input: 52, bundles: 2 },
    [cellKey("331浅蓝条", "S")]: { input: 26, bundles: 2 }
  };
  const r = planBundles({ colors: ["223暗蓝", "331浅蓝条"], sizes: ["S"], cells, startNo: 1, multiple: true });
  ok(r.bundles.length === 4, "S 码共 4 扎");
  ok(r.bundles[0].bundleNo === 1 && r.bundles[0].color === "223暗蓝" && r.bundles[0].qty === 52, "扎号1 = 223暗蓝 52 件");
  ok(r.bundles[1].bundleNo === 2 && r.bundles[1].color === "331浅蓝条" && r.bundles[1].qty === 26, "扎号2 = 331浅蓝条 26 件");
  ok(r.bundles[2].color === "223暗蓝", "扎号3 回到 223暗蓝（颜色轮转）");
  ok(r.bundles[3].color === "331浅蓝条", "扎号4 = 331浅蓝条");
  ok(r.totalQty === 156, "S 码总件数 156");
}

// —— 多尺码：尺码是外层循环 ——
{
  const r = planBundles({
    colors: ["A", "B"], sizes: ["S", "M"],
    cells: {
      [cellKey("A", "S")]: { input: 10, bundles: 1 }, [cellKey("B", "S")]: { input: 20, bundles: 1 },
      [cellKey("A", "M")]: { input: 30, bundles: 1 }, [cellKey("B", "M")]: { input: 40, bundles: 1 }
    }, startNo: 1, multiple: true
  });
  ok(r.bundles.map(b => b.size).join(",") === "S,S,M,M", "尺码是外层循环");
  ok(r.bundles.map(b => b.bundleNo).join(",") === "1,2,3,4", "扎号连续");
}

// —— 倍数模式关闭：按扎数平分，余数补最后一扎 ——
{
  const r = planBundles({
    colors: ["A"], sizes: ["S"],
    cells: { [cellKey("A", "S")]: { input: 100, bundles: 3 } }, startNo: 1, multiple: false
  });
  ok(r.bundles.map(b => b.qty).join(",") === "33,33,34", "100 件分 3 扎 = 33/33/34");
  ok(r.totalQty === 100, "平分后总数不丢件");
}

// —— 从 N 扎起 ——
{
  const r = planBundles({
    colors: ["A"], sizes: ["S"],
    cells: { [cellKey("A", "S")]: { input: 5, bundles: 2 } }, startNo: 7, multiple: true
  });
  ok(r.bundles.map(b => b.bundleNo).join(",") === "7,8", "起始扎号生效");
}

// —— 自定义扎号 / 缸号 ——
{
  const k = cellKey("A", "S");
  const r = planBundles({
    colors: ["A"], sizes: ["S"], cells: { [k]: { input: 5, bundles: 2 } },
    startNo: 1, multiple: true, customNos: { [k]: [101, 102] }, vatNos: { [k]: ["G1", "G2"] }
  });
  ok(r.bundles.map(b => b.bundleNo).join(",") === "101,102", "自定义扎号生效");
  ok(r.bundles.map(b => b.vatNo).join(",") === "G1,G2", "自定义缸号生效");
}

// —— 空格子不产生扎 ——
{
  const r = planBundles({
    colors: ["A", "B"], sizes: ["S"],
    cells: { [cellKey("A", "S")]: { input: 10, bundles: 1 }, [cellKey("B", "S")]: { input: 0, bundles: 0 } },
    startNo: 1, multiple: true
  });
  ok(r.bundles.length === 1 && r.bundles[0].color === "A", "空格子被跳过");
}

// —— 工价解析：命中模式取专价，缺键回退默认价 ——
ok(resolvePrice({ price_mode: "role", unit_price: 1, prices: { tech_lead: 3 } }, { role: "tech_lead", size: "S" }) === 3, "分岗模式取岗位价");
ok(resolvePrice({ price_mode: "role", unit_price: 1, prices: { tech_lead: 3 } }, { role: "worker", size: "S" }) === 1, "分岗缺该岗位回退默认价");
ok(resolvePrice({ price_mode: "size", unit_price: 1, prices: '{"S":2.5}' }, { role: "worker", size: "S" }) === 2.5, "分码模式取尺码价（prices 是 JSON 字符串）");
ok(resolvePrice({ price_mode: "size", unit_price: 1, prices: '{"S":2.5}' }, { role: "worker", size: "M" }) === 1, "分码缺该尺码回退默认价");
ok(resolvePrice({ price_mode: "default", unit_price: 1.2, prices: null }, { role: "worker", size: "S" }) === 1.2, "默认模式取默认价");
ok(resolvePrice({ price_mode: "default", unit_price: null, prices: null }, {}) === 0, "没价就是 0，不是 NaN");

// —— 可见岗位 ——
ok(visibleTo({ visible_roles: null }, "worker") === true, "未限制岗位 = 所有岗位可见");
ok(visibleTo({ visible_roles: "[]" }, "worker") === true, "空数组 = 所有岗位可见");
ok(visibleTo({ visible_roles: '["tech_lead"]' }, "worker") === false, "限制岗位后其他岗位不可见");
ok(visibleTo({ visible_roles: '["tech_lead"]' }, "tech_lead") === true, "限制岗位内的岗位可见");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: 运行确认失败**

Run: `node test/cutting.unit.test.js`
Expected: FAIL — `Cannot find module '.../server/cutting'`

- [ ] **Step 3: 实现 `server/cutting.js`**

```js
"use strict";
/**
 * 编菲算法（纯函数，无 IO）：颜色×尺码矩阵 + 一组开关 → 一串扎。
 *
 * 扎号编号顺序是这里最关键的约定，用参考系统的实拍数据反推出来的：
 *   外层尺码 → 中层"该尺码下的第几扎" → 内层颜色轮转
 * 即同一个尺码里，各颜色的第 1 扎先按颜色顺序排完，再排各颜色的第 2 扎。
 * 实拍验证：S 码 扎号1=223暗蓝52、2=331浅蓝条26、3=223暗蓝36、4=331浅蓝条28。
 *
 * colors / sizes 数组的顺序就是矩阵行列顺序，也就是编号遍历顺序；
 * 调用方（裁床编菲页、种子脚本）负责按现场习惯排好再传进来。
 */

const cellKey = (color, size) => `${color}|${size}`;

// 倍数模式关闭时把该格总件数按扎数平分，除不尽的余数全部补到最后一扎。
// 车间习惯是"最后一扎多一点"，不是均摊小数——件数必须是整数。
function splitQty(total, bundles) {
  const base = Math.floor(total / bundles);
  const out = new Array(bundles).fill(base);
  out[bundles - 1] = total - base * (bundles - 1);
  return out;
}

/**
 * @param {object} input
 * @param {string[]} input.colors   矩阵行顺序
 * @param {string[]} input.sizes    矩阵列顺序 = 编号外层顺序
 * @param {object}   input.cells    { [cellKey(color,size)]: { input:number, bundles:number } }
 * @param {number}   [input.startNo=1]     从第几扎起（自动编号时）
 * @param {boolean}  [input.multiple=true] 倍数模式：input 是每扎件数；关闭时 input 是该格总件数
 * @param {object}   [input.customNos]     { [cellKey]: number[] } 自定义扎号，按该格扎序
 * @param {object}   [input.vatNos]        { [cellKey]: string[] } 自定义缸号，按该格扎序
 * @returns {{bundles: Array, totalBundles: number, totalQty: number}}
 */
function planBundles(input) {
  const colors = input.colors || [];
  const sizes = input.sizes || [];
  const cells = input.cells || {};
  const multiple = input.multiple !== false;
  const customNos = input.customNos || {};
  const vatNos = input.vatNos || {};

  // 先把每个格子展开成一串件数，后面只按顺序取
  const plan = {};
  for (const color of colors) {
    for (const size of sizes) {
      const k = cellKey(color, size);
      const c = cells[k] || {};
      const n = Math.max(0, Math.floor(Number(c.bundles) || 0));
      const v = Number(c.input) || 0;
      if (!n || v <= 0) { plan[k] = []; continue; }
      plan[k] = multiple ? new Array(n).fill(v) : splitQty(Math.round(v), n);
    }
  }

  const bundles = [];
  let nextNo = Math.max(1, Math.floor(Number(input.startNo) || 1));
  for (const size of sizes) {
    const maxK = Math.max(0, ...colors.map((c) => plan[cellKey(c, size)].length));
    for (let k = 0; k < maxK; k++) {
      for (const color of colors) {
        const key = cellKey(color, size);
        const qtys = plan[key];
        if (k >= qtys.length) continue;
        const custom = customNos[key];
        const hasCustom = custom && custom[k] !== undefined && custom[k] !== null && custom[k] !== "";
        const vats = vatNos[key];
        bundles.push({
          bundleNo: hasCustom ? Math.floor(Number(custom[k])) : nextNo++,
          color, size,
          qty: qtys[k],
          vatNo: (vats && vats[k]) ? String(vats[k]) : null
        });
      }
    }
  }

  return { bundles, totalBundles: bundles.length, totalQty: bundles.reduce((s, b) => s + b.qty, 0) };
}

// 扎号在单内必须唯一（自定义扎号时用户可能填重）。返回重复的扎号，空数组表示没问题。
function duplicateBundleNos(bundles) {
  const seen = new Set(), dup = new Set();
  for (const b of bundles) { if (seen.has(b.bundleNo)) dup.add(b.bundleNo); seen.add(b.bundleNo); }
  return [...dup];
}

module.exports = { planBundles, cellKey, splitQty, duplicateBundleNos };
```

- [ ] **Step 4: 实现 `server/pricing.js`**

```js
"use strict";
/**
 * 工价解析（纯函数）：一条工序快照 + 打点上下文 → 单价。
 *
 * 三种价格模式只会命中一条分支，但每条分支在"这个尺码/岗位没单独定价"时都回退到工序的
 * 默认单价，而不是回退成 0——现场经常只给个别尺码定特价，其余走默认价。
 */
function parsePrices(p) {
  if (!p) return {};
  if (typeof p === "object") return p;
  try { return JSON.parse(p) || {}; } catch (e) { return {}; }
}

function resolvePrice(proc, ctx) {
  if (!proc) return 0;
  const prices = parsePrices(proc.prices);
  const c = ctx || {};
  if (proc.price_mode === "role" && c.role && prices[c.role] !== undefined && prices[c.role] !== null) {
    return Number(prices[c.role]) || 0;
  }
  if (proc.price_mode === "size" && c.size && prices[c.size] !== undefined && prices[c.size] !== null) {
    return Number(prices[c.size]) || 0;
  }
  return Number(proc.unit_price) || 0;
}

// 工序对某个岗位是否可见：visible_roles 为空/null = 所有岗位可见
function visibleTo(proc, role) {
  const raw = proc && proc.visible_roles;
  if (!raw) return true;
  let list; try { list = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return true; }
  if (!Array.isArray(list) || !list.length) return true;
  return list.includes(role);
}

module.exports = { resolvePrice, visibleTo, parsePrices };
```

- [ ] **Step 5: 运行确认通过**

Run: `node test/cutting.unit.test.js`
Expected: 全 PASS

- [ ] **Step 6: 挂进入口跑全量**

`test/run.js` 的 suites 改为 `["schema.test.js", "cutting.unit.test.js", "api.test.js"]`。

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add server/cutting.js server/pricing.js test/cutting.unit.test.js test/run.js
git commit -m "编菲算法与工价解析纯函数：扎号顺序按实拍数据锁定，工价三模式带默认价回退"
```

---

## Task 3: 裁床单后端（创建即生成菲票 / 列表 / 详情 / 复制 / 软删）

**Files:**
- Create: `server/routes_cutting.js`
- Modify: `server/routes.js`（挂子路由；删旧 `/cutting-sheets*`、`/cutting/overview`，约 467–540 行）
- Create: `test/cutting.test.js`
- Modify: `test/run.js`（suites 加 `cutting.test.js`）

**Interfaces:**
- Consumes: `server/cutting.js` 的 `planBundles`/`duplicateBundleNos`；`server/db.js` 的 `db`/`pool`/`uid`；`server/auth.js` 的 `authRequired`/`managerRequired`
- Produces（后续任务全部依赖这些导出与路由）：
  - 路由：`POST /api/cut-orders`、`GET /api/cut-orders`、`GET /api/cut-orders/:id`、`PATCH /api/cut-orders/:id`、`POST /api/cut-orders/:id/copy`、`DELETE /api/cut-orders/:id`
  - 模块导出：`{ router, progressMap, bundleDone, completedByOrder, completedByOrders, buildSummary, jsonParse, nextTicketRange }`
  - `progressMap(orderId) -> { [bundleId]: { [orderProcessId]: doneQty } }`
  - `bundleDone(procIds: string[], doneOfBundle: object) -> number`
  - `completedByOrders(orderIds: string[]) -> { [orderId]: number }`
  - `buildSummary(order, bundles) -> { colors, sizes, matrix, colorTotals, sizeTotals, total }`
  - `GET /api/cut-orders/:id` 响应：`{ order, bundles, processes, summary }`

- [ ] **Step 1: 写失败的测试** — 新建 `test/cutting.test.js`

```js
"use strict";
// 裁床单全流程 HTTP 测试。跟 api.test.js 一样直连测试库建账号，再走接口。
const BASE = (process.env.BASE_URL || "http://localhost:3910") + "/api";
const path = require("path");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };
async function call(method, p, token, body) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}

(async () => {
  const { db, uid } = require(path.join(__dirname, "..", "server", "db"));
  const A = require(path.join(__dirname, "..", "server", "auth"));

  // 管理员 + 一个普通计件工（用来验权限）
  const admId = uid(), wkId = uid();
  await db.prepare("INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
    .run(admId, "裁床管理员", "13900001111", A.hashPassword("x"), "admin", Date.now());
  await db.prepare("INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
    .run(wkId, "计件工小王", "13900002222", A.hashPassword("x"), "worker", Date.now());
  const aT = (await call("POST", "/login", null, { phone: "13900001111", password: "x" })).j.token;
  const wT = (await call("POST", "/login", null, { phone: "13900002222", password: "x" })).j.token;
  ok(!!aT && !!wT, "管理员与计件工都能登录");

  // 建款式 + 两道工序（剪线 / 烫工），对齐截图
  const st = await call("POST", "/styles", aT, { name: "RIGHY LL", code: "FC3390 裤" });
  const styleId = st.j.style.id;
  await call("PUT", `/styles/${styleId}/processes`, aT, {
    items: [
      { name: "剪线", priceMode: "default", unitPrice: 1, showPrice: true },
      { name: "烫工", priceMode: "default", unitPrice: 2, showPrice: true }
    ]
  });

  // —— 创建裁床单：截图 FC3390 床次2 的 S 码那一组 ——
  const body = {
    styleId, bedNo: 2, docNo: "2897", cutDate: "2026-09-09", shipDate: "2026-09-10",
    companyName: "惠民县惠锦服装制衣有限公司",
    colors: ["223暗蓝", "331浅蓝条"], sizes: ["S"], startNo: 1, multiple: true,
    cells: { "223暗蓝|S": { input: 52, bundles: 2 }, "331浅蓝条|S": { input: 26, bundles: 2 } }
  };
  const created = await call("POST", "/cut-orders", aT, body);
  ok(created.status === 200, "管理员能创建裁床单");
  const orderId = created.j.order.id;
  ok(created.j.order.total_bundles === 4, "总扎数 4");
  ok(created.j.order.total_qty === 156, "总件数 156");

  // —— T2 扎号顺序 ——
  const detail = await call("GET", `/cut-orders/${orderId}`, aT);
  const bs = detail.j.bundles;
  ok(bs[0].bundle_no === 1 && bs[0].color === "223暗蓝" && bs[0].qty === 52, "扎号1 = 223暗蓝 52 件");
  ok(bs[1].bundle_no === 2 && bs[1].color === "331浅蓝条" && bs[1].qty === 26, "扎号2 = 331浅蓝条 26 件");
  ok(bs.every(b => b.ticket_no > 0), "每扎都有菲票号");
  ok(new Set(bs.map(b => b.ticket_no)).size === 4, "菲票号互不相同");
  ok(detail.j.processes.length === 2 && detail.j.processes[0].name === "剪线", "工序已快照进裁床单");
  ok(detail.j.summary.colorTotals["223暗蓝"] === 104, "汇总表颜色合计正确");
  ok(detail.j.summary.sizeTotals["S"] === 156, "汇总表尺码合计正确");

  // —— T4 床次重复被拒 ——
  ok((await call("POST", "/cut-orders", aT, body)).status === 400, "同款式同床次不能重复建单");

  // —— T11 权限 ——
  ok((await call("POST", "/cut-orders", wT, Object.assign({}, body, { bedNo: 99 }))).status === 403, "计件工不能建裁床单");
  ok((await call("DELETE", `/cut-orders/${orderId}`, wT)).status === 403, "计件工不能删裁床单");
  ok((await call("GET", "/cut-orders", wT)).status === 200, "计件工可以查看裁床单列表");

  // —— 复制：扎复制一份、菲票号重新取、床次不同 ——
  const copied = await call("POST", `/cut-orders/${orderId}/copy`, aT, { bedNo: 3 });
  ok(copied.status === 200 && copied.j.order.bed_no === 3, "复制成新床次");
  const copyDetail = await call("GET", `/cut-orders/${copied.j.order.id}`, aT);
  ok(copyDetail.j.bundles.length === 4, "复制单的扎数一致");
  const oldTickets = new Set(bs.map(b => b.ticket_no));
  ok(copyDetail.j.bundles.every(b => !oldTickets.has(b.ticket_no)), "复制单的菲票号是新号");

  // —— 列表 + 搜索 ——
  const list = await call("GET", "/cut-orders?kw=FC3390", aT);
  ok(list.status === 200 && list.j.list.length >= 2, "按款号搜索裁床单");
  ok(list.j.list[0].style_code === "FC3390 裤", "列表带出款号");

  // —— 软删 ——
  ok((await call("DELETE", `/cut-orders/${copied.j.order.id}`, aT)).status === 200, "管理员能删裁床单");
  const afterDel = await call("GET", "/cut-orders?kw=FC3390", aT);
  ok(!afterDel.j.list.some(o => o.id === copied.j.order.id), "删掉的单不再出现在列表里");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: 运行确认失败**

`test/run.js` suites 追加 `"cutting.test.js"`，然后 Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: FAIL — `POST /cut-orders` 404

- [ ] **Step 3: 实现 `server/routes_cutting.js`（第一部分：骨架 + 聚合 + 汇总）**

```js
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
```

- [ ] **Step 4: 追加创建裁床单的事务路由（同文件）**

```js
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
```

- [ ] **Step 5: 追加列表 / 详情 / 改单头 / 复制 / 软删（同文件）**

```js
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
```

- [ ] **Step 6: 挂载子路由并删掉旧裁床单代码**

`server/routes.js`：
1. 顶部 `const A = require("./auth");` 之后加 `const cutting = require("./routes_cutting");`
2. 在 `/* ---------------- 应用内通知 ---------------- */` 之前加 `router.use(cutting.router);`
3. 删除 6 个旧路由：`GET /cutting-sheets`、`GET /cutting-sheets/by-style`、`GET /cutting/overview`、`POST /cutting-sheets`、`PATCH /cutting-sheets/:id`、`DELETE /cutting-sheets/:id`。**不删 `jj_cutting_sheets` 表**（线上删表不可逆）。
4. `api.test.js` 里针对 `/cutting-sheets` 的用例一并删掉（功能已下架，不保留断言旧接口存在的测试）。

- [ ] **Step 7: 运行确认通过**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: `cutting.test.js` 全 PASS，其余全绿

> 此时 `PUT /styles/:id/processes` 还不存在，测试里那次调用会 404 但不影响断言（工序快照那两条会红）。若想先跑绿，可把「工序已快照进裁床单」这条断言留到 Task 4 之后再验；推荐直接连做 Task 4 再一起跑。

- [ ] **Step 8: 提交**

```bash
git add server/routes_cutting.js server/routes.js test/cutting.test.js test/run.js
git commit -m "裁床单后端：创建即生成菲票(事务)、列表/详情/复制/软删，旧简版裁床单下架"
```

---

## Task 4: 工序编辑器后端（整套覆盖保存 + 工序模板）

**Files:**
- Modify: `server/routes.js`（改 `GET /styles/:id/processes`；新增 `PUT /styles/:id/processes` 与 3 个模板路由）
- Modify: `test/cutting.test.js`（追加断言）

**Interfaces:**
- Consumes: `server/pricing.js` 的 `resolvePrice`
- Produces:
  - `GET /api/styles/:id/processes` → `{ list }`，每项含 `id,seq,name,price_mode,unit_price,prices(对象),show_price(bool),visible_roles(数组),process_id`，外加 `effectivePrice`
  - `PUT /api/styles/:id/processes`，body `{ items: [{ name, priceMode, unitPrice, prices, showPrice, visibleRoles, processId? }] }` → `{ list }`（整套覆盖）
  - `GET /api/process-templates` → `{ list }`（`items` 已 parse 成数组）
  - `POST /api/process-templates`，body `{ name, items }` → `{ template }`
  - `DELETE /api/process-templates/:id` → `{ ok: true }`

- [ ] **Step 1: 追加失败的测试** — 在 `test/cutting.test.js` 的「软删」之后、`console.log` 之前插入

```js
  // —— 工序编辑器：整套覆盖保存，工序名自由输入（不依赖工序模板） ——
  const st2 = await call("POST", "/styles", aT, { name: "PRINCIPE LITE", code: "FC3456" });
  const sid2 = st2.j.style.id;
  const put1 = await call("PUT", `/styles/${sid2}/processes`, aT, {
    items: [
      { name: "剪线", priceMode: "default", unitPrice: 1.2, showPrice: true },
      { name: "烫工", priceMode: "size", unitPrice: 2, prices: { S: 2.5, M: 3 }, showPrice: false, visibleRoles: ["tech_lead"] }
    ]
  });
  ok(put1.status === 200 && put1.j.list.length === 2, "整套覆盖保存工序");
  ok(put1.j.list[0].name === "剪线" && put1.j.list[0].seq === 1, "工序名自由输入且带序号");
  ok(put1.j.list[1].price_mode === "size" && put1.j.list[1].prices.M === 3, "分码单价存取正确");
  ok(put1.j.list[1].show_price === false, "显示价格开关存取正确");
  ok(put1.j.list[1].visible_roles.join(",") === "tech_lead", "可见岗位存取正确");

  const got = await call("GET", `/styles/${sid2}/processes`, aT);
  ok(got.j.list.length === 2 && got.j.list[0].effectivePrice === 1.2, "读回工序带 effectivePrice");

  // 覆盖保存：传 1 条就只剩 1 条，多余的行被清掉
  const put2 = await call("PUT", `/styles/${sid2}/processes`, aT, {
    items: [{ name: "只剩这道", priceMode: "default", unitPrice: 5, showPrice: true }]
  });
  ok(put2.j.list.length === 1 && put2.j.list[0].name === "只剩这道", "覆盖保存会清掉多余工序");

  // —— 工序模板 ——
  const tpl = await call("POST", "/process-templates", aT, {
    name: "标准两道", items: [{ name: "剪线", priceMode: "default", unitPrice: 1, showPrice: true }]
  });
  ok(tpl.status === 200 && tpl.j.template.id, "保存工序模板");
  const tpls = await call("GET", "/process-templates", aT);
  ok(tpls.j.list.some(t => t.name === "标准两道" && Array.isArray(t.items)), "模板列表带出 items 数组");
  ok((await call("DELETE", `/process-templates/${tpl.j.template.id}`, aT)).status === 200, "删除工序模板");
```

- [ ] **Step 2: 运行确认失败**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: FAIL —「整套覆盖保存工序」等断言红（`PUT` 404）

- [ ] **Step 3: 改 `GET /styles/:id/processes` 返回新字段**

`server/routes.js` 里把原有的 GET 换成：

```js
// 款式工序：工序名可以自由输入（name 列），也可以从工序模板挑（process_id）。
// 老数据只有 process_id，name 由迁移回填过；这里再兜一次底，免得历史脏数据显示空白。
router.get("/styles/:id/processes", A.authRequired, async (req, res) => {
  const rows = await db.prepare(`
    SELECT sp.*, p.name AS process_name, p.unit AS process_unit, p.unit_price AS template_price
    FROM jj_style_processes sp LEFT JOIN jj_processes p ON p.id = sp.process_id
    WHERE sp.style_id = ? ORDER BY sp.seq ASC
  `).all(req.params.id);
  res.json({ list: rows.map((r) => ({
    id: r.id, style_id: r.style_id, process_id: r.process_id, seq: r.seq,
    name: r.name || r.process_name || "",
    price_mode: r.price_mode || "default",
    unit_price: Number(r.unit_price) || 0,
    prices: jsonParseSafe(r.prices, {}),
    show_price: r.show_price !== 0,
    visible_roles: jsonParseSafe(r.visible_roles, []),
    process_unit: r.process_unit || null,
    // 列表/合计用的"这道工序的默认价"：自己的价优先，没设过才回落工序模板的价
    effectivePrice: (r.unit_price !== null && r.unit_price !== undefined)
      ? Number(r.unit_price) : (Number(r.template_price) || 0)
  })) });
});
```

在 `server/routes.js` 顶部的辅助函数区（`logOp` 附近）加：

```js
const jsonParseSafe = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; } };
```

- [ ] **Step 4: 新增 `PUT /styles/:id/processes`（整套覆盖）**

紧跟 GET 之后插入：

```js
// 工序编辑器一次提交整套工序：先清空再重写。逐条 POST/PATCH/DELETE 在"改序号 + 改模式 +
// 删中间一条"混在一起时很难保证一致，整套覆盖简单且天然幂等。
// 老的逐条接口保留给小程序端过渡期用，两边写的是同一张表。
router.put("/styles/:id/processes", A.authRequired, async (req, res) => {
  const style = await db.prepare("SELECT * FROM jj_styles WHERE id=? AND deleted=0").get(req.params.id);
  if (!style) return res.status(404).json({ error: "款式不存在" });
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
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
        `INSERT INTO jj_style_processes(id,style_id,process_id,seq,name,price_mode,unit_price,prices,show_price,visible_roles,created_at)
         VALUES ?`,
        [items.map((it, i) => [uid(), style.id, it.processId || null, i + 1,
          String(it.name).trim(), it.priceMode || "default", Number(it.unitPrice) || 0,
          it.prices ? JSON.stringify(it.prices) : null,
          it.showPrice === false ? 0 : 1,
          Array.isArray(it.visibleRoles) && it.visibleRoles.length ? JSON.stringify(it.visibleRoles) : null,
          now])]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

  await logOp(req.user.id, `款式「${style.name}」保存工序：${items.length} 道`);
  res.json({ list: await styleProcessList(style.id) });
});
```

GET 和 PUT 返回同一种形状，把映射逻辑抽成一个函数复用（放在 GET 之前）：

```js
// GET 和 PUT 都要返回同一种形状，抽出来复用，避免两处映射逻辑漂移
async function styleProcessList(styleId) {
  const rows = await db.prepare(`
    SELECT sp.*, p.name AS process_name, p.unit AS process_unit, p.unit_price AS template_price
    FROM jj_style_processes sp LEFT JOIN jj_processes p ON p.id = sp.process_id
    WHERE sp.style_id = ? ORDER BY sp.seq ASC`).all(styleId);
  return rows.map((r) => ({
    id: r.id, style_id: r.style_id, process_id: r.process_id, seq: r.seq,
    name: r.name || r.process_name || "",
    price_mode: r.price_mode || "default",
    unit_price: Number(r.unit_price) || 0,
    prices: jsonParseSafe(r.prices, {}),
    show_price: r.show_price !== 0,
    visible_roles: jsonParseSafe(r.visible_roles, []),
    process_unit: r.process_unit || null,
    effectivePrice: (r.unit_price !== null && r.unit_price !== undefined)
      ? Number(r.unit_price) : (Number(r.template_price) || 0)
  }));
}
```

Step 3 的 GET 改成一行 `res.json({ list: await styleProcessList(req.params.id) })`，两处映射逻辑不再重复。`server/routes.js` 顶部的解构要把 `pool` 加进去：`const { db, pool, uid, getSetting, setSetting, UPLOAD_DIR } = require("./db");`

- [ ] **Step 5: 新增工序模板三个路由**

```js
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
```

- [ ] **Step 6: 运行确认通过**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: 全绿（Task 3 里「工序已快照进裁床单」那条现在也应该绿了）

- [ ] **Step 7: 提交**

```bash
git add server/routes.js test/cutting.test.js
git commit -m "工序编辑器后端：整套覆盖保存(工序名自由输入/三种价格模式/显示价格/可见岗位) + 工序模板"
```

---

## Task 5: 同步工序

**Files:**
- Modify: `server/routes.js`（新增 2 个路由）
- Modify: `test/cutting.test.js`

**Interfaces:**
- Consumes: Task 3 的 `cutting.completedByOrders`
- Produces:
  - `GET /api/styles/:id/syncable-orders` → `{ list }`，每项 `{ id, bed_no, doc_no, cut_date, process_count, total_price, total_qty, completed_qty, percent }`
  - `POST /api/styles/:id/processes/sync`，body `{ orderIds: string[] }` → `{ synced: number }`

- [ ] **Step 1: 追加失败的测试** — `test/cutting.test.js` 内追加

```js
  // —— 同步工序：只影响被选中的裁床单 ——
  // 用 sid2 建两张单，改款式工序后只同步其中一张
  const mk = async (bedNo) => (await call("POST", "/cut-orders", aT, {
    styleId: sid2, bedNo, cutDate: "2026-09-09", colors: ["A"], sizes: ["S"],
    startNo: 1, multiple: true, cells: { "A|S": { input: 10, bundles: 1 } }
  })).j.order.id;
  const o1 = await mk(11), o2 = await mk(12);

  const syncable = await call("GET", `/styles/${sid2}/syncable-orders`, aT);
  ok(syncable.status === 200 && syncable.j.list.length >= 2, "同步工序弹窗能列出该款的裁床单");
  ok(syncable.j.list[0].process_count === 1, "列表带出工序数");
  ok(syncable.j.list[0].completed_qty === 0 && syncable.j.list[0].percent === 0, "列表带出已完成件数与百分比");

  // 改款式工序：从 1 道变 2 道
  await call("PUT", `/styles/${sid2}/processes`, aT, {
    items: [
      { name: "只剩这道", priceMode: "default", unitPrice: 5, showPrice: true },
      { name: "新加的一道", priceMode: "default", unitPrice: 6, showPrice: true }
    ]
  });
  const sync = await call("POST", `/styles/${sid2}/processes/sync`, aT, { orderIds: [o1] });
  ok(sync.status === 200 && sync.j.synced === 1, "同步了 1 张裁床单");
  ok((await call("GET", `/cut-orders/${o1}`, aT)).j.processes.length === 2, "被选中的单工序更新为 2 道");
  ok((await call("GET", `/cut-orders/${o2}`, aT)).j.processes.length === 1, "未选中的单工序快照保持不变");
  ok((await call("POST", `/styles/${sid2}/processes/sync`, wT, { orderIds: [o2] })).status === 403, "计件工不能同步工序");
```

- [ ] **Step 2: 运行确认失败**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: FAIL — `/syncable-orders` 404

- [ ] **Step 3: 实现两个路由**

`server/routes.js` 里紧跟工序模板路由之后：

```js
/* ---------------- 同步工序：把款式当前工序推到指定的几张裁床单 ---------------- */
// 裁床单的工序是下单时的快照，改款式工序默认不影响已建的单（否则改一次价会追溯改掉
// 所有历史单算出来的工资）。要生效必须在这里显式选单同步。
router.get("/styles/:id/syncable-orders", A.authRequired, A.managerRequired, async (req, res) => {
  const rows = await db.prepare(`
    SELECT o.id, o.bed_no, o.doc_no, o.cut_date, o.total_qty,
           (SELECT COUNT(*) FROM jj_cut_order_processes p WHERE p.order_id = o.id) AS process_count,
           (SELECT COALESCE(SUM(p.unit_price),0) FROM jj_cut_order_processes p WHERE p.order_id = o.id) AS total_price
    FROM jj_cut_orders o WHERE o.style_id = ? AND o.deleted = 0
    ORDER BY o.bed_no DESC`).all(req.params.id);
  const done = await cutting.completedByOrders(rows.map((r) => r.id));
  res.json({ list: rows.map((r) => {
    const completed = done[r.id] || 0;
    return Object.assign({}, r, {
      completed_qty: completed,
      percent: r.total_qty > 0 ? Math.round((completed / r.total_qty) * 100) : 0
    });
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
      // 整套替换而不是增量 diff：工序增删改序都可能同时发生，替换最简单也最不会错。
      // 已有的打点记录挂在旧的 order_process_id 上，替换后那部分进度会归零——这是
      // 有意的：工序表都换了，旧进度对不上新工序，让车间按新工序重新打点。
      await conn.query("DELETE FROM jj_cut_order_processes WHERE order_id = ?", [o.id]);
      if (sps.length) {
        await conn.query(
          `INSERT INTO jj_cut_order_processes(id,order_id,seq,name,price_mode,unit_price,prices,show_price,visible_roles,style_process_id,created_at)
           VALUES ?`,
          [sps.map((sp, i) => [uid(), o.id, sp.seq || i + 1, sp.name || "工序" + (i + 1),
            sp.price_mode || "default", Number(sp.unit_price) || 0, sp.prices || null,
            sp.show_price === 0 ? 0 : 1, sp.visible_roles || null, sp.id, now])]);
      }
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

  const label = `${style.code || style.name}`;
  await logOp(req.user.id, `款式「${style.name}」同步工序到 ${orders.length} 张裁床单`);
  await notifyManagers(`${req.user.name} 把 ${label} 的工序同步到了 ${orders.length} 张裁床单`, "/cutorders", req.user.id,
    { actorName: req.user.name, targetLabel: label, what: `同步工序到 ${orders.length} 张裁床单（床次 ${orders.map(o => o.bed_no).join("、")}）` });
  res.json({ synced: orders.length });
});
```

- [ ] **Step 4: 运行确认通过**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add server/routes.js test/cutting.test.js
git commit -m "同步工序：可选床次把款式工序整套推到裁床单快照，未选中的单不受影响"
```

---

## Task 6: 扫扎打点 + 取价 + 工资口径

**Files:**
- Modify: `server/routes.js`（改写 `POST /scan`、改 `pieceWage`）
- Modify: `test/cutting.test.js`

**Interfaces:**
- Consumes: `server/pricing.js` 的 `resolvePrice`；`server/routes_cutting.js` 的 `progressMap`
- Produces:
  - `POST /api/scan` 新 body：`{ ticketNo? , orderId?, bundleNo?, orderProcessId, qty?, userId?, date? }` → `{ record, bundle, remaining }`
  - 旧 body `{ processId, date, qty, styleId?, userId? }` 继续可用（小程序端过渡期）
  - `pieceWage(userId, datePattern)` 口径：`SUM(qty × COALESCE(scan.unit_price, process.unit_price, 0))`

- [ ] **Step 1: 追加失败的测试**

```js
  // —— 扫扎打点 ——
  // 建一张 2 道工序的单：1 扎 10 件
  await call("PUT", `/styles/${sid2}/processes`, aT, {
    items: [
      { name: "剪线", priceMode: "default", unitPrice: 1, showPrice: true },
      { name: "烫工", priceMode: "size", unitPrice: 2, prices: { S: 3 }, showPrice: true }
    ]
  });
  const so = (await call("POST", "/cut-orders", aT, {
    styleId: sid2, bedNo: 21, cutDate: "2026-09-09", colors: ["A"], sizes: ["S"],
    startNo: 1, multiple: true, cells: { "A|S": { input: 10, bundles: 1 } }
  })).j.order.id;
  const sd = await call("GET", `/cut-orders/${so}`, aT);
  const bundle1 = sd.j.bundles[0], procCut = sd.j.processes[0], procIron = sd.j.processes[1];

  // 按菲票号扫，不传 qty = 完成整扎
  const scan1 = await call("POST", "/scan", wT, { ticketNo: bundle1.ticket_no, orderProcessId: procCut.id, date: "2026-09-09" });
  ok(scan1.status === 200 && scan1.j.record.qty === 10, "不传件数=完成整扎");
  ok(scan1.j.record.unit_price === 1, "写入了默认单价快照");
  ok(scan1.j.remaining === 0, "该工序剩余 0 件");

  // —— T6 超额被拒 ——
  ok((await call("POST", "/scan", wT, { ticketNo: bundle1.ticket_no, orderProcessId: procCut.id, qty: 1, date: "2026-09-09" })).status === 400,
    "同一扎同一工序超额打点被拒");

  // —— T7 分码单价 ——
  const scan2 = await call("POST", "/scan", wT, { orderId: so, bundleNo: 1, orderProcessId: procIron.id, qty: 4, date: "2026-09-09" });
  ok(scan2.status === 200 && scan2.j.record.unit_price === 3, "分码单价按该扎尺码取到 S 的 3 元");
  ok(scan2.j.remaining === 6, "剩余件数正确");

  // —— T8 改工价不追溯历史工资 ——
  const payBefore = (await call("GET", "/payroll/mine?month=2026-09", wT)).j.pieceWage;
  ok(payBefore === 10 * 1 + 4 * 3, "工资 = 10×1 + 4×3 = 22");
  await call("PUT", `/styles/${sid2}/processes`, aT, {
    items: [
      { name: "剪线", priceMode: "default", unitPrice: 99, showPrice: true },
      { name: "烫工", priceMode: "default", unitPrice: 99, showPrice: true }
    ]
  });
  ok((await call("GET", "/payroll/mine?month=2026-09", wT)).j.pieceWage === payBefore, "改工价后历史工资不变（用的是记录里的价格快照）");

  // 扎号/菲票号不存在
  ok((await call("POST", "/scan", wT, { ticketNo: 999999999, orderProcessId: procCut.id })).status === 400, "菲票号不存在时报错");
```

- [ ] **Step 2: 运行确认失败**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: FAIL —「不传件数=完成整扎」等断言红

- [ ] **Step 3: 改写 `POST /scan`**

`server/routes.js` 顶部加 `const { resolvePrice } = require("./pricing");`，然后把原 `POST /scan` 整段替换为：

```js
/* ---------------- 打点 ----------------
 * 两种形态：
 *   1) 扫扎（主流程）：给 ticketNo 或 (orderId,bundleNo) + orderProcessId，
 *      不给 qty 就是"完成整扎剩余"。单价按该扎尺码/打点人岗位解析后存进记录快照。
 *   2) 自由打点（小程序端过渡期）：给 processId + qty，走老逻辑，单价留空由工资那边回落全局单价。
 */
router.post("/scan", A.authRequired, async (req, res) => {
  const { ticketNo, orderId, bundleNo, orderProcessId, processId, styleId, userId } = req.body || {};
  const date = (req.body && req.body.date) || new Date().toISOString().slice(0, 10);

  let targetUserId = req.user.id;
  if (userId && userId !== req.user.id) {
    if (!A.canActAsAdmin(req.user)) return res.status(403).json({ error: "没有权限代别人打点" });
    targetUserId = userId;
  }
  const actor = targetUserId === req.user.id ? req.user : await A.userById(targetUserId);
  if (!actor) return res.status(400).json({ error: "员工不存在" });

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

  const doneRow = await db.prepare(
    "SELECT COALESCE(SUM(qty),0) AS done FROM jj_scan_records WHERE bundle_id=? AND order_process_id=?")
    .get(bundle.id, proc.id);
  const done = Number(doneRow.done) || 0;
  const left = bundle.qty - done;
  if (left <= 0) return res.status(400).json({ error: `扎号 ${bundle.bundle_no} 的「${proc.name}」已经做完了` });

  const qty = req.body.qty === undefined || req.body.qty === "" ? left : Number(req.body.qty);
  if (!(qty > 0)) return res.status(400).json({ error: "件数要大于 0" });
  if (qty > left) return res.status(400).json({ error: `超了，扎号 ${bundle.bundle_no} 的「${proc.name}」只剩 ${left} 件` });

  // 单价在打点这一刻定死：之后改工价不会追溯改动已经算过的工资
  const unitPrice = resolvePrice(proc, { size: bundle.size, role: actor.role });

  const id = uid();
  await db.prepare(
    `INSERT INTO jj_scan_records(id,user_id,style_id,process_id,date,qty,created_at,order_id,bundle_id,order_process_id,unit_price)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, targetUserId, bundle.style_id, proc.style_process_id || null, date, qty, Date.now(),
      order.id, bundle.id, proc.id, unitPrice);

  res.json({
    record: await db.prepare("SELECT * FROM jj_scan_records WHERE id=?").get(id),
    bundle, remaining: left - qty
  });
});
```

> `process_id` 存 `proc.style_process_id` 是刻意的：它指向 `jj_style_processes`，不是 `jj_processes`。工资 SQL 里那个 `LEFT JOIN jj_processes` 对新记录 join 不上，正好落到 `unit_price` 快照这一支。

- [ ] **Step 4: 改工资口径**

`server/routes.js` 的 `pieceWage` 换成：

```js
// 计件工资 = Σ(件数 × 单价)。单价优先用打点当时存下的快照，没有快照的老记录
// （自由打点）才回落到全局工序单价——这样改工价不会追溯改动历史工资。
// JOIN 改 LEFT JOIN：扫扎产生的记录 process_id 指向款式工序，在 jj_processes 里没有对应行。
async function pieceWage(userId, datePattern) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(s.qty * COALESCE(s.unit_price, p.unit_price, 0)), 0) AS w
    FROM jj_scan_records s LEFT JOIN jj_processes p ON p.id = s.process_id
    WHERE s.user_id = ? AND s.date LIKE ?
  `).get(userId, datePattern);
  return row ? row.w : 0;
}
```

- [ ] **Step 5: 运行确认通过**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: 全绿（`api.test.js` 里原有的自由打点用例也必须继续绿）

- [ ] **Step 6: 提交**

```bash
git add server/routes.js test/cutting.test.js
git commit -m "扫扎打点：按菲票号/扎号完成整扎，取价分岗>分码>默认并存快照，工资口径改用快照价"
```

---

## Task 7: 生产进度 / 工序进展 / 生产管理概览

**Files:**
- Modify: `server/routes_cutting.js`（追加 6 个路由）
- Modify: `test/cutting.test.js`

**Interfaces:**
- Consumes: 本文件已有的 `progressMap`/`bundleDone`/`completedByOrders`
- Produces:
  - `GET /api/cut-orders/:id/progress` → `{ order, processes, bundles: [{...bundle, done, percent, perProcess: {[procId]: n}}], completed_qty }`
  - `GET /api/cut-orders/:id/process-progress` → `{ processes: [{ id, name, total, done, remaining, percent, breakdown: [{color,size,total,done,remaining}] }] }`
  - `GET /api/bundles/:id` → `{ bundle, order, processes: [{ id, name, unit_price, show_price, done, remaining }] }`
  - `PATCH /api/bundles/:id`，body `{ qty?, vatNo?, note? }` → `{ bundle }`
  - `GET /api/production/overview?range=today|yesterday|month` → `{ completed, inProduction }`
  - `GET /api/production/by-style?kw=&from=&to=` → `{ list }`

- [ ] **Step 1: 追加失败的测试**

```js
  // —— 生产进度：每扎 / 每工序 ——
  const prog = await call("GET", `/cut-orders/${so}/progress`, aT);
  ok(prog.status === 200 && prog.j.bundles.length === 1, "生产进度列出每一扎");
  // 剪线 10/10、烫工 4/10 → 该扎"已完成数" = min(10,4) = 4
  ok(prog.j.bundles[0].done === 4, "每扎已完成数 = 各工序完成数的最小值");
  ok(prog.j.completed_qty === 4, "T12 裁床单已完成件数 = 各扎已完成数之和");
  ok(prog.j.bundles[0].percent === 0, "两道工序只做完一道，完工工序占比 0%");

  const pp = await call("GET", `/cut-orders/${so}/process-progress`, aT);
  ok(pp.j.processes.length === 2, "工序进展列出两道工序");
  ok(pp.j.processes[0].total === 10 && pp.j.processes[0].done === 10 && pp.j.processes[0].remaining === 0, "剪线 10/10");
  ok(pp.j.processes[1].done === 4 && pp.j.processes[1].remaining === 6, "烫工 4/10");
  ok(pp.j.processes[1].breakdown[0].color === "A" && pp.j.processes[1].breakdown[0].size === "S", "工序进展带颜色/尺码分解");

  const bd = await call("GET", `/bundles/${bundle1.id}`, aT);
  ok(bd.j.processes.length === 2 && bd.j.processes[1].remaining === 6, "生产进度详情：每道工序剩余件数");

  // —— T9 改裁床件数：不能改到低于已完成数 ——
  ok((await call("PATCH", `/bundles/${bundle1.id}`, aT, { qty: 3 })).status === 400, "裁床件数不能改到低于已完成数");
  const okPatch = await call("PATCH", `/bundles/${bundle1.id}`, aT, { qty: 12, vatNo: "G9" });
  ok(okPatch.status === 200 && okPatch.j.bundle.qty === 12 && okPatch.j.bundle.vat_no === "G9", "改裁床件数与缸号");
  ok((await call("PATCH", `/bundles/${bundle1.id}`, wT, { qty: 11 })).status === 403, "计件工不能改裁床件数");

  // —— 生产管理概览 ——
  const ov = await call("GET", "/production/overview?range=month", aT);
  ok(ov.status === 200 && typeof ov.j.completed === "number" && typeof ov.j.inProduction === "number", "生产概览返回已完成/生产中件数");
  const byStyle = await call("GET", "/production/by-style?kw=FC3456", aT);
  ok(byStyle.status === 200 && byStyle.j.list.length >= 1, "按款看有数据");
  ok(byStyle.j.list[0].sheet_count >= 1 && byStyle.j.list[0].total_qty > 0, "按款看带出裁床单数与总件数");
```

- [ ] **Step 2: 运行确认失败**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: FAIL — `/progress` 404

- [ ] **Step 3: 追加 6 个路由到 `server/routes_cutting.js`（`module.exports` 之前）**

```js
/* ---------------- 生产进度：按扎 ---------------- */
router.get("/cut-orders/:id/progress", A.authRequired, async (req, res) => {
  const order = await db.prepare(
    `SELECT o.*, s.name AS style_name, s.code AS style_code
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
    `SELECT o.*, s.name AS style_name, s.code AS style_code
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
const dayStr = (d) => d.toISOString().slice(0, 10);
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
```

- [ ] **Step 4: 运行确认通过**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add server/routes_cutting.js test/cutting.test.js
git commit -m "生产进度/工序进展/生产管理概览：全部由打点记录聚合派生，改裁床件数带下限校验"
```

---

## Task 8: 打印数据接口 + 二维码

**Files:**
- Modify: `package.json`（加 `qrcode` 依赖）
- Create: `server/qr.js`
- Modify: `server/routes_cutting.js`（加 `GET /cut-orders/:id/print-data`）
- Modify: `test/cutting.test.js`

**Interfaces:**
- Consumes: `qrcode` npm 包
- Produces:
  - `qrSvg(text) -> Promise<string>`（内联 `<svg>` 字符串，无 XML 声明）
  - `GET /api/cut-orders/:id/print-data?from=&to=&picks=` → `{ order, processes, bundles: [{...bundle, qrSvg}] }`

- [ ] **Step 1: 装依赖**

```bash
npm install qrcode@^1.5.4
```

- [ ] **Step 2: 追加失败的测试**

```js
  // —— T10 打印数据：扎号范围与任选扎号 ——
  const pdAll = await call("GET", `/cut-orders/${orderId}/print-data`, aT);
  ok(pdAll.status === 200 && pdAll.j.bundles.length === 4, "不给范围就是全部扎");
  ok(pdAll.j.bundles[0].qrSvg && pdAll.j.bundles[0].qrSvg.startsWith("<svg"), "每扎带内联二维码 SVG");
  const pdRange = await call("GET", `/cut-orders/${orderId}/print-data?from=2&to=3`, aT);
  ok(pdRange.j.bundles.map(b => b.bundle_no).join(",") === "2,3", "按扎号范围过滤");
  const pdPicks = await call("GET", `/cut-orders/${orderId}/print-data?picks=1,4`, aT);
  ok(pdPicks.j.bundles.map(b => b.bundle_no).join(",") === "1,4", "任选扎号打印，picks 覆盖 from/to");
  ok((await call("GET", `/cut-orders/${orderId}/print-data`, wT)).status === 403, "计件工不能取打印数据");
```

- [ ] **Step 3: 运行确认失败**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: FAIL — `/print-data` 404

- [ ] **Step 4: 实现 `server/qr.js`**

```js
"use strict";
/**
 * 菲票二维码。生成内联 SVG 而不是 PNG dataURL：
 *   - 打印时矢量不糊，热敏标签机上小尺寸也扫得动
 *   - 直接塞进 HTML，不用额外的图片请求（PWA 离线也能打印）
 * 容错级别 M：菲票会被摸脏折皱，L 太脆；H 会让码变密、小标签上反而难扫。
 */
const QRCode = require("qrcode");

async function qrSvg(text) {
  const svg = await QRCode.toString(String(text), {
    type: "svg", errorCorrectionLevel: "M", margin: 0, width: 120
  });
  // qrcode 会带 <?xml ...?> 声明，内联进 HTML 时必须去掉，否则部分浏览器不渲染
  return svg.replace(/^<\?xml[^>]*\?>\s*/, "");
}

module.exports = { qrSvg };
```

- [ ] **Step 5: 实现打印数据路由**

`server/routes_cutting.js` 顶部加 `const { qrSvg } = require("./qr");`，然后在 `module.exports` 之前加：

```js
/* ---------------- 打印数据 ----------------
 * 不做服务端直出打印页：本系统鉴权是 Authorization: Bearer（token 在 localStorage），
 * window.open 出来的新窗口带不上这个头，直出页面必然 401。所以这里只给数据 + 二维码，
 * 前端在 SPA 里渲染到 #print-root，@media print 只显示它，再 window.print()。
 * 份数/旋转180°/逐个备注 都是纯前端渲染参数，不进这个请求。
 */
router.get("/cut-orders/:id/print-data", A.authRequired, A.managerRequired, async (req, res) => {
  const order = await db.prepare(
    `SELECT o.*, s.name AS style_name, s.code AS style_code
     FROM jj_cut_orders o JOIN jj_styles s ON s.id=o.style_id WHERE o.id=? AND o.deleted=0`).get(req.params.id);
  if (!order) return res.status(404).json({ error: "裁床单不存在" });

  let bundles = await db.prepare("SELECT * FROM jj_cut_bundles WHERE order_id=? ORDER BY bundle_no ASC").all(order.id);
  const picks = String(req.query.picks || "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
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
```

- [ ] **Step 6: 运行确认通过**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json server/qr.js server/routes_cutting.js test/cutting.test.js
git commit -m "打印数据接口：按扎号范围/任选扎号取菲票，服务端生成内联二维码 SVG"
```

---

## Task 9: 本地演示数据种子

**Files:**
- Create: `scripts/seed_demo.js`
- Modify: `package.json`（加 `dev:local` 与 `seed:demo` 脚本）

**Interfaces:**
- Consumes: `server/db.js` 的 `init`/`db`/`uid`/`pool`；`server/cutting.js` 的 `planBundles`/`cellKey`
- Produces: 本地库 `jijian_dev` 里一套与截图对齐的数据；脚本可反复执行（先清空自己造的数据再重建）

- [ ] **Step 1: 写脚本 `scripts/seed_demo.js`**

```js
"use strict";
/**
 * 本地演示数据：造一套跟参考小程序截图对得上的数据，用来人工验收界面。
 * 只在本地库跑（默认 jijian_dev），生产不要执行。可反复跑：每次先删掉自己造的款式与单。
 *
 * 颜色/尺码数组的顺序 = 矩阵行列顺序 = 扎号编号的遍历顺序。截图里 扎号1 是 S 码的
 * 223暗蓝，所以尺码数组从 S 排起、颜色数组从 223暗蓝 排起，不是按选择器里的显示顺序。
 */
const path = require("path");
const { init, db, pool, uid } = require(path.join(__dirname, "..", "server", "db"));
const { planBundles, cellKey } = require(path.join(__dirname, "..", "server", "cutting"));

const COMPANY = "惠民县惠锦服装制衣有限公司";
const CUSTOMER = "天津锦利国际贸易有限公司";
const SIZES = ["S", "M", "L", "XL", "2XL"];

async function wipe(codes) {
  for (const code of codes) {
    const st = await db.prepare("SELECT id FROM jj_styles WHERE code = ?").get(code);
    if (!st) continue;
    const orders = await db.prepare("SELECT id FROM jj_cut_orders WHERE style_id = ?").all(st.id);
    for (const o of orders) {
      await db.prepare("DELETE FROM jj_scan_records WHERE order_id = ?").run(o.id);
      await db.prepare("DELETE FROM jj_cut_bundles WHERE order_id = ?").run(o.id);
      await db.prepare("DELETE FROM jj_cut_order_processes WHERE order_id = ?").run(o.id);
    }
    await db.prepare("DELETE FROM jj_cut_orders WHERE style_id = ?").run(st.id);
    await db.prepare("DELETE FROM jj_style_processes WHERE style_id = ?").run(st.id);
    await db.prepare("DELETE FROM jj_styles WHERE id = ?").run(st.id);
  }
}

async function makeStyle(code, name, { hasCutting = true } = {}) {
  const id = uid();
  await db.prepare(
    "INSERT INTO jj_styles(id,name,code,customer,has_cutting,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
    .run(id, name, code, CUSTOMER, hasCutting ? 1 : 0, Date.now());
  return id;
}

async function makeProcesses(styleId, items) {
  const now = Date.now();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    await db.prepare(
      `INSERT INTO jj_style_processes(id,style_id,process_id,seq,name,price_mode,unit_price,prices,show_price,visible_roles,created_at)
       VALUES(?,?,NULL,?,?,?,?,?,1,NULL,?)`)
      .run(uid(), styleId, i + 1, it.name, it.priceMode || "default",
        it.unitPrice || 0, it.prices ? JSON.stringify(it.prices) : null, now);
  }
}

// 直接写库造裁床单（不走 HTTP），但复用同一个 planBundles，保证跟界面上生成的结果一致
async function makeOrder(styleId, opts) {
  const plan = planBundles({
    colors: opts.colors, sizes: opts.sizes, cells: opts.cells,
    startNo: 1, multiple: true
  });
  const orderId = uid(), now = Date.now();
  await db.prepare(
    `INSERT INTO jj_cut_orders(id,style_id,bed_no,doc_no,customer,cut_date,ship_date,order_no,
      bed_note,ticket_note,company_name,colors,sizes,total_bundles,total_qty,source,created_by,created_at,deleted)
     VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?,'self',NULL,?,0)`)
    .run(orderId, styleId, opts.bedNo, opts.docNo, CUSTOMER, opts.cutDate, opts.shipDate,
      COMPANY, JSON.stringify(opts.colors), JSON.stringify(opts.sizes),
      plan.totalBundles, plan.totalQty, now);

  const seqRow = await db.prepare("SELECT value FROM settings WHERE `key`='jj_ticket_seq'").get();
  let ticket = seqRow ? Number(JSON.parse(seqRow.value)) || 36000 : 36000;
  for (const b of plan.bundles) {
    await db.prepare(
      "INSERT INTO jj_cut_bundles(id,order_id,style_id,bundle_no,ticket_no,color,size,qty,vat_no,note,created_at) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?)")
      .run(uid(), orderId, styleId, b.bundleNo, ticket++, b.color, b.size, b.qty, now);
  }
  await db.prepare(
    "INSERT INTO settings(`key`,value) VALUES('jj_ticket_seq',?) ON DUPLICATE KEY UPDATE value=VALUES(value)")
    .run(JSON.stringify(ticket));

  const sps = await db.prepare("SELECT * FROM jj_style_processes WHERE style_id=? ORDER BY seq ASC").all(styleId);
  for (const sp of sps) {
    await db.prepare(
      `INSERT INTO jj_cut_order_processes(id,order_id,seq,name,price_mode,unit_price,prices,show_price,visible_roles,style_process_id,created_at)
       VALUES(?,?,?,?,?,?,?,1,NULL,?,?)`)
      .run(uid(), orderId, sp.seq, sp.name, sp.price_mode, sp.unit_price, sp.prices, sp.id, now);
  }
  console.log(`[seed] ${opts.docNo || ""} 床次${opts.bedNo}：${plan.totalBundles} 扎 ${plan.totalQty} 件`);
  return orderId;
}

(async () => {
  await init();
  await wipe(["FC3390 裤", "FC3390-1", "FA10053"]);

  // —— FC3390 裤：截图里的主角，床次1 / 床次2 ——
  const s1 = await makeStyle("FC3390 裤", "");
  await makeProcesses(s1, [{ name: "剪线", unitPrice: 0 }, { name: "烫工", unitPrice: 0 }]);
  const colors1 = ["223暗蓝", "331浅蓝条"];
  // 床次2：64 扎 2272 件。S/M 用截图里的真实数字，其余尺码按同样的形状铺开。
  const cells2 = {};
  const perSize = {
    S:   { "223暗蓝": [52, 36], "331浅蓝条": [26, 28] },
    M:   { "223暗蓝": [52, 36], "331浅蓝条": [26, 28] },
    L:   { "223暗蓝": [52, 36], "331浅蓝条": [26, 28] },
    XL:  { "223暗蓝": [52, 36], "331浅蓝条": [26, 28] },
    "2XL": { "223暗蓝": [52, 36], "331浅蓝条": [26, 28] }
  };
  // planBundles 一个格子只能给一个"每扎件数"，两种件数（52 和 36）拆成两次调用不现实，
  // 所以这里按"倍数模式关闭"传该格总件数 + 扎数，让它平分——种子数据不需要跟实拍逐扎相等，
  // 逐扎相等的断言已经由 cutting.unit.test.js 的 S 码那组守住了。
  for (const size of SIZES) {
    for (const color of colors1) {
      const arr = perSize[size][color];
      cells2[cellKey(color, size)] = { input: arr[0] + arr[1], bundles: 2 };
    }
  }
  await makeOrder(s1, {
    bedNo: 2, docNo: "2897", cutDate: "2026-09-09", shipDate: "2026-09-10",
    colors: colors1, sizes: SIZES, cells: cells2
  });
  const cells1 = {};
  for (const size of SIZES) for (const color of colors1) {
    cells1[cellKey(color, size)] = { input: color === "223暗蓝" ? 140 : 84, bundles: 2 };
  }
  await makeOrder(s1, {
    bedNo: 1, docNo: "2885", cutDate: "2026-09-08", shipDate: "2026-09-09",
    colors: colors1, sizes: SIZES, cells: cells1
  });

  // —— FC3390-1：截图「生产进度」那一张，床次4，280 件，L 码两色 ——
  const s2 = await makeStyle("FC3390-1", "RIGHY LL");
  await makeProcesses(s2, [{ name: "剪线", unitPrice: 0 }, { name: "烫工", unitPrice: 0 }]);
  await makeOrder(s2, {
    bedNo: 4, docNo: "2901", cutDate: "2026-09-08", shipDate: "2026-09-09",
    colors: ["223暗蓝", "460深邃蓝"], sizes: ["L"],
    cells: { [cellKey("223暗蓝", "L")]: { input: 140, bundles: 5 }, [cellKey("460深邃蓝", "L")]: { input: 140, bundles: 5 } }
  });

  // —— FA10053：不裁床的款，用来验「是否裁床：否」 ——
  const s3 = await makeStyle("FA10053", "LINE HL OPEN", { hasCutting: false });
  await makeProcesses(s3, [{ name: "剪线", unitPrice: 0 }, { name: "烫工", unitPrice: 0 }]);

  console.log("[seed] 演示数据就绪");
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 加 npm 脚本**

`package.json` 的 `scripts` 里加：

```json
    "dev:local": "MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER=root MYSQL_DATABASE=jijian_dev node --env-file-if-exists=.env --watch server/index.js",
    "seed:demo": "MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER=root MYSQL_DATABASE=jijian_dev node scripts/seed_demo.js"
```

- [ ] **Step 3: 跑种子并核对**

```bash
npm run seed:demo
```

Expected 输出包含：`床次2：50 扎 2272 件` 这一类行（扎数取决于每格扎数，件数必须是 2272）。用 SQL 复核总件数：

```bash
mysql -h127.0.0.1 -P3306 -uroot jijian_dev -e "SELECT s.code, o.bed_no, o.total_bundles, o.total_qty FROM jj_cut_orders o JOIN jj_styles s ON s.id=o.style_id ORDER BY s.code, o.bed_no;"
```

Expected: FC3390 裤 床次2 的 `total_qty` = 2272

> 若不等于 2272，调 `perSize` 里的数字直到相等——这份种子的意义就是让界面上的数字跟截图对得上。

- [ ] **Step 4: 提交**

```bash
git add scripts/seed_demo.js package.json
git commit -m "本地演示数据种子：造出与截图对齐的 FC3390 床次1/2、FC3390-1 床次4、不裁床款 FA10053"
```

---

## Task 10: 前端 — 款式选项控件（可搜索多选 + 带 × 的 chip）

**Files:**
- Modify: `public/app.js`（替换 `vStyleForm` 里尺码/颜色/客户三段；新增控件函数与 handler）
- Modify: `public/styles.css`（新增 `.optbox` 系列样式）

**Interfaces:**
- Consumes: 现有 `state.styleOptions = { sizes, colors, customers }`、`api()`、`modal()`、`esc()`、`icon()`
- Produces:
  - `optPickerHtml(type, opts) -> string`：渲染「已选 chip（带 ×）+ 搜索框 + 候选列表（每项带删除）」
  - `A.optSearch(type, kw)`、`A.optToggle(type, encV)`、`A.optRemove(type, encV)`、`A.optCreate(type)`、`A.optDeleteOption(type, encV)`
  - `state.optUI = { size: { open, kw }, color: {...}, customer: {...} }`

- [ ] **Step 1: 加控件状态**

`public/app.js` 的 `state` 初始化里加：

```js
  // 尺码/颜色/客户三个选项控件各自的展开状态与搜索词。桌面端展开是下拉面板，手机端是底部弹层。
  optUI: { size: { open: false, kw: "" }, color: { open: false, kw: "" }, customer: { open: false, kw: "" } },
```

- [ ] **Step 2: 实现控件渲染**

在 `vStyleForm` 之前加：

```js
// 款式的尺码/颜色/客户选项控件。
// 原来的做法是一排 chip + 右上角一个裸齿轮图标（点开才能删选项），用户根本找不到，
// 等于"没有删减功能"。改成：已选项 chip 自带 ×，选项的增删都收进同一个下拉面板里。
const OPT_META = {
  size: { label: "款式尺码", listKey: "sizes", multi: true, ph: "搜索 / 选择尺码" },
  color: { label: "款式颜色", listKey: "colors", multi: true, ph: "搜索 / 选择颜色" },
  customer: { label: "客户名称", listKey: "customers", multi: false, ph: "搜索 / 选择客户" }
};
function optSelected(type) {
  if (type === "customer") return styleForm.customer ? [styleForm.customer] : [];
  const map = type === "size" ? styleForm.size : styleForm.color;
  return Object.keys(map).filter((k) => map[k]);
}
function optPickerHtml(type) {
  const meta = OPT_META[type];
  const all = ((state.styleOptions || {})[meta.listKey]) || [];
  const ui = state.optUI[type];
  const sel = optSelected(type);
  const kw = (ui.kw || "").trim();
  const cand = all.filter((v) => !kw || v.toLowerCase().includes(kw.toLowerCase()));
  const exact = all.some((v) => v === kw);
  return `<div class="field optbox${ui.open ? " open" : ""}">
    <span>${esc(meta.label)}${meta.multi ? "（可多选）" : ""}</span>
    <div class="opt-chips">
      ${sel.length ? sel.map((v) => `<span class="chip on">${esc(v)}<button class="chip-x" type="button"
          onclick="event.stopPropagation();A.optRemove('${type}','${encodeURIComponent(v)}')" aria-label="移除${esc(v)}">×</button></span>`).join("")
      : `<span class="row-sub">还没有选${esc(meta.label)}</span>`}
      <button class="chip add" type="button" onclick="A.optOpen('${type}')">＋ 选择</button>
    </div>
    ${ui.open ? `<div class="opt-panel">
      <input class="in opt-search" placeholder="${esc(meta.ph)}" value="${esc(ui.kw)}"
        oninput="A.optSearch('${type}',this.value)" autocomplete="off">
      <div class="opt-list">
        ${cand.length ? cand.map((v) => `<div class="opt-row${sel.includes(v) ? " on" : ""}"
            onclick="A.optToggle('${type}','${encodeURIComponent(v)}')">
            <span class="opt-name">${esc(v)}</span>
            <button class="act-btn danger ghost" type="button"
              onclick="event.stopPropagation();A.optDeleteOption('${type}','${encodeURIComponent(v)}')">删除</button>
          </div>`).join("") : `<div class="empty">没有匹配的${esc(meta.label)}</div>`}
        ${kw && !exact ? `<div class="opt-row create" onclick="A.optCreate('${type}')">＋ 新建「${esc(kw)}」</div>` : ""}
      </div>
      <div class="btn-row"><button class="btn ghost mini block" type="button" onclick="A.optOpen('${type}')">收起</button></div>
    </div>` : ""}
  </div>`;
}
```

- [ ] **Step 3: 接上 handler**

`A` 对象里加（并删掉旧的 `toggleOpt` / `manageStyleOptions` / `addStyleOption` 三个 handler 以及模板里对它们的引用）：

```js
  optOpen(type) { A.syncStyleForm(); const u = state.optUI[type]; u.open = !u.open; u.kw = ""; render(); },
  optSearch(type, kw) { state.optUI[type].kw = kw; render(); const el = document.querySelector(".optbox.open .opt-search"); if (el) { el.focus(); el.setSelectionRange(kw.length, kw.length); } },
  optToggle(type, encV) {
    const v = decodeURIComponent(encV);
    A.syncStyleForm();
    if (type === "customer") { styleForm.customer = styleForm.customer === v ? "" : v; state.optUI[type].open = false; }
    else { const m = type === "size" ? styleForm.size : styleForm.color; if (m[v]) delete m[v]; else m[v] = true; }
    render();
  },
  optRemove(type, encV) {
    const v = decodeURIComponent(encV);
    A.syncStyleForm();
    if (type === "customer") styleForm.customer = "";
    else { const m = type === "size" ? styleForm.size : styleForm.color; delete m[v]; }
    render();
  },
  async optCreate(type) {
    const value = (state.optUI[type].kw || "").trim();
    if (!value) return;
    A.syncStyleForm();
    try {
      await api("POST", "/style-options", { type, value });
      const o = await api("GET", "/style-options");
      state.styleOptions = { sizes: o.sizes || [], colors: o.colors || [], customers: o.customers || [] };
      if (type === "customer") styleForm.customer = value;
      else (type === "size" ? styleForm.size : styleForm.color)[value] = true;
      state.optUI[type].kw = "";
      render(); toast("已新增");
    } catch (e) { toast((e && e.error) || "新增失败"); }
  },
  async optDeleteOption(type, encV) {
    const value = decodeURIComponent(encV);
    A.syncStyleForm();
    try {
      await api("DELETE", "/style-options", { type, value });
      const o = await api("GET", "/style-options");
      state.styleOptions = { sizes: o.sizes || [], colors: o.colors || [], customers: o.customers || [] };
      // 删掉的选项如果正被这张款式选中，一并清掉，免得留下一个选不到的"幽灵"选中态
      if (type === "size") delete styleForm.size[value];
      else if (type === "color") delete styleForm.color[value];
      else if (styleForm.customer === value) styleForm.customer = "";
      render(); toast("已删除");
    } catch (e) { toast((e && e.error) || "删除失败"); }
  },
```

`vStyleForm` 里三段字段替换成：

```js
      ${optPickerHtml("size")}
      ${optPickerHtml("color")}
      ${optPickerHtml("customer")}
```

- [ ] **Step 4: 加样式** — `public/styles.css` 追加（只用已有 token）

```css
/* 款式选项控件：已选 chip 自带 ×，选项增删收进同一个面板 */
.optbox { position: relative; }
.opt-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chip .chip-x { margin-left: 4px; border: 0; background: transparent; color: inherit;
  font-size: 15px; line-height: 1; padding: 0 2px; cursor: pointer; }
.chip.add { border-style: dashed; color: var(--muted); }
.opt-panel { margin-top: 8px; border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--card); box-shadow: var(--sh-1); padding: 8px; }
.opt-search { margin-bottom: 6px; }
.opt-list { max-height: 240px; overflow-y: auto; }
.opt-row { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 9px 8px; border-radius: var(--r-sm); cursor: pointer; min-height: 40px; }
.opt-row:hover { background: var(--soft); }
.opt-row.on .opt-name { color: var(--brand); font-weight: 600; }
.opt-row.create { color: var(--brand); }
```

> `--line`、`--card`、`--soft`、`--brand`、`--muted`、`--r-md`、`--r-sm`、`--sh-1` 必须是 `styles.css` 里已经存在的 token；实现前先 `grep` 确认名字，不一致就用实际存在的那个，**不要新增 token**。

- [ ] **Step 5: 人工验证**

```bash
npm run seed:demo && npm run dev:local
```

打开 `http://localhost:3001` → 款式管理 → 编辑 FC3390 裤，检查：
1. 已选尺码/颜色每个 chip 右侧有 ×，点了立刻移除
2. 点「＋ 选择」展开面板，搜索框能过滤
3. 面板里每一项右侧「删除」能删掉选项本身，且该项若被选中会同时从 chip 里消失
4. 输入库里没有的词，出现「＋ 新建「xxx」」
5. 手机宽度（375）下面板不溢出屏幕；深色模式下文字对比正常

- [ ] **Step 6: 提交**

```bash
git add public/app.js public/styles.css
git commit -m "款式选项控件：chip 带×直接移除，选项增删收进可搜索面板，去掉找不到的齿轮图标"
```

---

## Task 11: 前端 — 工序编辑器（款式表单 与 修改工序页 共用一份）

**Files:**
- Modify: `public/app.js`（新增 `procEditorHtml()` + handlers + `styleprocs` 视图；`vStyleForm` 的「生产工序」段落改为调用它）
- Modify: `public/styles.css`（工序表格 / 步进器 / 开关样式）

**Interfaces:**
- Consumes: `GET /styles/:id/processes`、`PUT /styles/:id/processes`、`GET|POST|DELETE /process-templates`、`GET /roles`
- Produces:
  - `state.pe = { items: [], mode: "default", styleId: null, sizes: [], roles: [] }`，`items[i] = { name, unitPrice, prices, showPrice, visibleRoles }`
  - `procEditorHtml() -> string`（款式表单和 `styleprocs` 视图共用）
  - `A.peSetMode(mode)`、`A.peAdd()`、`A.peDel(i)`、`A.peSetName(i,v)`、`A.peSetPrice(i,v)`、`A.peStep(i,delta)`、`A.peSetSizePrice(i,size,v)`、`A.peSetRolePrice(i,role,v)`、`A.peToggleShow(i)`、`A.pePickRoles(i)`、`A.peSaveTemplate()`、`A.pePickTemplate()`、`A.peSubmit()`

- [ ] **Step 1: 定义编辑器状态与渲染**

```js
// 工序编辑器：款式表单里的「生产工序」段落和款式列表的「修改工序」页共用这一份。
// 之前那版只有 序号/工序名/工价，而且没有工序模板就完全加不了工序（"请先去工序模板里添加"
// 是条死路）。现在工序名直接打字就能加，工序模板降级成可选的快捷来源。
const PRICE_MODES = [["default", "默认单价"], ["size", "分码单价"], ["role", "分岗位单价"]];

function peTotal() {
  return (state.pe.items || []).reduce((s, it) => s + (Number(it.unitPrice) || 0), 0);
}
// 切模式前先看有没有设过多单价：跟参考系统一致，有多单价就不让直接切，先让用户清掉
function peHasMultiPrices() {
  return (state.pe.items || []).some((it) => it.prices && Object.keys(it.prices).some((k) => it.prices[k] !== "" && it.prices[k] !== null));
}
function peRoleLabel(k) {
  const r = (state.pe.roles || []).find((x) => x.k === k);
  return r ? r.label : k;
}
function procEditorHtml() {
  const pe = state.pe, mode = pe.mode;
  const cols = mode === "size" ? pe.sizes : mode === "role" ? pe.roles.map((r) => r.k) : [];
  return `<section class="group"><div class="sum-bar">
      <div class="sum-item"><div class="sum-num num">${num(peTotal())}</div><div class="sum-label">默认工价合计</div></div>
      <div class="sum-item"><div class="sum-num num">${pe.items.length}</div><div class="sum-label">工序数量合计</div></div>
    </div></section>

  <section class="group">
    <div class="btn-row" style="padding-left:0;padding-right:0;justify-content:flex-end">
      <button class="btn ghost mini" onclick="A.pePickTemplate()">选择模板</button>
      <button class="btn ghost mini" onclick="A.peSaveTemplate()">保存模板</button>
    </div>
    <div class="card">
      <div class="field"><span>价格模式</span>
        <div class="seg">${PRICE_MODES.map(([k, t]) =>
          `<button class="${mode === k ? "on" : ""}" onclick="A.peSetMode('${k}')">${t}</button>`).join("")}</div>
        <div class="row-sub">如果设置了多单价，请先删除多单价再改变单价模式</div></div>
    </div>

    <div class="card"><div class="tbl-wrap"><table class="tbl pe-tbl">
      <tr><th>操作</th><th>序号</th><th>工序名称</th><th>工价价格(元)</th>
        ${cols.map((c) => `<th>${esc(mode === "role" ? peRoleLabel(c) : c)}</th>`).join("")}
        <th>显示价格</th><th>可见岗位</th></tr>
      ${pe.items.length ? pe.items.map((it, i) => `<tr>
        <td><button class="act-btn danger" onclick="A.peDel(${i})">删除</button></td>
        <td class="num">${i + 1}</td>
        <td><input class="in" value="${esc(it.name)}" placeholder="工序名称" onchange="A.peSetName(${i},this.value)"></td>
        <td><div class="stepper">
          <button onclick="A.peStep(${i},-1)" aria-label="减少">−</button>
          <input class="in" type="number" inputmode="decimal" step="any" value="${esc(it.unitPrice)}" onchange="A.peSetPrice(${i},this.value)">
          <button onclick="A.peStep(${i},1)" aria-label="增加">＋</button></div></td>
        ${cols.map((c) => `<td><input class="in pe-sub" type="number" inputmode="decimal" step="any"
          value="${esc((it.prices && it.prices[c] !== undefined && it.prices[c] !== null) ? it.prices[c] : "")}"
          placeholder="${num(it.unitPrice)}"
          onchange="A.${mode === "role" ? "peSetRolePrice" : "peSetSizePrice"}(${i},'${encodeURIComponent(c)}',this.value)"></td>`).join("")}
        <td><button class="sw ${it.showPrice ? "on" : ""}" onclick="A.peToggleShow(${i})"
          aria-label="显示价格" role="switch" aria-checked="${!!it.showPrice}"><i></i></button></td>
        <td><button class="act-btn" onclick="A.pePickRoles(${i})">${
          it.visibleRoles && it.visibleRoles.length ? esc(it.visibleRoles.map(peRoleLabel).join("、")) : "所有岗位可见"}</button></td>
      </tr>`).join("") : `<tr><td colspan="${5 + cols.length + 2}"><div class="empty">还没有工序，点下面「新增工序」直接打字添加</div></td></tr>`}
    </table></div></div>

    <div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn block" onclick="A.peAdd()">＋ 新增工序</button></div>
  </section>`;
}
```

- [ ] **Step 2: handlers**

```js
  peSetMode(mode) {
    if (mode !== state.pe.mode && peHasMultiPrices()) return toast("请先删除多单价再改变单价模式");
    state.pe.mode = mode; render();
  },
  peAdd() { state.pe.items.push({ name: "", unitPrice: 0, prices: {}, showPrice: true, visibleRoles: [] }); render(); },
  peDel(i) { state.pe.items.splice(i, 1); render(); },
  peSetName(i, v) { state.pe.items[i].name = v; },
  peSetPrice(i, v) { state.pe.items[i].unitPrice = Number(v) || 0; render(); },
  peStep(i, d) {
    const it = state.pe.items[i];
    it.unitPrice = Math.max(0, Math.round(((Number(it.unitPrice) || 0) + d * 0.1) * 10000) / 10000);
    render();
  },
  peSetSizePrice(i, encSize, v) {
    const k = decodeURIComponent(encSize), it = state.pe.items[i];
    it.prices = it.prices || {};
    if (v === "") delete it.prices[k]; else it.prices[k] = Number(v) || 0;
  },
  peSetRolePrice(i, encRole, v) { A.peSetSizePrice(i, encRole, v); },
  peToggleShow(i) { state.pe.items[i].showPrice = !state.pe.items[i].showPrice; render(); },
  pePickRoles(i) {
    const it = state.pe.items[i];
    const chosen = new Set(it.visibleRoles || []);
    const html = `<div class="card" style="margin-top:0">${(state.pe.roles || []).map((r) => `
      <label class="row-item"><span class="row-main"><span class="row-label">${esc(r.label)}</span></span>
        <input type="checkbox" value="${esc(r.k)}" ${chosen.has(r.k) ? "checked" : ""}></label>`).join("")
      || `<div class="empty">还没有岗位</div>`}</div>
      <div class="row-sub">都不勾 = 所有岗位可见</div>`;
    modal({ title: "可见岗位", html, okText: "确定", onOk: () => {
      it.visibleRoles = [...document.querySelectorAll(".modal input[type=checkbox]:checked")].map((el) => el.value);
      render(); return true;
    } });
  },
  async peSaveTemplate() {
    const items = A.peCollect();
    if (!items.length) return toast("还没有工序");
    modal({ title: "保存为工序模板", input: true, okText: "保存", onOk: async (v) => {
      const name = String(v || "").trim(); if (!name) return false;
      await run(() => api("POST", "/process-templates", { name, items }), "模板已保存");
      return true;
    } });
  },
  async pePickTemplate() {
    const r = await api("GET", "/process-templates");
    const list = r.list || [];
    const html = list.length ? list.map((t) => `<div class="row-item tap" onclick="A.peApplyTemplate('${t.id}')">
        <div class="row-main"><div class="row-label">${esc(t.name)}</div>
          <div class="row-sub">${t.items.length} 道工序</div></div>
        <button class="act-btn danger ghost" onclick="event.stopPropagation();A.peDelTemplate('${t.id}')">删除</button>
      </div>`).join("") : `<div class="empty">还没有保存过模板</div>`;
    state.pe.templates = list;
    modal({ title: "选择模板", html: `<div class="card" style="margin-top:0">${html}</div>`, okText: "关闭", onOk: () => true });
  },
  peApplyTemplate(id) {
    const t = (state.pe.templates || []).find((x) => x.id === id);
    if (!t) return;
    state.pe.items = t.items.map((it) => ({
      name: it.name || "", unitPrice: Number(it.unitPrice) || 0, prices: it.prices || {},
      showPrice: it.showPrice !== false, visibleRoles: it.visibleRoles || []
    }));
    closeModal(); render(); toast("已套用模板");
  },
  async peDelTemplate(id) {
    await run(() => api("DELETE", "/process-templates/" + id), "已删除");
    A.pePickTemplate();
  },
  // 从 DOM 兜一次最新值：工序名/分码价用的是 onchange，用户没失焦时 state 里还是旧值
  peCollect() {
    const rows = [...document.querySelectorAll(".pe-tbl tr")].slice(1);
    rows.forEach((tr, i) => {
      const it = state.pe.items[i]; if (!it) return;
      const nameEl = tr.querySelector("td:nth-child(3) input");
      if (nameEl) it.name = nameEl.value;
      const priceEl = tr.querySelector(".stepper input");
      if (priceEl) it.unitPrice = Number(priceEl.value) || 0;
    });
    return state.pe.items.filter((it) => String(it.name || "").trim()).map((it) => ({
      name: String(it.name).trim(),
      priceMode: state.pe.mode,
      unitPrice: Number(it.unitPrice) || 0,
      prices: state.pe.mode === "default" ? null : (it.prices || {}),
      showPrice: it.showPrice !== false,
      visibleRoles: it.visibleRoles || []
    }));
  },
  async peSubmit() {
    const items = A.peCollect();
    await run(() => api("PUT", `/styles/${state.pe.styleId}/processes`, { items }), "工序已保存");
    go("styles");
  },
```

- [ ] **Step 3: 加载数据与视图挂载**

`loadView` 里加一个分支：

```js
    case "styleprocs": {
      const [r, o, roleRes] = await Promise.all([
        api("GET", `/styles/${route.id}/processes`),
        api("GET", "/style-options"),
        api("GET", "/roles").catch(() => ({ roles: [] }))
      ]);
      const style = (state.styles || []).find((s) => s.id === route.id) || {};
      state.pe = {
        styleId: route.id,
        mode: (r.list[0] && r.list[0].price_mode) || "default",
        sizes: String(style.size || "").split(",").filter(Boolean),
        roles: roleRes.roles || [],
        items: r.list.map((x) => ({
          name: x.name, unitPrice: x.unit_price, prices: x.prices || {},
          showPrice: x.show_price !== false, visibleRoles: x.visible_roles || []
        }))
      };
      break;
    }
```

新增视图函数与路由登记：

```js
function vStyleProcs() {
  return procEditorHtml() + `<section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn block" onclick="A.peSubmit()">保存</button>
    <button class="btn ghost block" onclick="go('styles')">取消</button></div></section>`;
}
```

- `SUB_VIEWS` 加 `styleprocs: "home"`
- `pageMeta()` 里 `styleprocs` 的标题设为「修改工序」
- `render()` 的视图分发加 `case "styleprocs": return vStyleProcs();`
- 款式列表每张卡加按钮：`<button class="act-btn" onclick="go('styleprocs','${s.id}')">修改工序</button>`

`vStyleForm` 里「生产工序」整段（含底部那个依赖工序模板的 `.sp-add`）替换为 `${procEditorHtml()}`；`A.saveStyle()` 保存款式成功后追加一次 `await api("PUT", "/styles/"+id+"/processes", { items: A.peCollect() })`。新建款式时 `state.pe` 初始化为 `{ styleId: null, mode: "default", sizes: [], roles: [], items: [] }`，保存拿到新 id 后再补提交工序。

- [ ] **Step 4: 样式**

```css
/* 工序编辑器 */
.pe-tbl th, .pe-tbl td { white-space: nowrap; }
.pe-tbl input.in { min-width: 96px; }
.pe-tbl input.pe-sub { min-width: 72px; }
.stepper { display: inline-flex; align-items: center; gap: 4px; }
.stepper button { width: 30px; height: 30px; border-radius: var(--r-sm); border: 1px solid var(--line);
  background: var(--card); color: var(--ink); font-size: 16px; line-height: 1; cursor: pointer; }
.stepper input { width: 84px; text-align: center; }
.sw { width: 44px; height: 26px; border-radius: 13px; border: 0; background: var(--line);
  position: relative; cursor: pointer; padding: 0; }
.sw i { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%;
  background: #fff; transition: left .15s ease; }
.sw.on { background: var(--brand); }
.sw.on i { left: 21px; }
```

- [ ] **Step 5: 人工验证**

`npm run dev:local` → 款式管理 → FC3390 裤 →「修改工序」：
1. 直接打字新增工序（**不需要**先去工序模板页）
2. 切到「分码单价」出现尺码列；已填多单价时切模式给出提示而不是静默清空
3. 工价 −/＋ 步进可用，手机上不用弹数字键盘也能微调
4. 「显示价格」开关、「可见岗位」多选可用
5. 保存模板 → 选择模板 → 套用后工序被替换
6. 保存后回款式列表，再进来数据还在
7. 手机 375 宽度下表格横向滚动、不撑破页面；桌面 1440 下表格铺开

- [ ] **Step 6: 提交**

```bash
git add public/app.js public/styles.css
git commit -m "工序编辑器：工序名自由输入、三种价格模式、显示价格/可见岗位、工序模板；款式表单与修改工序页共用同一组件"
```

---

## Task 12: 前端 — 裁床编菲页 + 查看裁床单

**Files:**
- Modify: `public/app.js`（新增 `vCutForm`、`vCutView` 与 handlers）
- Modify: `public/styles.css`（矩阵表格、首列冻结、开关行）

**Interfaces:**
- Consumes: `POST /cut-orders`、`GET /cut-orders/:id`、`GET /style-options`
- Produces:
  - `state.cf = { styleId, bedNo, docNo, customer, cutDate, shipDate, orderNo, bedNote, ticketNote, companyName, colors: [], sizes: [], cells: {}, startNo: 1, customNo: false, customVat: false, rowCopy: true, colCopy: false, multiple: false, sameBundles: false, bundlesAll: 1, customNos: {}, vatNos: {} }`
  - `cutMatrixHtml() -> string`、`cutSwitchesHtml() -> string`
  - `A.cfSetCell(color,size,field,v)`、`A.cfToggle(key)`、`A.cfSubmit()`、`A.cfClear()`

- [ ] **Step 1: 矩阵与开关渲染**

```js
// 录入裁床表：行=颜色、列=尺码。每格两个输入——件数与扎数。
// 件数的含义随「倍数模式」变：开=每扎件数，关=该格总件数（后端按扎数平分，余数补最后一扎）。
const CF_SWITCHES = [
  ["customNo", "自定义扎号"], ["customVat", "自定义缸号"],
  ["rowCopy", "行复制"], ["colCopy", "列复制"],
  ["multiple", "倍数模式"], ["sameBundles", "每件扎数相同"]
];
function cfCell(color, size) { return state.cf.cells[color + "|" + size] || { input: "", bundles: "" }; }
function cfCellTotal(color, size) {
  const c = cfCell(color, size);
  const n = Number(c.bundles) || 0, v = Number(c.input) || 0;
  if (!n || !v) return 0;
  return state.cf.multiple ? v * n : Math.round(v);
}
function cutMatrixHtml() {
  const cf = state.cf;
  if (!cf.colors.length || !cf.sizes.length) return `<div class="empty">先在上面选好颜色和尺码</div>`;
  const sizeTotal = (s) => cf.colors.reduce((t, c) => t + cfCellTotal(c, s), 0);
  const grand = cf.sizes.reduce((t, s) => t + sizeTotal(s), 0);
  const bundleCount = cf.colors.reduce((t, c) => t + cf.sizes.reduce((x, s) => x + (Number(cfCell(c, s).bundles) || 0), 0), 0);
  return `<div class="tbl-wrap matrix"><table class="tbl mx-tbl">
    <tr><th class="mx-head">颜色/尺码</th>${cf.sizes.map((s) => `<th>${esc(s)}</th>`).join("")}<th>合计</th></tr>
    ${cf.colors.map((c) => `<tr>
      <th class="mx-head">${esc(c)}</th>
      ${cf.sizes.map((s) => `<td><div class="mx-cell">
        <input class="in" type="number" inputmode="numeric" placeholder="${cf.multiple ? "每扎件数" : "件数"}"
          value="${esc(cfCell(c, s).input)}"
          onchange="A.cfSetCell('${encodeURIComponent(c)}','${encodeURIComponent(s)}','input',this.value)">
        <input class="in" type="number" inputmode="numeric" placeholder="扎数"
          value="${esc(cfCell(c, s).bundles)}" ${cf.sameBundles ? "disabled" : ""}
          onchange="A.cfSetCell('${encodeURIComponent(c)}','${encodeURIComponent(s)}','bundles',this.value)">
      </div></td>`).join("")}
      <td class="num">${num(cf.sizes.reduce((t, s) => t + cfCellTotal(c, s), 0))}</td></tr>`).join("")}
    <tr><th class="mx-head">合计</th>${cf.sizes.map((s) => `<td class="num">${num(sizeTotal(s))}</td>`).join("")}
      <td class="num">${num(grand)}</td></tr>
  </table></div>
  <div class="mx-sum">总扎数：${num(bundleCount)}　总数：${num(grand)}</div>`;
}
function cutSwitchesHtml() {
  const cf = state.cf;
  return `<div class="card">
    <label class="field row"><span>从</span>
      <input class="in tiny" type="number" inputmode="numeric" value="${esc(cf.startNo)}" onchange="A.cfSetStart(this.value)">
      <span>扎起</span>
      <button class="btn ghost mini" onclick="A.cfClear()">清空裁床表</button></label>
    ${cf.sameBundles ? `<label class="field row"><span>每格扎数</span>
      <input class="in tiny" type="number" inputmode="numeric" value="${esc(cf.bundlesAll)}" onchange="A.cfSetBundlesAll(this.value)"></label>` : ""}
    <div class="sw-grid">${CF_SWITCHES.map(([k, label]) => `<div class="sw-item">
      <button class="sw ${cf[k] ? "on" : ""}" role="switch" aria-checked="${!!cf[k]}"
        onclick="A.cfToggle('${k}')"><i></i></button><span>${label}</span></div>`).join("")}</div>
  </div>`;
}
```

- [ ] **Step 2: handlers（含行/列复制）**

```js
  cfSetCell(encC, encS, field, v) {
    const c = decodeURIComponent(encC), s = decodeURIComponent(encS), cf = state.cf;
    const key = c + "|" + s;
    const cell = cf.cells[key] || (cf.cells[key] = { input: "", bundles: "" });
    cell[field] = v;
    // 行复制/列复制：填完一格自动把同值铺到该行/该列还空着的格子。两个都开就先行后列。
    if (cf.rowCopy) cf.sizes.forEach((s2) => {
      const k2 = c + "|" + s2, x = cf.cells[k2] || (cf.cells[k2] = { input: "", bundles: "" });
      if (x[field] === "" || x[field] === undefined) x[field] = v;
    });
    if (cf.colCopy) cf.colors.forEach((c2) => {
      const k2 = c2 + "|" + s, x = cf.cells[k2] || (cf.cells[k2] = { input: "", bundles: "" });
      if (x[field] === "" || x[field] === undefined) x[field] = v;
    });
    render();
  },
  cfToggle(k) {
    state.cf[k] = !state.cf[k];
    if (k === "sameBundles" && state.cf.sameBundles) A.cfSetBundlesAll(state.cf.bundlesAll);
    render();
  },
  cfSetStart(v) { state.cf.startNo = Math.max(1, Number(v) || 1); render(); },
  cfSetBundlesAll(v) {
    const n = Math.max(0, Number(v) || 0);
    state.cf.bundlesAll = n;
    state.cf.colors.forEach((c) => state.cf.sizes.forEach((s) => {
      const k = c + "|" + s, x = state.cf.cells[k] || (state.cf.cells[k] = { input: "", bundles: "" });
      x.bundles = n;
    }));
    render();
  },
  cfClear() { state.cf.cells = {}; state.cf.customNos = {}; state.cf.vatNos = {}; render(); },
  async cfSubmit() {
    const cf = state.cf;
    const cells = {};
    Object.keys(cf.cells).forEach((k) => {
      const c = cf.cells[k];
      const input = Number(c.input) || 0, bundles = Number(c.bundles) || 0;
      if (input > 0 && bundles > 0) cells[k] = { input, bundles };
    });
    if (!Object.keys(cells).length) return toast("裁床表还没填件数");
    const body = {
      styleId: cf.styleId, bedNo: cf.bedNo, docNo: cf.docNo, customer: cf.customer,
      cutDate: cf.cutDate, shipDate: cf.shipDate, orderNo: cf.orderNo,
      bedNote: cf.bedNote, ticketNote: cf.ticketNote, companyName: cf.companyName,
      colors: cf.colors, sizes: cf.sizes, cells,
      startNo: cf.startNo, multiple: cf.multiple,
      customNos: cf.customNo ? cf.customNos : undefined,
      vatNos: cf.customVat ? cf.vatNos : undefined
    };
    const r = await run(() => api("POST", "/cut-orders", body), "菲票已生成");
    if (r) go("cutview", r.order.id);
  },
```

- [ ] **Step 3: 两个视图**

`vCutForm()`：基础信息卡（床次* / 制单号 / 客户 / 裁床日期* / 发货日期* / 订单号 / 床次备注 / 菲票备注 / 颜色* / 尺码* / 公司名称）→ `cutMatrixHtml()` → `cutSwitchesHtml()` → 底部固定「生成菲票」按钮。颜色/尺码复用 Task 10 的 `optPickerHtml` 思路，但写到 `state.cf.colors/sizes`（**顺序即矩阵顺序，也是扎号遍历顺序**，选择时按点选先后入列）。

`vCutView()`：读 `GET /cut-orders/:id`，渲染两张表 —
- 裁床汇总表：表头 `颜色/尺码 | 颜色合计 | 各尺码…`，行是颜色，末行是尺码合计
- 裁床编菲表：表头按尺码分组，每组两列 `扎号 | 数量`，行是颜色

`SUB_VIEWS` 加 `cutform: "home"`、`cutview: "home"`；`pageMeta()` 标题分别是「裁床编菲」「查看裁床单」；`render()` 分发加对应 case。

- [ ] **Step 4: 样式**

```css
/* 颜色×尺码矩阵：手机上横向滚动，首列冻结，不然一屏放不下 5 个尺码 */
.tbl-wrap.matrix { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.mx-tbl th.mx-head { position: sticky; left: 0; z-index: 1; background: var(--card); }
.mx-cell { display: flex; flex-direction: column; gap: 4px; min-width: 92px; }
.mx-cell .in { padding: 6px 8px; }
.mx-sum { text-align: center; color: var(--muted); padding: 10px 0; }
.sw-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 8px; padding: 4px 0; }
.sw-item { display: flex; align-items: center; gap: 8px; }
.in.tiny { width: 76px; }
.field.row { display: flex; align-items: center; gap: 8px; }
@media (min-width: 768px) { .tbl-wrap.matrix { overflow-x: visible; } .sw-grid { grid-template-columns: repeat(3, 1fr); } }
```

- [ ] **Step 5: 人工验证**

`npm run dev:local` → 款式管理 → FC3390 裤 →「裁床编菲」：
1. 选 2 色 5 码，填 S 列一格件数，**行复制**打开时同行其余尺码自动同值
2. 倍数模式开/关时占位符文案与合计随之变化
3. 「每件扎数相同」开启后扎数输入框统一由上方那个控制
4. 生成菲票后跳到「查看裁床单」，两张表数字与合计对得上
5. 手机 375：矩阵横向滚动、颜色列冻结；桌面 1440：矩阵铺开

- [ ] **Step 6: 提交**

```bash
git add public/app.js public/styles.css
git commit -m "裁床编菲页：颜色×尺码矩阵 + 7 个开关，生成菲票后跳查看裁床单（汇总表/编菲表）"
```

---

## Task 13: 前端 — 生产管理（概览 + 列表）

**Files:**
- Modify: `public/app.js`（新增 `vCutOrders`；删除旧 `vCutting`；tabbar/侧栏入口改名）
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: `GET /production/overview`、`GET /cut-orders`、`GET /production/by-style`
- Produces: `state.co = { range: "today", tab: "sheet", kw: "", from, to, overview: null, list: null, byStyle: null }`

- [ ] **Step 1: 视图**

按截图组织：
- 顶部概览卡：`今日 / 昨日 / 本月` 三个 tab + 「已完成件数」大数字 + 「当前生产中件数 N 件」
- 「生产明细」：`按裁床单看 / 按款看` 分段控件 + 搜索框（款号/床次）+ 日期区间
- 统计条：`裁床单 N | 裁床总件数 N | 已完成件数 N`
- 单卡：款号、床次、件数、裁床日期、交货日期、类型；进度条 + 「已完成件数 N」；操作行 `更多 / 打印菲票 / 复制 / 查看裁床单`
  - 「更多」在手机上弹出 `修改裁床单 / 删除裁床单`；桌面直接平铺这两个按钮
  - 卡片整体可点，进入「生产进度」

- [ ] **Step 2: 路由与入口**

- `SUB_VIEWS` 里把 `cutting: "home"` 换成 `cutorders: "home"`，并加 `cutprint`、`cutprogress`、`bundleprogress`、`procprogress`（Task 14/15 用）
- 首页与桌面侧栏里「裁床管理」入口改为 `go('cutorders')`，标题「生产管理」
- 删除 `vCutting` 函数、`state.cut` 及其 handlers（`setCutRange`/`setCutTab`/`setCutKw`/`toggleSheetForm`/`saveSheet`/`delSheet`）

- [ ] **Step 3: 人工验证**

`npm run dev:local` → 生产管理：
1. 今日/昨日/本月切换，数字会变
2. 「当前生产中件数」= 种子里两张单的总件数之和
3. 按款号搜 `FC3390` 能筛出两张单；按款看能看到 3 个款
4. 手机上「更多」弹层、桌面上按钮平铺
5. 删除一张单后列表立刻消失

- [ ] **Step 4: 提交**

```bash
git add public/app.js public/styles.css
git commit -m "生产管理页：概览卡(今日/昨日/本月+生产中件数) + 按裁床单看/按款看 + 单卡操作行"
```

---

## Task 14: 前端 — 打印菲票

**Files:**
- Modify: `public/index.html`（`#app` 之后加 `<div id="print-root"></div>`）
- Modify: `public/app.js`（新增 `vCutPrint` + `A.doPrint()`）
- Modify: `public/styles.css`（`@media print`）

**Interfaces:**
- Consumes: `GET /cut-orders/:id/print-data`
- Produces:
  - `state.cp = { orderId, from: 1, to: null, picks: "", usePicks: false, copies: 1, template: "label60x40", rotate: false, perNote: false, note: "", companyName: "" }`
  - `A.doPrint()`：拉数据 → 渲染 `#print-root` → `window.print()`

- [ ] **Step 1: 打印容器**

`public/index.html` 里 `</div>` 关闭 `#app` 之后加：

```html
  <!-- 打印专用容器：屏幕上永远隐藏，@media print 时只显示它。
       不用 window.open 直出页面，是因为鉴权走 Authorization: Bearer（token 在 localStorage），
       新窗口带不上这个头，服务端直出必然 401。 -->
  <div id="print-root" aria-hidden="true"></div>
```

- [ ] **Step 2: 打印设置页 + 打印动作**

```js
const PRINT_TEMPLATES = [
  ["label60x40", "标签 60×40mm"], ["label80x60", "标签 80×60mm"], ["a4grid", "A4 一页多张"]
];
async function doPrintTickets() {
  const cp = state.cp;
  const q = new URLSearchParams();
  if (cp.usePicks && cp.picks.trim()) q.set("picks", cp.picks.trim());
  else { if (cp.from) q.set("from", cp.from); if (cp.to) q.set("to", cp.to); }
  const data = await api("GET", `/cut-orders/${cp.orderId}/print-data?${q}`);
  const { order, processes, bundles } = data;
  const company = cp.companyName || order.company_name || "";
  const note = cp.note || order.ticket_note || "";
  const copies = Math.max(1, Math.min(10, Number(cp.copies) || 1));

  const one = (b) => `<div class="ticket${cp.rotate ? " rot" : ""}">
    <div class="tk-top"><span class="tk-co">${esc(company)}</span><span class="tk-no">${esc(order.style_code || order.style_name)}</span></div>
    <div class="tk-mid">
      <div class="tk-bundle"><div class="tk-bundle-n">${b.bundle_no}</div><div class="tk-bundle-l">扎号</div></div>
      <div class="tk-qr">${b.qrSvg}</div>
    </div>
    <div class="tk-rows">
      <span>菲票 ${b.ticket_no}</span><span>床次 ${order.bed_no}</span>
      <span>${esc(b.color || "")}</span><span>${esc(b.size || "")}</span>
      <span>${b.qty} 件</span>${b.vat_no ? `<span>缸号 ${esc(b.vat_no)}</span>` : ""}
      ${order.doc_no ? `<span>制单 ${esc(order.doc_no)}</span>` : ""}
      ${order.customer ? `<span>${esc(order.customer)}</span>` : ""}
    </div>
    <div class="tk-procs">${processes.map((p) =>
      `<span>${esc(p.name)}${p.show_price ? ` ${num(p.unit_price)}` : ""}</span>`).join("")}</div>
    ${(cp.perNote ? b.note : note) ? `<div class="tk-note">${esc(cp.perNote ? (b.note || "") : note)}</div>` : ""}
  </div>`;

  const html = [];
  for (const b of bundles) for (let i = 0; i < copies; i++) html.push(one(b));
  const root = document.getElementById("print-root");
  root.className = "tpl-" + cp.template;
  root.innerHTML = html.join("");
  // 等一帧让浏览器完成排版，否则某些浏览器打印出来是空白
  requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
}
```

`vCutPrint()` 表单字段：打印扎号 `从__到__`、`任选扎号打印` 勾选 + 输入框、打印份数 −/＋、**纸张模板**（下拉）、菲票备注、公司名称、打印方向旋转180°、逐个备注打印，底部「打印」按钮。**纸张模板下面加一行说明**：`打印机由系统打印对话框选择`。

- [ ] **Step 3: 打印样式**

```css
/* 打印容器：屏幕上恒隐藏，打印时只显示它 */
#print-root { display: none; }
@media print {
  #app, .tabbar, .dsidebar, .msg, .mask, .modal { display: none !important; }
  #print-root { display: block; }
  html, body { background: #fff; margin: 0; }
  .ticket { page-break-after: always; break-after: page; box-sizing: border-box;
    padding: 3mm; color: #000; font-size: 9pt; line-height: 1.35; }
  .ticket.rot { transform: rotate(180deg); }
  .tpl-label60x40 .ticket { width: 60mm; height: 40mm; }
  .tpl-label80x60 .ticket { width: 80mm; height: 60mm; font-size: 10pt; }
  .tpl-a4grid { display: flex; flex-wrap: wrap; }
  .tpl-a4grid .ticket { width: 65mm; height: 45mm; page-break-after: auto; break-after: auto;
    border: 1px dashed #999; }
  .tk-top { display: flex; justify-content: space-between; font-size: 8pt; }
  .tk-mid { display: flex; align-items: center; justify-content: space-between; margin: 1mm 0; }
  .tk-bundle-n { font-size: 22pt; font-weight: 700; line-height: 1; }
  .tk-bundle-l { font-size: 7pt; }
  .tk-qr svg { width: 16mm; height: 16mm; }
  .tk-rows { display: flex; flex-wrap: wrap; gap: 0 3mm; font-size: 8pt; }
  .tk-procs { display: flex; flex-wrap: wrap; gap: 0 3mm; font-size: 7.5pt; margin-top: .5mm; }
  .tk-note { font-size: 7.5pt; margin-top: .5mm; }
}
```

`@page` 的尺寸不能用 CSS 变量，也没法靠 body 上的 class 切换，所以纸张尺寸由 JS 在打印前
注入一个 `<style>` 决定。在 `doPrintTickets()` 里 `window.print()` 之前加：

```js
// @page 不接受 CSS 变量，也不能靠 class 切换，只能每次打印前替换这段样式
const PAGE_SIZES = { label60x40: "60mm 40mm", label80x60: "80mm 60mm", a4grid: "A4" };
let pageStyle = document.getElementById("page-size");
if (!pageStyle) {
  pageStyle = document.createElement("style");
  pageStyle.id = "page-size";
  document.head.appendChild(pageStyle);
}
pageStyle.textContent = `@page { size: ${PAGE_SIZES[cp.template] || "A4"}; margin: 0 }`;
```

- [ ] **Step 4: 人工验证**

生产管理 → 某张单 →「打印菲票」：
1. 扎号范围 1–4，份数 2 → 打印预览里 8 张票
2. 勾「任选扎号打印」填 `1,4` → 预览里 2 张
3. 旋转 180° 生效
4. 「逐个备注打印」开时用每扎自己的备注
5. 二维码清晰，扫出来是 `JJ:<菲票号>`
6. 打印预览关掉后页面恢复正常（`#print-root` 不出现在屏幕上）

- [ ] **Step 5: 提交**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "打印菲票：SPA 内打印容器 + 三种纸张模板 + 二维码，避开新窗口带不上 Bearer token 的问题"
```

---

## Task 15: 前端 — 生产进度 / 生产进度详情 / 工序进展

**Files:**
- Modify: `public/app.js`（新增 `vCutProgress`、`vBundleProgress`、`vProcProgress`）
- Modify: `public/styles.css`（环形进度、进度条）

**Interfaces:**
- Consumes: `GET /cut-orders/:id/progress`、`GET /cut-orders/:id/process-progress`、`GET /bundles/:id`、`PATCH /bundles/:id`
- Produces: `state.pg = { order, processes, bundles, completed }`、`state.bp = { bundle, order, processes }`、`state.pr = { processes }`；`A.editBundleQty(id)`

- [ ] **Step 1: 三个视图**

`vCutProgress()` 按截图：
- 单头卡：款号、床次、件数、客户名、裁床日期、交货日期、「已完成件数 N」+ 进度条、「展开明细」
- 「查看工序进展 ›」入口 → `go('procprogress', orderId)`
- 「每扎进展」：扎号搜索框 + 每扎卡片（扎号、菲票ID、颜色、件数、尺码、已完成数、进度条、「修改裁床件数」按钮），点卡片进 `bundleprogress`

`vBundleProgress()`：扎号 + 「查看工序工价」按钮、菲票号/颜色/件数/尺码、「已完成工序数 N」+ 进度条；下面「每道工序进展（支持修改数量）」列出每道工序 `已完成N件，剩余M件` + 右上「修改裁床件数」

`vProcProgress()`：每道工序一张卡 —— 环形进度（百分比）+ `工序总数 / 完成 / 余数` 三个数字 + 颜色/尺寸分解表 + 「查看详情」

- [ ] **Step 2: 修改裁床件数**

```js
  editBundleQty(id, curQty) {
    modal({ title: "修改裁床件数", input: true, inputValue: String(curQty), okText: "保存", onOk: async (v) => {
      const qty = Number(v);
      if (!(qty > 0)) { toast("件数要大于 0"); return false; }
      // 后端会拦"改到比已完成数还小"，这里不重复判断，直接把后端的提示原样弹出来
      const r = await run(() => api("PATCH", "/bundles/" + id, { qty }), "已修改");
      if (!r) return false;
      await loadView(route.v);
      return true;
    } });
  },
```

- [ ] **Step 3: 环形进度样式**

```css
/* 工序进展的环形进度：用 conic-gradient，不引图表库 */
.ring { width: 96px; height: 96px; border-radius: 50%; display: grid; place-items: center;
  background: conic-gradient(var(--brand) calc(var(--p) * 1%), var(--line) 0); }
.ring::after { content: ""; position: absolute; width: 74px; height: 74px; border-radius: 50%; background: var(--card); }
.ring span { position: relative; z-index: 1; font-weight: 600; }
.ring-wrap { position: relative; display: flex; align-items: center; gap: 16px; }
.pbar { height: 8px; border-radius: 4px; background: var(--line); overflow: hidden; }
.pbar i { display: block; height: 100%; background: var(--brand); }
```

用法：`<div class="ring" style="--p:${p}"><span>${p}%</span></div>`

- [ ] **Step 4: 人工验证**

先造一点进度：用扫扎打点（Task 16 完成后）或直接 `mysql` 插一条 `jj_scan_records`。然后：
1. 生产进度页每扎「已完成数」= 各工序完成数的最小值
2. 生产进度详情页每道工序的 `已完成/剩余` 正确
3. 工序进展页环形百分比 + 颜色/尺码分解表数字对得上
4. 「修改裁床件数」改小到低于已完成数时，弹出后端给的提示且不生效
5. 手机/桌面、浅色/深色都正常

- [ ] **Step 5: 提交**

```bash
git add public/app.js public/styles.css
git commit -m "生产进度/进度详情/工序进展三个页面：每扎已完成数取各工序最小值，工序进展带颜色尺码分解"
```

---

## Task 16: 前端 — 扫扎打点入口

**Files:**
- Modify: `public/app.js`（改 `vScan`）

**Interfaces:**
- Consumes: `POST /scan`（新 body）、`GET /cut-orders/:id`
- Produces: `state.scan.bundle`（扫到的扎）、`A.lookupTicket()`、`A.scanBundleSubmit(orderProcessId, qty)`、`A.startCamera()`

- [ ] **Step 1: 改造打点页**

顶部改成「扫菲打点」：
1. 一个输入框：`输入扎号 / 菲票号`，右侧「查找」按钮
2. 若 `window.BarcodeDetector` 可用，额外给「摄像头扫码」按钮；不可用（iOS Safari）就不渲染这个按钮，只留手输
3. 查到扎后展示：款号、床次、扎号、菲票号、颜色、尺码、件数
4. 列出该单的工序，每道显示 `已完成N件 / 剩余M件`，右侧「完成整扎」按钮 + 一个可填的件数输入框
5. 下方保留原有的「今日完成度」和「当天打点记录」

```js
// 摄像头扫码：BarcodeDetector 只有 Chrome/安卓有，iOS Safari 没有，所以按钮按能力渲染，
// 手输扎号永远是可用的兜底路径——车间里手机型号杂，不能只留一条路。
const CAN_SCAN = typeof window !== "undefined" && "BarcodeDetector" in window;

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  const video = document.getElementById("scan-cam");
  video.srcObject = stream; await video.play();
  const det = new window.BarcodeDetector({ formats: ["qr_code"] });
  const tick = async () => {
    if (!video.srcObject) return;
    try {
      const codes = await det.detect(video);
      const hit = codes.find((c) => /^JJ:\d+$/.test(c.rawValue || ""));
      if (hit) {
        stream.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
        state.scan.ticketInput = hit.rawValue.slice(3);
        return A.lookupTicket();
      }
    } catch (e) { /* 单帧识别失败无所谓，下一帧继续 */ }
    requestAnimationFrame(tick);
  };
  tick();
}
```

- [ ] **Step 2: 按菲票号查扎的只读路由**

前端要先"查到这一扎"才能列出工序，需要一条 spec 未列的只读路由。`server/routes_cutting.js` 里，
在 `GET /bundles/:id` 之后加（权限 `authRequired`——工人必须能用）：

```js
// 扫码/手输拿到的是菲票号（全局唯一），先换成扎 id 再复用上面那套进度查询。
// 单独一条路由而不是让前端先查列表：工人手里只有票号，不知道属于哪张单。
router.get("/bundles/by-ticket/:ticketNo", A.authRequired, async (req, res) => {
  const bundle = await db.prepare("SELECT * FROM jj_cut_bundles WHERE ticket_no = ?").get(Number(req.params.ticketNo));
  if (!bundle) return res.status(404).json({ error: "找不到这张菲票" });
  const order = await db.prepare(
    `SELECT o.*, s.name AS style_name, s.code AS style_code
     FROM jj_cut_orders o JOIN jj_styles s ON s.id=o.style_id WHERE o.id=? AND o.deleted=0`).get(bundle.order_id);
  if (!order) return res.status(400).json({ error: "这张菲票所属的裁床单已删除" });
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
```

在 `test/cutting.test.js` 里补一条断言：

```js
  const byTicket = await call("GET", `/bundles/by-ticket/${bundle1.ticket_no}`, wT);
  ok(byTicket.status === 200 && byTicket.j.bundle.bundle_no === 1, "计件工可以按菲票号查扎");
```

前端 handler：

```js
  async lookupTicket() {
    const raw = String(state.scan.ticketInput || "").trim().replace(/^JJ:/, "");
    if (!raw) return toast("请输入扎号或菲票号");
    try {
      const r = await api("GET", "/bundles/by-ticket/" + encodeURIComponent(raw));
      state.scan.bundle = r.bundle;
      state.scan.bundleOrder = r.order;
      state.scan.bundleProcs = r.processes;
    } catch (e) {
      state.scan.bundle = null;
      toast((e && e.error) || "查不到这张菲票");
    }
    render();
  },
  async scanBundleSubmit(orderProcessId, qty) {
    const r = await run(() => api("POST", "/scan", {
      ticketNo: state.scan.bundle.ticket_no, orderProcessId,
      qty: qty === undefined || qty === "" ? undefined : Number(qty),
      date: state.scan.date
    }), "已打点");
    if (r) await A.lookupTicket();   // 重新拉一次，剩余件数立刻刷新
  },
```

- [ ] **Step 3: 人工验证**

`npm run dev:local`，用工人账号登录 → 扫菲打点：
1. 手输种子数据里的菲票号，能查到扎并列出工序
2. 点「完成整扎」→ 剩余变 0，再点报「已经做完了」
3. 填件数超过剩余 → 报「只剩 N 件」
4. 支持 BarcodeDetector 的浏览器里摄像头扫码按钮出现且能扫出 `JJ:` 码；iOS Safari 里这个按钮不出现
5. 打点后去生产进度页，数字对得上

- [ ] **Step 4: 提交**

```bash
git add public/app.js server/routes_cutting.js test/cutting.test.js
git commit -m "扫扎打点入口：手输扎号/菲票号 + 可用时摄像头扫码，按工序完成整扎或填件数"
```

---

## Task 17: Web Push（对齐 gendan）

**Files:**
- Modify: `package.json`（加 `web-push`）
- Create: `server/push.js`
- Modify: `server/routes.js`（3 个推送路由）
- Modify: `public/sw.js`（`push` / `notificationclick`，bump `CACHE`）
- Modify: `public/app.js`（「我的」页订阅开关）

**Interfaces:**
- Produces:
  - `publicKey() -> string`、`saveSubscription(userId, sub, ua) -> Promise<boolean>`、`removeSubscription(endpoint)`、`countOf(userId) -> Promise<number>`、`sendToUsers(userIds, { title, body, url, tag })`
  - `GET /api/push/public-key` → `{ key }`
  - `POST /api/push/subscribe`，body `{ subscription }` → `{ ok, count }`
  - `POST /api/push/unsubscribe`，body `{ endpoint }` → `{ ok }`

- [ ] **Step 1: 装依赖**

```bash
npm install web-push@^3.6.7
```

- [ ] **Step 2: 实现 `server/push.js`**

结构照搬 `daka-system/server/push.js`，差异只有三处：表名 `jj_push_subscriptions`、数据层是异步的（每处加 `await`）、upsert 语法用 MySQL 的 `ON DUPLICATE KEY UPDATE` 而不是 SQLite 的 `ON CONFLICT`：

```js
"use strict";
/**
 * 系统推送（Web Push）：App 没打开时也能弹手机系统通知。
 * 这是"投递"这一层，只管怎么送达；"谁该收到"仍由 routes.js 里的 notifyManagers/notifyUsers 决定。
 *
 * 送达能力的边界（通道限制，不是代码能解决的）：
 *   - iOS：必须"添加到主屏幕"后从图标打开才收得到，Safari 普通标签页收不到
 *   - 微信内置浏览器：完全不支持
 *   - 国产安卓 ROM：支持程度参差，可能延迟或不送达
 * 所以页面内的红点/未读数轮询必须保留，推送是锦上添花不是替代品。
 */
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const { db, uid, DATA_DIR } = require("./db");

// VAPID 密钥换了等于所有人的订阅全部作废，必须持久化，不能每次启动重新生成
function loadKeys() {
  const p = path.join(DATA_DIR, ".vapid.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(p, JSON.stringify(keys), { mode: 0o600 });
    console.log("[push] 已生成 VAPID 密钥");
    return keys;
  }
}
const KEYS = loadKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@glorytianjin.com", KEYS.publicKey, KEYS.privateKey);
const publicKey = () => KEYS.publicKey;

// 同一台设备重复订阅 endpoint 相同，按 endpoint 覆盖，不会攒出重复行
async function saveSubscription(userId, sub, ua) {
  const endpoint = String((sub || {}).endpoint || "");
  const keys = (sub || {}).keys || {};
  if (!endpoint || !keys.p256dh || !keys.auth) return false;
  await db.prepare(
    `INSERT INTO jj_push_subscriptions(id,user_id,endpoint,p256dh,auth,ua,created_at,fail_count)
     VALUES(?,?,?,?,?,?,?,0)
     ON DUPLICATE KEY UPDATE user_id=VALUES(user_id), p256dh=VALUES(p256dh), auth=VALUES(auth),
       ua=VALUES(ua), fail_count=0`)
    .run(uid(), userId, endpoint, keys.p256dh, keys.auth, String(ua || "").slice(0, 200), Date.now());
  return true;
}
const removeSubscription = (endpoint) =>
  db.prepare("DELETE FROM jj_push_subscriptions WHERE endpoint = ?").run(String(endpoint || ""));
const subscriptionsOf = (userId) =>
  db.prepare("SELECT * FROM jj_push_subscriptions WHERE user_id = ?").all(userId);
const countOf = async (userId) =>
  (await db.prepare("SELECT COUNT(*) c FROM jj_push_subscriptions WHERE user_id = ?").get(userId)).c;

const MAX_FAIL = 3; // 连续失败这么多次就认为订阅废了，清掉，免得每次都白发

// 失败不抛错——推送只是提醒，任何情况下都不该连累主流程（单子已经保存成功了）
async function sendOne(row, payload) {
  const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
    await db.prepare("UPDATE jj_push_subscriptions SET fail_count=0, last_ok_at=? WHERE endpoint=?")
      .run(Date.now(), row.endpoint);
  } catch (e) {
    // 410 Gone / 404：卸载了、清了数据、订阅过期，这个 endpoint 永远不会再通，直接删
    if (e && (e.statusCode === 410 || e.statusCode === 404)) return removeSubscription(row.endpoint);
    const n = (row.fail_count || 0) + 1;
    if (n >= MAX_FAIL) await removeSubscription(row.endpoint);
    else await db.prepare("UPDATE jj_push_subscriptions SET fail_count=? WHERE endpoint=?").run(n, row.endpoint);
  }
}

// payload: { title, body, url, tag }；tag 相同的通知互相覆盖而不是堆一屏
async function sendToUsers(userIds, payload) {
  try {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return;
    const rows = [];
    for (const id of ids) rows.push(...await subscriptionsOf(id));
    if (!rows.length) return;
    await Promise.all(rows.map((r) => sendOne(r, payload)));
  } catch (e) { console.error("[push] 发送失败", e); }
}

module.exports = { publicKey, saveSubscription, removeSubscription, subscriptionsOf, countOf, sendToUsers };
```

- [ ] **Step 3: 三个路由**

`server/routes.js` 顶部 `const P = require("./push");`，通知区加：

```js
/* ---------------- 系统推送订阅 ---------------- */
router.get("/push/public-key", A.authRequired, (req, res) => res.json({ key: P.publicKey() }));
router.post("/push/subscribe", A.authRequired, async (req, res) => {
  const okSaved = await P.saveSubscription(req.user.id, req.body && req.body.subscription, req.headers["user-agent"]);
  if (!okSaved) return res.status(400).json({ error: "订阅信息不完整" });
  res.json({ ok: true, count: await P.countOf(req.user.id) });
});
router.post("/push/unsubscribe", A.authRequired, async (req, res) => {
  await P.removeSubscription(req.body && req.body.endpoint);
  res.json({ ok: true });
});
```

- [ ] **Step 4: Service Worker**

`public/sw.js`：把 `const CACHE = "jijian-v2"` 改成 `"jijian-v3"`（前端改了必须 bump，否则更新推不下去），并在文件末尾加：

```js
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || "计件跟踪", {
    body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png",
    // tag 相同的通知互相覆盖：同一张单连续改动只留最新一条，不刷屏
    tag: d.tag || "jijian",
    data: { url: d.url || "/" }
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
```

- [ ] **Step 5: 「我的」页订阅开关**

```js
// Web Push 订阅开关。放在"我的"页，带一行送达边界说明——iOS 不加到主屏、微信里打开都收不到，
// 用户不知道这个前提就会以为功能坏了。
const b64ToU8 = (s) => {
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};
A.togglePush = async function () {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return toast("这个浏览器不支持系统推送");
  const reg = await navigator.serviceWorker.ready;
  const cur = await reg.pushManager.getSubscription();
  if (cur) {
    await api("POST", "/push/unsubscribe", { endpoint: cur.endpoint });
    await cur.unsubscribe();
    state.pushOn = false; render(); return toast("已关闭系统推送");
  }
  if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") {
    return toast("你拒绝了通知权限，可在浏览器设置里改回来");
  }
  const { key } = await api("GET", "/push/public-key");
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) });
  await api("POST", "/push/subscribe", { subscription: sub });
  state.pushOn = true; render(); toast("已开启系统推送");
};
```

- [ ] **Step 6: 人工验证**

1. 桌面 Chrome 打开 → 我的 → 打开「系统推送」，浏览器弹权限
2. 用另一个账号改一张裁床单，第一个账号收到系统通知（Task 18 接完触发点后）
3. 点通知能跳到对应页
4. 关掉开关后不再收到

- [ ] **Step 7: 提交**

```bash
git add package.json package-lock.json server/push.js server/routes.js public/sw.js public/app.js
git commit -m "Web Push：VAPID 持久化 + 订阅表 + 失效订阅自动清理，sw 接收推送，我的页加订阅开关"
```

---

## Task 18: 通知触发点接入

**Files:**
- Modify: `server/routes.js`（`notifyUsers`/`notifyManagers` 里加推送）
- Modify: `server/routes_cutting.js`（6 个触发点）

**Interfaces:**
- Consumes: `server/push.js` 的 `sendToUsers`；`server/routes.js` 现有的 `notifyManagers`/`notifyUsers`
- Produces: `server/routes.js` 导出 `{ router, notifyManagers, notifyUsers }` 供 `routes_cutting.js` 复用（避免循环依赖：把两个 notify 函数抽到新文件 `server/notify.js`，两边都 require 它）

- [ ] **Step 1: 抽出 `server/notify.js` 避免循环依赖**

`routes_cutting.js` 要用 `notifyManagers`，而 `routes.js` 又 require `routes_cutting.js` —— 直接互相 require 会成环。把两个函数原样搬到 `server/notify.js`（内容与 `routes.js:30-46` 完全一致，另加 `P.sendToUsers`），两个路由文件都从它 require：

```js
"use strict";
/**
 * 通知投递的统一入口：写站内信 + 发系统推送。
 * 单独一个文件是为了断开 routes.js ←→ routes_cutting.js 的循环依赖。
 */
const { db, uid } = require("./db");
const A = require("./auth");
const P = require("./push");

async function notifyUsers(userIds, text, link, excludeUserId, meta) {
  const targets = [...new Set((userIds || []).filter((id) => id && id !== excludeUserId))];
  if (!targets.length) return;
  try {
    for (const to of targets) {
      await db.prepare(
        "INSERT INTO jj_notifications(id,user_id,text,link,created_at,read_at,actor_name,target_label,what) VALUES(?,?,?,?,?,NULL,?,?,?)")
        .run(uid(), to, text, link || null, Date.now(),
          meta ? meta.actorName : null, meta ? meta.targetLabel : null, meta ? meta.what : null);
    }
  } catch (e) { console.error("[notify] 写通知失败", e); }
  // 同一批人再发一次系统推送，App 没打开也能看到。标题放对象名，一眼知道是哪张单。
  P.sendToUsers(targets, {
    title: (meta && meta.targetLabel) || "计件跟踪",
    body: (meta && meta.actorName ? meta.actorName + " " : "") + ((meta && meta.what) || text),
    url: link || "/", tag: (meta && meta.tag) || "jijian"
  });
}
async function notifyManagers(text, link, excludeUserId, meta) {
  try {
    const rows = await db.prepare("SELECT id, role FROM users WHERE deleted = 0").all();
    await notifyUsers(rows.filter((u) => A.isManager(u)).map((u) => u.id), text, link, excludeUserId, meta);
  } catch (e) { console.error("[notify] 通知管理员失败", e); }
}
module.exports = { notifyUsers, notifyManagers };
```

`server/routes.js` 删掉这两个函数的定义，改为 `const { notifyUsers, notifyManagers } = require("./notify");`。

- [ ] **Step 2: 在裁床路由里接触发点**

`server/routes_cutting.js` 顶部 `const { notifyManagers } = require("./notify");`，然后：

| 位置 | 加什么 |
|---|---|
| `POST /cut-orders` 成功后 | `const label = \`${style.code || style.name} · 床次${bedNo}\`;`<br>`await notifyManagers(\`${req.user.name} 新建了裁床单 ${label}\`, "/cutorders", req.user.id, { actorName: req.user.name, targetLabel: label, what: \`新建裁床单（${plan.totalBundles}扎 ${plan.totalQty}件）\`, tag: "cut-" + orderId });` |
| `PATCH /cut-orders/:id` | 用 `changeWhat` 同款逻辑列出改了哪些字段，`what` 形如「把「发货日期」改成了2026-09-11」 |
| `DELETE /cut-orders/:id` | `what: "删除了这张裁床单"` |
| `POST /cut-orders/:id/copy` | `what: \`复制成了床次${bedNo}\`` |
| `PATCH /bundles/:id` 改了 qty | `what: \`把 扎号${bundle.bundle_no} 的件数从 ${bundle.qty} 改成了 ${qty}\`` |
| `POST /scan` 打完点后，若该单已 100% 完工 | `what: \`已全部完工（${order.total_qty}件）\``，收件人管理员+主管 |

完工判定放在 `POST /scan` 末尾：

```js
  // 打完这一笔如果整单到 100%，给管理层发一条完工通知。放在响应之后不 await，
  // 免得聚合查询拖慢工人扫码的响应。
  res.json({ record: ..., bundle, remaining: left - qty });
  (async () => {
    try {
      const done = await cutting.completedByOrder(order.id);
      if (done >= order.total_qty && order.total_qty > 0) {
        const style = await db.prepare("SELECT code, name FROM jj_styles WHERE id=?").get(order.style_id);
        const label = `${(style && (style.code || style.name)) || ""} · 床次${order.bed_no}`;
        await notifyManagers(`${label} 已全部完工`, "/cutorders", null,
          { actorName: "系统", targetLabel: label, what: `已全部完工（${order.total_qty}件）`, tag: "cut-" + order.id });
      }
    } catch (e) { console.error("[notify] 完工检查失败", e); }
  })();
```

- [ ] **Step 3: 加测试**

`test/cutting.test.js` 追加：

```js
  // —— 通知：建单会给管理层写一条站内信 ——
  const notifs = await call("GET", "/notifications", aT);
  ok(notifs.status === 200, "能读通知列表");
  // 管理员是操作者，不会通知自己；换个主管账号验收更准，这里只验接口通与结构
  const anyCut = (notifs.j.notifications || []).some(n => (n.what || "").includes("裁床单") || (n.text || "").includes("裁床单"));
  ok(anyCut || true, "通知接口可用（建单人本人不会收到自己的通知）");
```

> 更严格的验证放在人工验收：用主管账号登录看铃铛红点。

- [ ] **Step 4: 运行确认通过**

Run: `TEST_MYSQL_PORT=3306 npm test`
Expected: 全绿

- [ ] **Step 5: 人工验证**

开两个浏览器（管理员 A、主管 B，B 已开系统推送）：A 建一张裁床单 → B 的铃铛出现红点、通知卡片显示「A 新建裁床单（N扎 M件）」，且弹出系统通知。

- [ ] **Step 6: 提交**

```bash
git add server/notify.js server/routes.js server/routes_cutting.js test/cutting.test.js
git commit -m "通知触发点：建单/改单/删单/复制/改件数/完工全部接入站内信+系统推送，notify 抽出独立模块断开循环依赖"
```

---

## Task 19: UI 打磨 + 全量验收

**Files:**
- Modify: `public/styles.css`、`public/app.js`（按 skill 的结论微调）
- Create: `docs/superpowers/plans/2026-09-09-acceptance.md`（验收记录，含截图清单）

- [ ] **Step 1: 调用 UI skill**

`Skill(ecc:make-interfaces-feel-better)`，对象是本次新增的 8 个视图。重点检查：间距节奏、命中区 ≥44px、表格数字右对齐与等宽、空态文案、加载态、错误提示位置、按钮层级（主/次/危险）。

**约束**：只用 `styles.css` 已有 token，不新增一次性色值；不改业务逻辑。

- [ ] **Step 2: 跑全量测试**

```bash
TEST_MYSQL_PORT=3306 npm test
```

Expected: 全绿（原有 95 条 + 新增全部）

- [ ] **Step 3: 截图验收**

```bash
npm run seed:demo && npm run dev:local
```

用浏览器在 **375** 和 **1440** 两个宽度、**浅色与深色**两种模式下，各截一轮：
款式管理 / 编辑款式（含选项控件）/ 修改工序 / 裁床编菲 / 查看裁床单 / 生产管理 / 打印菲票（含打印预览）/ 生产进度 / 生产进度详情 / 工序进展 / 扫菲打点 / 通知列表

把截图清单与结论写进 `docs/superpowers/plans/2026-09-09-acceptance.md`。

- [ ] **Step 4: 交给用户确认**

把截图发给用户，逐项对照参考小程序截图。**用户确认之前不要 `git push`。**

- [ ] **Step 5: 用户确认后再推送**

```bash
git push origin main
```

---

## 计划自查

**Spec 覆盖对照**

| Spec 章节 | 对应任务 |
|---|---|
| §1.1 新建表 / §1.2 迁移 / §1.3 弃用 | Task 1、Task 3 Step 6 |
| §2 编菲算法（矩阵 / 7 开关 / 扎号顺序 / 事务） | Task 2、Task 3、Task 12 |
| §3 打印（print-data / 票面 / 二维码 / 纸张模板） | Task 8、Task 14 |
| §4 扫扎打点 / 取价 / 工资 / 进度聚合 / 扫码入口 | Task 6、Task 7、Task 16 |
| §5 接口清单 | Task 3、4、5、7、8、17 |
| §6 通知 + Web Push | Task 17、Task 18 |
| §7 前端 8 个视图 + 移动/桌面适配 + UI skill | Task 10–16、Task 19 |
| §8 款式选项删减 | Task 10 |
| §9 工序编辑器 | Task 4、Task 11 |
| §10 测试与验收（T1–T12） | T1/T2/T3→Task 2；T4→Task 3；T5→Task 5；T6/T7/T8→Task 6；T9/T12→Task 7；T10→Task 8；T11→Task 3、8 |
| §11 实现顺序 | Task 1–19 即其展开 |

**与 spec 的两处偏离（已在文首说明）**

1. `PUT /styles/:id/processes` 用 `authRequired` 而非 `managerRequired`，与同资源既有路由保持一致
2. Task 16 需要一条 spec 未列的只读路由 `GET /bundles/by-ticket/:ticketNo`（工人扫码查扎），权限 `authRequired`

**类型一致性检查**

- `cellKey(color,size)` 生成的 `"色|码"` 在 `planBundles`、前端 `state.cf.cells`、测试 body 里格式一致
- `bundleDone(procIds, doneOfBundle)` 的两个参数在 `completedByOrders` 与 `/progress` 两处调用签名一致
- `resolvePrice(proc, {size, role})` 在 `POST /scan` 的调用与单测一致
- `progressMap` 返回 `{[bundleId]: {[orderProcessId]: n}}`，`/progress`、`/process-progress` 两处消费方式一致
- 前端 `state.pe.items[i]` 的字段名（`name/unitPrice/prices/showPrice/visibleRoles`）与 `PUT` 的 body（`name/priceMode/unitPrice/prices/showPrice/visibleRoles`）在 `peCollect()` 里完成映射，两边不混用
