const api = require("../../utils/api");

Page({
  data: {
    processes: [],
    totalCount: 0,
    totalPrice: 0,
    showForm: false,
    editingId: "",
    name: "",
    unit: "",
    stdQty: "",
    hourQuota: "",
    unitPrice: ""
  },
  onShow() { this.load(); },
  load() {
    api.get("/processes").then((res) => {
      const list = res.processes || [];
      const totalPrice = list.reduce((sum, p) => sum + Number(p.unit_price || 0), 0);
      this.setData({ processes: list, totalCount: list.length, totalPrice: Math.round(totalPrice * 100) / 100 });
    }).catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },
  toggleForm() {
    this.setData({ showForm: !this.data.showForm, editingId: "", name: "", unit: "", stdQty: "", hourQuota: "", unitPrice: "" });
  },
  editItem(e) {
    const item = e.currentTarget.dataset.item;
    this.setData({
      showForm: true, editingId: item.id, name: item.name,
      unit: item.unit || "", stdQty: String(item.std_qty), hourQuota: String(item.hour_quota),
      unitPrice: item.unit_price !== null && item.unit_price !== undefined ? String(item.unit_price) : ""
    });
  },
  onName(e) { this.setData({ name: e.detail.value }); },
  onUnit(e) { this.setData({ unit: e.detail.value }); },
  onStdQty(e) { this.setData({ stdQty: e.detail.value }); },
  onHourQuota(e) { this.setData({ hourQuota: e.detail.value }); },
  onUnitPrice(e) { this.setData({ unitPrice: e.detail.value }); },
  submit() {
    const { name, unit, stdQty, hourQuota, unitPrice, editingId } = this.data;
    if (!name || !stdQty || !hourQuota) {
      wx.showToast({ title: "请填写完整", icon: "none" });
      return;
    }
    const body = { name, unit, stdQty: Number(stdQty), hourQuota: Number(hourQuota) };
    if (unitPrice !== "") body.unitPrice = Number(unitPrice);
    const p = editingId ? api.patch("/processes/" + editingId, body) : api.post("/processes", body);
    p.then(() => { wx.showToast({ title: "已保存" }); this.toggleForm(); this.load(); })
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },
  remove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "删除工序",
      content: "确定删除这个工序模板吗？",
      cancelText: "取消",
      confirmText: "确认",
      success: (r) => {
        if (!r.confirm) return;
        api.del("/processes/" + id).then(() => this.load())
          .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
      }
    });
  }
});
