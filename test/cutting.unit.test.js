"use strict";
// 纯函数单测：不起服务、不连库，直接 require 模块跑。
const path = require("path");
const { planBundles, cellKey, duplicateBundleNos } = require(path.join(__dirname, "..", "server", "cutting"));
const { resolvePrice, visibleTo } = require(path.join(__dirname, "..", "server", "pricing"));
const { cnDayStr } = require(path.join(__dirname, "..", "server", "daytime"));
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

// —— 自定义扎号与自动扎号混用：产生碰撞（已知行为，由调用方拦截）——
// 这个测试记录 planBundles 的真实行为：当自定义扎号与自动编号共存时，
// nextNo 计数器不知道 customNos 占用了哪些号，可能产生重复扎号。
// 算法设计上允许这个碰撞存在，由上层调用方用 duplicateBundleNos 检测并拦截。
{
  const k1 = cellKey("A", "S");
  const k2 = cellKey("B", "S");
  const r = planBundles({
    colors: ["A", "B"], sizes: ["S"],
    cells: {
      [k1]: { input: 10, bundles: 1 },
      [k2]: { input: 20, bundles: 1 }
    },
    startNo: 1, multiple: true,
    customNos: { [k1]: [1] }  // A 的扎号固定为 1
    // B 的扎号走自动编号，从 startNo:1 开始，也会产生 bundleNo=1
  });
  const bundleNos = r.bundles.map(b => b.bundleNo);
  ok(bundleNos.filter(no => no === 1).length === 2, "混用自定义/自动编号时确实产生重号1");
  ok(r.bundles[0].bundleNo === 1 && r.bundles[0].color === "A", "第一扎是自定义的1（A颜色）");
  ok(r.bundles[1].bundleNo === 1 && r.bundles[1].color === "B", "第二扎是自动编号的1（B颜色）");
}

// —— duplicateBundleNos 能检测出重号 ——
// 把上面混用产生的碰撞结果传给 duplicateBundleNos，应该能准确返回重复的扎号列表
{
  const k1 = cellKey("A", "S");
  const k2 = cellKey("B", "S");
  const r = planBundles({
    colors: ["A", "B"], sizes: ["S"],
    cells: {
      [k1]: { input: 10, bundles: 1 },
      [k2]: { input: 20, bundles: 1 }
    },
    startNo: 1, multiple: true,
    customNos: { [k1]: [1] }
  });
  const dups = duplicateBundleNos(r.bundles);
  ok(dups.length === 1, "检测到恰好1个重复扎号");
  ok(dups[0] === 1, "重复的扎号是1");
}

// —— duplicateBundleNos 对正常情况不误报 ——
// 传入没有重号的 bundles，应该返回空数组
{
  const r = planBundles({
    colors: ["A", "B"], sizes: ["S"],
    cells: {
      [cellKey("A", "S")]: { input: 10, bundles: 1 },
      [cellKey("B", "S")]: { input: 20, bundles: 1 }
    },
    startNo: 1, multiple: true
    // 不设 customNos，全走自动编号，不会产生重号
  });
  const dups = duplicateBundleNos(r.bundles);
  ok(dups.length === 0, "正常情况下不误报重号");
}

// —— 中国时区日期（cnDayStr）：不能直接截 UTC 的 toISOString() ——
// UTC 16:30 = 中国时间次日 00:30，已经跨到"第二天"
ok(cnDayStr(new Date("2026-09-09T16:30:00Z")) === "2026-09-10", "UTC 16:30 落在中国的第二天");
// UTC 02:00 = 中国时间 10:00，还是同一天，不跨天
ok(cnDayStr(new Date("2026-09-09T02:00:00Z")) === "2026-09-09", "UTC 02:00 不跨天，仍是当天");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
