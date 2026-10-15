# -*- coding: utf-8 -*-
"""生成界面里的 logo：src/renderer/src/assets/app-logo.png

用法：python tools/make-logo-tomato.py
换源图：TOMATO_LOGO_SRC=<图片路径> python tools/make-logo-tomato.py

界面 logo 和系统图标是**两条互不相干的线**（用户 2026-10-13 明确要求过，别再"统一"）：
  · 界面 logo（本脚本）：白底徽标，顶栏 38px、关于面板里也用它。当前用**方案 F**
    （番茄 U 盘 + 圆点眼 + 腮红），源图由 tools/_tomato_geo.py 输出到 assets/_logo-src/。
  · 系统图标（make-icon.py）：蓝底圆角方块，给 exe / 任务栏 / 快捷方式用。当前用**方案 A**
    （番茄光盘，无脸），源图是 assets/app-icon-source.png。

⛔ 界面 logo 的源图**不要**直接拿 assets/app-icon-source.png（蓝底方块那张）。
   方块四个角是白的，b-r≈0，与番茄同属「非蓝」，会把包围盒撑到整张图 ——
   实测 bbox 从 149 起算，番茄只占 69% 宽、圆心还偏。所以源图用白底重绘版。

两种源图都支持，靠四角颜色自动判别：
  · 白底（当前）：非白即前景。图形边缘是「浅红/浅灰 → 白」的过渡，贴到白底上天然干净，
    不需要收边。眼睛的白色高光会被判成背景留白，效果与白底一致。
  · 蓝底（旧 AI 那张）：非蓝即前景（方块底 b-r 有 32~44，番茄全身在 0 上下，一刀分开）。
    ⚠️ 抠完必须把 alpha 向内收 1px —— 番茄描边和蓝底之间那圈抗锯齿是"暗蓝"，b-r 落在
    中间地带，不收掉会在白底上显出一圈脏边。包围盒还要限制在中间 80%，避开四个白角。
"""
import os

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = (os.environ.get('TOMATO_LOGO_SRC')
       or os.path.join(ROOT, 'assets', '_logo-src', 'f-white.png'))
DST = os.path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'app-logo.png')

BLUE_BIAS = 25    # 蓝底源图：b - r 超过它算「蓝底」（方块底实测 32~44）
WHITE_T = 230     # 白底源图：min(RGB) 不小于它算「白底」
# ⚠️ AI 出的「纯白底」实际带一层极浅噪点（min≈235~250 会散落全图）→ 阈值必须压到 230
# 才量得准图形范围；调到 245 会把噪点算成前景，bbox 撑满整图、番茄被缩成一坨。
# ⚠️ 别用 250：AI 出的白底会带一层极浅的噪点/暗角（实测 245~250 之间散着约 5000 个像素，
#    全图每个角都有），阈值放到 250 会让 bbox 撑满整张画布，番茄被缩成一小坨。
#    245 时 bbox = (99,247,907,776)，正好是图形的真实范围。
SIZE = 256
MARGIN = 0.08     # 四周留白比例
INSET = 1         # 蓝底源图：alpha 向内收的像素数


def is_white_bg(im: Image.Image) -> bool:
    """四角 + 上下边中点，六个采样点里至少 5 个是纯白 → 判为白底。"""
    w, h = im.size
    px = im.load()
    probes = [(3, 3), (w - 4, 3), (3, h - 4), (w - 4, h - 4), (w // 2, 2), (2, h // 2)]
    n = sum(1 for x, y in probes if min(px[x, y]) >= WHITE_T)
    return n >= 5


def white_bg_alpha(im: Image.Image) -> Image.Image:
    """白底：非白即前景。不收边 —— 边缘是浅色过渡，贴白底看不出脏边。"""
    w, h = im.size
    px = im.load()
    a = Image.new('L', (w, h), 0)
    ap = a.load()
    for y in range(h):
        for x in range(w):
            if min(px[x, y]) < WHITE_T:
                ap[x, y] = 255
    return a


def blue_bg_alpha(im: Image.Image) -> Image.Image:
    """蓝底：非蓝即番茄，再向内收 1px 去掉抗锯齿的脏边。"""
    w, h = im.size
    px = im.load()
    a = Image.new('L', (w, h), 0)
    ap = a.load()
    for y in range(h):
        for x in range(w):
            r, _g, b = px[x, y]
            if b - r <= BLUE_BIAS:
                ap[x, y] = 255
    return a.filter(ImageFilter.MinFilter(2 * INSET + 1))


def main() -> None:
    src = Image.open(SRC).convert('RGB')
    w, h = src.size
    white = is_white_bg(src)
    print('源图:', SRC, src.size, '（%s底）' % ('白' if white else '蓝'))

    if white:
        alpha = white_bg_alpha(src)
        box = alpha.getbbox()
        assert box, '没找到前景（判据失效？）'
    else:
        alpha = blue_bg_alpha(src)
        # 只看中间 80%：方块四个角是白的（b-r≈0），不排掉的话包围盒会撑满整张图
        x0, y0, x1, y1 = int(w * .1), int(h * .1), int(w * .9), int(h * .9)
        inner = alpha.crop((x0, y0, x1, y1)).getbbox()
        assert inner, '没找到番茄（判据失效？）'
        box = (inner[0] + x0, inner[1] + y0, inner[2] + x0, inner[3] + y0)

    print('前景外接框:', box, '尺寸 %dx%d' % (box[2] - box[0], box[3] - box[1]))

    rgba = src.convert('RGBA')
    rgba.putalpha(alpha)
    rgba = rgba.crop(box)

    # 居中补成正方形（图形是竖长的：番茄 + 下方 U 盘插头）
    side = int(max(rgba.size) * (1 + MARGIN * 2))
    canvas = Image.new('RGBA', (side, side), (255, 255, 255, 255))
    canvas.paste(rgba, ((side - rgba.width) // 2, (side - rgba.height) // 2), rgba)
    out = canvas.convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
    out.save(DST, optimize=True)
    print('输出:', DST, '%.1f KB' % (os.path.getsize(DST) / 1024))

    # 自检：四角必须是纯白（白底徽标），中心必须不是白（有番茄）
    op = out.load()
    corners = [op[2, 2], op[SIZE - 3, 2], op[2, SIZE - 3], op[SIZE - 3, SIZE - 3]]
    print('四角 RGB:', corners)
    assert all(c == (255, 255, 255) for c in corners), '四角不是纯白'
    assert op[SIZE // 2, SIZE // 2] != (255, 255, 255), '正中间是白的，番茄没抠出来'

    # 预览：左白底原图 + 右按顶栏实际显示尺寸 38px
    preview = os.path.join(ROOT, 'dist', '_uicheck', 'repro', '_logo-preview.png')
    small = out.resize((38, 38), Image.LANCZOS)
    pv = Image.new('RGB', (SIZE + 90, SIZE), (255, 255, 255))
    pv.paste(out, (0, 0))
    pv.paste(small, (SIZE + 26, (SIZE - 38) // 2))
    pv.save(preview)
    print('预览:', preview)


if __name__ == '__main__':
    main()
