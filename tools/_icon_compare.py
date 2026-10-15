# -*- coding: utf-8 -*-
"""把一批系统图标候选拼成一张对照表，方便挑选。

用法：
    ICON_SRC=<候选目录> ICON_OUT=<输出png> ICON_TITLE=<标题> python tools/_icon_compare.py
不设环境变量时默认跑 assets/tomato-candidates（v1.2.35 出番茄图标时用的那批）。

⚠️ 这套清洗判据是照着「白角 + 满幅圆角方块」这种画法调的（本项目所有番茄候选都是）。
   换成别的画法（方块不满幅、或者角落不是白的）`pick_radius` 会量出荒唐值并直接报错，
   那时用 `TOMATO_ICON_RADIUS=<比例或像素>` 显式指定即可。

清洗逻辑**全部从 tools/make-icon.py 原样加载**，不在这里复制一份 ——
这套判据踩了很多坑才定下来（见 make-icon.py 里 watermark_mask 的注释），
抄一份出来迟早两边不一致。

唯一不同的地方：候选图的尺寸未知，水印框按比例算（右下角 45%~100% × 55%~100%），
而 make-icon.py 用的是在 1024 源图上实测的绝对框。
"""
import importlib.util
import os

from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.environ.get("ICON_SRC", os.path.join(ROOT, "assets", "tomato-candidates"))
OUT = os.environ.get("ICON_OUT", os.path.join(ROOT, "dist", "_uicheck", "repro", "番茄图标候选.png"))
TITLE = os.environ.get("ICON_TITLE", "番茄系统图标候选")

BIG = 216
ZOOMS = [(48, 3), (32, 5), (16, 9)]   # (原尺寸, 放大倍数)

# 手绘的候选（tools/_tomato_geo.py 出的那批）根本没有水印，跑清洗反而有害：
# 判据是「比局部背景亮 + b-r>15」，而银灰的 U 盘插头描边恰好 b-r≈18，
# 会被当成水印抹掉（实测一次 3022 个像素）。这种候选用 ICON_NO_CLEAN=1 跳过。
# （正式构建时对应的开关叫 TOMATO_ICON_NO_CLEAN，见 make-icon.py 的 build_master。
#   两边不要合并 —— 一个是批量比候选，一个是出正式图标，参数本来就该各自独立。）
NO_CLEAN = os.environ.get("ICON_NO_CLEAN") == "1"


def _load_make_icon():
    """把 make-icon.py 当模块加载（文件名带连字符，不能直接 import）。"""
    path = os.path.join(ROOT, "tools", "make-icon.py")
    spec = importlib.util.spec_from_file_location("tomato_make_icon", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


MIC = _load_make_icon()

FONT = "C:/Windows/Fonts/msyh.ttc"
def font(sz, bold=False):
    for p in (("C:/Windows/Fonts/msyhbd.ttc" if bold else FONT), FONT):
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            pass
    return ImageFont.load_default()

BG, INK, DIM = (255, 255, 255), (28, 32, 44), (128, 136, 150)


def discover():
    """目录里的 PNG 按文件名排序，依次标 A/B/C…，时间戳从文件名尾巴上取。"""
    out = []
    for i, fn in enumerate(sorted(f for f in os.listdir(SRC) if f.lower().endswith(".png"))):
        stamp = fn.rsplit("_", 1)[-1][:-4]
        out.append((chr(ord("A") + i), stamp[11:], fn))
    return out


CANDS = discover()


def build(fn, tag):
    im = Image.open(os.path.join(SRC, fn)).convert("RGB")
    w, h = im.size

    # 候选图尺寸未知 → 水印框按比例给
    box = (int(w * 0.55), int(h * 0.45), w, h)
    if NO_CLEAN:
        n = 0
    else:
        im, n = MIC.remove_watermark(im, box)

    r = MIC.pick_radius(im)
    alpha = MIC.tile_alpha(im, r)
    alpha = alpha.filter(ImageFilter.MinFilter(2 * MIC.ALPHA_INSET + 1))   # 内收量跟 make-icon.py 走
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.8))

    print(f"  {tag} 圆角半径 {r}  定向修补 {n} 个像素")
    rgba = im.convert("RGBA")
    rgba.putalpha(alpha)
    return rgba.resize((1024, 1024), Image.LANCZOS)


def flatten(tile, size):
    """贴到白底上预览（图标自带 alpha，白角已透明）。"""
    small = tile.resize((size, size), Image.LANCZOS)
    bg = Image.new("RGB", (size, size), (255, 255, 255))
    bg.paste(small, (0, 0), small)
    return bg


W = 900
PAD = 16
LABEL_W = 118
row_h = BIG + 34
board_h = 2 * 46 + 34
HEAD = 92          # 表头高度（两行说明 + 余量）

canvas = Image.new("RGB", (W, HEAD + len(CANDS) * row_h + board_h + PAD), BG)
d = ImageDraw.Draw(canvas)
# 表头分行写 —— 挤成一行时后面那截会被画布右边裁掉
d.text((PAD, 14), TITLE, font=font(20, True), fill=INK)
d.text((PAD, 44), "左边看设计，右边是它在任务栏 / 资源管理器里的真实观感", font=font(13), fill=DIM)
d.text((PAD, 63), "右边三栏是从 48/32/16 像素原样放大（NEAREST，没做平滑），你屏幕上看到的就是这个清晰度",
       font=font(13), fill=DIM)

data = []
print("处理候选图：")
for tag, t, fn in CANDS:
    tile = build(fn, tag)
    tile.save(os.path.join(os.path.dirname(OUT), f"_clean-{tag}.png"))   # 选中的那张直接当图标源图
    data.append((tag, t, tile))

y = HEAD
for tag, t, tile in data:
    d.text((PAD, y + 4), f"方案 {tag}", font=font(20, True), fill=INK)
    d.text((PAD, y + 32), t, font=font(13), fill=DIM)

    x = PAD + LABEL_W
    canvas.paste(flatten(tile, BIG), (x, y + 4))
    d.rectangle([x, y + 4, x + BIG - 1, y + 4 + BIG - 1], outline=(222, 226, 234))
    x += BIG + 22

    for size, z in ZOOMS:
        d.text((x, y + 4), f"{size}px", font=font(13, True), fill=INK)
        canvas.paste(flatten(tile, size * z).resize((size * z, size * z), Image.NEAREST), (x, y + 24))
        x += size * z + 20
    y += row_h

# ---- 任务栏模拟（图标自带 alpha，直接贴，能看出白角到底透不透）----
d.text((PAD, y + 2), "在任务栏上的样子（28px 实际尺寸，不做放大）", font=font(15, True), fill=INK)
y += 30
for bar_bg, bar_name in (((32, 34, 38), "深色任务栏"), ((242, 243, 245), "浅色任务栏")):
    d.rectangle([PAD, y, W - PAD, y + 40], fill=bar_bg)
    d.text((PAD + 10, y + 12), bar_name, font=font(13),
           fill=(255, 255, 255) if bar_bg[0] < 128 else (40, 44, 54))
    # 步长按画布宽度算 —— 候选超过 4 个时写死的 150 会把后面的挤出画布
    bx0 = PAD + 110
    step = max(56, (W - PAD - 6 - bx0) // len(data))
    bx = bx0
    for tag, t, tile in data:
        small = tile.resize((28, 28), Image.LANCZOS)
        canvas.paste(small, (bx, y + 6), small)
        d.text((bx + 32, y + 12), tag, font=font(13, True),
               fill=(255, 255, 255) if bar_bg[0] < 128 else (40, 44, 54))
        bx += step
    y += 46

os.makedirs(os.path.dirname(OUT), exist_ok=True)
canvas.save(OUT)
print("saved", OUT, canvas.size)
