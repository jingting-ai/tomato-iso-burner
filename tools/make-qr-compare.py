# -*- coding: utf-8 -*-
"""生成「收款码处理前后对比」图：左＝用户给的原海报，右＝软件里实际用的成品。"""
import io
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WECHAT_SRC = ('C:/Users/jingt/Documents/Tencent Files/2289888789/nt_qq/nt_data/Pic/'
              '2026-10/Ori/d0d2c0634fa177bc256f6ae812edf71c.png')
ALIPAY_SRC = ('C:/Users/jingt/Documents/Tencent Files/2289888789/nt_qq/nt_data/Pic/'
              '2026-10/Thumb/74e3e857de89a66ef93f2e090d679b0c_720.png')
WECHAT_OUT = os.path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'donate-wechat.png')
ALIPAY_OUT = os.path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'donate-alipay.png')

FONT = 'C:/Windows/Fonts/msyh.ttc'
FONT_B = 'C:/Windows/Fonts/msyhbd.ttc'


def font(size, bold=False):
    try:
        return ImageFont.truetype(FONT_B if bold else FONT, size)
    except OSError:
        return ImageFont.truetype(FONT, size)


BG = (244, 246, 251)
CARD = (255, 255, 255)
LINE = (226, 230, 238)
TEXT = (34, 38, 47)
DIM = (110, 118, 132)
GREEN = (7, 193, 96)
BLUE = (22, 119, 255)
HEART = (226, 85, 125)

TH = 400          # 缩略图高度
PAD = 40
GAP = 34


def fit(im, h):
    w = round(im.width * h / im.height)
    return im.resize((w, h), Image.LANCZOS)


def rounded(draw, box, r, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def main():
    rows = [
        ('微信', WECHAT_SRC, WECHAT_OUT, GREEN),
        ('支付宝', ALIPAY_SRC, ALIPAY_OUT, BLUE),
    ]
    posters = [fit(Image.open(s).convert('RGB'), TH) for _, s, _, _ in rows]
    qrs = [fit(Image.open(o).convert('RGB'), TH) for _, _, o, _ in rows]

    label_w = 96
    arrow_w = 54
    left = PAD + label_w
    poster_w = max(p.width for p in posters)
    qr_w = max(q.width for q in qrs)
    body_w = poster_w + arrow_w + qr_w
    W = PAD * 2 + label_w + body_w
    W = max(W, 980)
    head_h = 132
    row_h = 52 + TH
    H = head_h + row_h * 2 + PAD + 8

    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)

    d.text((PAD, 28), '收款码处理前后对比', font=font(30, True), fill=TEXT)
    d.text((PAD, 68), '软件「关于」面板里用的收款码，是从这两张海报里裁出来的',
           font=font(15), fill=DIM)

    poster_center = left + poster_w // 2
    qr_center = left + poster_w + arrow_w + qr_w // 2

    d.text((poster_center, head_h - 26), '原始海报', font=font(15, True), fill=DIM,
           anchor='mm')
    d.text((qr_center, head_h - 26), '裁切成品（已补足标准静区）', font=font(15, True),
           fill=DIM, anchor='mm')

    y = head_h
    for i, (name, _, _, color) in enumerate(rows):
        cy = y + row_h // 2

        # 左侧色块标签
        rounded(d, [PAD, cy - 46, PAD + label_w - 16, cy + 46], 14, color)
        d.text((PAD + (label_w - 16) / 2, cy), name, font=font(20, True),
               fill=(255, 255, 255), anchor='mm')

        # 原海报（带浅色底衬，跟白底海报区分开）
        p = posters[i]
        px = poster_center - p.width // 2
        py = y + 52
        rounded(d, [px - 6, py - 6, px + p.width + 6, py + p.height + 6], 10,
                CARD, outline=LINE)
        im.paste(p, (px, py))

        # 箭头
        ax0 = left + poster_w + 10
        ax1 = ax0 + arrow_w - 20
        d.line([ax0, cy, ax1, cy], fill=(150, 158, 172), width=3)
        d.polygon([(ax1 + 1, cy - 8), (ax1 + 14, cy), (ax1 + 1, cy + 8)],
                  fill=(150, 158, 172))

        # 成品
        q = qrs[i]
        qx = qr_center - q.width // 2
        rounded(d, [qx - 6, py - 6, qx + q.width + 6, py + q.height + 6], 10,
                CARD, outline=LINE)
        im.paste(q, (qx, py))

        y += row_h

    out = os.path.join(ROOT, 'dist', '_uicheck', '收款码对比-1.2.19.png')
    im.save(out)
    print('[OK]', out, im.size)
    # 同时留一份原图缩略，供说明里引用
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
