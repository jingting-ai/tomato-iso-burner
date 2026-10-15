# -*- coding: utf-8 -*-
"""出「顶栏特写」图（v1.2.23）：弹窗打开时右上角不再穿模 —— 按钮区与遮罩融合、面板圆角完整。

注意：1.2.23 起的界面效果图是 DPR 1.752 的 1752x1518，坐标按 CSS 像素写、脚本内换算。
"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'dist', '_uicheck', 'gallery', '界面效果-1.2.23-关于面板.png')
DST1 = r'E:/DoroBurner-1.2.23/顶栏特写-1.2.23.png'
DST2 = r'E:/DoroBurner-1.2.4/顶栏特写-1.2.23.png'

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
    dpr = src.width / 1001.0  # 离屏窗 innerWidth=1001

    # 取 CSS 区域：x 500..1001（含主题切换器、窗口按钮区、面板右上的圆角），y 0..200
    box = (int(500 * dpr), 0, src.width, int(200 * dpr))
    crop = src.crop(box)
    scale = 2
    big = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)

    pad, head = 24, 82
    W = big.width + pad * 2
    H = head + big.height + pad + 52
    out = Image.new('RGB', (W, H), (255, 255, 255))
    d = ImageDraw.Draw(out)

    d.text((pad, 20), '弹窗打开时，右上角不再「穿模」',
           font=font(23, True), fill=TEXT)
    d.text((pad, 52), '右边三个窗口按钮由系统绘制，底色随遮罩一起变暗；左边面板的圆角与描边完整可见',
           font=font(15), fill=DIM)

    ox, oy = pad, head
    out.paste(big, (ox, oy))

    # 红框圈出面板右上角（CSS x 690..855, y 12..150），换算到大图坐标
    x0 = int((690 - 500) * dpr) * scale + ox
    x1 = int((855 - 500) * dpr) * scale + ox
    y0 = int(12 * dpr) * scale + oy
    y1 = int(150 * dpr) * scale + oy
    for i in range(3):  # 虚线感：分段画
        d.rectangle([x0 + i, y0 + i, x1 - i, y1 - i], outline=RED, width=2)

    d.text((pad, oy + big.height + 16),
           '红框：面板右上角 —— 以前这一块会被窗口按钮的底色盖掉一截',
           font=font(14), fill=DIM)

    out.save(DST1)
    out.save(DST2)
    print('[OK]', DST1, out.size)


if __name__ == '__main__':
    main()
