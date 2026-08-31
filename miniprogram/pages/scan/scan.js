const api = require("../../utils/api");

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

Page({
  data: {
    date: todayStr(),
    processes: [],
    styles: [],
    processIndex: 0,
    styleIndex: 0,
    qty: "",
    records: [],
    percent: null,
    percentText: "",
    attendanceHours: 0
  },
  onShow() {
    this.loadOptionsThenRecords();
    this.loadEfficiency();
  },
  loadOptionsThenRecords() {
    Promise.all([
      api.get("/processes").then((res) => this.setData({ processes: res.processes || [] })),
      api.get("/styles").then((res) => this.setData({ styles: res.styles || [] }))
    ]).then(() => this.loadRecords()).catch(() => this.loadRecords());
  },
  loadRecords() {
    api.get("/scan?date=" + this.data.date).then((res) => {
      const list = (res.records || []).map((r) => {
        const p = this.data.processes.find((x) => x.id === r.process_id);
        return Object.assign({}, r, { processName: p ? p.name : r.process_id });
      });
      this.setData({ records: list });
    }).catch(() => {});
  },
  loadEfficiency() {
    api.get("/efficiency/daily?date=" + this.data.date).then((res) => {
      const percentText = res.percent !== null ? Math.round(res.percent * 1000) / 10 + "%" : "";
      this.setData({ percent: res.percent, percentText, attendanceHours: res.attendanceHours });
    }).catch(() => {});
  },
  onDateChange(e) {
    this.setData({ date: e.detail.value }, () => {
      this.loadRecords();
      this.loadEfficiency();
    });
  },
  onProcessChange(e) { this.setData({ processIndex: Number(e.detail.value) }); },
  onStyleChange(e) { this.setData({ styleIndex: Number(e.detail.value) }); },
  onQty(e) { this.setData({ qty: e.detail.value }); },
  submit() {
    const proc = this.data.processes[this.data.processIndex];
    if (!proc) {
      wx.showToast({ title: "请先添加工序模板", icon: "none" });
      return;
    }
    if (!this.data.qty) {
      wx.showToast({ title: "请填写完成数量", icon: "none" });
      return;
    }
    const style = this.data.styles[this.data.styleIndex];
    api.post("/scan", {
      processId: proc.id,
      styleId: style ? style.id : undefined,
      date: this.data.date,
      qty: Number(this.data.qty)
    }).then(() => {
      wx.showToast({ title: "已打点" });
      this.setData({ qty: "" });
      this.loadRecords();
      this.loadEfficiency();
    }).catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },
  removeRecord(e) {
    const id = e.currentTarget.dataset.id;
    api.del("/scan/" + id).then(() => { this.loadRecords(); this.loadEfficiency(); })
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  }
});
