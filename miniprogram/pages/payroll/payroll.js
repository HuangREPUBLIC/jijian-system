const api = require("../../utils/api");
const { isManager } = require("../../utils/perm");

function monthStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1);
}

Page({
  data: {
    month: monthStr(),
    isAdmin: false,
    list: [],
    mine: null,
    editingUserId: "",
    mealSubsidy: "",
    penalty: "",
    bonus: ""
  },
  onShow() {
    const user = wx.getStorageSync("user");
    this.setData({ isAdmin: isManager(user) }); // 管理员+主管都看全员薪资、可调整薪资项
    this.load();
  },
  onMonthChange(e) { this.setData({ month: e.detail.value }, () => this.load()); },
  load() {
    if (this.data.isAdmin) {
      api.get("/payroll/summary?month=" + this.data.month).then((res) => {
        this.setData({ list: res.list || [] });
      }).catch((err) => wx.showToast({ title: String(err), icon: "none" }));
    } else {
      api.get("/payroll/mine?month=" + this.data.month).then((res) => {
        this.setData({ mine: res });
      }).catch((err) => wx.showToast({ title: String(err), icon: "none" }));
    }
  },
  editRow(e) {
    const item = e.currentTarget.dataset.item;
    const same = this.data.editingUserId === item.userId;
    this.setData({
      editingUserId: same ? "" : item.userId,
      mealSubsidy: same ? "" : String(item.mealSubsidy || ""),
      penalty: same ? "" : String(item.penalty || ""),
      bonus: same ? "" : String(item.bonus || "")
    });
  },
  onMeal(e) { this.setData({ mealSubsidy: e.detail.value }); },
  onPenalty(e) { this.setData({ penalty: e.detail.value }); },
  onBonus(e) { this.setData({ bonus: e.detail.value }); },
  saveAdjust() {
    api.post("/payroll/adjustments", {
      userId: this.data.editingUserId,
      month: this.data.month,
      mealSubsidy: Number(this.data.mealSubsidy) || 0,
      penalty: Number(this.data.penalty) || 0,
      bonus: Number(this.data.bonus) || 0
    }).then(() => { wx.showToast({ title: "已保存" }); this.setData({ editingUserId: "" }); this.load(); })
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  }
});
