const api = require("../../utils/api");

Page({
  data: {
    styles: [],
    showForm: false,
    editingId: "",
    name: "",
    code: "",
    images: [],       // 款式多图：fileID 数组（cloud://...）
    sizeSelMap: {},   // 尺码多选：{ "XL": true, "2XL": true }
    colorSelMap: {},  // 颜色多选
    customer: "",
    nameError: "",
    codeError: "",
    sizes: [],
    colors: [],
    customers: [],
    customerIndex: -1,
    processOptions: [],
    styleProcesses: [], // 编辑已有款式时是真实记录（有id）；新建时是本地暂存(pending:true)
    showAddProcess: false,
    addProcessIndex: 0,
    addProcessPrice: "",
    editingSpId: "",
    editSpPrice: "",
    totalPrice: "0",
    totalCount: 0
  },
  onShow() {
    this.load();
    this.loadOptions();
    this.loadProcessOptions();
  },
  load() {
    api.get("/styles").then((res) => {
      const list = (res.styles || []).map((s) => {
        let imgs = [];
        try { imgs = s.images ? JSON.parse(s.images) : []; } catch (e) { imgs = []; }
        if ((!imgs || imgs.length === 0) && s.image) imgs = [s.image]; // 兼容旧单图数据
        return Object.assign({}, s, { imagesList: imgs });
      });
      this.setData({ styles: list });
    }).catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },
  // 点图放大看（列表缩略图、编辑表单图墙都用它）：urls 是同款全部图，current 是点的这张
  previewImage(e) {
    const urls = e.currentTarget.dataset.urls || [];
    const current = e.currentTarget.dataset.current;
    if (!urls.length) { if (current) wx.previewImage({ current, urls: [current] }); return; }
    wx.previewImage({ current: current || urls[0], urls });
  },
  loadOptions() {
    api.get("/style-options").then((res) => this.setData({
      sizes: res.sizes || [], colors: res.colors || [], customers: res.customers || []
    })).catch(() => {});
  },
  loadProcessOptions() {
    api.get("/processes").then((res) => this.setData({ processOptions: res.processes || [] })).catch(() => {});
  },

  recalcTotals() {
    const list = this.data.styleProcesses;
    let sum = 0;
    list.forEach((it) => { sum += Number(it.effectivePrice) || 0; });
    this.setData({ totalPrice: Math.round(sum * 100) / 100 + "", totalCount: list.length });
  },

  toggleForm() {
    const show = !this.data.showForm;
    this.setData({
      showForm: show, editingId: "", name: "", code: "", images: [],
      sizeSelMap: {}, colorSelMap: {}, customer: "", customerIndex: -1,
      nameError: "", codeError: "", styleProcesses: [], showAddProcess: false,
      addProcessIndex: 0, addProcessPrice: "", editingSpId: ""
    });
    this.recalcTotals();
  },
  editItem(e) {
    const item = e.currentTarget.dataset.item;
    const sizeSelMap = {}; (item.size ? String(item.size).split(",") : []).forEach((s) => { if (s) sizeSelMap[s] = true; });
    const colorSelMap = {}; (item.color ? String(item.color).split(",") : []).forEach((c) => { if (c) colorSelMap[c] = true; });
    let imgs = [];
    try { imgs = item.images ? JSON.parse(item.images) : []; } catch (e) { imgs = []; }
    if ((!imgs || imgs.length === 0) && item.image) imgs = [item.image]; // 兼容旧的单图数据
    this.setData({
      showForm: true, editingId: item.id, name: item.name, code: item.code || "", images: imgs,
      sizeSelMap, colorSelMap, customer: item.customer || "",
      customerIndex: this.data.customers.indexOf(item.customer), nameError: "", codeError: ""
    });
    this.loadStyleProcesses(item.id);
  },
  loadStyleProcesses(styleId) {
    api.get(`/styles/${styleId}/processes`).then((res) => {
      this.setData({ styleProcesses: res.list || [] });
      this.recalcTotals();
    }).catch(() => {});
  },

  onName(e) { this.setData({ name: e.detail.value, nameError: "" }); },
  onCode(e) { this.setData({ code: e.detail.value, codeError: "" }); },

  chooseImage() {
    // 多图：一次最多选 9 张（微信上限），可反复点"添加"继续加，总数不限。上传到云托管对象存储。
    wx.chooseMedia({
      count: 9,
      mediaType: ["image"],
      sizeType: ["compressed"],
      success: (res) => {
        const files = res.tempFiles || [];
        if (!files.length) return;
        wx.showLoading({ title: "上传中", mask: true });
        Promise.all(files.map((f) => api.uploadCloudImage(f.tempFilePath))).then((ids) => {
          wx.hideLoading();
          this.setData({ images: this.data.images.concat(ids) });
        }).catch((err) => {
          wx.hideLoading();
          wx.showToast({ title: String(err), icon: "none" });
        });
      }
    });
  },
  removeImageAt(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const imgs = this.data.images.slice();
    imgs.splice(idx, 1);
    this.setData({ images: imgs });
  },

  toggleSize(e) {
    const v = e.currentTarget.dataset.value;
    const map = Object.assign({}, this.data.sizeSelMap);
    if (map[v]) delete map[v]; else map[v] = true;
    this.setData({ sizeSelMap: map });
  },
  toggleColor(e) {
    const v = e.currentTarget.dataset.value;
    const map = Object.assign({}, this.data.colorSelMap);
    if (map[v]) delete map[v]; else map[v] = true;
    this.setData({ colorSelMap: map });
  },
  onCustomerChange(e) {
    const idx = Number(e.detail.value);
    this.setData({ customerIndex: idx, customer: this.data.customers[idx] || "" });
  },
  addOption(e) {
    const type = e.currentTarget.dataset.type; // size | color | customer
    const titles = { size: "新增尺码", color: "新增颜色", customer: "新增客户" };
    wx.showModal({
      title: titles[type],
      editable: true,
      placeholderText: "请输入",
      cancelText: "取消",
      confirmText: "确认",
      success: (r) => {
        if (!r.confirm || !r.content) return;
        api.post("/style-options", { type, value: r.content.trim() }).then(() => {
          this.loadOptions();
          wx.showToast({ title: "已添加" });
        }).catch((err) => wx.showToast({ title: String(err), icon: "none" }));
      }
    });
  },

  toggleAddProcess() { this.setData({ showAddProcess: !this.data.showAddProcess, addProcessIndex: 0, addProcessPrice: "" }); },
  onAddProcessChange(e) { this.setData({ addProcessIndex: Number(e.detail.value) }); },
  onAddProcessPrice(e) { this.setData({ addProcessPrice: e.detail.value }); },
  confirmAddProcess() {
    const proc = this.data.processOptions[this.data.addProcessIndex];
    if (!proc) { wx.showToast({ title: "请先添加工序模板", icon: "none" }); return; }
    const priceStr = this.data.addProcessPrice;
    const unitPrice = priceStr !== "" ? Number(priceStr) : null;
    const effectivePrice = unitPrice !== null ? unitPrice : (proc.unit_price || 0);

    if (this.data.editingId) {
      api.post(`/styles/${this.data.editingId}/processes`, { processId: proc.id, unitPrice: unitPrice === null ? undefined : unitPrice })
        .then(() => { this.loadStyleProcesses(this.data.editingId); this.toggleAddProcess(); })
        .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
    } else {
      const list = this.data.styleProcesses.concat([{
        id: "pending-" + Date.now(), pending: true, process_id: proc.id, process_name: proc.name,
        unit_price: unitPrice, effectivePrice
      }]);
      this.setData({ styleProcesses: list });
      this.recalcTotals();
      this.toggleAddProcess();
    }
  },
  removeProcess(e) {
    const item = e.currentTarget.dataset.item;
    if (item.pending) {
      const list = this.data.styleProcesses.filter((x) => x.id !== item.id);
      this.setData({ styleProcesses: list });
      this.recalcTotals();
      return;
    }
    api.del(`/style-processes/${item.id}`).then(() => this.loadStyleProcesses(this.data.editingId))
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },
  editProcessPrice(e) {
    const item = e.currentTarget.dataset.item;
    this.setData({ editingSpId: item.id, editSpPrice: item.unit_price !== null && item.unit_price !== undefined ? String(item.unit_price) : "" });
  },
  onEditSpPrice(e) { this.setData({ editSpPrice: e.detail.value }); },
  saveProcessPrice() {
    const id = this.data.editingSpId;
    const priceStr = this.data.editSpPrice;
    const unitPrice = priceStr !== "" ? Number(priceStr) : null;
    if (id.indexOf("pending-") === 0) {
      const proc = this.data.processOptions.find((p) => this.data.styleProcesses.find((x) => x.id === id && x.process_id === p.id));
      const list = this.data.styleProcesses.map((x) => x.id === id
        ? Object.assign({}, x, { unit_price: unitPrice, effectivePrice: unitPrice !== null ? unitPrice : (proc ? proc.unit_price || 0 : 0) })
        : x);
      this.setData({ styleProcesses: list, editingSpId: "" });
      this.recalcTotals();
      return;
    }
    api.patch(`/style-processes/${id}`, { unitPrice: unitPrice === null ? "" : unitPrice })
      .then(() => { this.setData({ editingSpId: "" }); this.loadStyleProcesses(this.data.editingId); })
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },

  submit() {
    const { name, code, customer, editingId } = this.data;
    const images = this.data.images;
    const image = images[0] || ""; // 封面 = 第一张
    const size = Object.keys(this.data.sizeSelMap).join(",");
    const color = Object.keys(this.data.colorSelMap).join(",");
    let hasError = false;
    if (!name.trim()) { this.setData({ nameError: "请填写款式名称" }); hasError = true; }
    if (!code.trim()) { this.setData({ codeError: "请填写款号" }); hasError = true; }
    if (hasError) return;
    const body = { name, code, image, images, size, color, customer };
    const p = editingId ? api.patch(`/styles/${editingId}`, body) : api.post("/styles", body);
    p.then((res) => {
      const styleId = editingId || res.style.id;
      if (!editingId && this.data.styleProcesses.length > 0) {
        const jobs = this.data.styleProcesses.map((it) => api.post(`/styles/${styleId}/processes`, {
          processId: it.process_id, unitPrice: it.unit_price === null ? undefined : it.unit_price
        }));
        return Promise.all(jobs);
      }
    }).then(() => {
      wx.showToast({ title: "已保存" });
      this.toggleForm();
      this.load();
    }).catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },

  remove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "删除款式",
      content: "确定删除这个款式吗？",
      cancelText: "取消",
      confirmText: "确认",
      success: (r) => {
        if (!r.confirm) return;
        api.del("/styles/" + id).then(() => this.load())
          .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
      }
    });
  }
});
