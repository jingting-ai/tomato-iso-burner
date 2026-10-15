# -*- coding: utf-8 -*-
"""离屏分析用户截图：找出「关闭时穿模」的具体位置与颜色。"""
from PIL import Image

p = r'C:\Users\jingt\.workbuddy\clipboard-images\clipboard-2026-10-13T01-40-34-208Z-d26b56e3.png'
im = Image.open(p).convert('RGB')
W, H = im.size
px = im.load()
print('尺寸', W, H)

# ---- 1) 中间列的颜色分段（自上而下所有边界）----
x = W // 2
print('\n--- x=%d 列颜色分段 ---' % x)
prev, start = None, 0
for y in range(H):
    c = px[x, y]
    if prev is not None and (abs(c[0] - prev[0]) + abs(c[1] - prev[1]) + abs(c[2] - prev[2])) > 16:
        print('  y %4d..%4d (%4d) %s' % (start, y - 1, y - start, prev))
        start = y
    prev = c
print('  y %4d..%4d (%4d) %s' % (start, H - 1, H - start, prev))

# ---- 2) 强横向边缘（整行像素突变）----
print('\n--- 强横向边缘（可能是“穿模”线条）---')
for y in range(1, H - 1):
    d = sum(1 for xx in range(0, W, 2) if px[xx, y] != px[xx, y - 1])
    if d > W * 0.30:
        print('  y=%4d 突变=%4d 样本=%s' % (y, d, [px[xx, y] for xx in (W // 6, W // 2, W * 5 // 6)]))

# ---- 3) 顶部条带 + 右上角色带 ----
print('\n--- 顶部条带 y=10 横向取样 ---')
for xx in (8, W // 4, W // 2, W * 3 // 4, W - 200, W - 150, W - 100, W - 60, W - 30, W - 8):
    print('  x=%4d %s' % (xx, px[xx, 10]))

print('\n--- 右上角逐列取样 y=15 ---')
for xx in range(W - 4, W - 320, -20):
    print('  x=%4d %s' % (xx, px[xx, 15]))

# ---- 4) 保存放大图 ----
im.crop((W - 340, 0, W, 70)).resize((340 * 3, 210), Image.LANCZOS).save('dist/_uicheck/_shot_tr.png')
im.crop((0, 395, W, 480)).resize((W, 85 * 3), Image.LANCZOS).save('dist/_uicheck/_shot_mid.png')
im.crop((0, 0, W, 44)).resize((W, 44 * 3), Image.LANCZOS).save('dist/_uicheck/_shot_top.png')
print('\n放大图已存 dist/_uicheck/_shot_tr.png / _shot_mid.png / _shot_top.png')
