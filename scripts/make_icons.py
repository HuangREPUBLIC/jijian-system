#!/usr/bin/env python3
"""生成 PWA 图标：public/app-icon.svg、icon-192.png、icon-512.png、icon-maskable.png、apple-touch-icon.png。

图形是一张菲票：上联印二维码，下联撕下来歪在一边 —— 扫菲、撕联、计一件。
底色是本系统专属的葡萄紫（跟单是蓝、报销是绿），跟 CSS 的 --violet 一致。
页面里内嵌的 logo（public/index.html 启动页、public/app.js 的 APP_LOGO）用的是同一段图形，改图形时三处一起改。
改完跑一次：python3 scripts/make_icons.py（需要 Pillow）
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")
S = 1024            # 先画 1024 再缩小，等于 4 倍超采样抗锯齿
K = S / 512         # 设计稿坐标系是 512
VIOLET = (0x6A, 0x3F, 0xC1)
STOPS = [(0.0, (0x8E, 0x63, 0xE6)), (0.55, (0x6A, 0x3F, 0xC1)), (1.0, (0x42, 0x23, 0x84))]
STUB_TILT = 9       # 撕下来的下联顺时针歪的角度

SVG = """<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" fill="none">
  <defs>
    <linearGradient id="bg" x1="60" y1="30" x2="440" y2="490" gradientUnits="userSpaceOnUse">
      <stop stop-color="#8E63E6"/><stop offset=".55" stop-color="#6A3FC1"/><stop offset="1" stop-color="#422384"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <path d="M174 92H338A24 24 0 0 1 362 116V282H150V116A24 24 0 0 1 174 92Z" fill="#fff"/>
  <rect x="202" y="133" width="108" height="108" rx="16" stroke="#6A3FC1" stroke-width="22"/>
  <rect x="237" y="168" width="38" height="38" rx="6" fill="#6A3FC1"/>
  <path d="M150 316H362V396A24 24 0 0 1 338 420H174A24 24 0 0 1 150 396Z" fill="#fff" transform="rotate(9 256 368)"/>
</svg>
"""


def lerp(t):
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            u = (t - t0) / (t1 - t0)
            return tuple(round(a + (b - a) * u) for a, b in zip(c0, c1))
    return STOPS[-1][1]


def gradient():
    # 跟 SVG 一样：渐变轴从 (60,30) 到 (440,490)，每个像素投影到轴上取颜色
    ax, ay, bx, by = 60 * K, 30 * K, 440 * K, 490 * K
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    lut = [lerp(i / 255) for i in range(256)]
    img = Image.new("RGB", (S, S))
    px = img.load()
    for y in range(S):
        for x in range(S):
            t = ((x - ax) * dx + (y - ay) * dy) / l2
            px[x, y] = lut[int(min(1, max(0, t)) * 255)]
    return img


def draw_glyph(img, scale):
    c = 256

    def p(x, y):
        return ((c + (x - c) * scale) * K, (c + (y - c) * scale) * K)

    def box(x0, y0, x1, y1):
        (a, b), (e, f) = p(x0, y0), p(x1, y1)
        return [a, b, e, f]

    r = 24 * K * scale
    d = ImageDraw.Draw(img)
    # 上联：只有上面两个角是圆的
    d.rounded_rectangle(box(150, 92, 362, 282), radius=r, fill="white", corners=(True, True, False, False))
    # 二维码定位角：SVG 里是 22 宽描边的框，这里用外框减内框画出同样的环
    d.rounded_rectangle(box(191, 122, 321, 252), radius=27 * K * scale, fill=VIOLET)
    d.rounded_rectangle(box(213, 144, 299, 230), radius=5 * K * scale, fill="white")
    d.rounded_rectangle(box(237, 168, 275, 206), radius=6 * K * scale, fill=VIOLET)
    # 下联：单独画一层再绕自身中心旋转，PIL 的角度是逆时针，所以取负
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(box(150, 316, 362, 420), radius=r, fill="white",
                                            corners=(False, False, True, True))
    layer = layer.rotate(-STUB_TILT, resample=Image.BICUBIC, center=p(256, 368))
    img.alpha_composite(layer)


def make(base, rounded, scale):
    img = base.copy().convert("RGBA")
    draw_glyph(img, scale)
    if rounded:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=116 * K, fill=255)
        img.putalpha(mask)
    return img


def save(img, size, name):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(ROOT, name), optimize=True)
    print("  ", name)


if __name__ == "__main__":
    base = gradient()
    with open(os.path.join(ROOT, "app-icon.svg"), "w") as f:
        f.write(SVG)
    print("   app-icon.svg")
    rounded = make(base, True, 1.0)
    save(rounded, 192, "icon-192.png")
    save(rounded, 512, "icon-512.png")
    # maskable：系统会裁成圆形/水滴等形状，图形要缩进 80% 的安全区里
    save(make(base, False, 0.78), 512, "icon-maskable.png")
    # iOS 自己加圆角，给不透明的方图
    save(make(base, False, 1.0).convert("RGB"), 180, "apple-touch-icon.png")
