# -*- coding: utf-8 -*-
"""检查抹完水印后右下角还有没有残留（拉高对比看）。"""
from PIL import Image, ImageDraw, ImageFont

D = r"E:\开发\Doro镜像刻录工具\dist\_uicheck\repro"
OUT = D + r"\_wm-after.png"
BOX = (500, 460, 1024, 1024)
Z = 2
S = (BOX[2] - BOX[0]) * Z

f = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 20)
canvas = Image.new("RGB", (S + 90, S * 3 + 20), (255, 255, 255))
d = ImageDraw.Draw(canvas)
for i, tag in enumerate("ABC"):
    rgba = Image.open(f"{D}/_clean-{tag}.png").convert("RGBA")
    flat = Image.new("RGB", rgba.size, (255, 255, 255))
    flat.paste(rgba, (0, 0), rgba)
    im = flat.crop(BOX)
    lo, hi = 20, 100                      # 暗部拉伸：水印若还在就会现形
    im = im.point(lambda v: max(0, min(255, int((v - lo) * 255 / (hi - lo)))))
    y = 10 + i * S
    canvas.paste(im.resize((S, S), Image.NEAREST), (80, y))
    d.text((10, y + S // 2), f"方案 {tag}", font=f, fill=(20, 20, 20))
canvas.save(OUT)
print("saved", OUT, canvas.size)
