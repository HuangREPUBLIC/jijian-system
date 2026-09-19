"use strict";
// 接口请求，以及「进页面前先拉数据」的注册表：各功能文件用 LOADERS.<页面名> = async () => {…} 登记自己要的接口。

// 断网 / 超时要给人话提示，不能落到"操作失败"：车间 Wi-Fi 时好时坏，工人得知道是网的问题、重试就行。
// 超时按请求体大小放宽：带图保存款式动辄几 MB，弱网下 20 秒传不完。
async function api(method, path, body) {
  const headers = {};
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const opts = { method, headers };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const big = opts.body && opts.body.length > 200 * 1024;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), big ? 120000 : 20000) : null;
  if (ctrl) opts.signal = ctrl.signal;
  let r;
  try { r = await fetch("/api" + path, opts); }
  catch (e) {
    throw { error: e && e.name === "AbortError" ? "请求超时，请检查网络后重试" : "网络连接失败，请检查网络后重试", network: true };
  } finally { if (timer) clearTimeout(timer); }
  if (r.status === 401 && state.token) { A.forceLogout(); throw { error: "登录已失效，请重新登录" }; }
  let j = null; try { j = await r.json(); } catch (e) { }
  if (!r.ok) throw (j || { error: r.status >= 500 ? "服务器开小差了，请稍后再试" : "请求失败" });
  if (j === null) throw { error: "数据没收全，请检查网络后重试", network: true };
  return j;
}
// 执行一个动作 → 重新拉当前页数据 → 重绘；返回 fn() 的结果（成功）或 undefined（失败并已 toast 提示）
async function run(fn, okMsg) {
  try { const result = await fn(); await loadView(route.v); render(); if (okMsg) toast(okMsg); return result; }
  catch (e) { toast((e && e.error) || "操作失败"); return undefined; }
}

const getDailyWage = () => api("GET", "/settings/daily-wage").catch(() => ({ value: 100 }));

// 进页面前先拉这个页面要的接口、写进 state；各功能文件里用 LOADERS.<页面名> 登记
const LOADERS = {};
async function loadView(v) {
  const load = LOADERS[v];
  if (load) await load();
}
