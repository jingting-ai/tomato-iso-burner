# -*- coding: utf-8 -*-
"""把「更可爱」版和原版拼成对照图，并验小尺寸。

输出：
  dist/_uicheck/repro/番茄更可爱-对比.png     原版 vs 更可爱（大图 + 16/32/48 缩略）
  dist/_uicheck/repro/番茄更可爱-小尺寸.png   图标候选在深浅任务栏上的真实观感
"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAND = os.path.join(ROOT, 'assets', '_q2', 'cand')
OUT = os.path.join(ROOT, 'dist', '_uicheck', 'repro')
os.makedirs(OUT, exist_ok=True)

TILE = 340
GAP = 24
PAD = 26
LABEL_H = 46

FONT = None
for p in (r'C:\Windows\Fonts\msyhbd.ttc', r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\simhei.ttf'):
    if os.path.exists(p):
        try:
            FONT = ImageFont.truetype(p, 22)
            FONT_S = ImageFont.truetype(p, 18)
            break
        except Exception:
            pass
if FONT is None:
    FONT = FONT_S = ImageFont.load_default()


def tile(im, size=TILE):
    return im.convert('RGB').resize((size, size), Image.LANCZOS)


def sheet():
    rows = [
        ('方案 A（系统图标）· 抱着 U 盘',
         [('原版', '_orig_A.png', False), ('更可爱 ★', 'icon-A4-cute.png', True)]),
        ('方案 F（程序内 logo）· 番茄 + 箭头 + U 盘',
         [('原版（蓝底）', '_orig_F.png', False), ('更可爱 + 白底 ★', 'logo-F-cute-white.png', True)]),
    ]
    cols = 3  # 原版 / 更可爱 / 小尺寸列
    w = PAD * 2 + cols * TILE + (cols - 1) * GAP
    h = PAD * 2 + 78 + len(rows) * (TILE + LABEL_H + GAP + 34)
    im = Image.new('RGB', (w, h), (255, 255, 255))
    d = ImageDraw.Draw(im)

    d.text((PAD, 18), '番茄图标 —— 原版 vs「更可爱」版', font=FONT, fill=(20, 24, 40))
    d.text((PAD, 46), '★ 是这一轮的候选；最右一列是按真实小尺寸缩下来的观感',
           font=FONT_S, fill=(120, 128, 145))

    y = PAD + 78
    for title, items in rows:
        d.text((PAD, y), title, font=FONT, fill=(20, 24, 40))
        y += 34
        for i, (label, fn, star) in enumerate(items):
            x = PAD + i * (TILE + GAP)
            src = os.path.join(CAND, fn)
            im.paste(tile(Image.open(src)), (x, y))
            if star:
                d.rectangle([x - 4, y - 4, x + TILE + 3, y + TILE + 3], outline=(230, 60, 60), width=4)
            d.text((x + 6, y + TILE + 8), label, font=FONT_S,
                   fill=(200, 40, 40) if star else (90, 96, 110))

        # 小尺寸列：16 / 32 / 48（NEAREST 放大看真实清晰度）
        x = PAD + 2 * (TILE + GAP)
        src = Image.open(os.path.join(CAND, items[1][1])).convert('RGB')
        strip = Image.new('RGB', (TILE, TILE), (26, 52, 96))
        sd = ImageDraw.Draw(strip)
        sx = 34
        for s in (16, 32, 48):
            sm = src.resize((s, s), Image.LANCZOS)
            big = sm.resize((s * 3, s * 3), Image.NEAREST)
            strip.paste(big, (sx, (TILE - s * 3) // 2))
            sd.text((sx, (TILE - s * 3) // 2 + s * 3 + 4), '%dpx' % s, font=FONT_S, fill=(220, 226, 240))
            sx += s * 3 + 26
        im.paste(strip, (x, y))
        d.text((x + 6, y + TILE + 8), '缩到 16/32/48px', font=FONT_S, fill=(90, 96, 110))

        y += TILE + LABEL_H + GAP

    p = os.path.join(OUT, '番茄更可爱-对比.png')
    im.save(p)
    print('ok', p, im.size)


def bars():
    """图标候选在深/浅任务栏 28px 上的真实观感。"""
    srcs = [('原版', '_orig_A.png'), ('更可爱', 'icon-A4-cute.png')]
    rowh = 46
    w = 520
    im = Image.new('RGB', (w, rowh * len(srcs)), (255, 255, 255))
    d = ImageDraw.Draw(im)
    for i, (name, fn) in enumerate(srcs):
        y = i * rowh
        d.rectangle([0, y, w, y + rowh - 1], fill=(243, 243, 245) if i % 2 == 0 else (32, 36, 44))
        src = Image.open(os.path.join(CAND, fn)).convert('RGB')
        d.text((10, y + 13), name, font=FONT_S,
               fill=(40, 44, 56) if i % 2 == 0 else (225, 230, 240))
        x = 130
        for s in (16, 24, 28, 32, 48):
            sm = src.resize((s, s), Image.LANCZOS)
            im.paste(sm, (x, y + (rowh - s) // 2))
            x += s + 26
    p = os.path.join(OUT, '番茄更可爱-小尺寸.png')
    im.save(p)
    print('ok', p)


if __name__ == '__main__':
    sheet()
    bars()
