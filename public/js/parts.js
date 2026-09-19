"use strict";
// 多个页面共用的小块 HTML：键值格、日期行、进度条、扎信息、裁床单单头、款式缩略图。

// 卡片里的键值格（value 须已转义）与"裁床 → 交货"日期行
const kv = (k, v) => `<span class="sc-cell"><span class="sc-k">${k}：</span><span class="sc-v">${v}</span></span>`;
const datesCell = o => `<span class="sc-cell sc-dates"><span class="sc-k">裁床</span><span class="sc-v">${esc(o.cut_date || "—")}</span>
  <span class="sc-arrow">→</span><span class="sc-k">交货</span><span class="sc-v">${esc(o.ship_date || "—")}</span></span>`;
// 工序进度条那一行
const progRowHtml = (pct, style) => `<div class="cc-prog"${style ? ` style="${style}"` : ""}>
  <span class="cc-prog-t">工序进度</span>
  <div class="pbar"><i style="width:${pct}%"></i></div><span class="cc-pct num">${pct}%</span></div>`;
// 扎的颜色 / 件数 / 尺码
const bundleCells = b => kv("颜色", esc(b.color || "—")) + kv("件数", num(b.qty)) + kv("尺码", esc(b.size || "—"));
// 带款式缩略图的裁床单单头
function orderHeadHtml(o, cells) {
  return `<div class="sc-head">${styleThumbHtml(o.style_id, o.style_image)}
    <div class="sc-info"><div class="sc-title">款号 ${esc(o.style_code || o.style_name || "—")}</div>
      <div class="sc-grid">${cells}</div></div></div>`;
}
// 卡片上的款式缩略图：点开看大图（先用缩略图垫着，原图到了再换上）
function styleThumbHtml(styleId, src, count, cls) {
  return showable(src)
    ? `<img class="${cls || "sc-thumb"}" src="${esc(src)}" alt="款式图" loading="lazy" decoding="async"
        data-count="${Number(count) || 1}" onclick="event.stopPropagation();A.viewStyle('${styleId}',this)">`
    : `<div class="${cls || "sc-thumb"} sc-noimg" aria-hidden="true">${icon("image")}</div>`;
}
