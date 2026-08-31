App({
  globalData: { user: null, token: null },
  onLaunch() {
    // 初始化云开发/云托管（体验版、正式版调 wx.cloud.callContainer 需要）
    if (wx.cloud && wx.cloud.init) {
      wx.cloud.init({ env: "prod-d1g9085h570a48a5e", traceUser: true });
    }
    this.globalData.user = wx.getStorageSync("user") || null;
    this.globalData.token = wx.getStorageSync("token") || null;
  }
});
