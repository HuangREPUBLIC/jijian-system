const api = require("../../utils/api");
const icons = require("../../utils/icons");

Page({
  data: {
    icons,
    range: "today",
    overview: { completed: 0, inProduction: 0 },
    tab: "sheet", // sheet | style
    keyword: "",
    sheets: [],
    byStyle: [],
    styles: [],
    showForm: false,
    styleIndex: 0,
    qty: "",
    note: ""
  },
  onShow() {
    this.loadStyles();
    this.loadOverview();
    this.loadList();
  },
  loadStyles() {
    api.get("/styles").then((res) => this.setData({ styles: res.styles || [] })).catch(() => {});
  },
  loadOverview() {
    api.get("/cutting/overview?range=" + this.data.range).then((res) => {
      this.setData({ overview: { completed: res.completed, inProduction: res.inProduction } });
    }).catch(() => {});
  },
  switchRange(e) {
    this.setData({ range: e.currentTarget.dataset.range }, () => this.loadOverview());
  },
  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab }, () => this.loadList());
  },
  onSearch(e) {
    this.setData({ keyword: e.detail.value }, () => this.loadList());
  },
  loadList() {
    const q = this.data.keyword.trim();
    const qs = q ? "?q=" + encodeURIComponent(q) : "";
    if (this.data.tab === "sheet") {
      api.get("/cutting-sheets" + qs).then((res) => this.setData({ sheets: res.sheets || [] }))
        .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
    } else {
      api.get("/cutting-sheets/by-style" + qs).then((res) => this.setData({ byStyle: res.list || [] }))
        .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
    }
  },
  toggleForm() { this.setData({ showForm: !this.data.showForm, qty: "", note: "" }); },
  onStyleChange(e) { this.setData({ styleIndex: Number(e.detail.value) }); },
  onQty(e) { this.setData({ qty: e.detail.value }); },
  onNote(e) { this.setData({ note: e.detail.value }); },
  submit() {
    const style = this.data.styles[this.data.styleIndex];
    if (!style) {
      wx.showToast({ title: "请先添加款式", icon: "none" });
      return;
    }
    if (!this.data.qty) {
      wx.showToast({ title: "请填写数量", icon: "none" });
      return;
    }
    api.post("/cutting-sheets", { styleId: style.id, qty: Number(this.data.qty), note: this.data.note })
      .then(() => { wx.showToast({ title: "已新增" }); this.toggleForm(); this.loadOverview(); this.loadList(); })
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },
  remove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "删除裁床单",
      content: "确定删除吗？",
      cancelText: "取消",
      confirmText: "确认",
      success: (r) => {
        if (!r.confirm) return;
        api.del("/cutting-sheets/" + id).then(() => { this.loadOverview(); this.loadList(); })
          .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
      }
    });
  }
});
