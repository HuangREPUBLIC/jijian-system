"use strict";
// 款式图片：选图 → 压缩 → 缩略图 → 排队处理，以及电脑上拖进来 / 粘贴。
// 款式图 base64 存库，另存 360px 缩略图给列表用。压缩逐张排队（防老安卓内存不够），
// 不会按 EXIF 摆正的老 WebView 手动转正，透明 PNG 先铺白底。
// 电脑上建款式，从文件夹直接拖图进图片区、或者截图后 Ctrl+V 就能加，不用每次点"添加图片"再翻文件夹。

/* ---- 页面渲染 ---- */
// 款式图 base64 存库，另存 360px 缩略图给列表用。压缩逐张排队（防老安卓内存不够），
// 不会按 EXIF 摆正的老 WebView 手动转正，透明 PNG 先铺白底。
const PHOTO_MAX = 9;                    // 一个款式最多 9 张（跟微信发图一样）
const PHOTO_EDGE = 1600;                // 原图最长边
const PHOTO_TARGET = 380 * 1024;        // 单张原图目标体积
const THUMB_EDGE = 360;                 // 缩略图最长边（卡片上 84px × 3 倍屏 ≈ 252px，留点余量）
const IMG_LIMIT = 6 * 1024 * 1024;      // 一个款式所有原图 data URI 总长上限（服务端 JSON 上限 8MB）
const CANVAS_MAX_AREA = 16 * 1000 * 1000;
const HEIC_MSG = "这张是 HEIC 格式，当前浏览器打不开。iPhone 可在「设置 › 相机 › 格式」选「兼容性最佳」，或截个图再传";
let photoDraft = {};            // { 上下文key: [{ key, src, data, status, file, err }] } 表单里正在编辑的照片
let photoSeq = 0;

// 历史数据里个别款式图地址不是浏览器能加载的格式（不是 data:/http(s):/站内路径），只显示占位
const showable = u => /^(data:|https?:|\/|blob:)/.test(String(u || ""));
function normalizePhotos(v) {
  if (Array.isArray(v)) return v.filter(x => typeof x === "string" && x);
  if (typeof v === "string" && v) return [v];
  return [];
}
const photoItem = url => ({ key: "p" + (++photoSeq), src: url, data: url, status: "ready" });
const draftReady = ctx => (photoDraft[ctx] || []).filter(p => p.status === "ready");

// 浏览器画 <img> 到 canvas 时会不会自动按 EXIF 摆正（Chrome 81+ / Safari 13.1+ / Firefox 77+ 会）
const AUTO_ORIENT = (function () {
  try { return !!(window.CSS && CSS.supports && CSS.supports("image-orientation", "from-image")); } catch (e) { return false; }
})();
function readHead(blob, n) {
  const part = blob.slice(0, n);
  if (part.arrayBuffer) return part.arrayBuffer();
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(part); });
}
// 读 JPEG 的 EXIF 方向（1~8），读不到一律当 1。EXIF 都在文件开头，只扫前 128KB
async function exifOrientation(file) {
  try {
    const v = new DataView(await readHead(file, 128 * 1024));
    if (v.getUint16(0) !== 0xFFD8) return 1;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xFF00) !== 0xFF00) return 1;
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) {      // APP1 段，"Exif"
        const tiff = off + 10, little = v.getUint16(tiff) === 0x4949;
        const ifd = tiff + v.getUint32(tiff + 4, little);
        const count = v.getUint16(ifd, little);
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (v.getUint16(e, little) === 0x0112) return v.getUint16(e + 8, little) || 1;
        }
        return 1;
      }
      off += 2 + v.getUint16(off + 2);
    }
  } catch (e) { }
  return 1;
}
function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode"));
    img.src = src;
  });
}
function makeCanvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
// EXIF 方向 → 画布变换（w×h 是摆正后的输出尺寸）
function orientTransform(ctx, o, w, h) {
  const T = { 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, w, 0], 7: [0, -1, -1, 0, w, h], 8: [0, -1, 1, 0, 0, h] }[o];
  if (T) ctx.transform(T[0], T[1], T[2], T[3], T[4], T[5]);
}
// 缩到最长边 maxEdge：先对半缩（每步 2 倍以内插值才不出锯齿/摩尔纹），最后一步带方向变换落到目标尺寸
function drawScaled(img, maxEdge, orient) {
  const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  const rot = orient >= 5 && orient <= 8;
  const ow = rot ? sh : sw, oh = rot ? sw : sh;                     // 摆正后的宽高
  const k = Math.min(1, maxEdge / Math.max(ow, oh));
  const tw = Math.max(1, Math.round(ow * k)), th = Math.max(1, Math.round(oh * k));
  const dw = rot ? th : tw, dh = rot ? tw : th;                     // 在"未旋转"坐标系里要画的尺寸
  let src = img, cw = sw, ch = sh;
  while (cw > dw * 2 && ch > dh * 2) {
    let nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    if (nw * nh > CANVAS_MAX_AREA) { const f = Math.sqrt(CANVAS_MAX_AREA / (cw * ch)); nw = Math.floor(cw * f); nh = Math.floor(ch * f); }
    const c = makeCanvas(nw, nh), x = c.getContext("2d");
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.drawImage(src, 0, 0, nw, nh);
    if (src !== img) src.width = src.height = 0;                     // 中间画布用完就释放，iOS 画布内存很紧
    src = c; cw = nw; ch = nh;
  }
  const out = makeCanvas(tw, th), ctx = out.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, tw, th);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  orientTransform(ctx, orient, tw, th);
  ctx.drawImage(src, 0, 0, dw, dh);
  if (src !== img) src.width = src.height = 0;
  return out;
}
function dataUrlToBlob(u) {
  const parts = u.split(","), bin = atob(parts[1]), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: (parts[0].match(/data:([^;]+)/) || [])[1] || "image/jpeg" });
}
function canvasToBlob(c, q) {
  return new Promise((resolve) => {
    if (c.toBlob) c.toBlob(b => resolve(b), "image/jpeg", q);
    else resolve(dataUrlToBlob(c.toDataURL("image/jpeg", q)));
  });
}
function blobToDataUrl(b) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
}
// 先用 0.86 编一次，没超目标体积就用它；超了再二分找"不超标的最高质量"，最多再编 5 次
async function encodeJpeg(c, target) {
  const first = await canvasToBlob(c, 0.86);
  if (!first) throw new Error("encode");
  if (first.size <= target) return first;
  let lo = 0.45, hi = 0.86, best = null;
  for (let k = 0; k < 5; k++) {
    const mid = (lo + hi) / 2, t = await canvasToBlob(c, mid);
    if (t && t.size <= target) { best = t; lo = mid; } else hi = mid;
  }
  return best || (await canvasToBlob(c, 0.45)) || first;
}
async function compressPhoto(file) {
  const heic = /hei[cf]/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || "");
  if (file.type && !/^image\//.test(file.type)) throw { error: "不是图片文件", short: "不是图片" };
  const url = URL.createObjectURL(file);
  try {
    let img;
    try { img = await loadImg(url); }
    catch (e) { throw { error: heic ? HEIC_MSG : "这张图片打不开，可能已损坏或格式不支持", short: heic ? "HEIC 格式" : "打不开" }; }
    const orient = AUTO_ORIENT ? 1 : await exifOrientation(file);
    const c = drawScaled(img, PHOTO_EDGE, orient);
    const blob = await encodeJpeg(c, PHOTO_TARGET);
    c.width = c.height = 0;
    return await blobToDataUrl(blob);
  } finally { URL.revokeObjectURL(url); }
}
// 缩略图：从原图再压一张小的（最长边 360，控制在 60KB 以内）
async function makeThumb(src) {
  const img = await loadImg(src);
  const c = drawScaled(img, THUMB_EDGE, 1);
  let q = 0.74, out = c.toDataURL("image/jpeg", q);
  while (out.length > 60 * 1024 && q > 0.4) { q -= 0.12; out = c.toDataURL("image/jpeg", q); }
  c.width = c.height = 0;
  return out;
}
// 压缩排队：一次只处理一张，避免同时解码多张大图把内存吃爆
let photoQueue = Promise.resolve();
function queuePhoto(ctx, item) {
  photoQueue = photoQueue.then(async () => {
    if ((photoDraft[ctx] || []).indexOf(item) < 0) return;          // 排队期间被删掉了
    try {
      const data = await compressPhoto(item.file);
      if ((photoDraft[ctx] || []).indexOf(item) < 0) return;
      const used = draftReady(ctx).reduce((s, p) => s + p.data.length, 0);
      if (used + data.length > IMG_LIMIT) throw { error: "图片总量超出上限，请删掉几张再加", short: "超出上限", fatal: true };
      if (String(item.src).indexOf("blob:") === 0) URL.revokeObjectURL(item.src);
      item.src = item.data = data; item.status = "ready"; item.file = null;
    } catch (e) {
      item.status = "error"; item.err = (e && e.short) || "处理失败";
      if (e && e.fatal) item.file = null;
      toast((e && e.error) || "图片处理失败");
    }
    refreshPicker(ctx);
  });
  return photoQueue;
}
function clearPhotoDraft() {
  Object.keys(photoDraft).forEach(k => (photoDraft[k] || []).forEach(p => {
    if (String(p.src).indexOf("blob:") === 0) URL.revokeObjectURL(p.src);
  }));
  photoDraft = {};
}
function refreshPicker(ctx) { const el = $("pe-" + ctx); if (el) el.innerHTML = pickerInner(ctx); }
// 拍照和相册拆成两个独立入口：部分手机(尤其华为)系统选择器在 <input multiple> 上会隐藏"拍照"选项
// (一次拍照只能出一张图，跟多选语义冲突)，只拆开两个按钮才能保证两条路都能用。电脑上没有"拍照"这回事，只留一个。
function pickerInner(ctx) {
  if (ctx === "style" && styleForm && styleForm.imagesLocked) {
    return `<div class="ph-hint">原图没加载出来，图片暂时不能改。<button type="button" class="link-btn" onclick="A.loadStyleImages()">重新加载</button></div>`;
  }
  const list = photoDraft[ctx] || [];
  const mobile = isMobileDevice();
  const thumbs = list.map((p, i) => `<div class="ph-thumb is-${p.status}">
      ${showable(p.src) ? `<img src="${esc(p.src)}" alt="款式图 ${i + 1}" decoding="async" onclick="A.viewDraft('${ctx}','${p.key}')">`
        : p.status === "processing" ? `<div class="ph-na sk"></div>` : `<div class="ph-na">图片已失效<br>请重新上传</div>`}
      ${i === 0 && p.status === "ready" ? `<span class="ph-cover">封面</span>` : ""}
      ${p.status === "processing" ? `<span class="ph-state" aria-label="处理中"><i class="spin"></i></span>` : ""}
      ${p.status === "error" ? `<button type="button" class="ph-state err" ${p.file ? `onclick="A.retryPhoto('${ctx}','${p.key}')"` : "disabled"}>
          <span>${esc(p.err || "失败")}</span>${p.file ? "<b>点击重试</b>" : ""}</button>` : ""}
      <button type="button" class="ph-x" onclick="A.removeDraftPhoto('${ctx}','${p.key}')" aria-label="移除第 ${i + 1} 张">${icon("close")}</button>
    </div>`).join("");
  const adders = list.length >= PHOTO_MAX ? "" :
    (mobile ? `<label class="ph-add"><input type="file" accept="image/*" capture="environment" hidden onchange="A.addDraftPhotos('${ctx}',this)">
      ${icon("camera")}<span>拍照</span></label>` : "") +
    `<label class="ph-add"><input type="file" accept="image/*" multiple hidden onchange="A.addDraftPhotos('${ctx}',this)">
      ${icon("image")}<span>${mobile ? "相册" : "添加图片"}</span></label>`;
  return thumbs + adders + `<div class="ph-hint">${list.length}/${PHOTO_MAX} 张 · 第一张是封面，点开大图可以换封面${mobile ? "" : " · 也可以把图片拖进来或直接粘贴"}</div>`;
}
function photoPicker(ctx) { return `<div class="photos-grid editable" id="pe-${ctx}" data-ctx="${ctx}">${pickerInner(ctx)}</div>`; }
function styleImages(s) {
  let imgs = [];
  try { imgs = s.images ? JSON.parse(s.images) : []; } catch (e) { imgs = []; }
  if ((!imgs || !imgs.length) && s.image) imgs = [s.image];
  return normalizePhotos(imgs);
}

// 点开大图时按款式取原图，留最近 8 个款的原图在内存里，来回看不重复下载
const fullImgCache = new Map();
function cacheFullImgs(id, imgs) {
  fullImgCache.delete(id);
  if (imgs) fullImgCache.set(id, imgs);
  while (fullImgCache.size > 8) fullImgCache.delete(fullImgCache.keys().next().value);
}
// 老款式没有缩略图：列表拿到的是封面原图，趁空闲在后台压一张缩略图补上，以后列表就轻了
const thumbTried = {};
function backfillThumbs() {
  const todo = (state.styles || []).filter(s => s.image && !s.has_thumb && showable(s.image) && !thumbTried[s.id]);
  if (!todo.length) return;
  todo.forEach(s => { thumbTried[s.id] = true; });
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 800));
  idle(async () => {
    for (const s of todo) {
      const src = s.image;
      // 列表可能已经刷新过，按最新数据判断还要不要补
      const cur = (state.styles || []).find(x => x.id === s.id);
      if (!cur || cur.has_thumb || cur.image !== src) continue;
      try {
        const t = await makeThumb(src);
        await api("PUT", `/styles/${s.id}/thumb`, { thumb: t, srcLen: src.length });
        if (cur.image === src) { cur.image = t; cur.has_thumb = true; }
      } catch (e) { }
      await new Promise(r => setTimeout(r, 80));
    }
  });
}

const hasFiles = e => !!(e.dataTransfer && [...(e.dataTransfer.types || [])].indexOf("Files") >= 0);
document.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();                                     // 不拦的话浏览器会直接打开这张图、页面就没了
  const g = e.target.closest && e.target.closest(".photos-grid.editable");
  document.querySelectorAll(".photos-grid.drop").forEach(x => { if (x !== g) x.classList.remove("drop"); });
  if (g) { g.classList.add("drop"); e.dataTransfer.dropEffect = "copy"; } else e.dataTransfer.dropEffect = "none";
});
document.addEventListener("dragleave", (e) => {
  const g = e.target.closest && e.target.closest(".photos-grid.editable");
  if (g && !g.contains(e.relatedTarget)) g.classList.remove("drop");
});
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const g = e.target.closest && e.target.closest(".photos-grid.editable");
  document.querySelectorAll(".photos-grid.drop").forEach(x => x.classList.remove("drop"));
  if (g) A.addPhotoFiles(g.getAttribute("data-ctx"), [...(e.dataTransfer.files || [])]);
});
document.addEventListener("paste", (e) => {
  if (e.target && e.target.closest && e.target.closest("input,textarea,[contenteditable]")) return;
  const g = document.querySelector(".photos-grid.editable");
  if (!g || !e.clipboardData) return;
  const files = [...(e.clipboardData.files || [])].filter(f => /^image\//.test(f.type));
  if (!files.length) return;
  e.preventDefault();
  A.addPhotoFiles(g.getAttribute("data-ctx"), files);
});

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  addDraftPhotos(ctx, input) {
    const files = [...(input.files || [])]; input.value = "";
    A.addPhotoFiles(ctx, files);
  },
  // 选图 / 拖进来 / 粘贴 都走这里：先把缩略图占位摆上，压缩在后台排队做
  addPhotoFiles(ctx, files) {
    files = (files || []).filter(f => !f.type || /^image\//.test(f.type) || /\.(hei[cf]|jpe?g|png|webp|gif|bmp)$/i.test(f.name || ""));
    if (!files.length) return;
    const list = photoDraft[ctx] = photoDraft[ctx] || [];
    const room = PHOTO_MAX - list.length;
    if (room <= 0) return toast(`最多 ${PHOTO_MAX} 张，先删掉几张再加`);
    if (files.length > room) toast(`最多 ${PHOTO_MAX} 张，这次只加了前 ${room} 张`);
    files.slice(0, room).forEach(f => {
      let preview = "";
      try { preview = URL.createObjectURL(f); } catch (e) { }
      const it = { key: "p" + (++photoSeq), src: preview, data: "", status: "processing", file: f };
      list.push(it);
      queuePhoto(ctx, it);
    });
    refreshPicker(ctx);
  },
  retryPhoto(ctx, key) {
    const it = (photoDraft[ctx] || []).find(p => p.key === key);
    if (!it || !it.file) return;
    it.status = "processing"; it.err = "";
    refreshPicker(ctx); queuePhoto(ctx, it);
  },
  removeDraftPhoto(ctx, key) {
    const list = photoDraft[ctx] || [], k = list.findIndex(p => p.key === key);
    if (k < 0) return;
    const it = list[k];
    if (String(it.src).indexOf("blob:") === 0) URL.revokeObjectURL(it.src);
    list.splice(k, 1); refreshPicker(ctx);
  },
});
