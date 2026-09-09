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
  // multiple 模式下同一格两个数会被合并成 input=arr[0]+arr[1] 后原样复制两扎（见下方
  // for 循环的注释），所以 S/M 用真实数字后，L/XL/2XL 按同样的颜色配比放大到 2 倍，
  // 让 2 校验对上 2272：284(S) + 284(M) + 568(L) + 568(XL) + 568(2XL) = 2272。
  const perSize = {
    S:   { "223暗蓝": [52, 36], "331浅蓝条": [26, 28] },
    M:   { "223暗蓝": [52, 36], "331浅蓝条": [26, 28] },
    L:   { "223暗蓝": [104, 72], "331浅蓝条": [52, 56] },
    XL:  { "223暗蓝": [104, 72], "331浅蓝条": [52, 56] },
    "2XL": { "223暗蓝": [104, 72], "331浅蓝条": [52, 56] }
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
