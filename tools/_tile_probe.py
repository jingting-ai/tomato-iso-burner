# -*- coding: utf-8 -*-
"""用「蓝远大于红」圈出圆角方块本身，顺带看水印有没有压进方块里。"""
import os
from PIL import Image

SRC = r"E:\开发\Doro镜像刻录工具\assets\icon-candidates"
FILES = [
    ("A", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-46.png"),
    ("B", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-45.png"),
    ("C", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-43.png"),
]

for tag, fn in FILES:
    im = Image.open(os.path.join(SRC, fn)).convert("RGB")
    px = im.load()
    w, h = im.size
    for th in (15, 25, 35, 45):
        xs, ys = [], []
        for y in range(h):
            for x in range(w):
                r, g, b = px[x, y]
                if b - r > th:
                    xs.append(x); ys.append(y)
        bb = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
        print(f"{tag} b-r>{th:3d}  蓝像素 {len(xs):7d}  外接框 {bb}  "
              f"宽高 {bb[2]-bb[0]}×{bb[3]-bb[1]}")
    print()
