# -*- coding: utf-8 -*-
"""把 AI 图标源图的「圆角方块底色边」整体重做一遍。

为什么要这一步：
  AI 出的图标底是浅色。「浅色底 → 白色圆角外」之间的抗锯齿带里，颜色深浅连续变化，
  floodfill 无论阈值取多少都会漏掉最外一层「比底色浅、又比白色深」的像素。
  这些残留像素贴在 alpha 边界上、min(RGB) > 238，会被 make-icon 的边缘亮边检查判为
  「图标边缘有一圈白边」（实测漏 40 个）。

做法：
  沿着「底色 base → 白色 white」这条直线做投影，求每个像素的插值系数 a：
      a = dot(p - base, white - base) / |white - base|²
  把像素投影回直线得到 proj：
      * 若 |p - proj| 很小 → 它是背景带上的像素（底色↔白的抗锯齿过渡）→
        输出成 新底色↔白 在同系数 a 下的插值（底色换了，抗锯齿保持平滑）
      * 若残差很大 → 它是前景（番茄 / U 盘 / 描边 / 浅灰插头）→ 原样保留

用法：
  python tools/_qicon_bg.py <源图> <输出图> [新底色RRGGBB]
"""
import sys
from PIL import Image, ImageDraw

RES_TOL = 20          # 残差小于它算「背景带」；银灰插头残差 46、白高光残差 0
FILL_TOL = 20         # floodfill 把底色渐变统一掉（白角与底色差 31.6，不会被吞）
SEED_XY = (512, 8)    # 方块顶边中点，必在底色上
NEW_BASE = (183, 208, 238)   # #B7D0EE 浅蓝：比深蓝浅得多，浅色任务栏上仍看得出边界


def hx(s):
    s = s.lstrip('#')
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def main():
    src_path, out_path = sys.argv[1], sys.argv[2]
    new_base = hx(sys.argv[3]) if len(sys.argv) > 3 else NEW_BASE

    im = Image.open(src_path).convert('RGB')
    w, h = im.size
    px = im.load()
    base = px[SEED_XY[0], SEED_XY[1]]
    if min(base) < 180:
        raise SystemExit('种子点 %s 取到的不是浅色底（%s），换个种子点' % (str(SEED_XY), str(base)))

    # 1) 底色渐变统一（不改动圆角外、不吞白角：白与底差 31.6 > FILL_TOL）
    ImageDraw.floodfill(im, SEED_XY, base, thresh=FILL_TOL)

    # 2) 沿 base→white 投影，按 a 在 new_base↔white 之间插值
    white = (255, 255, 255)
    dx, dy, dz = (white[i] - base[i] for i in range(3))
    dd = float(dx * dx + dy * dy + dz * dz)
    nb0, nb1, nb2 = new_base
    b0, b1, b2 = base
    tol2 = RES_TOL * RES_TOL
    changed = 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            a = ((r - b0) * dx + (g - b1) * dy + (b - b2) * dz) / dd
            if a <= 0.0:
                a = 0.0
            elif a >= 1.0:
                a = 1.0
            pr = b0 + a * dx
            pg = b1 + a * dy
            pb = b2 + a * dz
            dr = r - pr
            dg = g - pg
            db = b - pb
            if dr * dr + dg * dg + db * db < tol2:
                if a >= 0.5:
                    # 圆角外侧那半段直接给纯白：AI 的「白角」本身带浅蓝偏色（实测 (253,255,255)、
                    # (240,245,251)），不抹干净的话 make-icon 的 corner_radius 认不出白区 →
                    # 沿对角线一路走到底，量出 1748 这种假半径。
                    px[x, y] = (255, 255, 255)
                else:
                    px[x, y] = (int(nb0 + (white[0] - nb0) * a + 0.5),
                                int(nb1 + (white[1] - nb1) * a + 0.5),
                                int(nb2 + (white[2] - nb2) * a + 0.5))
                changed += 1

    im.save(out_path)
    print('底色 %s -> %s  背景带像素 %d  四角 %s %s %s %s'
          % (str(base), str(new_base), changed, px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]))
    print('->', out_path)


if __name__ == '__main__':
    main()
