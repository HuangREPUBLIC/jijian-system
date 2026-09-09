# 裁床编菲 / 菲票 / 生产进度 子系统设计

**日期**：2026-09-09
**状态**：已确认，待实现
**范围**：把参考小程序（码上记）的款式管理、裁床编菲、修改工序、同步工序、生产管理、打印菲票、生产进度七块功能，在 jijian-system 的网页端（手机 + 桌面）做到功能一致；补齐款式表单的选项删减与工序编辑器；加上 gendan 系统那样的 Web Push 消息通知。

---

## 0. 决策记录

实现时如果和下面任何一条冲突，先回来改设计，不要在代码里偷偷绕过。

| # | 决策 | 选项 | 理由 |
|---|---|---|---|
| D1 | 打点模型 | **扫扎号完成整扎** | 菲票带扎号二维码，工人扫码 → 选工序 → 该扎该工序完成。截图里的「生产进度详情 / 每道工序进展」只有这个模型能算出来。 |
| D2 | 进度存储 | **派生式（A1）** | 「某扎某工序完成多少」由 `jj_scan_records` 聚合得出，打点记录是唯一真相。不双写，杜绝进度表与工资表对不上账。 |
| D3 | 裁床单工序 | **下单快照（B1）** | 生成菲票时把款式工序拷贝一份存进裁床单。这正是「同步工序」按钮存在的前提；且改工价不会追溯改动已发工资。 |
| D4 | 打印 | **浏览器打印** | SPA 内的打印专用容器 + `@page` + `window.print()`，走系统打印对话框。网页没有蓝牙打印机 SDK；不服务端直出打印页，原因见 3.1（Bearer token 带不进新窗口）。 |
| D5 | 价格模式 | **三种全做** | 默认单价 / 分码单价 / 分岗位单价，外加「显示价格」开关和「可见岗位」。 |
| D6 | 工资口径 | **优先款式工价 + 快照** | 取价优先级：分岗 → 分码 → 款式工序默认 → 全局工序单价 → 0；取到的价写进打点记录，历史工资不被后续改价影响。 |
| D7 | 旧数据 | **丢弃** | 旧 `jj_cutting_sheets`（只有款式+数量+备注）从界面和代码下架。 |
| D8 | 权限 | **管理员 + 主管** | 建单 / 编菲 / 打印 / 改裁床件数限管理员和主管岗位；普通工人只能扫扎推进度、看自己的记录和工资。 |
| D9 | 交付 | **一次性做完再演示** | 本地库跑通 + 截图给用户确认后才 push。 |

---

## 1. 数据模型

### 1.1 新建表

所有表沿用现有约定：`id VARCHAR(64)` 主键（`uid()` 生成）、时间戳 `BIGINT` 毫秒、`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`。

#### `jj_cut_orders` — 裁床单（床次）

| 列 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) PK | |
| style_id | VARCHAR(64) NOT NULL | 关联款式 |
| bed_no | INT NOT NULL | 床次 |
| doc_no | VARCHAR(64) | 制单号 |
| customer | VARCHAR(255) | 客户 |
| cut_date | VARCHAR(16) NOT NULL | 裁床日期 `YYYY-MM-DD` |
| ship_date | VARCHAR(16) | 发货日期 |
| order_no | VARCHAR(64) | 订单号 |
| bed_note | VARCHAR(500) | 床次备注 |
| ticket_note | VARCHAR(500) | 菲票备注 |
| company_name | VARCHAR(255) | 公司名称，印在菲票上 |
| colors | MEDIUMTEXT | JSON 字符串数组，本单启用的颜色（有序） |
| sizes | MEDIUMTEXT | JSON 字符串数组，本单启用的尺码（有序） |
| total_bundles | INT NOT NULL DEFAULT 0 | 总扎数（冗余，列表页免聚合） |
| total_qty | DOUBLE NOT NULL DEFAULT 0 | 总件数（冗余） |
| source | VARCHAR(16) NOT NULL DEFAULT 'self' | 类型：`self`=自建 |
| created_by | VARCHAR(64) | |
| created_at | BIGINT NOT NULL | |
| deleted | TINYINT NOT NULL DEFAULT 0 | |

索引：`KEY idx_jjco_style (style_id)`、`KEY idx_jjco_date (cut_date)`、`KEY idx_jjco_deleted (deleted, cut_date)`。

**床次唯一性**：同一款式下 `bed_no` 不重复，由应用层判重（MySQL 不支持 `WHERE deleted=0` 的部分唯一索引，沿用 `users.phone` 的既有做法）。

#### `jj_cut_bundles` — 扎 / 菲票

| 列 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) PK | |
| order_id | VARCHAR(64) NOT NULL | |
| style_id | VARCHAR(64) NOT NULL | 冗余，按款统计免 join |
| bundle_no | INT NOT NULL | 扎号 |
| ticket_no | BIGINT NOT NULL | 菲票号，全局自增（截图里的 36091） |
| color | VARCHAR(64) | |
| size | VARCHAR(32) | |
| qty | DOUBLE NOT NULL | 裁床件数，可后续修改 |
| vat_no | VARCHAR(64) | 缸号 |
| note | VARCHAR(255) | 逐个备注 |
| created_at | BIGINT NOT NULL | |

索引：`UNIQUE KEY uq_jjcb_ticket (ticket_no)`、`UNIQUE KEY uq_jjcb_order_bundle (order_id, bundle_no)`、`KEY idx_jjcb_order (order_id)`。

**菲票号生成**：`settings` 表存 `jj_ticket_seq`，生成菲票时在事务内 `SELECT ... FOR UPDATE` 取号并递增；起始值 `36000`（贴近参考系统的量级，避免和现场已发的旧票号混淆时误读）。

#### `jj_cut_order_processes` — 裁床单的工序快照

| 列 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) PK | |
| order_id | VARCHAR(64) NOT NULL | |
| seq | INT NOT NULL | 序号 |
| name | VARCHAR(255) NOT NULL | 工序名称 |
| price_mode | VARCHAR(16) NOT NULL DEFAULT 'default' | `default` / `size` / `role` |
| unit_price | DOUBLE NOT NULL DEFAULT 0 | 默认单价 |
| prices | MEDIUMTEXT | JSON：`size` 模式 `{"S":1.2,...}`；`role` 模式 `{"tech_lead":1.2,...}` |
| show_price | TINYINT NOT NULL DEFAULT 1 | 是否对工人/菲票显示工价 |
| visible_roles | MEDIUMTEXT | JSON 岗位 key 数组；`null` 或空数组 = 所有岗位可见 |
| style_process_id | VARCHAR(64) | 来源款式工序 id，供「同步工序」比对 |
| created_at | BIGINT NOT NULL | |

索引：`KEY idx_jjcop_order (order_id, seq)`。

#### `jj_process_templates` — 工序模板（保存模板 / 选择模板）

| 列 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) PK | |
| name | VARCHAR(255) NOT NULL | 模板名 |
| items | MEDIUMTEXT NOT NULL | JSON 数组，元素为 `{name, price_mode, unit_price, prices, show_price, visible_roles}` |
| created_by | VARCHAR(64) | |
| created_at | BIGINT NOT NULL | |
| deleted | TINYINT NOT NULL DEFAULT 0 | |

注意与既有 `jj_processes`（单条工序模板，带标准定额/小时定额）区分：`jj_process_templates` 存的是**整套工序清单**，`jj_processes` 存的是**单个工序的定额参数**，两者都保留，用途不同。

#### `jj_push_subscriptions` — Web Push 订阅

| 列 | 类型 | 说明 |
|---|---|---|
| id | VARCHAR(64) PK | |
| user_id | VARCHAR(64) NOT NULL | |
| endpoint | VARCHAR(512) NOT NULL | |
| p256dh | VARCHAR(255) NOT NULL | |
| auth | VARCHAR(255) NOT NULL | |
| created_at | BIGINT NOT NULL | |

索引：`UNIQUE KEY uq_jjps_endpoint (endpoint(191))`、`KEY idx_jjps_user (user_id)`。

### 1.2 现有表迁移

全部写成 `information_schema` 判存在再 `ALTER TABLE ADD COLUMN` 的幂等迁移，放在 `server/db.js` 的 `init()` 里，紧跟已有的 2b/2c/2d 段落，编号续为 2e 起。

| 表 | 新增列 | 说明 |
|---|---|---|
| `jj_styles` | `has_cutting TINYINT NOT NULL DEFAULT 1` | 是否裁床 |
| `jj_styles` | `note VARCHAR(500)` | 款式备注（参考系统有，当前缺） |
| `jj_style_processes` | `name VARCHAR(255)` | 工序名称，允许自由输入 |
| `jj_style_processes` | `price_mode VARCHAR(16) NOT NULL DEFAULT 'default'` | |
| `jj_style_processes` | `prices MEDIUMTEXT` | |
| `jj_style_processes` | `show_price TINYINT NOT NULL DEFAULT 1` | |
| `jj_style_processes` | `visible_roles MEDIUMTEXT` | |
| `jj_scan_records` | `order_id VARCHAR(64)` | |
| `jj_scan_records` | `bundle_id VARCHAR(64)` | |
| `jj_scan_records` | `order_process_id VARCHAR(64)` | |
| `jj_scan_records` | `unit_price DOUBLE` | 打点时的价格快照 |

另需把 `jj_style_processes.process_id` 改为可空（`ALTER TABLE ... MODIFY process_id VARCHAR(64) NULL`），并对已有行回填 `name`（从 `jj_processes.name` 取），保证老数据在新界面上有名字可显示。

`jj_scan_records` 增加索引 `KEY idx_jjscan_bundle (bundle_id, order_process_id)`，进度聚合查询要用。

### 1.3 弃用

`jj_cutting_sheets` 表**保留在库里但不再读写**，相关路由（`/cutting-sheets*`、`/cutting/overview`）和前端 `vCutting` 视图删除。不执行 `DROP TABLE`——线上删表不可逆，留一张空表零风险。

---

## 2. 编菲算法（录入裁床表）

### 2.1 输入模型

矩阵：**行 = 颜色，列 = 尺码**。每格代表「该颜色该尺码的若干扎」，格子的数据结构是 `{ input, bundles }`：`bundles` 是扎数，`input` 的含义由「倍数模式」决定——开启时是**每扎件数**，关闭时是**该格总件数**（见下表）。

开关（全部按截图实现）：

| 开关 | 语义 |
|---|---|
| 从 N 扎起 | 起始扎号，默认 1 |
| 自定义扎号 | 关：自动连续编号；开：每扎可手填扎号（校验单内不重复） |
| 自定义缸号 | 开：每扎可填缸号 |
| 行复制 | 某格填完后，同一行其余空格自动同值 |
| 列复制 | 某格填完后，同一列其余空格自动同值 |
| 倍数模式 | 开：输入值 = 每扎件数，该格总件数 = 每扎件数 × 扎数；关：输入值 = 该格总件数，按扎数平分，余数补到最后一扎 |
| 每件扎数相同 | 开：所有格子共用同一个扎数，只需填一次 |

行复制与列复制可同时开启：先行后列，列复制只填仍为空的格子。

### 2.2 扎号编号顺序

```
for size of sizes:                    # 外层：尺码
  for k of 1..maxBundlesInThisSize:   # 中层：该尺码下的第几扎
    for color of colors:              # 内层：颜色轮转
      if 该 (color,size) 还有第 k 扎: 分配下一个扎号
```

**用截图数据验证过**：尺码 S 的扎号 1=223暗蓝(52)、2=331浅蓝条(26)、3=223暗蓝(36)、4=331浅蓝条(28)——颜色交替 ✓。223暗蓝 S 合计 52+36+52+36=176 ✓；331浅蓝条 S 合计 26+28+26+28=108 ✓。

### 2.3 生成菲票（事务）

`POST /cut-orders` 在一个 MySQL 事务里完成：

1. 校验：款式存在、床次未重复、颜色/尺码非空、至少一格有件数
2. 插入 `jj_cut_orders`
3. 按 2.2 的顺序批量插入 `jj_cut_bundles`（单条 `INSERT ... VALUES (...),(...)`，几百扎一次写完）
4. 从 `jj_style_processes` 拷贝工序到 `jj_cut_order_processes`（D3 快照）
5. 回填 `total_bundles` / `total_qty`
6. 提交后发通知（第 6 节）

失败整单回滚，不留半张单。

---

## 3. 打印菲票

### 3.1 为什么不能服务端直出打印页

本系统鉴权是 `Authorization: Bearer <token>`，token 存在 localStorage（`public/app.js:156`、`server/auth.js:39`）。`window.open("/print/tickets?...")` 打开的新窗口**带不上这个头**，服务端直出的打印页必然 401。绕开的办法（query 里塞 token、发一次性打印令牌）都是在鉴权上开口子，不做。

### 3.2 方案：SPA 内打印容器

1. 前端带 `Authorization` 调 `GET /cut-orders/:id/print-data?from=&to=&picks=&template=`，拿到 JSON：单头 + 命中的扎数组 + 工序快照 + **每扎的二维码 SVG 字符串**（服务端生成）
2. 前端把票面渲染进 SPA 里一个打印专用容器 `#print-root`
3. `@media print` 下隐藏 `#app`、只显示 `#print-root`；`@media screen` 下 `#print-root` 恒隐藏
4. 调 `window.print()`，走系统打印对话框

这样不新开窗口、不碰鉴权模型，手机和电脑都能用系统打印。

| 参数 | 说明 |
|---|---|
| `from` / `to` | 打印扎号范围 |
| `picks` | 任选扎号打印，逗号分隔，给了就忽略 from/to |
| `template` | `label60x40` / `label80x60` / `a4grid`，决定 `@page` 尺寸 |

份数（`copies`）、旋转 180°（`rotate`）、逐个备注（`perNote`）、统一菲票备注（`note`）都是**纯前端渲染参数**，不进请求。

打印 CSS 用 `@page { size: 60mm 40mm; margin: 0 }`（模板决定尺寸），每张票 `page-break-after: always`。`rotate` 开时给票面加 `transform: rotate(180deg)`。

### 3.3 票面内容

公司名称、款号 / 款名、床次、**扎号（大字）**、菲票号、颜色、尺码、件数、缸号、制单号、客户、二维码、工序清单、备注。

工序清单是否印工价：`show_price = 0` 的工序只印名字不印价。

### 3.4 二维码

服务端用 npm `qrcode` 生成 **内联 SVG**（不引 CDN，PWA 离线可印）。内容格式：`JJ:<ticket_no>`，前缀用于扫码时区分本系统的码。

### 3.5 与截图的差异（唯一一处）

截图里的「打印机」下拉，在网页端换成 **「纸张模板」**。浏览器无法枚举/指定打印机，打印机由系统打印对话框选择。UI 上要有一行说明文字，避免用户以为功能缺失。

---

## 4. 扫扎打点与工资

### 4.1 打点接口

`POST /scan` 扩展（向后兼容旧的自由打点 body）：

```
{ ticketNo?, orderId?, bundleNo?, orderProcessId, qty?, userId?, date? }
```

- 用 `ticketNo` 或 `(orderId, bundleNo)` 定位扎；两者都没有则走旧的自由打点分支
- `qty` 不传 = 该扎该工序的**剩余件数**（整扎完成）
- 服务端校验 `已完成 + qty <= 扎的 qty`，超额返回 400
- 代他人打点仍受 `canActAsAdmin` 限制（沿用现有逻辑）

### 4.2 取价优先级（D6）

```
1. 分岗单价   order_process.prices[打点人的 role]     （price_mode='role'）
2. 分码单价   order_process.prices[该扎的 size]       （price_mode='size'）
3. 工序默认单价 order_process.unit_price
4. 全局工序单价 jj_processes.unit_price               （仅旧的自由打点走这条）
5. 0
```

取到的价写进 `jj_scan_records.unit_price` 快照。

### 4.3 工资计算

`pieceWage()` 改为：

```sql
SELECT COALESCE(SUM(s.qty * COALESCE(s.unit_price, p.unit_price, 0)), 0) AS w
FROM jj_scan_records s
LEFT JOIN jj_processes p ON p.id = s.process_id
WHERE s.user_id = ? AND s.date LIKE ?
```

`JOIN` 改 `LEFT JOIN`（新记录的 `process_id` 可能为空），`unit_price` 为 NULL 的老记录自动回退全局单价——**历史工资一分不变**。

### 4.4 进度聚合（D2）

全部从 `jj_scan_records` 聚合，不建进度表：

| 视图 | 聚合方式 |
|---|---|
| 每扎每工序进度 | `GROUP BY bundle_id, order_process_id` |
| 每扎「已完成数」 | `MIN(该扎各工序的完成件数)`——所有工序都过了的件数 |
| 每扎「进度百分比」 | 已完全做完的工序数 / 该单工序总数（截图「已完成工序数 0」那一栏用这个） |
| 裁床单已完成件数 | 该单所有扎的「已完成数」求和 |
| 工序进展 | `GROUP BY order_process_id`，再按 `color, size` 分解（join `jj_cut_bundles`） |
| 生产管理概览 | 已完成件数按日期区间过滤；生产中件数 = 未完工裁床单的 `total_qty` 之和 |

「修改裁床件数」改的是 `jj_cut_bundles.qty`（分母），不碰打点记录（分子）。若改小到低于已完成数，返回 400 并提示。

### 4.5 扫码入口

- **网页**：输入框手输扎号 / 菲票号；浏览器支持 `BarcodeDetector`（Chrome / 安卓）时额外给「摄像头扫码」按钮，iOS Safari 自动退回手输
- **小程序**：`wx.scanCode` 拿到 `JJ:<ticket_no>` 后走同一个接口

---

## 5. 接口清单

权限：`M` = 管理员+主管（`A.managerRequired`），`U` = 任意登录用户。

### 裁床单

| 方法 | 路径 | 权 | 说明 |
|---|---|---|---|
| GET | `/cut-orders` | U | 列表，支持 `kw`(款号/床次)、`from`/`to`(裁床日期)、`styleId`、分页 |
| GET | `/cut-orders/:id` | U | 详情：单头 + 裁床汇总表 + 裁床编菲表 + 工序快照 |
| POST | `/cut-orders` | M | 创建 + 生成菲票（第 2.3 节事务） |
| PATCH | `/cut-orders/:id` | M | 改单头字段（不含颜色/尺码/扎） |
| DELETE | `/cut-orders/:id` | M | 软删（`deleted=1`），级联隐藏扎 |
| POST | `/cut-orders/:id/copy` | M | 复制成新床次（扎全部复制，菲票号重新取，进度清零） |
| GET | `/cut-orders/:id/progress` | U | 生产进度：按扎 |
| GET | `/cut-orders/:id/process-progress` | U | 工序进展：按工序 + 颜色/尺码分解 |

### 扎

| 方法 | 路径 | 权 | 说明 |
|---|---|---|---|
| GET | `/bundles/:id` | U | 生产进度详情：该扎每道工序完成/剩余 |
| PATCH | `/bundles/:id` | M | 修改裁床件数 / 缸号 / 备注 |

### 工序

| 方法 | 路径 | 权 | 说明 |
|---|---|---|---|
| GET | `/styles/:id/processes` | U | 款式工序（返回 price_mode/prices/show_price/visible_roles） |
| PUT | `/styles/:id/processes` | M | **整套覆盖保存**（工序编辑器一次提交，取代逐条 POST/PATCH/DELETE） |
| POST | `/styles/:id/processes/sync` | M | 同步工序到指定裁床单，body `{ orderIds: [] }` |
| GET | `/styles/:id/syncable-orders` | M | 「选择需要同步的裁床单」列表（床次/制单号/工序数/工价/裁单日期/已完成件数/百分比） |
| GET | `/process-templates` | U | 模板列表 |
| POST | `/process-templates` | M | 保存模板 |
| DELETE | `/process-templates/:id` | M | 删除模板 |

保留 `POST /styles/:id/processes`、`PATCH /style-processes/:id`、`DELETE /style-processes/:id` 供小程序端过渡期使用，网页端改用 `PUT`。

### 生产管理

| 方法 | 路径 | 权 | 说明 |
|---|---|---|---|
| GET | `/production/overview` | U | 今日/昨日/本月已完成件数 + 当前生产中件数 |
| GET | `/production/by-style` | U | 按款汇总 |

### 打印 / 推送

| 方法 | 路径 | 权 | 说明 |
|---|---|---|---|
| GET | `/cut-orders/:id/print-data` | M | 打印数据（含每扎二维码 SVG），前端自行排版打印 |
| GET | `/push/public-key` | U | VAPID 公钥 |
| POST | `/push/subscribe` | U | 保存订阅 |
| POST | `/push/unsubscribe` | U | 删除订阅 |

---

## 6. 通知（对齐 gendan）

### 6.1 Web Push

新建 `server/push.js`，结构照搬 `daka-system/server/push.js`：

- VAPID 密钥首次启动生成并持久化到 `DATA_DIR/.vapid.json`（沿用 `.jwt_secret` 的做法，密钥换了等于所有订阅作废）
- `sendToUsers(userIds, { title, body, url, tag })`
- 推送返回 404/410 时自动删除失效订阅
- 新增依赖 `web-push`

`public/sw.js` 补 `push` 和 `notificationclick` 事件处理；「我的」页加订阅开关。

**送达边界要在 UI 上写清楚**（照抄 gendan 的注释结论）：iOS 必须「添加到主屏幕」后才收得到；微信内置浏览器完全不支持；国产安卓 ROM 参差。所以页面内的红点/未读数轮询保留，推送是锦上添花。

### 6.2 触发点

全部走现有 `notifyManagers` / `notifyUsers`（写 `jj_notifications`，带 `actor_name` / `target_label` / `what` 三个结构化字段），并对同一批人调 `push.sendToUsers`。

| 事件 | 收件人 | 文案示例 |
|---|---|---|
| 新建裁床单 | 管理员+主管 | 张三 在 FC3390 裤 · 床次2 新建了裁床单（64扎 2272件） |
| 修改裁床单 | 管理员+主管 | 张三 在 FC3390 裤 · 床次2 修改了「发货日期」 |
| 删除裁床单 | 管理员+主管 | 张三 删除了 FC3390 裤 · 床次2 |
| 同步工序 | 管理员+主管 | 张三 把 FC3390 裤 的工序同步到了 2 张裁床单 |
| 修改款式工序 | 管理员+主管 | 张三 在 FC3390 裤 修改了工序（剪线 工价 0→1.2） |
| 修改裁床件数 | 管理员+主管 | 张三 把 床次2 扎号1 的件数从 29 改成了 28 |
| 裁床单完工 | 管理员+主管 | FC3390 裤 · 床次2 已全部完工（2272件） |

`link` 字段指向对应页面（如 `/cutorders`、`/cutprogress?id=xxx`），推送 `tag` 用 `cut-<orderId>`，同一张单连续改动覆盖不堆叠。

---

## 7. 前端视图

### 7.1 新增视图

| 视图 key | 标题 | 内容 |
|---|---|---|
| `cutorders` | 生产管理 | 概览卡（今日/昨日/本月 + 生产中件数）+ 按裁床单看 / 按款看 + 搜索 + 日期区间 + 统计条 + 单卡（更多/打印菲票/复制/查看裁床单） |
| `cutform` | 裁床编菲 | 基础信息 + 录入裁床表（矩阵 + 7 个开关）+ 生成菲票 |
| `cutview` | 查看裁床单 | 裁床汇总表（颜色×尺码）+ 裁床编菲表（扎号/数量） |
| `cutprint` | 打印菲票 | 扎号范围 / 任选扎号 / 份数 / 纸张模板 / 菲票备注 / 公司名称 / 旋转180° / 逐个备注 → 跳打印页 |
| `cutprogress` | 生产进度 | 单头 + 查看工序进展入口 + 每扎进展列表（含修改裁床件数） |
| `bundleprogress` | 生产进度详情 | 该扎每道工序完成/剩余 + 查看工序工价 |
| `procprogress` | 工序进展 | 每道工序环形进度 + 颜色/尺码分解表 |
| `styleprocs` | 修改工序 | 工序编辑器（第 9 节） |

在 `SUB_VIEWS` 里挂到 `home` 下，沿用现有 `go()` 路由与面包屑机制。

### 7.2 移动 / 桌面适配

- **手机**：沿用 `tabbar` + 卡片流。颜色×尺码矩阵放进 `overflow-x: auto` 容器横向滚动，首列（颜色名）用 `position: sticky; left: 0` 冻结
- **桌面**：沿用 `dsidebar`，矩阵直接铺开不滚动；单卡的操作按钮行内展开而非「更多」弹层
- 断点沿用 `styles.css` 现有的媒体查询，不新增断点

### 7.3 UI 实现要求

实现前端时调用 `ecc:make-interfaces-feel-better` skill 过一遍（间距、命中区、表格对齐、状态反馈、空态）。颜色 / 圆角 / 阴影**全部复用现有 CSS token**（`--on-blue`、`--on-soft`、`--ok-ink`、`--warn-soft` 等），不新增一次性色值。深色模式与浅色模式都要给到。

---

## 8. 款式选项的删减（可发现性修复）

**现状**：删除功能其实存在——标签右侧的齿轮图标打开弹窗可逐条删除，chip 再点一次可取消选中。但图标裸露无文字、太小，用户找不到，等于没有。

**改法**（对齐参考系统）：

1. **已选项做成带 × 的 chip**，点 × 直接取消选中，不依赖「再点一次」这种不可见的约定
2. **加可搜索多选控件**：`搜索/选择颜色`、`搜索/选择尺码`。桌面端是下拉面板，手机端点开是底部弹层
3. 下拉/弹层里每一项右侧带「删除」，把「选择选项」和「管理选项」合并到同一处，齿轮图标去掉
4. 客户名称同样改造（单选 + 可搜索 + 可删除选项）
5. 保留「新增」入口：下拉里输入未匹配的值时给「＋ 新建"xxx"」

后端 `/style-options` 三个接口不变。

---

## 9. 工序编辑器（共用组件）

**现状缺口**：款式表单的「生产工序」只有 `序号/工序名称/工价/操作`，且没有 `jj_processes` 工序模板时完全加不了工序（"请先去「工序模板」里添加"是死路）。

**补齐清单**：

| 缺的 | 补法 |
|---|---|
| 工序名称不能自由输入 | `jj_style_processes.name` + `process_id` 可空 → 直接打字就能加工序；工序模板降级为「可选的快捷来源」 |
| 没有价格模式 | 单选 `默认单价 / 分码单价 / 分岗位单价`。切换模式时若已设过多单价，提示「请先删除多单价再改模式」（与参考系统一致） |
| 工价没有步进器 | 工价输入框加 `−／＋` 按钮 |
| 没有「显示价格」开关 | `show_price` 列，控制菲票打印与工人端是否露出工价 |
| 没有「可见岗位」 | `visible_roles` JSON 多选岗位，默认「所有岗位可见」；岗位列表取自 `settings.roles` |
| 没有 选择模板 / 保存模板 | `jj_process_templates` 表 + 两个按钮 |
| 合计 | 底部显示「默认工价合计」+「工序数合计」（现有，保留） |

**关键约束**：这套编辑器实现为**一个共用组件**，款式表单里的「生产工序」段落和款式列表里的「修改工序」页用同一份渲染 + 同一个 `PUT /styles/:id/processes` 提交路径，**不写两遍**。

分码单价的尺码来源 = 该款式已选的尺码；分岗单价的岗位来源 = `settings.roles`。

---

## 10. 测试与验收

### 10.1 本地环境

- 本地 MariaDB（已在 127.0.0.1:3306 运行）建库 `jijian_dev`
- `scripts/seed_demo.js` 造与截图对齐的演示数据：
  - 款式 `FC3390 裤` / `FC3390-1 RIGHY LL` / `FA10053 LINE HL OPEN`
  - 颜色 `331浅蓝条` / `223暗蓝` / `460深邃蓝`，尺码 `2XL/XL/L/M/S`
  - 工序 `剪线` / `烫工`
  - 床次 1（2224 件）与床次 2（**64 扎 2272 件**，颜色/尺码分布与截图一致）
- `npm run dev:local` 指向本地库启动

### 10.2 自动化测试（扩充 `test/api.test.js`）

| # | 用例 |
|---|---|
| T1 | 编菲生成的扎数、总件数与输入矩阵一致 |
| T2 | 扎号顺序符合 2.2（用截图的 S 码数据做断言：1=223暗蓝52, 2=331浅蓝条26, 3=223暗蓝36, 4=331浅蓝条28） |
| T3 | 倍数模式关闭时按扎数平分、余数补最后一扎 |
| T4 | 床次重复被拒 |
| T5 | 同步工序只影响被选中的裁床单，未选中的工序快照不变 |
| T6 | 扫扎打点超过剩余件数返回 400 |
| T7 | 取价优先级：分岗 > 分码 > 工序默认 > 全局；且写入 `unit_price` 快照 |
| T8 | 改工价后，改价前的打点记录算出的工资不变 |
| T9 | 修改裁床件数改小到低于已完成数被拒 |
| T10 | 打印页按 `from/to` 和 `picks` 正确过滤扎号 |
| T11 | 权限：普通工人调建单/编菲/打印/改件数返回 403 |
| T12 | 进度聚合：单张裁床单的已完成件数 = 各工序完成数的最小值 |

现有 95 个测试全部保持通过。

### 10.3 验收流程

1. 本地跑通，服务起在本地库
2. 手机宽度（375）+ 桌面宽度（1440）各截一轮图，浅色 + 深色
3. 交给用户确认
4. **确认后才 `git push`**

---

## 11. 实现顺序

1. 数据层：DDL + 迁移 + `scripts/seed_demo.js`
2. 工序编辑器后端（`PUT /styles/:id/processes`、模板接口）+ 第 9 节前端组件 + 第 8 节选项控件
3. 裁床单后端（创建/编菲事务、查询、复制、删除）
4. 裁床编菲前端（矩阵 + 7 个开关）+ 查看裁床单
5. 生产管理列表 + 概览
6. 打印页（含 `qrcode` 依赖）
7. 扫扎打点 + 取价 + 工资口径调整
8. 生产进度 / 生产进度详情 / 工序进展
9. 同步工序（依赖 3 和 8）
10. Web Push（`server/push.js` + sw.js + 订阅开关）+ 全部通知触发点
11. 测试扩充 + UI skill 过一遍 + 截图验收
