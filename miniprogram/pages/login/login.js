const api = require("../../utils/api");

Page({
  data: {
    loading: true,
    needJoin: false,
    openid: "",
    name: "",
    phone: "",
    submitted: false,
    errorMsg: ""
  },
  onLoad() {
    // 已经登录过（本地有 token+user）就直接进工作台，保持登录状态、不再要求登录。
    if (wx.getStorageSync("token") && wx.getStorageSync("user")) {
      wx.reLaunch({ url: "/pages/index/index" });
      return;
    }
    // 主动退出登录过：进入「换账号」模式——不自动登回原账号，而是显示填信息表单，可登录别的账号。
    if (wx.getStorageSync("loggedOut")) {
      this.tryLogin({ switchAccount: true });
      return;
    }
    this.tryLogin();
  },
  tryLogin(opts) {
    // opts.switchAccount=true 时走「换账号」：后端不自动登回原账号，直接返回 openid 显示填信息表单。
    const extra = (opts && opts.switchAccount === true) ? { switchAccount: true } : {};
    this.setData({ loading: true, errorMsg: "" });
    const envVersion = (wx.getAccountInfoSync && wx.getAccountInfoSync().miniProgram.envVersion) || "develop";
    if (envVersion !== "develop") {
      // 云托管：openid 由 callContainer 自动注入，无需 wx.login 拿 code
      this.doLogin(extra);
      return;
    }
    wx.login({
      success: (r) => this.doLogin(Object.assign({ code: r.code }, extra)),
      fail: () => this.setData({ loading: false, errorMsg: "微信登录失败，请重试" })
    });
  },
  doLogin(payload) {
    api.post("/wx/login", payload).then((res) => {
      if (res.token) {
        wx.removeStorageSync("loggedOut");
        wx.setStorageSync("token", res.token);
        wx.setStorageSync("user", res.user);
        wx.reLaunch({ url: "/pages/index/index" });
      } else if (res.needJoin) {
        this.setData({ loading: false, needJoin: true, openid: res.openid });
      }
    }).catch((err) => {
      this.setData({ loading: false, errorMsg: typeof err === "string" ? err : "登录失败" });
    });
  },
  onNameInput(e) { this.setData({ name: e.detail.value }); },
  onPhoneInput(e) { this.setData({ phone: e.detail.value }); },
  submitJoin() {
    if (!this.data.name || !this.data.phone) {
      wx.showToast({ title: "请填写姓名和手机号", icon: "none" });
      return;
    }
    api.post("/join/scan", { openid: this.data.openid, phone: this.data.phone, name: this.data.name })
      .then((res) => {
        if (res.status === "approved" && res.token) {
          wx.removeStorageSync("loggedOut");
          wx.setStorageSync("token", res.token);
          wx.setStorageSync("user", res.user);
          wx.reLaunch({ url: "/pages/index/index" });
          return;
        }
        this.setData({ submitted: true });
      })
      .catch((err) => wx.showToast({ title: typeof err === "string" ? err : "提交失败", icon: "none" }));
  },
  checkApproved() { this.tryLogin(); }
});
