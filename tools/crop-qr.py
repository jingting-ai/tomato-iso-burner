# -*- coding: utf-8 -*-
"""从收款码海报中裁出干净的二维码方块。

做法（不依赖 numpy）：
  1. 用「三通道同时很暗」判定黑色（排除蓝底/绿底这类在灰度上也很暗的背景色）；
  2. 形态学闭运算（MaxFilter -> MinFilter）把分散的码点连成一个实心方块；
  3. 缩小 4 倍后用 BFS 找最大连通块 —— 那就是二维码；
  4. 映射回原图尺寸，再用「原始黑掩码」在该区域内求精确外接框；
  5. 归一化成正方形，四周补齐标准静区（quiet zone），纯裁切不重采样，保证可扫。
"""
import os
import sys
from collections import deque
from PIL import Image, ImageChops, ImageFilter, ImageOps

CLOSE = 13          # 闭运算核，用来把码点连成块（模块宽约 10px）
DOWN = 4            # 连通块分析前的缩小倍数


def black_mask(im):
    """三通道同时 < 128 才算黑：绿底、蓝底这类「灰阶也很暗」的背景会被排除。"""
    r, g, b = im.split()
    tbl = [255 if v < 128 else 0 for v in range(256)]
    th = lambda ch: ch.point(tbl, mode='1')  # noqa: E731
    return ImageChops.logical_and(ImageChops.logical_and(th(r), th(g)), th(b))


def ink_mask(im):
    """「不是接近纯白」的像素 —— 黑码点、灰昵称、蓝/绿卡边都算。

    用来在向外扩静区时及时收手：只吃白，碰到任何带颜色的东西就停。
    """
    r, g, b = im.split()
    tbl = [255 if v < 232 else 0 for v in range(256)]
    th = lambda ch: ch.point(tbl, mode='1')  # noqa: E731
    return ImageChops.logical_or(ImageChops.logical_or(th(r), th(g)), th(b))


def largest_component_box(mask_l, w, h):
    """在缩小的掩码上找最大连通块，返回原图坐标下的外接框。"""
    sw, sh = max(1, w // DOWN), max(1, h // DOWN)
    small = mask_l.resize((sw, sh), Image.NEAREST).load()
    seen = bytearray(sw * sh)
    best = None
    best_n = 0
    for sy in range(sh):
        for sx in range(sw):
            i = sy * sw + sx
            if seen[i] or not small[sx, sy]:
                continue
            q = deque([(sx, sy)])
            seen[i] = 1
            n = 0
            x0 = x1 = sx
            y0 = y1 = sy
            while q:
                cx, cy = q.popleft()
                n += 1
                if cx < x0: x0 = cx
                if cx > x1: x1 = cx
                if cy < y0: y0 = cy
                if cy > y1: y1 = cy
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1),
                               (cx - 1, cy - 1), (cx + 1, cy - 1),
                               (cx - 1, cy + 1), (cx + 1, cy + 1)):
                    if 0 <= nx < sw and 0 <= ny < sh:
                        j = ny * sw + nx
                        if not seen[j] and small[nx, ny]:
                            seen[j] = 1
                            q.append((nx, ny))
            if n > best_n:
                best_n = n
                best = (x0, y0, x1, y1)
    if not best:
        return None
    pad = CLOSE // 2 + 1
    return (
        max(0, best[0] * DOWN - pad),
        max(0, best[1] * DOWN - pad),
        min(w, (best[2] + 1) * DOWN + pad),
        min(h, (best[3] + 1) * DOWN + pad),
    )


def precise_box(mask_l, box, w, h):
    """在给定区域内用未膨胀的黑掩码求精确外接框。"""
    sub = mask_l.crop(box)
    bb = sub.getbbox()
    if not bb:
        return None
    return (box[0] + bb[0], box[1] + bb[1], box[0] + bb[2], box[1] + bb[3])


def module_size(mask_l, box):
    """量出单个码点（module）的像素边长。

    利用左上角定位符（finder pattern）：它最上面一行是连续 7 个黑点，
    右侧紧邻 1 个白点分隔符，所以从 (x0, y0) 向右的连续黑游程恰好 = 7 个码点。
    """
    px = mask_l.load()
    x0, y0 = box[0], box[1]
    best = 0
    for dy in range(0, 5):
        y = y0 + dy
        n = 0
        x = x0
        while px[x, y]:
            n += 1
            x += 1
            if x >= mask_l.width:
                break
        best = max(best, n)
    return best / 7.0 if best else 0.0


def trim_margin(ink_l, qbox, quiet):
    """逐边向外扩张静区：扩到标准 4 个码点，但碰到任何非白像素就停手。

    检查范围取「最终可能出现的最宽/最高」范围（而非只对齐二维码本身），
    这样白色圆角卡片角落漏出来的底色也会被算作障碍而及时收手。
    贴着二维码的 3px 可能是抗锯齿灰边，先跳过不判。
    """
    px = ink_l.load()
    w, h = ink_l.size
    x0, y0, x1, y1 = qbox
    SKIP = 3
    ax, bx = max(0, x0 - quiet), min(w, x1 + quiet)
    ay, by = max(0, y0 - quiet), min(h, y1 + quiet)

    row_has_ink = lambda y: any(px[x, y] for x in range(ax, bx))     # noqa: E731
    col_has_ink = lambda x: any(px[x, y] for y in range(ay, by))     # noqa: E731

    top = max(0, y0 - SKIP + 1)
    for k in range(SKIP, quiet + 1):
        y = y0 - k
        if y < 0 or row_has_ink(y):
            break
        top = y

    bottom = min(h, y1 + SKIP - 1)
    for k in range(SKIP, quiet + 1):
        y = y1 + k - 1
        if y >= h or row_has_ink(y):
            break
        bottom = y + 1

    left = max(0, x0 - SKIP + 1)
    for k in range(SKIP, quiet + 1):
        x = x0 - k
        if x < 0 or col_has_ink(x):
            break
        left = x

    right = min(w, x1 + SKIP - 1)
    for k in range(SKIP, quiet + 1):
        x = x1 + k - 1
        if x >= w or col_has_ink(x):
            break
        right = x + 1

    return (left, top, right, bottom)


def process(path, out_path):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    m = black_mask(im).convert('L')
    ink = ink_mask(im).convert('L')
    closed = m.filter(ImageFilter.MaxFilter(CLOSE)).filter(ImageFilter.MinFilter(CLOSE))
    coarse = largest_component_box(closed, w, h)
    fine = precise_box(m, coarse, w, h)
    x0, y0, x1, y1 = fine
    mod = module_size(m, fine)
    quiet = int(round(mod * 4))
    print(f'{os.path.basename(path)}: {w}x{h}')
    print(f'  QR box={fine}  {x1 - x0}x{y1 - y0}  module≈{mod:.2f}px  静区={quiet}px')

    box = trim_margin(ink, fine, quiet)
    out = im.crop(box)
    # 原海报的白卡边缘不一定够宽（支付宝那张只有 2.2 个码点），
    # 这里用纯白补齐到标准 4 个码点静区 —— 只加白、不改码，扫起来更稳。
    pad = (
        max(0, quiet - (x0 - box[0])),
        max(0, quiet - (y0 - box[1])),
        max(0, quiet - (box[2] - x1)),
        max(0, quiet - (box[3] - y1))
    )
    if any(pad):
        out = ImageOps.expand(out, border=pad, fill=(255, 255, 255))
    # 归一化成正方形：二维码永远居中
    side = max(out.width, out.height)
    canvas = Image.new('RGB', (side, side), (255, 255, 255))
    canvas.paste(out, ((side - out.width) // 2, (side - out.height) // 2))
    canvas.save(out_path)
    print(f'  -> {os.path.basename(out_path)}  crop={box}  补齐静区={pad}  输出 {side}x{side}')
    return canvas.size


if __name__ == '__main__':
    wechat_src, alipay_src = sys.argv[1], sys.argv[2]
    dst_dir = sys.argv[3]
    os.makedirs(dst_dir, exist_ok=True)
    jobs = [
        ('wechat', wechat_src),
        ('alipay', alipay_src),
    ]
    for key, src in jobs:
        process(src, os.path.join(dst_dir, f'donate-{key}.png'))
