"use strict";
/**
 * 测试入口：npm test
 * 用一个临时数据目录 + 随机端口启动服务端，跑各组测试，最后自动关闭。
 * 不会影响正式共用的 daka-system/data 目录。
 */
const { spawn, spawnSync } = require("child_process");
const mysqlDropArgs = (db, e) => [
  "-h", e.MYSQL_HOST, "-P", e.MYSQL_PORT, "-u", e.MYSQL_USER,
  ...(e.MYSQL_PASSWORD ? [`-p${e.MYSQL_PASSWORD}`] : []),
  "-e", `DROP DATABASE IF EXISTS \`${db}\`;`
];
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 3910 + Math.floor(Math.random() * 90);
const BASE_URL = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jijian-test-"));
// 迁到 MySQL 后测试指向一个本地实例（默认 127.0.0.1:3307，可用 TEST_MYSQL_* 覆盖），
// 每次跑用一个唯一库名，db.js init 会自动建库建表，互不干扰。
const TEST_DB = `jijian_test_${PORT}_${Math.floor(Math.random() * 1e6)}`;
const env = Object.assign({}, process.env, {
  PORT: String(PORT), DATA_DIR, BASE_URL, NODE_ENV: "test",
  MYSQL_HOST: process.env.TEST_MYSQL_HOST || "127.0.0.1",
  MYSQL_PORT: process.env.TEST_MYSQL_PORT || "3307",
  MYSQL_USER: process.env.TEST_MYSQL_USER || "root",
  MYSQL_PASSWORD: process.env.TEST_MYSQL_PASSWORD || "",
  MYSQL_DATABASE: TEST_DB
});

const server = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")],
  { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", d => serverLog += d);
server.stderr.on("data", d => serverLog += d);

function cleanup() {
  try { server.kill(); } catch (e) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  try { spawnSync("mysql", mysqlDropArgs(TEST_DB, env), { stdio: "ignore" }); } catch (e) {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

async function waitForServer(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(BASE_URL + "/"); return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  if (!await waitForServer()) {
    console.error("服务端启动失败：\n" + serverLog);
    process.exit(1);
  }
  const suites = ["api.test.js"];
  let failed = 0;
  for (const s of suites) {
    console.log(`\n===== ${s} =====`);
    const r = spawnSync(process.execPath, [path.join(__dirname, s)], { env, stdio: "inherit" });
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `\n✗ 有 ${failed} 组测试未通过` : "\n✓ 全部测试通过");
  process.exit(failed ? 1 : 0);
})();
