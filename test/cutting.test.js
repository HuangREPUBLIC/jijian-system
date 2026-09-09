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

  // —— 重号阻断：customNos 跟自动编号混用产生重号，路由层必须拦截 ——
  // A 格自定义扎号固定为 1，B 格走自动编号也从 1 开始，两者撞在一起（跟纯函数层的
  // duplicateBundleNos 测试同一个碰撞场景，这里验证的是 POST /cut-orders 这条接线本身）
  const dupNoBody = {
    styleId, bedNo: 10, docNo: "dup-1", cutDate: "2026-09-09",
    colors: ["A", "B"], sizes: ["S"], startNo: 1, multiple: true,
    customNos: { "A|S": [1] },
    cells: { "A|S": { input: 10, bundles: 1 }, "B|S": { input: 20, bundles: 1 } }
  };
  const dupNoRes = await call("POST", "/cut-orders", aT, dupNoBody);
  ok(dupNoRes.status === 400, "自定义/自动扎号撞号时返回400");
  ok(!!(dupNoRes.j && String(dupNoRes.j.error || "").includes("扎号重复")), "错误信息里说明是扎号重复");

  // —— 改单头：PATCH /cut-orders/:id ——
  const patched = await call("PATCH", `/cut-orders/${orderId}`, aT, { shipDate: "2026-09-20", docNo: "9999" });
  ok(patched.status === 200, "管理员能改裁床单单头");
  const afterPatch = await call("GET", `/cut-orders/${orderId}`, aT);
  ok(afterPatch.j.order.ship_date === "2026-09-20" && afterPatch.j.order.doc_no === "9999", "改完再查，出货日期和单号都变了");
  ok((await call("PATCH", `/cut-orders/${orderId}`, wT, { docNo: "0000" })).status === 403, "计件工不能改裁床单单头");

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

  // —— GET syncable-orders 款式存在性校验 ——
  const notExistRes = await call("GET", "/styles/xxx-not-exist/syncable-orders", aT);
  ok(notExistRes.status === 404, "不存在的款式返回404");

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
