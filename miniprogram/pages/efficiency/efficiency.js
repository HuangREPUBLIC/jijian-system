const api = require("../../utils/api");

function monthStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1);
}

Page({
  data: { month: monthStr(), list: [] },
  onShow() { this.load(); },
  onMonthChange(e) { this.setData({ month: e.detail.value }, () => this.load()); },
  load() {
    api.get("/efficiency/summary?month=" + this.data.month).then((res) => {
      const list = (res.list || []).map((x) => Object.assign({}, x, {
        percentText: x.percent !== null ? Math.round(x.percent * 1000) / 10 + "%" : "暂无考勤",
        effectiveHoursText: Math.round(x.effectiveHours * 10) / 10
      })).sort((a, b) => (b.percent === null ? -1 : b.percent) - (a.percent === null ? -1 : a.percent));
      this.setData({ list });
    }).catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  }
});
