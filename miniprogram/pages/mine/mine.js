const api = require("../../utils/api");

Page({
  data: { user: null, isAdmin: false },
  onShow() {
    const user = wx.getStorageSync("user");
    if (!user) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    this.setData({ user, isAdmin: user.role === "admin" });
    // 拉一次 /me 刷新最新岗位名（职位显示用），老会话没有 roleLabel 也能补上
    api.get("/me").then((res) => {
      if (res && res.user) {
        wx.setStorageSync("user", res.user);
        this.setData({ user: res.user, isAdmin: res.user.role === "admin" });
      }
    }).catch(() => {});
  },
  logout() {
    wx.showModal({
      title: "退出登录",
      content: "确定要退出登录吗？",
      cancelText: "取消",
      confirmText: "确认",
      success: (r) => {
        if (!r.confirm) return;
        wx.removeStorageSync("token");
        wx.removeStorageSync("user");
        wx.setStorageSync("loggedOut", "1"); // 标记主动退出，登录页据此不自动登录
        wx.reLaunch({ url: "/pages/login/login" });
      }
    });
  }
});
