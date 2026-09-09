"use strict";
/**
 * 菲票二维码。生成内联 SVG 而不是 PNG dataURL：
 *   - 打印时矢量不糊，热敏标签机上小尺寸也扫得动
 *   - 直接塞进 HTML，不用额外的图片请求（PWA 离线也能打印）
 * 容错级别 M：菲票会被摸脏折皱，L 太脆；H 会让码变密、小标签上反而难扫。
 */
const QRCode = require("qrcode");

async function qrSvg(text) {
  const svg = await QRCode.toString(String(text), {
    type: "svg", errorCorrectionLevel: "M", margin: 0, width: 120
  });
  // qrcode 会带 <?xml ...?> 声明，内联进 HTML 时必须去掉，否则部分浏览器不渲染
  return svg.replace(/^<\?xml[^>]*\?>\s*/, "");
}

module.exports = { qrSvg };
