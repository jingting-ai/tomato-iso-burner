# -*- coding: utf-8 -*-
"""量右下角那块：白底、水印字、方块边缘高光各自的亮度，好定 floodfill 的容差。"""
import os
from PIL import Image, ImageDraw

SRC = r"E:\开发\Doro镜像刻录工具\assets\icon-candidates"
FILES = [
    ("A", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-46.png"),
    ("B", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-45.png"),
    ("C", "应用图标设计_1024_1024_正方形满幅_深蓝色渐变圆角_2026-10-13T14-18-43.png"),
]
RX0, RY0 = 560, 520

for tag, fn in FILES:
    rgb = Image.open(os.path.join(SRC, fn)).convert("RGB")
    L = rgb.convert("L")
    lp = L.load()

    # 角落区亮度直方图（每 10 级一档，只看 150~255）
    hist = {}
    for y in range(RY0, rgb.height):
        for x in range(RX0, rgb.width):
            v = lp[x, y]
            if v >= 150:
                hist[v // 10 * 10] = hist.get(v // 10 * 10, 0) + 1
    print(f"--- {tag} 角落区亮度分布（>=150）:", dict(sorted(hist.items())))

    # 从四角 floodfill 几个容差，看抹掉的面积和剩下的包围盒
    for th in (30, 45, 60, 75, 90):
        g = L.copy()
        pad = Image.new("L", (g.width + 2, g.height + 2), 255)
        pad.paste(g, (1, 1))
        for pt in ((0, 0), (pad.width - 1, 0), (0, pad.height - 1), (pad.width - 1, pad.height - 1)):
            ImageDraw.floodfill(pad, pt, 1, thresh=th)
        bg = pad.crop((1, 1, 1 + g.width, 1 + g.height))
        bbox = bg.point(lambda v: 0 if v == 1 else 255).getbbox()
        removed = sum(1 for v in bg.getdata() if v == 1)
        print(f"   thresh={th:3d}  抹掉 {removed:7d} px   剩余包围盒 {bbox}")
