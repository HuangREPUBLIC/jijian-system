"use strict";
const BASE = (process.env.BASE_URL || "http://localhost:3910") + "/api";
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };
async function call(method, path, token, body) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}

(async () => {
  // 测试库是全新空库，先手动插一个管理员账号（跟 daka-system 一样直接建号），再用手机号+密码登录
  const { db, uid } = require(require("path").join(__dirname, "..", "server", "db"));
  const A = require(require("path").join(__dirname, "..", "server", "auth"));
  const adminId = uid();
  await db.prepare("INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
    .run(adminId, "老板", "13900000000", A.hashPassword("x"), "admin", Date.now());
  const admLogin = await call("POST", "/login", null, { phone: "13900000000", password: "x" });
  ok(admLogin.status === 200 && admLogin.j.token && admLogin.j.user.role === "admin", "管理员用手机号密码登录");
  const aT = admLogin.j.token;
  ok((await call("POST", "/login", null, { phone: "13900000000", password: "wrong" })).status === 400, "密码错误登录不了");

  // 员工账号只能由管理员建：建好后用默认密码 123456 登录
  const huanAdd = await call("POST", "/users", aT, { name: "李焕", phone: "13711112222", role: "worker" });
  ok(huanAdd.status === 200 && huanAdd.j.user.name === "李焕", "管理员手动添加员工");
  const huanLogin = await call("POST", "/login", null, { phone: "13711112222", password: "123456" });
  ok(huanLogin.status === 200 && huanLogin.j.token && huanLogin.j.user.name === "李焕", "新员工用默认密码登录");
  ok((await call("POST", "/users", aT, { name: "李焕2", phone: "13711112222" })).status === 400, "同一手机号不能重复建号");
  const manualAdd = await call("POST", "/users", aT, { name: "纪秀芝", phone: "13722223333", role: "worker" });
  ok(manualAdd.status === 200 && manualAdd.j.user.name === "纪秀芝", "管理员再添加一个员工");

  // 非管理员不能添加员工/管理工序款式
  const wT = huanLogin.j.token; // 李焕，普通员工
  ok((await call("POST", "/users", wT, { name: "x", phone: "13733334444" })).status === 403, "普通员工不能手动添加员工");

  // 工序模板增删改
  const p1 = await call("POST", "/processes", aT, { name: "订立扣", unit: "个", stdQty: 1800, hourQuota: 225 });
  ok(p1.status === 200 && p1.j.process.name === "订立扣", "管理员新增工序模板");
  ok((await call("POST", "/processes", wT, { name: "x", stdQty: 1, hourQuota: 1 })).status === 200, "测试阶段普通员工也能新增工序模板");
  const pList = await call("GET", "/processes", wT);
  ok(pList.status === 200 && pList.j.processes.some(p => p.name === "订立扣"), "普通员工能查看工序模板");
  const pEdit = await call("PATCH", `/processes/${p1.j.process.id}`, aT, { hourQuota: 230 });
  ok(pEdit.status === 200 && pEdit.j.process.hour_quota === 230, "管理员修改工序模板");
  const pDel = await call("DELETE", `/processes/${p1.j.process.id}`, aT);
  ok(pDel.status === 200, "管理员删除工序模板");
  const pListAfterDel = await call("GET", "/processes", wT);
  ok(!pListAfterDel.j.processes.some(p => p.id === p1.j.process.id), "删除后的工序模板不再出现");

  // 款式管理增删改
  const s1 = await call("POST", "/styles", aT, { name: "MACU", code: "FA9926" });
  ok(s1.status === 200 && s1.j.style.name === "MACU", "管理员新增款式");
  ok((await call("POST", "/styles", wT, { name: "x", code: "WX1" })).status === 200, "测试阶段普通员工也能新增款式");
  const sEdit = await call("PATCH", `/styles/${s1.j.style.id}`, aT, { code: "FA9999" });
  ok(sEdit.status === 200 && sEdit.j.style.code === "FA9999", "管理员修改款式");
  const sDel = await call("DELETE", `/styles/${s1.j.style.id}`, aT);
  ok(sDel.status === 200, "管理员删除款式");

  // 打点 + 考勤 + 完成百分比（用真实台账里李焕 6/1 那组数字做回归：
  // 1085/225 + 850/225 = 8.6 时效小时，出勤 8 小时，8.6/8 = 1.075）
  const huanId = huanLogin.j.user.id; // 李焕
  const proc2 = await call("POST", "/processes", aT, { name: "订立扣2", unit: "个", stdQty: 1800, hourQuota: 225 });
  ok(proc2.status === 200, "新增回归测试用的工序");

  const scan1 = await call("POST", "/scan", wT, { processId: proc2.j.process.id, date: "2026-06-01", qty: 1085 });
  ok(scan1.status === 200, "员工提交第一条打点");
  const scan2 = await call("POST", "/scan", wT, { processId: proc2.j.process.id, date: "2026-06-01", qty: 850 });
  ok(scan2.status === 200, "员工提交第二条打点");

  ok((await call("POST", "/attendance", wT, { userId: huanId, date: "2026-06-01", hours: 8 })).status === 200, "测试阶段普通员工也能录入考勤");
  const attSet = await call("POST", "/attendance", aT, { userId: huanId, date: "2026-06-01", hours: 8 });
  ok(attSet.status === 200 && attSet.j.attendance.hours === 8, "管理员录入考勤");

  const daily = await call("GET", `/efficiency/daily?date=2026-06-01&userId=${huanId}`, wT);
  ok(daily.status === 200 && Math.abs(daily.j.percent - 1.075) < 0.001, "日完成百分比公式正确(1.075)");

  const scanList = await call("GET", "/scan?date=2026-06-01", wT);
  ok(scanList.status === 200 && scanList.j.records.length === 2, "能查到自己当天两条打点记录");

  ok((await call("GET", `/efficiency/daily?date=2026-06-01&userId=${huanId}`, aT)).status === 200, "管理员能查看他人日效率");
  const otherToken = manualAdd.j.user.id; // 纪秀芝还没登录过，没有 token，改用她的 id 测越权查询会被拒绝
  ok((await call("GET", `/efficiency/daily?date=2026-06-01&userId=${otherToken}`, wT)).status === 200, "测试阶段普通员工也能查看他人效率");

  const monthly = await call("GET", `/efficiency/monthly?month=2026-06&userId=${huanId}`, wT);
  ok(monthly.status === 200 && Math.abs(monthly.j.percent - 1.075) < 0.001, "月完成百分比（当月只有这一天）也是 1.075");

  const summary = await call("GET", "/efficiency/summary?month=2026-06", aT);
  ok(summary.status === 200 && summary.j.list.some(x => x.userId === huanId && Math.abs(x.percent - 1.075) < 0.001), "管理员全员月度看板包含李焕且百分比正确");
  ok((await call("GET", "/efficiency/summary?month=2026-06", wT)).status === 200, "测试阶段普通员工也能看全员看板");
  // 管理员不是计件工、不参与考勤，效率看板不列他（跟薪资汇总/员工列表口径一致）
  ok(!summary.j.list.some(x => x.userId === adminId), "效率看板不包含管理员");

  const delScan = await call("DELETE", `/scan/${scan1.j.record.id}`, wT);
  ok(delScan.status === 200, "员工能删除自己的打点记录");
  const scanListAfterDel = await call("GET", "/scan?date=2026-06-01", wT);
  ok(scanListAfterDel.j.records.length === 1, "删除后只剩一条打点记录");

  // 款式（style2 后面「款式关联工序」用例还要用）
  const style2 = await call("POST", "/styles", aT, { name: "TESTSTYLE", code: "T001" });

  // 薪资：计件单价工序 + 打点 -> 计件工资，再叠加餐补/奖金/扣罚
  const proc3 = await call("POST", "/processes", aT, { name: "锁边", unit: "件", stdQty: 100, hourQuota: 12.5, unitPrice: 2 });
  ok(proc3.status === 200 && proc3.j.process.unit_price === 2, "新增带计件单价的工序");
  await call("POST", "/scan", wT, { processId: proc3.j.process.id, date: "2026-06-02", qty: 30 });

  const payrollMineBefore = await call("GET", "/payroll/mine?month=2026-06", wT);
  ok(payrollMineBefore.status === 200 && payrollMineBefore.j.pieceWage === 60, "计件工资 = 30件 × 2元 = 60元（无单价的工序不计入）");

  ok((await call("POST", "/payroll/adjustments", wT, { userId: huanId, month: "2026-06", mealSubsidy: 100 })).status === 403, "普通员工不能调整薪资项");
  const adjSet = await call("POST", "/payroll/adjustments", aT, { userId: huanId, month: "2026-06", mealSubsidy: 100, penalty: 10, bonus: 20 });
  ok(adjSet.status === 200 && adjSet.j.total === 170, "管理员设置薪资调整项，总额 60+100+20-10=170");

  const payrollMine = await call("GET", "/payroll/mine?month=2026-06", wT);
  ok(payrollMine.status === 200 && payrollMine.j.total === 170, "员工查看自己的薪资总额正确");

  const payrollSummary = await call("GET", "/payroll/summary?month=2026-06", aT);
  ok(payrollSummary.status === 200 && payrollSummary.j.list.some(x => x.userId === huanId && x.total === 170), "管理员全员薪资汇总包含李焕且金额正确");
  ok((await call("GET", "/payroll/summary?month=2026-06", wT)).status === 403, "普通员工看不了全员薪资汇总");

  // 操作记录 / 全员扫菲记录
  const ops = await call("GET", "/operations", aT);
  ok(ops.status === 200 && ops.j.logs.length > 0, "管理员能看到操作记录");
  ok((await call("GET", "/operations", wT)).status === 403, "普通员工看不了操作记录");

  const scanAll = await call("GET", "/scan-all?date=2026-06-02", aT);
  ok(scanAll.status === 200 && scanAll.j.records.some(x => x.user_name === "李焕" && x.process_name === "锁边"), "管理员能看到全员扫菲记录（含姓名和工序名）");
  ok((await call("GET", "/scan-all?date=2026-06-02", wT)).status === 200, "测试阶段普通员工也能看全员扫菲记录");

  // 图片上传
  const fd = new FormData();
  fd.append("image", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "test.png");
  const uploadRes = await fetch(BASE + "/upload", { method: "POST", headers: { Authorization: "Bearer " + aT }, body: fd });
  const uploadJ = await uploadRes.json();
  ok(uploadRes.status === 200 && uploadJ.url && uploadJ.url.startsWith("/uploads/"), "管理员上传图片成功");
  const fd2 = new FormData();
  fd2.append("image", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "test2.png");
  const uploadNoAdmin = await fetch(BASE + "/upload", { method: "POST", headers: { Authorization: "Bearer " + wT }, body: fd2 });
  ok(uploadNoAdmin.status === 200, "测试阶段普通员工也能上传款式图");

  // 尺码/颜色/客户 选项池
  const optsEmpty = await call("GET", "/style-options", wT);
  ok(optsEmpty.status === 200 && Array.isArray(optsEmpty.j.sizes), "能查看选项池（普通员工也能看）");
  ok((await call("POST", "/style-options", wT, { type: "size", value: "S" })).status === 200, "测试阶段普通员工也能新增选项");
  const addSize = await call("POST", "/style-options", aT, { type: "size", value: "S" });
  ok(addSize.status === 200 && addSize.j.list.includes("S"), "管理员新增尺码选项");
  const addSizeDup = await call("POST", "/style-options", aT, { type: "size", value: "S" });
  ok(addSizeDup.j.list.filter(x => x === "S").length === 1, "重复添加不会出现两条");
  await call("POST", "/style-options", aT, { type: "color", value: "藏青" });
  await call("POST", "/style-options", aT, { type: "customer", value: "ABC贸易" });
  const optsAfter = await call("GET", "/style-options", aT);
  ok(optsAfter.j.sizes.includes("S") && optsAfter.j.colors.includes("藏青") && optsAfter.j.customers.includes("ABC贸易"), "三种选项都保存成功");
  const delSize = await call("DELETE", "/style-options", aT, { type: "size", value: "S" });
  ok(delSize.status === 200 && !delSize.j.list.includes("S"), "管理员删除选项");

  // 款式 - 生产工序关联（带图片/尺码/颜色/客户）
  const style3 = await call("POST", "/styles", aT, {
    name: "STYLE3", code: "S3001", image: uploadJ.url, size: "M", color: "藏青", customer: "ABC贸易"
  });
  ok(style3.status === 200 && style3.j.style.image === uploadJ.url && style3.j.style.size === "M", "新建款式带上图片/尺码/颜色/客户");
  ok((await call("POST", "/styles", aT, { name: "无款号", })).status === 400, "不填款号建不了款式");

  // 测试阶段权限：主管(技术主管 tech_lead)对 3 块受限区(员工管理/操作记录/薪资)有完全权限，普通员工没有
  await call("POST", "/users", aT, { name: "主管测试", phone: "13655556666", role: "tech_lead" });
  const superLogin = await call("POST", "/login", null, { phone: "13655556666", password: "123456" });
  ok(superLogin.status === 200 && superLogin.j.token, "主管账号登录");
  const supT = superLogin.j.token;
  ok((await call("GET", "/users", supT)).status === 200, "主管能进员工管理(受限区)");
  ok((await call("GET", "/operations", supT)).status === 200, "主管能看操作记录(受限区)");
  ok((await call("GET", "/payroll/summary?month=2026-06", supT)).status === 200, "主管能看全员薪资汇总(受限区)");
  ok((await call("GET", "/users", wT)).status === 403, "普通员工进不了员工管理(受限区)");

  // ---- 应用内通知 ----
  ok((await call("GET", "/notifications")).status === 401, "未登录看不了通知");
  const beforeCount = (await call("GET", "/notifications/unread-count", aT)).j.total;
  const newStyle = await call("POST", "/styles", wT, { name: "通知测试款", code: "NOTIFY-1" });
  ok(newStyle.status === 200, "普通员工新增一个款式(用来触发通知)");
  const afterCount = (await call("GET", "/notifications/unread-count", aT)).j.total;
  ok(afterCount === beforeCount + 1, "管理员收到一条新增款式的通知，未读数+1");
  const supCount = (await call("GET", "/notifications/unread-count", supT)).j.total;
  ok(supCount >= 1, "主管也收到了这条通知(通知所有管理员/主管)");
  const wList = (await call("GET", "/notifications", wT)).j.list;
  ok(!wList.some(n => n.text.includes("通知测试款")), "操作者自己不会收到这条通知");
  const admList = (await call("GET", "/notifications", aT)).j.list;
  const notif = admList.find(n => n.text.includes("通知测试款"));
  ok(!!notif && !notif.read, "管理员的通知列表里能看到这条，且是未读状态");
  ok((await call("POST", `/notifications/${notif.id}/read`, wT)).status === 403, "别人不能标记不属于自己的通知为已读");
  ok((await call("POST", `/notifications/${notif.id}/read`, aT)).status === 200, "管理员标记自己的通知已读");
  const admListAfter = (await call("GET", "/notifications", aT)).j.list;
  ok(admListAfter.find(n => n.id === notif.id).read === true, "标记已读后状态确实变了");
  await call("POST", "/notifications/read-all", aT);
  ok((await call("GET", "/notifications/unread-count", aT)).j.total === 0, "全部已读后未读数归零");
  // 岗位调整通知本人
  const roleChangeTarget = await call("POST", "/users", aT, { name: "岗位通知测试", phone: "13644445555", role: "worker" });
  await call("PATCH", `/users/${roleChangeTarget.j.user.id}`, aT, { role: "tech_lead" });
  const targetT = (await call("POST", "/login", null, { phone: "13644445555", password: "123456" })).j.token;
  const targetList = (await call("GET", "/notifications", targetT)).j.list;
  ok(targetList.some(n => n.text.includes("岗位")), "被调整岗位的员工本人收到了通知");

  // ---- 通知删除 / 清空已读 ----
  const seeded = [];
  for (let i = 0; i < 4; i++) {
    const nid = uid(); seeded.push(nid);
    await db.prepare("INSERT INTO jj_notifications(id,user_id,text,link,created_at,read_at) VALUES(?,?,?,?,?,?)")
      .run(nid, adminId, "删除测试" + i, null, Date.now(), i < 2 ? Date.now() : null);
  }
  const unreadBeforeDel = (await call("GET", "/notifications/unread-count", aT)).j.total;
  ok((await call("DELETE", `/notifications/${seeded[3]}`, wT)).status === 403, "别人删不了不属于自己的通知");
  ok((await call("DELETE", `/notifications/${seeded[3]}`, aT)).status === 200, "删除自己的一条通知");
  ok((await call("DELETE", `/notifications/${seeded[3]}`, aT)).status === 404, "已删的通知再删返回 404");
  ok(!(await call("GET", "/notifications", aT)).j.list.some(n => n.id === seeded[3]), "删掉的通知不再出现在列表里");
  ok((await call("GET", "/notifications/unread-count", aT)).j.total === unreadBeforeDel - 1, "删掉一条未读的，未读数跟着减一");
  ok((await call("DELETE", "/notifications", aT)).status === 400, "清空通知必须带 read=1");
  const clearRead = await call("DELETE", "/notifications?read=1", aT);
  const afterClear = (await call("GET", "/notifications", aT)).j.list;
  ok(clearRead.status === 200 && afterClear.every(n => !n.read) && afterClear.some(n => n.id === seeded[2]), "清空已读只删已读的，未读的留着");

  // ---- 款式列表只带缩略图，原图按需取 ----
  const bigImg = "data:image/jpeg;base64," + "A".repeat(60000);
  const thumbImg = "data:image/jpeg;base64," + "B".repeat(3000);
  const withImg = await call("POST", "/styles", aT, { name: "缩略图款", code: "THUMB-1", images: [bigImg, bigImg], thumb: thumbImg });
  const sid = withImg.j.style.id;
  let listed = (await call("GET", "/styles", aT)).j.styles.find(s => s.id === sid);
  ok(listed.image === thumbImg && listed.has_thumb === true && listed.image_count === 2 && listed.images === undefined,
    "款式列表只带缩略图和图片张数，不带原图");
  const full = await call("GET", `/styles/${sid}`, aT);
  ok(full.status === 200 && JSON.parse(full.j.style.images).length === 2 && full.j.style.image === bigImg, "单个款式接口带全部原图");
  ok((await call("GET", "/styles/nope", aT)).status === 404, "不存在的款式 404");
  await call("PATCH", `/styles/${sid}`, aT, { images: [bigImg] });
  listed = (await call("GET", "/styles", aT)).j.styles.find(s => s.id === sid);
  ok(listed.has_thumb === false && listed.image === bigImg && listed.image_count === 1, "换了图没带缩略图：旧缩略图作废，退回原图");
  ok((await call("PUT", `/styles/${sid}/thumb`, aT, { thumb: "not-an-image", srcLen: bigImg.length })).status === 400, "补缩略图只收图片 data URI");
  ok((await call("PUT", `/styles/${sid}/thumb`, aT, { thumb: thumbImg })).status === 400, "补缩略图必须带封面长度");
  ok((await call("PUT", `/styles/${sid}/thumb`, aT, { thumb: thumbImg, srcLen: bigImg.length + 1 })).status === 409,
    "封面跟补图时不一致（被换过）就不写缩略图");
  ok((await call("PUT", `/styles/${sid}/thumb`, aT, { thumb: "data:image/jpeg;base64," + "C".repeat(300 * 1024), srcLen: bigImg.length })).status === 400,
    "缩略图太大不收（防止把原图塞进缩略图列）");
  const notifBeforeThumb = (await call("GET", "/notifications/unread-count", supT)).j.total;
  ok((await call("PUT", `/styles/${sid}/thumb`, aT, { thumb: thumbImg, srcLen: bigImg.length })).status === 200, "后台补缩略图");
  ok((await call("PUT", `/styles/${sid}/thumb`, aT, { thumb: thumbImg, srcLen: bigImg.length })).status === 409, "已有缩略图的不会被覆盖");
  listed = (await call("GET", "/styles", aT)).j.styles.find(s => s.id === sid);
  ok(listed.has_thumb === true && listed.image === thumbImg, "补完缩略图列表就用缩略图");
  ok((await call("GET", "/notifications/unread-count", supT)).j.total === notifBeforeThumb, "补缩略图是静默的，不发通知");
  const noImg = await call("POST", "/styles", aT, { name: "无图款", code: "NOIMG-1" });
  ok((await call("PUT", `/styles/${noImg.j.style.id}/thumb`, aT, { thumb: thumbImg, srcLen: 10 })).status === 409, "没有图片的款式不能补缩略图");
  ok((await call("GET", "/styles", aT)).j.styles.find(s => s.id === noImg.j.style.id).image_count === 0, "没图的款式图片张数为 0");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(1); });
