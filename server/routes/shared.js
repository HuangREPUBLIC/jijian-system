"use strict";
// 多个路由文件共用的辅助函数（字段名对照、改动描述、取整、用户展示信息等）。

const jsonParseSafe = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; } };

function changeWhat(labels, body, skipValueKeys) {
  const changedKeys = Object.keys(labels).filter((k) => body[k] !== undefined);
  if (!changedKeys.length) return null;
  if (changedKeys.length === 1) {
    const k = changedKeys[0], v = body[k];
    if ((skipValueKeys || []).includes(k)) return `修改了「${labels[k]}」`;
    if (v === null || String(v).trim() === "") return `把「${labels[k]}」改成了（清空）`;
    return `把「${labels[k]}」改成了${v}`;
  }
  const names = changedKeys.map((k) => labels[k]);
  return names.length > 3 ? `修改了「${names.slice(0, 3).join("、")}」等${names.length}项` : `修改了「${names.join("、")}」`;
}

// 职位显示名：车间岗位存的是 settings.roles，遍历用户列表前先加载好再用这个同步版查表。
// 从跟单系统导入的老岗位键没有这张表的话会显示原始键（如 r1785125327446）
const LEGACY_ROLE_LABELS = {
  sales: "业务员（跟单系统）", follower: "下厂员（跟单系统）",
  tech_lead: "技术主管（跟单系统）", biz_lead: "业务主管（跟单系统）",
  r1785125327446: "技术主管（跟单系统）", r1785125333976: "业务主管（跟单系统）"
};
function roleLabelWith(roles, roleKey) {
  if (roleKey === "admin") return "工厂管理员";
  if (roleKey === "worker") return "计件工";
  const r = roles.find((x) => x.k === roleKey);
  if (r) return r.label;
  return LEGACY_ROLE_LABELS[roleKey] || roleKey;
}

module.exports = { jsonParseSafe, changeWhat, LEGACY_ROLE_LABELS, roleLabelWith };
