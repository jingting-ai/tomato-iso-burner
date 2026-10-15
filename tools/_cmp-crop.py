# -*- coding: utf-8 -*-
"""临时对比脚本：比较几种 logo 裁切方案在图标里的效果。用完可删。"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from logo_common import load_source  # noqa: E402

SRC = load_source(white_cut=242)
S = 1024
RADIUS = 232
TOP, BOTTOM = (158, 166, 176), (106, 114, 126)


def make(box, side):
    canvas = Image.new('RGB', (side, side), (255, 255, 255))
    sb = (max(0, box[0]), max(0, box[1]), min(SRC.width, box[2]), min(SRC.height, box[3]))
    canvas.paste(SRC.crop(sb), (sb[0] - box[0], sb[1] - box[1]))
    base = canvas.resize((S, S), Image.LANCZOS)
    grad = Image.new('RGB', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / (S - 1)
        gd.line([(0, y), (S, y)], fill=tuple(
            round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)))
    g = canvas.convert('L')
    p = ImageOps.expand(g, border=1, fill=255)
    ImageDraw.floodfill(p, (0, 0), 1, thresh=20)
    m = p.crop((1, 1, 1 + side, 1 + side)).point(lambda v: 255 if v == 1 else 0)
    m = m.resize((S, S), Image.LANCZOS).filter(ImageFilter.GaussianBlur(2.4))
    out = Image.composite(grad, base, m).convert('RGBA')
    mk = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mk).rounded_rectangle([0, 0, S - 1, S - 1], radius=RADIUS, fill=255)
    out.putalpha(mk)
    return out


variants = [
    ('旧 780（切掉两侧头发）', (22, 168, 802, 948), 780),
    ('新 900（四周均匀留白）', (-24, 115, 876, 1015), 900),
    ('折中 830（贴边不切）', (11, 150, 841, 980), 830),
    ('方案D 839（底部齐平）', (7, 126, 846, 965), 839),
]
PAD = 26
W = sum(300 + PAD * 2 for _ in variants)
canvas = Image.new('RGB', (W, 420), (243, 244, 246))
d = ImageDraw.Draw(canvas)
try:
    f = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 15)
except Exception:
    f = None
x = PAD
for name, box, side in variants:
    ic = make(box, side).resize((300, 300), Image.LANCZOS)
    tile = Image.new('RGBA', (300, 300), (243, 244, 246, 255))
    tile.alpha_composite(ic, (0, 0))
    canvas.paste(tile.convert('RGB'), (x, 20))
    d.text((x, 336), name, font=f, fill=(20, 25, 35))
    sm = ic.resize((24, 24), Image.LANCZOS)
    small = Image.new('RGBA', (24, 24), (243, 244, 246, 255))
    small.alpha_composite(sm, (0, 0))
    canvas.paste(small.convert('RGB'), (x, 370))
    x += 300 + PAD * 2
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dist',
                   '_icon_preview', '_cmp2.png')
canvas.save(out)
print('ok', canvas.size, out)
