const api = require("../../utils/api");

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

Page({
  data: { logs: [] },
  onShow() { this.load(); },
  load() {
    api.get("/operations").then((res) => {
      const logs = (res.logs || []).map((l) => Object.assign({}, l, { timeText: fmtTime(l.created_at) }));
      this.setData({ logs });
    }).catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  }
});
