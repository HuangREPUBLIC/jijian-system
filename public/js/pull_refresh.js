"use strict";
// 下拉刷新：顶部下拉强制刷新当前页，指示器跟手（阻尼）、拉够变色提示、刷新时转圈；横向滑动不误触发。

(function setupPullRefresh() {
  const THRESHOLD = 64;
  let startX = 0, startY = null, decided = false, pulling = false, dist = 0, refreshing = false, ind = null;
  const canPull = () => !refreshing && me() && !overlayOpen() && !notifPanelOpen && window.scrollY <= 0 && !state.scan.camOn;
  const node = () => {
    if (!ind) {
      ind = document.createElement("div"); ind.className = "ptr"; ind.setAttribute("aria-hidden", "true");
      ind.innerHTML = `<span class="ptr-ic">${icon("refresh")}</span>`;
      document.body.appendChild(ind);
    }
    return ind;
  };
  const show = (d, spin) => {
    const el = node(), k = Math.min(1, d / THRESHOLD);
    el.classList.remove("back");
    el.style.transform = `translate3d(-50%,${d - 48}px,0)`;
    el.style.opacity = String(k);
    el.classList.toggle("ready", d >= THRESHOLD);
    el.classList.toggle("spin", !!spin);
    el.querySelector(".ptr-ic").style.transform = spin ? "" : `rotate(${k * 300}deg)`;
  };
  const hide = () => {
    if (!ind) return;
    ind.classList.add("back"); ind.classList.remove("spin", "ready");
    ind.style.transform = "translate3d(-50%,-48px,0)"; ind.style.opacity = "0";
  };
  document.addEventListener("touchstart", (e) => {
    startY = null;
    if (!canPull() || e.touches.length > 1) return;
    if (e.target.closest && e.target.closest(".tbl-wrap,.chiprow,.scan-viewport,.opt-list,.lightbox,.mask")) return;
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; decided = false; pulling = false; dist = 0;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY, dx = e.touches[0].clientX - startX;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      if (Math.abs(dx) > Math.abs(dy) || dy < 0 || window.scrollY > 0) { startY = null; return; }
    }
    pulling = true;
    dist = dy > 0 ? rubber(dy, 600) : 0;
    show(dist, false);
  }, { passive: true });
  const end = async () => {
    if (startY === null || !pulling) { startY = null; return; }
    startY = null; pulling = false;
    if (dist < THRESHOLD) { hide(); return; }
    refreshing = true; show(THRESHOLD * 0.8, true); buzz(8);
    try { await loadView(route.v); render(); }
    catch (e) { toast((e && e.error) || "刷新失败"); }
    refreshing = false; hide();
  };
  document.addEventListener("touchend", end);
  document.addEventListener("touchcancel", end);
})();
