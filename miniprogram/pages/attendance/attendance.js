const api = require("../../utils/api");

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

Page({
  data: {
    users: [],
    userIndex: 0,
    date: todayStr(),
    hours: "",
    records: []
  },
  onShow() {
    api.get("/users").then((res) => {
      this.setData({ users: res.users || [] });
      this.loadRecords();
    }).catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },
  onUserChange(e) { this.setData({ userIndex: Number(e.detail.value) }, () => this.loadRecords()); },
  onDateChange(e) { this.setData({ date: e.detail.value }, () => this.loadRecords()); },
  onHours(e) { this.setData({ hours: e.detail.value }); },
  loadRecords() {
    const u = this.data.users[this.data.userIndex];
    if (!u) return;
    const month = this.data.date.slice(0, 7);
    api.get("/attendance?month=" + month + "&userId=" + u.id)
      .then((res) => this.setData({ records: res.attendance || [] })).catch(() => {});
  },
  submit() {
    const u = this.data.users[this.data.userIndex];
    if (!u) {
      wx.showToast({ title: "请先添加员工", icon: "none" });
      return;
    }
    if (!this.data.hours) {
      wx.showToast({ title: "请填写工时", icon: "none" });
      return;
    }
    api.post("/attendance", { userId: u.id, date: this.data.date, hours: Number(this.data.hours) })
      .then(() => { wx.showToast({ title: "已保存" }); this.setData({ hours: "" }); this.loadRecords(); })
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  }
});
