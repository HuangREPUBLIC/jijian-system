"use strict";
// 大图查看器：双指缩放、拖动、下滑关闭、惯性与回弹。

/* ---- 页面渲染 ---- */
let lightbox = null;            // 大图查看器状态 { photos:[{src,thumb}], i, ctx?, styleId?, loading? }

/* ---- 大图查看器 ----
 * 手势跟微信/系统相册一致：双指缩放、拖动带阻尼惯性、双击缩放、左右滑切图、下拉关闭；电脑上滚轮缩放、←→切图、Esc 关闭。
 * 所有动画都从当前值+松手速度起步，用临界阻尼弹簧收尾，任何时候都能按住打断，不用等动画播完。 */
const REDUCED_MOTION = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
// 越界阻尼：拉得越远跟得越少（iOS 橡皮筋的同一个公式）
function rubber(over, dim) { return (over * dim * 0.55) / (dim + 0.55 * over); }
// 按当前速度（px/s）"扔出去"最终会滑多远：跟系统滚动减速同一个指数衰减模型
function project(v, d) { return (v / 1000) * d / (1 - d); }
// 临界阻尼弹簧：每个通道 { from, to, v }，带初速度收敛到目标
function spring(ch, onFrame, onDone, response) {
  const keys = Object.keys(ch);
  if (REDUCED_MOTION) { const o = {}; keys.forEach(k => { o[k] = ch[k].to; }); onFrame(o); if (onDone) onDone(); return () => { }; }
  const w = 2 * Math.PI / (response || 0.38), t0 = performance.now();
  const C = keys.map(k => { const c = ch[k], a0 = c.from - c.to; return { k, to: c.to, a: a0, b: (c.v || 0) + w * a0, eps: c.eps || 0.4 }; });
  let raf = 0, stopped = false;
  const frame = (now) => {
    if (stopped) return;
    const t = (now - t0) / 1000, e = Math.exp(-w * t), o = {};
    let settled = true;
    C.forEach(c => {
      const x = c.to + (c.a + c.b * t) * e, v = (c.b - w * (c.a + c.b * t)) * e;
      o[c.k] = x;
      if (Math.abs(x - c.to) > c.eps || Math.abs(v) > c.eps * 20) settled = false;
    });
    if (settled || t > 2.5) { C.forEach(c => { o[c.k] = c.to; }); onFrame(o); if (onDone) onDone(); return; }
    onFrame(o); raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => { stopped = true; cancelAnimationFrame(raf); };
}

const V = { el: null, stop: null, s: 1, tx: 0, ty: 0, page: 0, ptrs: new Map(), mode: null, st: null, mid: null,
  hist: [], tapT: 0, tapX: 0, tapY: 0, tapTimer: 0, gap: 18 };
function openViewer(photos, i, extra) {
  if (!photos || !photos.length) return;
  lightbox = Object.assign({ photos, i: Math.max(0, Math.min(i || 0, photos.length - 1)) }, extra || {});
  renderLightbox();
}
function buildViewer() {
  const el = document.createElement("div");
  el.id = "lightbox"; el.className = "lightbox";
  el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "查看图片");
  el.innerHTML = `<div class="lb-bg"></div>
    <div class="lb-track">${[-1, 0, 1].map(k => `<div class="lb-slide" data-k="${k}">
      <div class="lb-frame"><img class="lb-low" alt="" aria-hidden="true" draggable="false"><img class="lb-img" alt="" draggable="false"></div>
      <i class="spin lb-spin" aria-hidden="true"></i>
      <button type="button" class="lb-err">图片加载失败，点这里重试</button></div>`).join("")}</div>
    <div class="lb-top"><span class="lb-count num"></span>
      <button type="button" class="lb-btn lb-close" aria-label="关闭">${icon("close")}</button></div>
    <button type="button" class="lb-nav prev" aria-label="上一张">‹</button>
    <button type="button" class="lb-nav next" aria-label="下一张">›</button>
    <div class="lb-bottom"><div class="lb-dots"></div><div class="lb-acts"></div></div>`;
  document.body.appendChild(el);
  V.el = el;
  el.querySelector(".lb-close").onclick = () => A.closeLightbox();
  el.querySelector(".lb-nav.prev").onclick = () => A.lbStep(-1);
  el.querySelector(".lb-nav.next").onclick = () => A.lbStep(1);
  el.querySelectorAll(".lb-err").forEach(b => {
    b.onclick = () => {
      const sl = b.closest(".lb-slide"), img = sl.querySelector(".lb-img"), u = img.getAttribute("src");
      sl.classList.remove("err");
      if (u) { img.removeAttribute("src"); sl.classList.add("loading"); img.src = u; }
    };
  });
  el.addEventListener("pointerdown", lbDown);
  el.addEventListener("pointermove", lbMove);
  el.addEventListener("pointerup", lbUp);
  el.addEventListener("pointercancel", lbUp);
  el.addEventListener("wheel", lbWheel, { passive: false });
  document.documentElement.classList.add("lb-lock");
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
  return el;
}
function renderLightbox() {
  let el = $("lightbox");
  if (!lightbox) {
    if (el && !el._closing) {
      el._closing = true; el.classList.add("out"); vStop();
      setTimeout(() => { el.remove(); if (V.el === el) V.el = null; }, REDUCED_MOTION ? 0 : 200);
    }
    document.documentElement.classList.remove("lb-lock");
    V.ptrs.clear(); clearTimeout(V.tapTimer);
    syncOverlayHistory();
    return;
  }
  if (!el || el._closing) { if (el) el.remove(); el = buildViewer(); }
  layoutViewer();
  syncOverlayHistory();
}
const vSize = () => ({ W: V.el.clientWidth || window.innerWidth, H: V.el.clientHeight || window.innerHeight });
const curSlide = () => V.el.querySelector('.lb-slide[data-k="0"]');
const curFrame = () => curSlide().querySelector(".lb-frame");
function layoutViewer() {
  const lb = lightbox, n = lb.photos.length, W = vSize().W;
  vStop();
  V.el.querySelectorAll(".lb-slide").forEach(sl => {
    const k = +sl.dataset.k, idx = lb.i + k;
    sl.style.transform = `translate3d(${k * (W + V.gap)}px,0,0)`;
    fillSlide(sl, idx >= 0 && idx < n ? lb.photos[idx] : null);
  });
  V.s = 1; V.tx = 0; V.ty = 0; V.page = 0;
  vApplyTrack(); vApplyImg(); vBg(1);
  V.el.querySelector(".lb-count").textContent = n > 1 ? `${lb.i + 1} / ${n}` : "";
  V.el.querySelector(".lb-dots").innerHTML = n > 1 && n <= 9 ? lb.photos.map((_, k) => `<i class="${k === lb.i ? "on" : ""}"></i>`).join("") : "";
  V.el.querySelector(".lb-nav.prev").hidden = lb.i <= 0;
  V.el.querySelector(".lb-nav.next").hidden = lb.i >= n - 1;
  V.el.querySelector(".lb-acts").innerHTML = lb.ctx ? `
    <button type="button" class="lb-act" ${lb.i === 0 ? "disabled" : ""} onclick="A.lbSetCover()">${lb.i === 0 ? "当前是封面" : "设为封面"}</button>
    <button type="button" class="lb-act danger" onclick="A.lbDelete()">${icon("trash")}<span>删除</span></button>` : "";
}
function fillSlide(sl, ph) {
  sl.hidden = !ph;
  if (!ph) return;
  const low = sl.querySelector(".lb-low"), img = sl.querySelector(".lb-img");
  const setSrc = (el, u) => { if ((el.getAttribute("src") || "") !== (u || "")) { if (u) el.src = u; else el.removeAttribute("src"); } };
  sl.classList.remove("err");
  low.onload = () => fitFrame(sl);
  low.hidden = !ph.thumb;
  setSrc(low, ph.thumb || "");
  if (ph.src) {
    const ready = () => { sl.classList.remove("loading"); sl.classList.add("full"); fitFrame(sl); };
    img.onload = ready;
    img.onerror = () => { sl.classList.remove("loading"); sl.classList.add("err"); };
    sl.classList.remove("full");
    setSrc(img, ph.src);
    if (img.complete && img.naturalWidth) ready(); else sl.classList.add("loading");
  } else { img.removeAttribute("src"); sl.classList.remove("full"); sl.classList.add("loading"); }
  fitFrame(sl);
}
// 让图片"刚好塞满屏幕"（contain），记下这个尺寸，缩放/拖动的边界都以它为准
function fitFrame(sl) {
  const img = sl.querySelector(".lb-img"), low = sl.querySelector(".lb-low"), frame = sl.querySelector(".lb-frame");
  const src = img.getAttribute("src") && img.naturalWidth ? img : (low.getAttribute("src") && low.naturalWidth ? low : null);
  const { W, H } = vSize();
  let fw = Math.min(W, H) * 0.7, fh = fw;
  if (src) { const k = Math.min(W / src.naturalWidth, H / src.naturalHeight); fw = src.naturalWidth * k; fh = src.naturalHeight * k; }
  frame.style.width = fw + "px"; frame.style.height = fh + "px";
  frame._fw = fw; frame._fh = fh;
}
function vApplyImg() { const f = curFrame(); if (f) f.style.transform = `translate3d(${V.tx}px,${V.ty}px,0) scale(${V.s})`; }
function vApplyTrack() { V.el.querySelector(".lb-track").style.transform = `translate3d(${V.page}px,0,0)`; }
function vBg(a) { V.el.querySelector(".lb-bg").style.opacity = Math.max(0, Math.min(1, a)); V.el.classList.toggle("dragging", a < 1); }
function vBounds(s) {
  const f = curFrame(), { W, H } = vSize();
  return { x: Math.max(0, ((f._fw || W) * s - W) / 2), y: Math.max(0, ((f._fh || H) * s - H) / 2) };
}
function vClamp(s, tx, ty) { const b = vBounds(s); return { tx: Math.max(-b.x, Math.min(b.x, tx)), ty: Math.max(-b.y, Math.min(b.y, ty)) }; }
function vStop() { if (V.stop) { V.stop(); V.stop = null; } }
function vAnim(to, vel, done, resp) {
  vStop();
  const ch = {};
  ["s", "tx", "ty", "page"].forEach(k => {
    if (to[k] !== undefined) ch[k] = { from: V[k], to: to[k], v: (vel && vel[k]) || 0, eps: k === "s" ? 0.002 : 0.4 };
  });
  V.stop = spring(ch, o => { Object.assign(V, o); vApplyImg(); vApplyTrack(); }, () => { V.stop = null; if (done) done(); }, resp);
}
// 以屏幕上 (mx,my) 这一点为中心把缩放从 V.s 换到 s：保证手指/鼠标底下那一点不动
function vZoomAt(s, mx, my) {
  const { W, H } = vSize(), cx = W / 2, cy = H / 2;
  const px = (mx - cx - V.tx) / V.s, py = (my - cy - V.ty) / V.s;
  return { tx: mx - cx - s * px, ty: my - cy - s * py };
}
function vVelocity() {
  const h = V.hist; if (h.length < 2) return { x: 0, y: 0 };
  const a = h[0], b = h[h.length - 1], dt = b.t - a.t;
  return dt < 8 ? { x: 0, y: 0 } : { x: (b.x - a.x) / dt * 1000, y: (b.y - a.y) / dt * 1000 };
}
function lbDown(e) {
  if (!lightbox || e.target.closest("button")) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  try { V.el.setPointerCapture(e.pointerId); } catch (x) { }
  vStop();
  V.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (V.ptrs.size === 1) {
    V.mode = "pending";
    V.st = { x: e.clientX, y: e.clientY, s: V.s, tx: V.tx, ty: V.ty };
    V.hist = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
  } else if (V.ptrs.size === 2) {
    const pts = [...V.ptrs.values()], a = pts[0], b = pts[1];
    if (V.page) { V.page = 0; vApplyTrack(); }
    if (V.mode === "drop") { V.s = 1; V.tx = 0; V.ty = 0; vBg(1); }
    V.mode = "pinch"; clearTimeout(V.tapTimer); V.tapT = 0;
    V.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    V.st = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: V.mid.x, my: V.mid.y, s: V.s, tx: V.tx, ty: V.ty };
  }
}
function lbMove(e) {
  if (!V.ptrs.has(e.pointerId) || !lightbox) return;
  V.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const { W, H } = vSize(), cx = W / 2, cy = H / 2;
  if (V.mode === "pinch") {
    if (V.ptrs.size < 2) return;
    const pts = [...V.ptrs.values()], a = pts[0], b = pts[1];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    let s = V.st.s * d / V.st.d;
    if (s > 5) s = 5 + (s - 5) * 0.25; else if (s < 1) s = Math.max(0.5, 1 - (1 - s) * 0.5);    // 超出范围有阻尼
    const px = (V.st.mx - cx - V.st.tx) / V.st.s, py = (V.st.my - cy - V.st.ty) / V.st.s;
    V.s = s; V.tx = mx - cx - s * px; V.ty = my - cy - s * py; V.mid = { x: mx, y: my };
    vApplyImg(); return;
  }
  const p = V.ptrs.get(e.pointerId), dx = p.x - V.st.x, dy = p.y - V.st.y, now = performance.now();
  V.hist.push({ x: p.x, y: p.y, t: now });
  while (V.hist.length > 2 && now - V.hist[0].t > 100) V.hist.shift();
  if (V.mode === "pending") {
    if (Math.hypot(dx, dy) < 8) return;                   // 8px 以内算手抖，不判方向
    clearTimeout(V.tapTimer); V.tapT = 0;
    V.mode = V.s > 1.01 ? "pan" : Math.abs(dx) > Math.abs(dy) ? "page" : dy > 0 ? "drop" : "pan";
  }
  if (V.mode === "pan") {
    const b = vBounds(V.s);
    const soft = (v, lim, dim) => v > lim ? lim + rubber(v - lim, dim) : v < -lim ? -lim - rubber(-lim - v, dim) : v;
    V.tx = soft(V.st.tx + dx, b.x, W); V.ty = soft(V.st.ty + dy, b.y, H); vApplyImg();
  } else if (V.mode === "page") {
    const n = lightbox.photos.length, i = lightbox.i;
    let off = dx;
    if ((i === 0 && off > 0) || (i === n - 1 && off < 0)) off = (off > 0 ? 1 : -1) * rubber(Math.abs(off), W);
    V.page = off; vApplyTrack();
  } else if (V.mode === "drop") {
    const k = Math.max(0, Math.min(1, dy / H));
    V.s = 1 - k * 0.35; V.tx = dx * 0.6; V.ty = dy > 0 ? dy : -rubber(-dy, H); vApplyImg(); vBg(1 - k * 1.6);
  }
}
function lbUp(e) {
  if (!V.ptrs.has(e.pointerId) || !lightbox) { V.ptrs.delete(e.pointerId); return; }
  V.ptrs.delete(e.pointerId);
  const { W, H } = vSize();
  if (V.mode === "pinch") {
    if (V.ptrs.size === 1) {                               // 抬起一根手指：剩下那根接着拖，不跳
      const p = [...V.ptrs.values()][0];
      V.mode = V.s > 1.01 ? "pan" : "pending";
      V.st = { x: p.x, y: p.y, s: V.s, tx: V.tx, ty: V.ty };
      V.hist = [{ x: p.x, y: p.y, t: performance.now() }];
    } else if (!V.ptrs.size) {
      V.mode = null;
      const s = Math.max(1, Math.min(5, V.s));
      const m = V.mid || { x: W / 2, y: H / 2 };
      const t0 = s === V.s ? { tx: V.tx, ty: V.ty } : vZoomAt(s, m.x, m.y);
      const t = s <= 1.001 ? { tx: 0, ty: 0 } : vClamp(s, t0.tx, t0.ty);
      vAnim({ s, tx: t.tx, ty: t.ty }, null, null, 0.35);
    }
    return;
  }
  if (V.ptrs.size) return;
  const mode = V.mode, v = vVelocity();
  V.mode = null;
  if (mode === "pending") { if (e.type === "pointerup") lbTap(e.clientX, e.clientY); return; }
  if (mode === "pan") {
    // 松手按速度预判最终停在哪（再夹回边界内），带着松手速度滑过去
    const t = vClamp(V.s, V.tx + project(v.x, 0.998), V.ty + project(v.y, 0.998));
    vAnim({ tx: t.tx, ty: t.ty }, { tx: v.x, ty: v.y }, null, 0.55);
  } else if (mode === "page") {
    const n = lightbox.photos.length, i = lightbox.i;
    const land = V.page + project(v.x, 0.99);            // 轻轻一甩也能翻页，慢慢拖过一半也能翻页
    const d = land < -W / 2 && i < n - 1 ? 1 : land > W / 2 && i > 0 ? -1 : 0;
    vAnim({ page: -d * (W + V.gap) }, { page: v.x }, () => { if (d && lightbox) { lightbox.i += d; layoutViewer(); } }, 0.32);
  } else if (mode === "drop") {
    if (V.ty > H * 0.16 || v.y > 700) { vDismiss(v); return; }
    vBg(1);
    vAnim({ s: 1, tx: 0, ty: 0 }, { tx: v.x, ty: v.y }, null, 0.35);
  }
}
function vDismiss(v) {
  const { H } = vSize();
  V.el.classList.add("out");
  vAnim({ ty: V.ty + Math.max(H * 0.35, project(v ? v.y : 0, 0.99)), s: V.s * 0.9 }, { ty: v ? v.y : 0 }, null, 0.3);
  setTimeout(() => A.closeLightbox(), 160);
}
// 单击关闭、双击放大/还原。单击要等 300ms 确认不是双击的第一下
function lbTap(x, y) {
  const now = performance.now();
  if (now - V.tapT < 300 && Math.hypot(x - V.tapX, y - V.tapY) < 30) {
    clearTimeout(V.tapTimer); V.tapT = 0;
    if (V.s > 1.01) { vAnim({ s: 1, tx: 0, ty: 0 }, null, null, 0.35); return; }
    const s = 2.5, t0 = vZoomAt(s, x, y), t = vClamp(s, t0.tx, t0.ty);
    vAnim({ s, tx: t.tx, ty: t.ty }, null, null, 0.35);
    return;
  }
  V.tapT = now; V.tapX = x; V.tapY = y;
  clearTimeout(V.tapTimer);
  V.tapTimer = setTimeout(() => { V.tapT = 0; if (lightbox) A.closeLightbox(); }, 300);
}
function lbWheel(e) {
  if (!lightbox) return;
  e.preventDefault(); vStop();
  const s = Math.max(1, Math.min(5, V.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
  const t0 = vZoomAt(s, e.clientX, e.clientY), t = s <= 1.001 ? { tx: 0, ty: 0 } : vClamp(s, t0.tx, t0.ty);
  V.s = s; V.tx = t.tx; V.ty = t.ty; vApplyImg();
}
window.addEventListener("resize", () => { if (lightbox && V.el && !V.el._closing) layoutViewer(); });

/* ---- 按钮动作（onclick 里的 A.xxx） ---- */
Object.assign(A, {
  viewDraft(ctx, key) {
    const it = (photoDraft[ctx] || []).find(p => p.key === key);
    if (!it) return;
    if (it.status !== "ready") return openViewer([{ src: it.src }], 0);
    const ready = draftReady(ctx);
    openViewer(ready.map(p => ({ src: p.src })), ready.indexOf(it), { ctx });
  },
  // 列表里的款式图：先拿缩略图垫着立刻打开，原图取回来再换上（跟微信看图一样先糊后清）
  viewStyle(styleId, el) {
    const thumb = (el && el.getAttribute("src")) || "";
    const count = Math.max(1, Number(el && el.getAttribute("data-count")) || 1);
    const cached = fullImgCache.get(styleId);
    if (cached && cached.length) return openViewer(cached.map((src, k) => ({ src, thumb: k === 0 ? thumb : "" })), 0, { styleId });
    openViewer(Array.from({ length: count }, (_, k) => ({ src: "", thumb: k === 0 ? thumb : "" })), 0, { styleId });
    api("GET", "/styles/" + encodeURIComponent(styleId)).then(r => {
      const imgs = styleImages(r.style || {}).filter(showable);
      cacheFullImgs(styleId, imgs);
      if (!lightbox || lightbox.styleId !== styleId) return;
      lightbox.photos = imgs.length ? imgs.map((src, k) => ({ src, thumb: k === 0 ? thumb : "" })) : [{ src: thumb }];
      lightbox.i = Math.min(lightbox.i, lightbox.photos.length - 1);
      renderLightbox();
    }).catch(e => {
      if (!lightbox || lightbox.styleId !== styleId) return;
      toast((e && e.error) || "原图没取到，先看缩略图");
      lightbox.photos = [{ src: thumb }]; lightbox.i = 0; renderLightbox();
    });
  },
  lbStep(d) {
    if (!lightbox || !V.el) return;
    const j = lightbox.i + d;
    if (j < 0 || j >= lightbox.photos.length) return;
    vAnim({ page: -d * (vSize().W + V.gap) }, null, () => { if (lightbox) { lightbox.i = j; layoutViewer(); } }, 0.3);
  },
  closeLightbox() { lightbox = null; renderLightbox(); },
  lbSetCover() {
    const lb = lightbox; if (!lb || !lb.ctx) return;
    const it = draftReady(lb.ctx)[lb.i], list = photoDraft[lb.ctx] || [], k = list.indexOf(it);
    if (k > 0) { list.splice(k, 1); list.unshift(it); }
    refreshPicker(lb.ctx);
    lb.photos = draftReady(lb.ctx).map(p => ({ src: p.src })); lb.i = 0;
    layoutViewer(); toast("已设为封面");
  },
  lbDelete() {
    const lb = lightbox; if (!lb || !lb.ctx) return;
    const it = draftReady(lb.ctx)[lb.i];
    if (it) A.removeDraftPhoto(lb.ctx, it.key);
    const ready = draftReady(lb.ctx);
    if (!ready.length) return A.closeLightbox();
    lb.photos = ready.map(p => ({ src: p.src })); lb.i = Math.min(lb.i, ready.length - 1);
    layoutViewer();
  },
});
