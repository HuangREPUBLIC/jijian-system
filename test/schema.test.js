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
