# -*- coding: utf-8 -*-
"""按用户给的番茄原型重画之后：原型 / 旧版(v1.2.37) / 新版(v1.2.38) 三方对照。

输出：
  dist/_uicheck/repro/番茄图标-按原型重画-对比.png     原型 vs 旧 vs 新（系统图标 + 界面 logo）
  dist/_uicheck/repro/番茄图标-按原型重画-小尺寸.png   真实小尺寸观感（浅色 / 深色两行）
"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'dist', '_uicheck', 'repro')
os.makedirs(OUT, exist_ok=True)

PROTO = r'C:\Users\jingt\.workbuddy\clipboard-images\clipboard-2026-10-13T16-02-00-930Z-1414d924.png'
OLD_ICON = os.path.join(ROOT, 'assets', 'app-icon-source-q-a.png')
NEW_ICON = os.path.join(ROOT, 'assets', 'app-icon-source.png')
OLD_LOGO = os.path.join(ROOT, 'assets', '_logo-src', 'f-white-q-f.png')
NEW_LOGO = os.path.join(ROOT, 'assets', '_logo-src', 'f-white.png')

TILE, GAP, PAD, LABEL_H = 330, 22, 26, 42
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


def tile(p, size=TILE):
    return Image.open(p).convert('RGB').resize((size, size), Image.LANCZOS)


ROWS = [
    ('系统图标（exe / 安装包 / 任务栏 / 桌面快捷方式）',
     [('你给的原型', PROTO, False), ('旧版 v1.2.37', OLD_ICON, False), ('新版 v1.2.38 ★', NEW_ICON, True)]),
    ('界面 logo（程序顶栏左上角 + 「关于」面板）',
     [('（同一个番茄原型）', PROTO, False), ('旧版 v1.2.37', OLD_LOGO, False), ('新版 v1.2.38 ★', NEW_LOGO, True)]),
]


def sheet():
    cols = 3
    w = PAD * 2 + cols * TILE + (cols - 1) * GAP
    h = PAD * 2 + 78 + len(ROWS) * (TILE + LABEL_H + GAP + 32) + 24
    im = Image.new('RGB', (w, h), (255, 255, 255))
    d = ImageDraw.Draw(im)
    d.text((PAD, 18), '番茄图标 —— 按你给的原型重画（v1.2.38）', font=FONT, fill=(20, 24, 40))
    d.text((PAD, 48), '★ 是这一版真正装进去的；底色由深蓝改成浅蓝，红色番茄的轮廓不再被吃掉',
           font=FONT_S, fill=(120, 128, 145))

    y = PAD + 78
    for title, items in ROWS:
        d.text((PAD, y), title, font=FONT, fill=(20, 24, 40))
        y += 32
        for i, (label, path, star) in enumerate(items):
            x = PAD + i * (TILE + GAP)
            im.paste(tile(path), (x, y))
            if star:
                d.rectangle([x - 4, y - 4, x + TILE + 3, y + TILE + 3], outline=(230, 60, 60), width=4)
            d.text((x + 6, y + TILE + 8), label, font=FONT_S,
                   fill=(200, 40, 40) if star else (90, 96, 110))
        y += TILE + LABEL_H + GAP

    p = os.path.join(OUT, '番茄图标-按原型重画-对比.png')
    im.save(p)
    print('ok', p, im.size)


def bars():
    """真实小尺寸观感：浅色行 + 深色行，各看同一个图标。"""
    srcs = [('旧版 v1.2.37', OLD_ICON), ('新版 v1.2.38', NEW_ICON)]
    rowh = 84
    w = 560
    im = Image.new('RGB', (w, rowh * len(srcs) * 2), (255, 255, 255))
    d = ImageDraw.Draw(im)
    yy = 0
    for bg, txt in (((243, 243, 245), (40, 44, 56)), ((32, 36, 44), (225, 230, 240))):
        for name, path in srcs:
            d.rectangle([0, yy, w, yy + rowh - 1], fill=bg)
            d.text((12, yy + 32), name, font=FONT_S, fill=txt)
            src = Image.open(path).convert('RGB')
            x = 170
            for s in (16, 24, 32, 48):
                sm = src.resize((s, s), Image.LANCZOS)
                im.paste(sm, (x, yy + (rowh - s) // 2))
                x += s + 30
            yy += rowh
    p = os.path.join(OUT, '番茄图标-按原型重画-小尺寸.png')
    im.save(p)
    print('ok', p, im.size)


if __name__ == '__main__':
    sheet()
    bars()
