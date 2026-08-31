const api = require("../../utils/api");

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

Page({
  data: { date: todayStr(), records: [] },
  onShow() { this.load(); },
  onDateChange(e) { this.setData({ date: e.detail.value }, () => this.load()); },
  load() {
    api.get("/scan-all?date=" + this.data.date).then((res) => this.setData({ records: res.records || [] }))
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  }
});
