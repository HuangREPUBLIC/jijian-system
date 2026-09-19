"use strict";
// 本地演示数据（只在 jijian_dev 这类库跑，可重复执行：先删掉自己造的款式与单再重建）。
// 颜色/尺码数组的顺序就是扎号编号顺序，按参考截图从 S 码、223暗蓝 排起。

// 生产库防呆：wipe() 会真删数据，库名不含 dev/demo/test 就拒绝执行（SEED_FORCE=1 可强制）
const SEED_DB_NAME = process.env.MYSQL_DATABASE || process.env.MYSQL_DB || "jijian";
if (!/dev|demo|test/i.test(SEED_DB_NAME) && process.env.SEED_FORCE !== "1") {
  console.error(
    `[seed] 拒绝执行：当前数据库名是 "${SEED_DB_NAME}"，库名里不含 dev/demo/test，看起来可能是生产库。\n` +
    "本脚本会先删除 FC3390 裤 / FC3390-1 / FA10053 相关的款式与裁床单（含其菲票、打点记录），\n" +
    "再重新造一遍演示数据；误连生产库执行会真删生产数据，不可恢复。\n" +
    "确认这确实是一个可以随意清空重造的库之后，加 SEED_FORCE=1 强制执行，例如：\n" +
    "  SEED_FORCE=1 node scripts/seed_demo.js"
  );
  process.exit(1);
}

const path = require("path");
const { init, db, pool, uid } = require(path.join(__dirname, "..", "server", "db"));
const { planBundles, cellKey } = require(path.join(__dirname, "..", "server", "cutting"));
// 取菲票号复用服务端的加锁逻辑，跟运行中的服务并发建单也不会撞号
const { nextTicketRange } = require(path.join(__dirname, "..", "server", "routes_cutting"));

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

async function makeStyle(code, name, opts = {}) {
  const { hasCutting = true } = opts;
  const id = uid();
  // 尺码/颜色要写进款式：裁床编菲页的候选就来自这两个字段，不写的话那一页没得选
  await db.prepare(
    "INSERT INTO jj_styles(id,name,code,customer,size,color,has_cutting,deleted,created_at) VALUES(?,?,?,?,?,?,?,0,?)")
    .run(id, name, code, CUSTOMER, (opts.sizes || SIZES).join(","), (opts.colors || []).join(","),
      hasCutting ? 1 : 0, Date.now());
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

// 直接写库造裁床单，复用 planBundles；取号、单头、扎、工序快照在同一个事务里
async function makeOrder(styleId, opts) {
  const plan = planBundles({
    colors: opts.colors, sizes: opts.sizes, cells: opts.cells,
    startNo: 1, multiple: true
  });
  const orderId = uid(), now = Date.now();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const startTicket = await nextTicketRange(conn, plan.totalBundles);

    await conn.query(
      `INSERT INTO jj_cut_orders(id,style_id,bed_no,doc_no,customer,cut_date,ship_date,order_no,
        bed_note,ticket_note,company_name,colors,sizes,total_bundles,total_qty,source,created_by,created_at,deleted)
       VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,?,?,'self',NULL,?,0)`,
      [orderId, styleId, opts.bedNo, opts.docNo, CUSTOMER, opts.cutDate, opts.shipDate,
        COMPANY, JSON.stringify(opts.colors), JSON.stringify(opts.sizes),
        plan.totalBundles, plan.totalQty, now]);

    await conn.query(
      `INSERT INTO jj_cut_bundles(id,order_id,style_id,bundle_no,ticket_no,color,size,qty,vat_no,note,created_at)
       VALUES ?`,
      [plan.bundles.map((b, i) =>
        [uid(), orderId, styleId, b.bundleNo, startTicket + i, b.color, b.size, b.qty, b.vatNo || null, null, now])]);

    const [sps] = await conn.query(
      "SELECT * FROM jj_style_processes WHERE style_id = ? ORDER BY seq ASC", [styleId]);
    if (sps.length) {
      await conn.query(
        `INSERT INTO jj_cut_order_processes(id,order_id,seq,name,price_mode,unit_price,prices,show_price,visible_roles,style_process_id,created_at)
         VALUES ?`,
        [sps.map((sp) => [uid(), orderId, sp.seq, sp.name, sp.price_mode, sp.unit_price, sp.prices,
          sp.show_price === 0 ? 0 : 1, sp.visible_roles || null, sp.id, now])]);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  console.log(`[seed] ${opts.docNo || ""} 床次${opts.bedNo}：${plan.totalBundles} 扎 ${plan.totalQty} 件`);
  return orderId;
}

(async () => {
  await init();
  await wipe(["FC3390 裤", "FC3390-1", "FA10053"]);

  // —— FC3390 裤：截图里的主角，床次1 / 床次2 ——
  const s1 = await makeStyle("FC3390 裤", "", { colors: ["223暗蓝", "331浅蓝条"] });
  await makeProcesses(s1, [{ name: "剪线", unitPrice: 0 }, { name: "烫工", unitPrice: 0 }]);
  const colors1 = ["223暗蓝", "331浅蓝条"];
  // 床次2：S/M 用截图里的真实逐扎数字，其余尺码按同样的形状铺开。
  const perSize = {
    S:   { "223暗蓝": [52, 36], "331浅蓝条": [26, 28] },
    M:   { "223暗蓝": [52, 36], "331浅蓝条": [26, 28] },
    L:   { "223暗蓝": [104, 72], "331浅蓝条": [52, 56] },
    XL:  { "223暗蓝": [104, 72], "331浅蓝条": [52, 56] },
    "2XL": { "223暗蓝": [104, 72], "331浅蓝条": [52, 56] }
  };
  // qtys 逐扎给件数（同色同码分几次铺布、每次层数不同）：每格 4 扎，两个实拍数字各出现两次，整单 2272 件
  const cells2 = {};
  for (const size of SIZES) {
    for (const color of colors1) {
      const arr = perSize[size][color];
      cells2[cellKey(color, size)] = { qtys: [arr[0], arr[1], arr[0], arr[1]] };
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
  const s2 = await makeStyle("FC3390-1", "RIGHY LL", { colors: ["223暗蓝", "460深邃蓝"], sizes: ["L"] });
  await makeProcesses(s2, [{ name: "剪线", unitPrice: 0 }, { name: "烫工", unitPrice: 0 }]);
  await makeOrder(s2, {
    bedNo: 4, docNo: "2901", cutDate: "2026-09-08", shipDate: "2026-09-09",
    colors: ["223暗蓝", "460深邃蓝"], sizes: ["L"],
    cells: { [cellKey("223暗蓝", "L")]: { input: 140, bundles: 5 }, [cellKey("460深邃蓝", "L")]: { input: 140, bundles: 5 } }
  });

  // —— FA10053：不裁床的款，用来验「是否裁床：否」 ——
  const s3 = await makeStyle("FA10053", "LINE HL OPEN", { hasCutting: false, colors: ["66酒红", "23地中海蓝"] });
  await makeProcesses(s3, [{ name: "剪线", unitPrice: 0 }, { name: "烫工", unitPrice: 0 }]);

  console.log("[seed] 演示数据就绪");
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
