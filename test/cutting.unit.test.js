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
