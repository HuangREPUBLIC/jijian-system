const icons = require("../../utils/icons");

Page({
  data: {
    icons,
    companyName: "天津锦利国际贸易有限公司"
  },
  onShareAppMessage() {
    return {
      title: "邀请你加入" + this.data.companyName + " · 计件跟踪",
      path: "/pages/login/login"
    };
  }
});
