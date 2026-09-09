"use strict";
/**
 * 中国时区（UTC+8）日期计算——固定偏移，绝不依赖进程时区。
 *
 * 为什么不能用 `d.toISOString().slice(0,10)` 直接截：ISO 字符串是 UTC 时间，
 * 中国本地时间 00:00–07:59 这 8 小时，对应的 UTC 时间还停在"昨天"的 16:00–23:59，
 * 直接截 UTC 日期会把这段时间算成昨天——车间凌晨这几个小时打点会记错日期，
 * 跨月时甚至会把工资记到上个月。
 *
 * 为什么不能依赖进程时区（`process.env.TZ` / `new Date().toString()` 那一套本地时间 API）：
 * 线上容器（Dockerfile 用 node:22-slim）默认时区是 UTC，`TZ` 环境变量可能被部署环境覆盖
 * 或漏配——一旦漏配，用本地时间 API 算出来的"今天"又变回 UTC 的今天，等于没修。
 * 所以这里只用 `Date` 的 UTC 方法（`getTime`/`toISOString` 全部工作在 UTC 上），
 * 手动加 8 小时的毫秒数，结果完全不受进程时区设置影响。
 */
const CN_OFFSET_MS = 8 * 3600 * 1000;

// 任意时刻 → 该时刻对应的中国日期 "YYYY-MM-DD"
function cnDayStr(d) {
  return new Date(d.getTime() + CN_OFFSET_MS).toISOString().slice(0, 10);
}

// 当前时刻对应的中国日期
function cnToday() {
  return cnDayStr(new Date());
}

module.exports = { cnDayStr, cnToday };
