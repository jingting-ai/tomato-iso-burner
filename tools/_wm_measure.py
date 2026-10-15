# -*- coding: utf-8 -*-
"""量出三张候选图里「AI生成」水印的精确外接框。

思路：水印是一层比背景更亮的半透明覆盖，而背景是平滑渐变。
把图重度高斯模糊当作「背景估计」，凡是亮度明显高于背景估计的像素就算水印。
"""
import os
from PIL import Image, ImageFilter

SRC = r"E:\开发\Doro镜像刻录工具\assets\icon-candidates"
FILES = [
    ("A", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-46.png"),
    ("B", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-45.png"),
    ("C", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-43.png"),
]

# 只看右下角这一大块，避免角色/图形本身被算进来
RX0, RY0 = 512, 512

for tag, fn in FILES:
    im = Image.open(os.path.join(SRC, fn)).convert("RGB")
    L = im.convert("L")
    bg = L.filter(ImageFilter.GaussianBlur(26))
    lp, bp = L.load(), bg.load()
    xs, ys, n = [], [], 0
    for y in range(RY0, im.height):
        for x in range(RX0, im.width):
            v = lp[x, y]
            # 明显亮于背景估计 → 水印；150 以上是白字/白 U 盘，另算
            if v > bp[x, y] + 14 and v < 200:
                xs.append(x); ys.append(y); n += 1
    if xs:
        print(f"{tag} {fn[-22:-4]}  n={n}  bbox=({min(xs)},{min(ys)},{max(xs)+1},{max(ys)+1})"
              f"  占比 x: {min(xs)/1024:.3f}~{(max(xs)+1)/1024:.3f}  y: {min(ys)/1024:.3f}~{(max(ys)+1)/1024:.3f}")
    else:
        print(f"{tag} n=0")
