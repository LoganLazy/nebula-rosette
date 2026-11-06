#!/usr/bin/env python3
"""
生成 PWA 图标。只在图标需要改动时手动跑一次，产物已提交，
所以正常开发和部署都不需要装 Pillow。

    python3 build/make-icons.py

图标是纯代码画的：玫瑰粉到紫的对角渐变 + 中间一个四角星，
跟应用内的 logo（✦）一致。不用位图素材，免得引入版权不明的图片。
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets"
SIZES = [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")]

# 与 index.html 的 rosette-300 / rosette-500 / petal-400 对齐
C1 = (253, 164, 196)
C2 = (244, 63, 134)
C3 = (192, 132, 252)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def gradient(size: int) -> Image.Image:
    """对角三段渐变。逐像素画 512x512 也就 26 万次，够快，不值得优化。"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(C1, C2, t / 0.55) if t < 0.55 else lerp(C2, C3, (t - 0.55) / 0.45)
    return img


def star_points(cx: float, cy: float, outer: float, inner: float, tips: int = 4):
    """四角星：长短半径交替，起点转 -90° 让尖角朝上。"""
    pts = []
    for i in range(tips * 2):
        r = outer if i % 2 == 0 else inner
        a = math.pi * i / tips - math.pi / 2
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def make(size: int, name: str) -> None:
    # 4 倍超采样再缩小，边缘才不会有锯齿
    s = size * 4
    img = gradient(s)

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255
    )

    star = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(star)
    d.polygon(star_points(s / 2, s / 2, s * 0.30, s * 0.085), fill=235)
    # 中心一点更亮的高光，避免星形显得扁平
    d.ellipse([s / 2 - s * 0.028, s / 2 - s * 0.028,
               s / 2 + s * 0.028, s / 2 + s * 0.028], fill=255)

    img.paste(Image.new("RGB", (s, s), (255, 255, 255)), (0, 0), star)

    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    out = out.resize((size, size), Image.LANCZOS)
    path = OUT / name
    out.save(path, "PNG", optimize=True)
    print(f"  {name}  {path.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    print("生成图标：")
    for size, name in SIZES:
        make(size, name)
