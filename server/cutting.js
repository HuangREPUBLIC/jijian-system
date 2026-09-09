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
 *   格子还支持一个可选的 `qtys: number[]` 字段——显式给出该格逐扎的件数。
 *   现场同一个(颜色,尺码)可以分几次铺布，每次层数不同，件数自然不同（比如实拍
 *   S 码 223暗蓝 是 4 扎 52/36/52/36 件），`{input,bundles}` 这种"一格一个值"的
 *   均匀模型表达不了这种情况，所以加一条显式路径：给了 `qtys` 就按数组原样取，
 *   扎数=数组长度、忽略 input/bundles/multiple；没给 `qtys` 时行为跟以前完全一样。
 * @param {number}   [input.startNo=1]     从第几扎起（自动编号时）
 * @param {boolean}  [input.multiple=true] 倍数模式：input 是每扎件数；关闭时 input 是该格总件数（对 qtys 无效）
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
      if (Array.isArray(c.qtys) && c.qtys.length) {
        // 显式逐扎件数优先：不受 multiple 开关影响，也不看 input/bundles。
        // <=0 或非数字的元素直接跳过——不产生扎，不是当 0 件的扎占个位置。
        plan[k] = c.qtys
          .map((q) => Number(q))
          .filter((q) => Number.isFinite(q) && q > 0);
        continue;
      }
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
