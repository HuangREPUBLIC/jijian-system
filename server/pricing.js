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
