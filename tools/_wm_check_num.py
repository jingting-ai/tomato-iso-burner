# -*- coding: utf-8 -*-
"""数值自检：清洗后的图在右下角还剩多少「低饱和中灰」像素（水印的指纹）。"""
from PIL import Image

D = r"E:\开发\Doro镜像刻录工具\dist\_uicheck\repro"

for tag in "ABC":
    rgba = Image.open(f"{D}/_clean-{tag}.png").convert("RGBA")
    flat = Image.new("RGB", rgba.size, (255, 255, 255))
    flat.paste(rgba, (0, 0), rgba)
    w, h = flat.size
    px, ap = flat.load(), rgba.load()
    lum = flat.convert("L").load()

    xs, ys, n = [], [], 0
    hi = 0
    for y in range(int(h * 0.45), h):
        for x in range(int(w * 0.55), w):
            if ap[x, y][3] < 200:          # 看透明区没意义
                continue
            v = lum[x, y]
            r, g, b = px[x, y]
            if 135 < v < 240 and max(r, g, b) - min(r, g, b) < 25:
                xs.append(x); ys.append(y); n += 1
                hi = max(hi, v)
    bb = (min(xs), min(ys), max(xs) + 1, max(ys) + 1) if xs else None
    print(f"{tag}  疑似残留 {n:6d} 个   bbox={bb}   最亮 {hi}")
