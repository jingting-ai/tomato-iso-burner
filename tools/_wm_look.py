# -*- coding: utf-8 -*-
"""把三张候选图的右下角裁出来、拉高对比，肉眼看水印到底占多大。"""
import os
from PIL import Image, ImageDraw, ImageFont

SRC = r"E:\开发\Doro镜像刻录工具\assets\icon-candidates"
OUT = r"E:\开发\Doro镜像刻录工具\dist\_uicheck\repro\_wm-look.png"
FILES = [
    ("A", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-46.png"),
    ("B", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-45.png"),
    ("C", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-43.png"),
]
BOX = (560, 560, 1024, 1024)   # 右下角 464×464
Z = 2                          # 放大 2 倍
S = (BOX[2] - BOX[0]) * Z

f = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 20)
canvas = Image.new("RGB", (S + 90, S * 3 + 20), (255, 255, 255))
d = ImageDraw.Draw(canvas)
for i, (tag, fn) in enumerate(FILES):
    im = Image.open(os.path.join(SRC, fn)).convert("RGB").crop(BOX)
    # 拉对比：把暗部区间线性拉开，让淡淡的水印显形
    lo, hi = 20, 90
    im = im.point(lambda v: max(0, min(255, int((v - lo) * 255 / (hi - lo)))))
    im = im.resize((S, S), Image.NEAREST)
    y = 10 + i * S
    canvas.paste(im, (80, y))
    d.text((10, y + S // 2), f"方案 {tag}", font=f, fill=(20, 20, 20))
canvas.save(OUT)
print("saved", OUT, canvas.size)
