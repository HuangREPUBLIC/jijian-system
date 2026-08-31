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
  // 测试库是全新空库，先手动插一个管理员账号（跟 daka-system 一样直接建号，走 wx.login 假 openid 绑定登录）
  const { db, uid } = require(require("path").join(__dirname, "..", "server", "db"));
  const A = require(require("path").join(__dirname, "..", "server", "auth"));
  const adminId = uid();
  await db.prepare("INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
    .run(adminId, "老板", "13900000000", A.hashPassword("x"), "admin", Date.now());
  await db.prepare("INSERT INTO jj_wx_bindings(openid,user_id,created_at) VALUES(?,?,?)")
    .run("openid-admin", adminId, Date.now());

  // 管理员用假 openid 登录
  const admLogin = await call("POST", "/wx/login", null, { testOpenid: "openid-admin" });
  ok(admLogin.status === 200 && admLogin.j.token && admLogin.j.user.role === "admin", "管理员用微信登录");
  const aT = admLogin.j.token;

  // 没配置 WX_APPID/SECRET 时，非测试 openid 走真实 code2Session 应该报 500（缺少配置）
  const noConfig = await call("POST", "/wx/login", null, { code: "abc" });
  ok(noConfig.status === 500, "未配置微信 AppID 时给出明确报错");

  // 管理员换一台设备扫码加入：应该直接自动放行，不需要（也没法）等审批
  const adminJoin = await call("POST", "/join/scan", null, { openid: "openid-admin-2nd-device", phone: "13900000000", name: "老板" });
  ok(adminJoin.status === 200 && adminJoin.j.status === "approved" && adminJoin.j.token, "管理员换设备扫码直接自动放行");

  // 新 openid 没绑定，返回 needJoin
  const newOpen = await call("POST", "/wx/login", null, { testOpenid: "openid-new-guy" });
  ok(newOpen.status === 200 && newOpen.j.needJoin === true, "陌生 openid 返回 needJoin");

  // 扫码加入：新手机号，走审批
  const join = await call("POST", "/join/scan", null, { openid: "openid-new-guy", phone: "13711112222", name: "李焕" });
  ok(join.status === 200 && join.j.status === "pending", "扫码加入新员工进入待审批");

  // 未审批前登录仍然 needJoin
  const stillPending = await call("POST", "/wx/login", null, { testOpenid: "openid-new-guy" });
  ok(stillPending.j.needJoin === true, "审批通过前仍然登录不了");

  // 非管理员不能看审批列表
  ok((await call("GET", "/join/requests", aT)).status === 200, "管理员能看待审批列表");

  // 管理员审批通过
  const appr = await call("POST", `/join/requests/${join.j.requestId}/approve`, aT);
  ok(appr.status === 200, "管理员审批通过");

  // 审批通过后重新登录成功
  const afterApprove = await call("POST", "/wx/login", null, { testOpenid: "openid-new-guy" });
  ok(afterApprove.status === 200 && afterApprove.j.token && afterApprove.j.user.name === "李焕", "审批后重新登录生效");

  // 手动添加员工（管理员直接建号，不需要审批）
  const manualAdd = await call("POST", "/users", aT, { name: "纪秀芝", phone: "13722223333", role: "worker" });
  ok(manualAdd.status === 200 && manualAdd.j.user.name === "纪秀芝", "管理员手动添加员工不需要审批");

  // 手动添加的员工后续扫码绑定同一手机号，直接命中已有账号（而不是新建一行）
  const bindExisting = await call("POST", "/join/scan", null, { openid: "openid-jixiuzhi", phone: "13722223333", name: "纪秀芝" });
  ok(bindExisting.status === 200, "已有账号也走扫码申请绑定");
  const users1 = await call("GET", "/users", aT);
  const jiCount = users1.j.users.filter(u => u.phone === "13722223333").length;
  ok(jiCount === 1, "扫码绑定已有手机号不会重复建号");

  // 非管理员不能添加员工/管理工序款式
  const wT = afterApprove.j.token; // 李焕，普通员工
  ok((await call("POST", "/users", wT, { name: "x", phone: "13733334444" })).status === 403, "普通员工不能手动添加员工");
  ok((await call("GET", "/join/requests", wT)).status === 403, "普通员工不能看审批列表");

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

  // 拒绝申请
  const join2 = await call("POST", "/join/scan", null, { openid: "openid-rejected", phone: "13744445555", name: "张三" });
  const rej = await call("POST", `/join/requests/${join2.j.requestId}/reject`, aT);
  ok(rej.status === 200, "管理员拒绝申请");
  const afterReject = await call("POST", "/wx/login", null, { testOpenid: "openid-rejected" });
  ok(afterReject.j.needJoin === true, "拒绝后仍然登录不了");
  const reApprove = await call("POST", `/join/requests/${join2.j.requestId}/approve`, aT);
  ok(reApprove.status === 400, "已处理过的申请不能重复审批");

  // 打点 + 考勤 + 完成百分比（用真实台账里李焕 6/1 那组数字做回归：
  // 1085/225 + 850/225 = 8.6 时效小时，出勤 8 小时，8.6/8 = 1.075）
  const huanId = afterApprove.j.user.id; // 李焕
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

  // 裁床单 / 生产管理
  const style2 = await call("POST", "/styles", aT, { name: "TESTSTYLE", code: "T001" });
  const sheet1 = await call("POST", "/cutting-sheets", aT, { styleId: style2.j.style.id, qty: 500, note: "测试批次" });
  ok(sheet1.status === 200 && sheet1.j.sheet.style_name === "TESTSTYLE", "管理员新增裁床单");
  ok((await call("POST", "/cutting-sheets", wT, { styleId: style2.j.style.id, qty: 1 })).status === 200, "测试阶段普通员工也能新增裁床单");
  ok((await call("GET", "/cutting-sheets", wT)).status === 200, "普通员工能查看裁床单");
  const sheetEdit = await call("PATCH", `/cutting-sheets/${sheet1.j.sheet.id}`, aT, { qty: 600 });
  ok(sheetEdit.status === 200 && sheetEdit.j.sheet.qty === 600, "管理员修改裁床单数量");
  const sheetDel = await call("DELETE", `/cutting-sheets/${sheet1.j.sheet.id}`, aT);
  ok(sheetDel.status === 200, "管理员删除裁床单");
  const sheetsAfterDel = await call("GET", "/cutting-sheets", aT);
  ok(!sheetsAfterDel.j.sheets.some(x => x.id === sheet1.j.sheet.id), "删除后的裁床单不再出现");

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
  ok(ops.j.logs.some(x => x.action.includes("裁床单")), "操作记录里包含裁床单相关操作");
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

  const procForStyle = await call("POST", "/processes", aT, { name: "钉扣3", unit: "个", stdQty: 100, hourQuota: 10, unitPrice: 1.5 });
  const spAdd = await call("POST", `/styles/${style3.j.style.id}/processes`, aT, { processId: procForStyle.j.process.id });
  ok(spAdd.status === 200 && spAdd.j.item.unit_price === null, "款式关联工序，不填价格就是走模板默认价");
  const spList1 = await call("GET", `/styles/${style3.j.style.id}/processes`, wT);
  ok(spList1.status === 200 && spList1.j.list[0].effectivePrice === 1.5, "没单独设价时，有效单价 = 工序模板默认单价");

  const spAddOverride = await call("POST", `/styles/${style3.j.style.id}/processes`, aT, { processId: procForStyle.j.process.id, unitPrice: 2.2 });
  ok(spAddOverride.j.item.unit_price === 2.2, "带价格新增，单独覆盖成功");
  ok((await call("POST", `/styles/${style2.j.style.id}/processes`, wT, { processId: procForStyle.j.process.id })).status === 200, "测试阶段普通员工也能给款式加工序");

  const spList2 = await call("GET", `/styles/${style3.j.style.id}/processes`, aT);
  ok(spList2.j.list.length === 2, "款式下有两条工序关联");
  ok(spList2.j.list[1].seq === 2, "第二条序号是2（按添加顺序）");

  const spPatch = await call("PATCH", `/style-processes/${spAdd.j.item.id}`, aT, { unitPrice: 1.8 });
  ok(spPatch.j.item.unit_price === 1.8, "管理员修改某条关联的单独单价");

  const spDel = await call("DELETE", `/style-processes/${spAddOverride.j.item.id}`, aT);
  ok(spDel.status === 200, "管理员删除一条款式工序关联");
  const spList3 = await call("GET", `/styles/${style3.j.style.id}/processes`, aT);
  ok(spList3.j.list.length === 1, "删除后只剩一条关联");

  // 测试阶段权限：主管(技术主管 tech_lead)对 3 块受限区(员工管理/操作记录/薪资)有完全权限，普通员工没有
  await call("POST", "/users", aT, { name: "主管测试", phone: "13655556666", role: "tech_lead" });
  const superJoin = await call("POST", "/join/scan", null, { openid: "openid-super", phone: "13655556666", name: "主管测试" });
  ok(superJoin.status === 200 && superJoin.j.token, "主管账号扫码直接登录");
  const supT = superJoin.j.token;
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
  const targetJoin = await call("POST", "/join/scan", null, { openid: "openid-rolechange", phone: "13644445555", name: "岗位通知测试" });
  const targetT = targetJoin.j.token;
  const targetList = (await call("GET", "/notifications", targetT)).j.list;
  ok(targetList.some(n => n.text.includes("岗位")), "被调整岗位的员工本人收到了通知");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(1); });
