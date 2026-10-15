# -*- coding: utf-8 -*-
"""出「顶栏右侧特写」图：证明「关于」按钮与颜色切换器等高对齐。"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'dist', '_uicheck', 'gallery', '界面效果-1.2.21.png')
DST1 = r'E:/DoroBurner-1.2.21/顶栏特写-1.2.21.png'
DST2 = r'E:/DoroBurner-1.2.4/顶栏特写-1.2.21.png'

CJK = 'C:/Windows/Fonts/msyh.ttc'


def font(size, bold=False):
    for p in ([CJK, 'C:/Windows/Fonts/msyhbd.ttc', 'C:/Windows/Fonts/simhei.ttf']
              if not bold else ['C:/Windows/Fonts/msyhbd.ttc', CJK]):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


TEXT = (15, 23, 42)
DIM = (118, 128, 143)
RED = (222, 52, 84)


def main():
    src = Image.open(SRC).convert('RGB')
    # 顶栏右侧：权限 chip(719-860) / 关于(871-952) / 主题三连(963-1079)
    crop = src.crop((705, 8, 1092, 70))
    scale = 2
    big = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)

    pad, head = 24, 82
    W = big.width + pad * 2
    H = head + big.height + pad + 52
    out = Image.new('RGB', (W, H), (255, 255, 255))
    d = ImageDraw.Draw(out)

    d.text((pad, 20), '顶栏右侧特写：「关于」在颜色切换左边，两块等高',
           font=font(23, True), fill=TEXT)
    d.text((pad, 52), '两条红线是两个控件的上 / 下边界 —— 落在同一条线上（同为 28px）',
           font=font(15), fill=DIM)

    ox, oy = pad, head
    out.paste(big, (ox, oy))
    # 上下两条参考线（正是两个控件共用的上下边界）
    for yy in (0, big.height - 1):
        d.line([(ox - 8, oy + yy), (ox + big.width + 8, oy + yy)], fill=RED, width=2)

    d.text((pad, oy + big.height + 16),
           '左：管理员权限状态　　中：心形「关于」　　右：自动 / 浅色 / 深色',
           font=font(14), fill=DIM)

    out.save(DST1)
    out.save(DST2)
    print('[OK]', DST1, out.size)


if __name__ == '__main__':
    main()
