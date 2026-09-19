"use strict";
// 中国时区（UTC+8）日期：只用 UTC 方法手动加 8 小时，不依赖进程时区（容器默认 UTC）。
// 直接截 UTC 日期会把凌晨 0-8 点算成"昨天"。
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
