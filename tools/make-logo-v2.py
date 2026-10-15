# -*- coding: utf-8 -*-
"""
界面 logo v2：从生成图里裁出「Doro 抱着 U 盘」的主体，铺成正方形白底徽标。

用户 2026-10-13 的原话：「logo 重画一下，最好是 doro 抱着 u 盘，简单直接，白色的」

做法：
  1. 从四角 floodfill 近白背景 —— 只去掉「与画面边缘相连」的白，
     角色身上白色的卫衣、白 U 盘因此不会被误抠（不能用「全图近白即背景」的粗暴判据）；
  2. 取前景包围盒，向外留 6% 余量后裁成正方形；
  3. 等比缩到 256×256，压在纯白上（不做透明底，与 .logo 的圆角白瓷片样式一致）。

用法：
  python tools/make-logo-v2.py <源图> [输出png]
"""
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.join(
    ROOT, 'assets', 'gen',
    'Q_版卡通吉物插画_半身构图_主体居中_一个粉红色长发的小女_2026-10-13T13-56-10.png'
)
DEFAULT_DST = os.path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'app-logo.png')

SIZE = 256
MARGIN = 0.06          # 主体四周留白（占输出边长）
MARK = (255, 0, 255)   # floodfill 用的哨兵色，只用来算掩码
NEAR_WHITE = 32        # 「近白」容差


def foreground_bbox(im):
    ff = im.copy()
    w, h = ff.size
    for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        ImageDraw.floodfill(ff, xy, MARK, thresh=NEAR_WHITE)
    px = ff.load()
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            if px[x, y] != MARK:
                xs.append(x)
                ys.append(y)
    if not xs:
        return (0, 0, w, h)
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    dst = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_DST
    im = Image.open(src).convert('RGB')
    print('源：', src, im.size)

    box = foreground_bbox(im)
    print('前景包围盒：', box, '->', (box[2] - box[0], box[3] - box[1]))
    sub = im.crop(box)

    # 裁正方形：以长边为准，短边居中，再叠加留白
    side = max(sub.size)
    pad = int(side * MARGIN)
    canvas = Image.new('RGB', (side + pad * 2, side + pad * 2), (255, 255, 255))
    canvas.paste(sub, ((canvas.width - sub.width) // 2, (canvas.height - sub.height) // 2))

    out = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    out.save(dst)
    print('输出：', dst, out.size, os.path.getsize(dst), 'B')


main()
