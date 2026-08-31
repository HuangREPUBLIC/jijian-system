// 测试阶段权限判断（前端菜单显隐用，跟后端 auth.js 的 isManager 保持一致）。
// 管理员 + 两个主管(技术主管/业务主管) = 完全权限，能看「员工管理/操作记录/薪资管理」这 3 块。
// 其他人这 3 块隐藏，其余功能都能用。测试结束想收紧就改这里 + 后端 auth.js。
const SUPERVISOR_ROLES = ["r1785125327446", "r1785125333976", "tech_lead", "biz_lead"];

function isManager(user) {
  return !!user && (user.role === "admin" || SUPERVISOR_ROLES.indexOf(user.role) >= 0);
}

module.exports = { isManager, SUPERVISOR_ROLES };
