const api = require("../../utils/api");
const icons = require("../../utils/icons");
const { isManager } = require("../../utils/perm");

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

Page({
  data: {
    icons,
    user: null,
    isAdmin: false,
    isManager: false, // 管理员+主管：能看员工管理/操作记录/薪资管理
    pendingCount: 0,
    todayCount: 0
  },
  onShow() {
    const user = wx.getStorageSync("user");
    if (!user) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    const mgr = isManager(user);
    this.setData({ user, isAdmin: user.role === "admin", isManager: mgr });
    if (mgr) this.loadPendingCount(); // 员工管理待审批数：管理员+主管才看得到
    this.loadTodayCount();
    // 拉 /me 刷新最新岗位名（首页身份标签显示用），老会话没有 roleLabel 也能补上
    api.get("/me").then((res) => {
      if (res && res.user) {
        wx.setStorageSync("user", res.user);
        this.setData({ user: res.user, isAdmin: res.user.role === "admin", isManager: isManager(res.user) });
      }
    }).catch(() => {});
  },
  loadPendingCount() {
    api.get("/join/requests").then((res) => {
      this.setData({ pendingCount: (res.requests || []).length });
    }).catch(() => {});
  },
  loadTodayCount() {
    api.get("/scan?date=" + todayStr()).then((res) => {
      const total = (res.records || []).reduce((sum, r) => sum + Number(r.qty || 0), 0);
      this.setData({ todayCount: total });
    }).catch(() => {});
  },
  goEmployees() { wx.navigateTo({ url: "/pages/employees/employees" }); },
  goProcesses() { wx.navigateTo({ url: "/pages/processes/processes" }); },
  goStyles() { wx.navigateTo({ url: "/pages/styles/styles" }); },
  goAttendance() { wx.navigateTo({ url: "/pages/attendance/attendance" }); },
  goEfficiency() { wx.navigateTo({ url: "/pages/efficiency/efficiency" }); },
  goCutting() { wx.navigateTo({ url: "/pages/cutting/cutting" }); },
  goPayroll() { wx.navigateTo({ url: "/pages/payroll/payroll" }); },
  goScanlog() { wx.navigateTo({ url: "/pages/scanlog/scanlog" }); },
  goOperations() { wx.navigateTo({ url: "/pages/operations/operations" }); }
});
