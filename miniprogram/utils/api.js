// 统一封装请求：
// - 开发者工具本地调试(develop) 走 http://localhost:3001（本地起服务器调试用）
// - 体验版/正式版 走微信云托管 wx.cloud.callContainer（不走公网域名，绕开 SNI 重置问题）
const envVersion = (wx.getAccountInfoSync && wx.getAccountInfoSync().miniProgram.envVersion) || "develop";
const useCloud = envVersion !== "develop";

// ⚠️ 云托管配置：环境 ID 已知；SERVICE_NAME 要填你在云托管里创建的“服务名称”
const CLOUD_ENV = "prod-d1g9085h570a48a5e";
const SERVICE_NAME = "kaoqin"; // 对应云托管控制台里创建的服务名

const LOCAL_BASE = "http://localhost:3001";

function handle(res, resolve, reject) {
  const status = res.statusCode;
  const body = res.data;
  if (status === 401) {
    wx.removeStorageSync("token");
    wx.removeStorageSync("user");
    wx.reLaunch({ url: "/pages/login/login" });
    reject((body && body.error) || "登录已失效");
    return;
  }
  if (status >= 200 && status < 300) resolve(body);
  else reject((body && body.error) || "请求失败");
}

function request(method, path, data) {
  const token = wx.getStorageSync("token");
  const auth = token ? { Authorization: "Bearer " + token } : {};
  if (useCloud) {
    return new Promise((resolve, reject) => {
      wx.cloud.callContainer({
        config: { env: CLOUD_ENV },
        path: "/api" + path,
        method,
        header: Object.assign({ "X-WX-SERVICE": SERVICE_NAME, "content-type": "application/json" }, auth),
        data,
        success: (res) => handle(res, resolve, reject),
        fail: (err) => reject((err && err.errMsg) || "网络错误")
      });
    });
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: LOCAL_BASE + "/api" + path,
      method,
      data,
      header: auth,
      success: (res) => handle(res, resolve, reject),
      fail: (err) => reject((err && err.errMsg) || "网络错误")
    });
  });
}

// 图片上传：云托管容器不支持 wx.uploadFile 的 multipart 直传，云托管环境下先禁用，
// 后续接入云存储再补（本地开发仍走 wx.uploadFile）。
function uploadImage(filePath) {
  if (useCloud) {
    return Promise.reject("图片上传暂未接入云存储（云托管环境）");
  }
  const token = wx.getStorageSync("token");
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: LOCAL_BASE + "/api/upload",
      filePath,
      name: "image",
      header: token ? { Authorization: "Bearer " + token } : {},
      success: (res) => {
        if (res.statusCode !== 200) { reject("上传失败"); return; }
        try {
          const data = JSON.parse(res.data);
          resolve(LOCAL_BASE + data.url);
        } catch (e) { reject("上传失败"); }
      },
      fail: (err) => reject((err && err.errMsg) || "网络错误")
    });
  });
}

// 上传图片到云托管对象存储，返回 fileID（cloud://...）。<image src="{{fileID}}"> 可直接显示。
// 款式多图/不限量用这个（不再走容器 multipart，也不存 base64）。开发者工具和体验版都走 wx.cloud。
function uploadCloudImage(filePath) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud || !wx.cloud.uploadFile) { reject("当前微信基础库不支持云上传，请升级微信"); return; }
    const ext = String(filePath.split(".").pop() || "jpg").toLowerCase();
    const cloudPath = "styles/" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "." + ext;
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      config: { env: CLOUD_ENV },
      success: (res) => { (res && res.fileID) ? resolve(res.fileID) : reject("上传失败"); },
      fail: (err) => reject((err && err.errMsg) || "上传失败")
    });
  });
}

module.exports = {
  CLOUD_ENV,
  get: (path) => request("GET", path),
  post: (path, data) => request("POST", path, data),
  patch: (path, data) => request("PATCH", path, data),
  del: (path) => request("DELETE", path),
  uploadImage,
  uploadCloudImage
};
