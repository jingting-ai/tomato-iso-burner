# -*- coding: utf-8 -*-
"""把几何版候选拼成一张「1024 原始观感」大图（配合 _icon_compare.py 用）。

对比表看的是缩到 48/32/16px 之后的清晰度；这张看的是设计本身好不好看。
两者要一起看：大图好看但缩下来糊成一团的（AI 那版）不能要，
缩下来清楚但大图寡淡的也未必合适。
"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLEAN = os.path.join(ROOT, "dist", "_uicheck", "repro")
OUT = os.path.join(CLEAN, "番茄图标候选-大图.png")

# 候选标签 → 说明。改这一批候选时同步改这里。
DESC = {
    "A": "番茄光盘（符号版 · 银灰盘缘）",
    "B": "番茄光盘 + 脸",
    "C": "烧录番茄（符号版 · 顶上火苗）",
    "D": "烧录番茄 + 脸",
    "E": "番茄 + 光盘 + 脸",
    "F": "番茄 U 盘 + 脸 + 腮红",
    "G": "向下写入箭头",
}
BEST = os.environ.get("ICON_BEST", "")

FONT = "C:/Windows/Fonts/msyh.ttc"


def font(sz, bold=False):
    for p in (("C:/Windows/Fonts/msyhbd.ttc" if bold else FONT), FONT):
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            pass
    return ImageFont.load_default()


tags = [t for t in sorted(DESC) if os.path.isfile(os.path.join(CLEAN, "_clean-%s.png" % t))]
COLS = 3
ROWS = (len(tags) + COLS - 1) // COLS
CELL, GAP, PAD, TOP, CAP = 320, 22, 26, 86, 46

cv = Image.new("RGB", (PAD * 2 + CELL * COLS + GAP * (COLS - 1),
                       TOP + (CELL + CAP) * ROWS + GAP * (ROWS - 1) + PAD), (255, 255, 255))
d = ImageDraw.Draw(cv)
d.text((PAD, 16), "番茄图标 · 几何版（1024 源图的原始观感）", font=font(23, True), fill=(28, 32, 44))
d.text((PAD, 50), "全部用纯色块手绘，没有渐变和高光；缩到 16px 的清晰度见另一张对比表",
       font=font(13), fill=(128, 136, 150))

for i, tag in enumerate(tags):
    src = Image.open(os.path.join(CLEAN, "_clean-%s.png" % tag)).convert("RGBA")
    im = src.resize((CELL, CELL), Image.LANCZOS)
    bg = Image.new("RGB", (CELL, CELL), (255, 255, 255))
    bg.paste(im, (0, 0), im)
    cx = PAD + (i % COLS) * (CELL + GAP)
    cy = TOP + (i // COLS) * (CELL + CAP)
    cv.paste(bg, (cx, cy))
    d.rectangle([cx, cy, cx + CELL - 1, cy + CELL - 1], outline=(224, 228, 236))
    hit = tag == BEST
    d.text((cx + 2, cy + CELL + 7), "方案 %s" % tag, font=font(16, True),
           fill=(200, 46, 42) if hit else (28, 32, 44))
    d.text((cx + 2, cy + CELL + 27), DESC[tag], font=font(12),
           fill=(200, 46, 42) if hit else (110, 118, 132))

cv.save(OUT)
print("saved", OUT, cv.size, "%.1f KB" % (os.path.getsize(OUT) / 1024))
