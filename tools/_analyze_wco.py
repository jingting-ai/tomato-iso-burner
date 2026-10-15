# -*- coding: utf-8 -*-
"""量化截图右上角：WCO（窗口按钮叠层）到底覆盖了多大一块、有没有啃到对话框的圆角。"""
from PIL import Image

p = r'C:\Users\jingt\.workbuddy\clipboard-images\clipboard-2026-10-13T01-40-34-208Z-d26b56e3.png'
im = Image.open(p).convert('RGB')
W, H = im.size
px = im.load()
DPR = W / 1000.0
print('尺寸 %dx%d  DPR=%.3f  → CSS 宽 %.0f' % (W, H, DPR, W / DPR))

# ---- 1) 对话框水平范围（取 y=200，找 灰→白 的边界）----
y = 200
runs, cur = [], None
for x in range(W):
    c = px[x, y]
    whiteish = c[0] > 248 and c[1] > 248 and c[2] > 248
    if cur is None:
        cur = [x, x, whiteish]
    elif whiteish == cur[2]:
        cur[1] = x
    else:
        runs.append(tuple(cur)); cur = [x, x, whiteish]
runs.append(tuple(cur))
big = [r for r in runs if r[1] - r[0] > 30]
print('\n--- y=%d 横向分段（宽>30px）---' % y)
for a, b, w in big:
    print('  x %4d..%4d (CSS %4d..%4d) %s' % (a, b, round(a / DPR), round(b / DPR), '白' if w else '非白'))

# ---- 2) 右侧纵向：白区向下延伸到哪里 ----
print('\n--- 右侧逐列白色延伸深度（从窗口顶往下）---')
for cx in (1600, 1660, 1720, 1745):
    col = []
    for yy in range(0, 140, 4):
        c = px[cx, yy]
        col.append((yy, 'W' if (c[0] > 250 and c[1] > 250 and c[2] > 250) else '.'))
    s = ''.join(t[1] for t in col)
    first_dot = next((t[0] for t in col if t[1] == '.'), None)
    print('  x=%4d (CSS %4d): %s  首个非白 y=%s (CSS %.1f)'
          % (cx, round(cx / DPR), s, first_dot, (first_dot or 0) / DPR))

# ---- 3) 对话框右上角有没有被 WCO 啃掉：扫描 y=40..120 的右侧 ----
print('\n--- y=45..120 右侧取样（对话框右缘应≈1575）---')
for yy in (45, 60, 80, 100, 120):
    row = []
    for cx in (1500, 1530, 1560, 1575, 1590, 1620, 1700):
        row.append((cx, px[cx, yy]))
    print('  y=%3d:' % yy, ' '.join('%d:%s' % (cx, c) for cx, c in row))

# ---- 4) 顶部白区左边界 ----
print('\n--- 白区左边界（逐行）---')
for yy in (4, 12, 20, 30, 40, 55, 70, 90, 110):
    edge = None
    for cx in range(W - 1, 1000, -1):
        c = px[cx, yy]
        if not (c[0] > 250 and c[1] > 250 and c[2] > 250):
            edge = cx
            break
    print('  y=%3d (CSS %5.1f) 最右非白 x=%s → 白区左界 CSS %.1f'
          % (yy, yy / DPR, edge, (edge + 1) / DPR if edge else 0))
