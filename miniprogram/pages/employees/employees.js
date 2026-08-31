const api = require("../../utils/api");
const icons = require("../../utils/icons");

function initials(name) {
  if (!name) return "";
  return name.length > 2 ? name.slice(-2) : name;
}
function fmtDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

Page({
  data: {
    icons,
    tab: "list",
    allUsers: [],
    users: [],
    keyword: "",
    requests: [],
    roles: [],
    showAdd: false,
    name: "",
    phone: "",
    expandedId: "",
    expandMode: "", // 'edit' | 'role'
    editName: "",
    editPhone: "",
    roleIndex: 0
  },
  onShow() {
    this.loadUsers();
    this.loadRequests();
    this.loadRoles();
  },
  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.tab }); },
  goInvite() { wx.navigateTo({ url: "/pages/invite/invite" }); },
  loadUsers() {
    api.get("/users").then((res) => {
      const list = (res.users || [])
        .filter((u) => u.role !== "admin")
        .map((u) => Object.assign({}, u, { initials: initials(u.name), dateText: fmtDate(u.createdAt) }));
      this.setData({ allUsers: list });
      this.applyKeyword();
    }).catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },
  onSearch(e) {
    this.setData({ keyword: e.detail.value });
    this.applyKeyword();
  },
  applyKeyword() {
    const kw = this.data.keyword.trim();
    const users = kw ? this.data.allUsers.filter((u) => u.name.includes(kw)) : this.data.allUsers;
    this.setData({ users });
  },
  loadRequests() {
    api.get("/join/requests").then((res) => this.setData({ requests: res.requests || [] })).catch(() => {});
  },
  loadRoles() {
    api.get("/roles").then((res) => this.setData({ roles: res.roles || [] })).catch(() => {});
  },
  toggleAdd() { this.setData({ showAdd: !this.data.showAdd, name: "", phone: "" }); },
  onNameInput(e) { this.setData({ name: e.detail.value }); },
  onPhoneInput(e) { this.setData({ phone: e.detail.value }); },
  submitAdd() {
    if (!this.data.name || !this.data.phone) {
      wx.showToast({ title: "请填写姓名和手机号", icon: "none" });
      return;
    }
    api.post("/users", { name: this.data.name, phone: this.data.phone, role: "worker" })
      .then(() => { wx.showToast({ title: "已添加" }); this.setData({ showAdd: false }); this.loadUsers(); })
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },

  openEdit(e) {
    const item = e.currentTarget.dataset.item;
    const same = this.data.expandedId === item.id && this.data.expandMode === "edit";
    this.setData({
      expandedId: same ? "" : item.id,
      expandMode: same ? "" : "edit",
      editName: item.name,
      editPhone: item.phone
    });
  },
  onEditName(e) { this.setData({ editName: e.detail.value }); },
  onEditPhone(e) { this.setData({ editPhone: e.detail.value }); },
  saveEdit() {
    api.patch("/users/" + this.data.expandedId, { name: this.data.editName, phone: this.data.editPhone })
      .then(() => { wx.showToast({ title: "已保存" }); this.setData({ expandedId: "", expandMode: "" }); this.loadUsers(); })
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },

  openRole(e) {
    const item = e.currentTarget.dataset.item;
    const same = this.data.expandedId === item.id && this.data.expandMode === "role";
    const idx = this.data.roles.findIndex((r) => r.k === item.role);
    this.setData({
      expandedId: same ? "" : item.id,
      expandMode: same ? "" : "role",
      roleIndex: idx >= 0 ? idx : 0
    });
  },
  onRoleChange(e) { this.setData({ roleIndex: Number(e.detail.value) }); },
  saveRole() {
    const role = this.data.roles[this.data.roleIndex];
    if (!role) return;
    api.patch("/users/" + this.data.expandedId, { role: role.k })
      .then(() => { wx.showToast({ title: "已设置" }); this.setData({ expandedId: "", expandMode: "" }); this.loadUsers(); })
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },

  removeUser(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "员工离职",
      content: "确定要将这个员工设为离职吗？",
      cancelText: "取消",
      confirmText: "离职",
      confirmColor: "#FF3B30",
      success: (r) => {
        if (!r.confirm) return;
        api.del("/users/" + id).then(() => this.loadUsers())
          .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
      }
    });
  },
  approve(e) {
    const id = e.currentTarget.dataset.id;
    api.post("/join/requests/" + id + "/approve").then(() => { this.loadRequests(); this.loadUsers(); })
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  },
  reject(e) {
    const id = e.currentTarget.dataset.id;
    api.post("/join/requests/" + id + "/reject").then(() => this.loadRequests())
      .catch((err) => wx.showToast({ title: String(err), icon: "none" }));
  }
});
