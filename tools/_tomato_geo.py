# -*- coding: utf-8 -*-
"""手绘几何番茄图标候选（第五轮：形状先立住，再谈语义）。

前几轮的两个教训：
  1. AI 出图会叠高光渐变，16px 糊成一团 → 改手绘几何
  2. 手绘的「番茄」其实只是个正圆 + 三根小苗，读不出番茄
     （🍅 的结构是「红果 + 五片张开压肩的萼片」，这轮照它重画）

语义上，用户指出这是**镜像刻录**工具，所以四条线都要有：
  镜像 → 光盘（盘面 + 中心孔 + 环形纹路）
  刻录 → 火苗
  写入 → 向下箭头
  介质 → U 盘

候选：
  A 番茄光盘      红盘面 + 一圈白环 + 白中心孔 + 萼片（既是光盘也是番茄）
  B 光盘纹路番茄  红盘面 + 两圈白环 + 白中心孔 + 萼片（纹路更密，更像光盘）
  C 烧录番茄      番茄 + 顶上火苗（刻录 = 烧录）
  D 烧盘番茄      光盘 + 白心 + 火苗（镜像 + 刻录合成一个形体）
  E 番茄 U 盘     番茄 + 银色 USB 插头
  F 番茄 U 盘+脸  番茄 + 圆点脸 + USB 插头（最可爱）
  G 向下写入箭头  番茄 + 白色向下箭头

⚠️ 这批图没有水印，比对时用 ICON_NO_CLEAN=1 跳过清洗（见 _icon_compare.py 说明）。

产出 assets/tomato-geo-candidates/，再走 tools/_icon_compare.py 出对比表。
"""
import math
import os
import shutil

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(ROOT, "assets", "tomato-geo-candidates")

S, SS = 1024, 4
W = S * SS
CX = S // 2
DAY = "2026-10-13T"

TILE = (27, 58, 107)
RED = (226, 58, 44)
GREEN = (76, 176, 84)
GREEN_D = (52, 132, 60)
WHITE = (255, 255, 255)
GREY = (206, 211, 219)
GREY_D = (150, 155, 162)
INK = (30, 36, 50)
ORANGE = (246, 146, 30)
YELLOW = (255, 205, 60)

R_CORNER = int(0.225 * S)
SQUASH = 0.94          # 番茄比正圆略扁


def P(v):
    return int(round(v * SS))


def canvas():
    im = Image.new("RGB", (W, W), WHITE)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, W - 1, W - 1], radius=P(R_CORNER), fill=TILE)
    return im, d


def ring(d, cy, r, w, cx=None, fill=WHITE):
    """光盘纹路：一圈等宽的白环。"""
    cx = CX if cx is None else cx
    d.ellipse([P(cx - r), P(cy - r), P(cx + r), P(cy + r)], outline=fill, width=P(w))


def hole(d, cy, r, cx=None, fill=WHITE):
    cx = CX if cx is None else cx
    d.ellipse([P(cx - r), P(cy - r), P(cx + r), P(cy + r)], fill=fill)


def calyx(d, cx, oy, L):
    """番茄萼片：五片叶从一个轴心向外张开、压在肩头 —— 🍅 就是这个结构。

    早先画成「三根竖直的小苗」，缩到 32px 就像头上长草；后来改成放射五片，
    但轴心放在果顶之外，五片全飘在红果上方，像顶绿帽子。
    现在把轴心压进果实里（`tomato` 里 +r*0.30），叶片才会**躺在肩上**。
    """
    for a, ln in ((0, 1.18), (-38, 1.00), (38, 1.00), (-74, 0.80), (74, 0.80)):
        ang = math.radians(-90 + a)
        ln = L * ln
        tip = (cx + ln * math.cos(ang), oy + ln * math.sin(ang))
        nx, ny = -math.sin(ang), math.cos(ang)
        wd = L * 0.44
        b1 = (cx + nx * wd, oy + ny * wd)
        b2 = (cx - nx * wd, oy - ny * wd)
        d.polygon([(P(b1[0]), P(b1[1])), (P(tip[0]), P(tip[1])), (P(b2[0]), P(b2[1]))],
                  fill=GREEN_D if a == 0 else GREEN)


def tomato(d, cy=556, r=310):
    top = cy - r * SQUASH
    d.ellipse([P(CX - r), P(top), P(CX + r), P(cy + r * SQUASH)], fill=RED)
    calyx(d, CX, top + r * 0.30, r * 0.46)


def face(d, cy=556, r=310, cx=None):
    """Q 版表情：大眼 + 高光 + 弯嘴 + 腮红。腮红是「Q」的关键 —— 只靠眼睛和嘴
    缩到 32px 就只剩黑点，两团粉红能把可爱度撑住。"""
    cx = CX if cx is None else cx
    er = r * 0.17
    ey = cy - r * 0.10
    ex_off = r * 0.36
    cheeks = (238, 132, 122)
    for sign in (-1, 1):
        cxx, cyy = cx + sign * r * 0.62, cy + r * 0.24
        cr = r * 0.16
        d.ellipse([P(cxx - cr), P(cyy - cr), P(cxx + cr), P(cyy + cr)], fill=cheeks)
    for ex in (cx - ex_off, cx + ex_off):
        d.ellipse([P(ex - er), P(ey - er), P(ex + er), P(ey + er)], fill=INK)
        d.ellipse([P(ex + er * 0.06), P(ey - er * 0.80),
                   P(ex + er * 0.70), P(ey - er * 0.14)], fill=WHITE)
    mw, mt, mh = r * 0.24, cy + r * 0.16, r * 0.30
    d.arc([P(cx - mw), P(mt), P(cx + mw), P(mt + mh)], start=22, end=158,
          fill=INK, width=P(r * 0.065))


def usb_plug(d, top, half_w, bot, radius, hole_dx, hole_top, hole_bot, hole_w):
    d.rounded_rectangle([P(CX - half_w), P(top), P(CX + half_w), P(bot)],
                        radius=P(radius), fill=GREY)
    d.rectangle([P(CX - hole_dx - hole_w), P(hole_top), P(CX - hole_dx), P(hole_bot)], fill=GREY_D)
    d.rectangle([P(CX + hole_dx), P(hole_top), P(CX + hole_dx + hole_w), P(hole_bot)], fill=GREY_D)


# ---- 火苗：外橙内黄，两段平色，不用渐变 -------------------------------------
FLAME_PROF = [(1.00, 0.00), (1.05, 0.22), (0.90, 0.42), (0.60, 0.62),
              (0.36, 0.80), (0.13, 0.93), (0.00, 1.00)]


def _flame_pts(base_y, h, hw, scale, rise):
    """火苗轮廓。⚠️ 左右两边都要从 FLAME_PROF 算 —— 早先偷懒写成
    `CX - hw * f for f, y in reversed(right[:-1])`，把**已算好的 x 坐标**
    当成了宽度系数 f（635.9），顶点飞到 -74000，画出来是横贯画布的一条长杠。"""
    def yy(t):
        return base_y - rise * h - (1 - rise) * h * t * scale

    right = [(CX + hw * f * scale, yy(t)) for f, t in FLAME_PROF]
    left = [(CX - hw * f * scale, yy(t)) for f, t in reversed(FLAME_PROF[:-1])]
    return [(P(x), P(y)) for x, y in right + left]


def flame(d, base_y, h, hw):
    d.polygon(_flame_pts(base_y, h, hw, 1.00, 0.00), fill=ORANGE)
    d.polygon(_flame_pts(base_y, h, hw, 0.55, 0.14), fill=YELLOW)


# ---- A 番茄光盘（银灰盘缘 + 白环 + 白心孔 + 萼片）--------------------------
# 盘缘一定要银灰：白环压在红底上像"靶心"，银灰才一眼是光盘。
def plan_disc():
    im, d = canvas()
    R = 336
    d.ellipse([P(CX - R), P(548 - R), P(CX + R), P(548 + R)], fill=GREY)
    r2 = R - 42
    d.ellipse([P(CX - r2), P(548 - r2), P(CX + r2), P(548 + r2)], fill=RED)
    ring(d, 548, 196, 16)
    hole(d, 548, 92)
    calyx(d, CX, 548 - R + R * 0.30, R * 0.46)
    return im


# ---- B 番茄光盘 · 有脸（盘心改画脸，去掉中心孔）-----------------------------
def plan_disc_face():
    im, d = canvas()
    R = 340
    d.ellipse([P(CX - R), P(548 - R), P(CX + R), P(548 + R)], fill=GREY)
    r2 = R - 46
    d.ellipse([P(CX - r2), P(548 - r2), P(CX + r2), P(548 + r2)], fill=RED)
    ring(d, 548, 254, 14)
    face(d, cy=548, r=286)
    calyx(d, CX, 548 - R + R * 0.30, R * 0.46)
    return im


# ---- C 烧录番茄（萼片 + 顶上火苗，无脸）------------------------------------
def plan_flame():
    im, d = canvas()
    tomato(d, cy=650, r=272)
    flame(d, 458, 300, 128)
    return im


# ---- D 烧录番茄 · 有脸 -----------------------------------------------------
def plan_flame_face():
    im, d = canvas()
    tomato(d, cy=650, r=272)
    face(d, cy=650, r=272)
    flame(d, 458, 300, 128)
    return im


# ---- E 番茄 + 光盘（两个形体并排，番茄有脸）--------------------------------
def plan_two():
    im, d = canvas()
    tx, ty, tr = 380, 470, 252
    dx, dy, R = 738, 712, 184
    d.ellipse([P(dx - R), P(dy - R), P(dx + R), P(dy + R)], fill=GREY)
    r2 = R - 34
    d.ellipse([P(dx - r2), P(dy - r2), P(dx + r2), P(dy + r2)], fill=(238, 241, 246))
    hole(d, dy, 58, cx=dx, fill=GREY)
    d.ellipse([P(tx - tr), P(ty - tr * SQUASH), P(tx + tr), P(ty + tr * SQUASH)], fill=RED)
    calyx(d, tx, ty - tr * SQUASH + tr * 0.30, tr * 0.46)
    face(d, cy=ty, r=tr, cx=tx)
    return im


# ---- F 番茄 U 盘 + 圆点眼 + 腮红 -------------------------------------------
def plan_usb_face():
    im, d = canvas()
    tomato(d, cy=470, r=252)
    face(d, cy=470, r=252)
    usb_plug(d, top=680, half_w=150, bot=866, radius=42,
             hole_dx=30, hole_top=732, hole_bot=798, hole_w=58)
    return im


# ---- G 向下写入箭头 --------------------------------------------------------
def plan_arrow():
    im, d = canvas()
    tomato(d, r=300)
    d.rectangle([P(CX - 56), P(470), P(CX + 56), P(650)], fill=WHITE)
    d.polygon([(P(CX - 138), P(638)), (P(CX + 138), P(638)), (P(CX), P(800))], fill=WHITE)
    return im


PLANS = [("A", "00-04-01", plan_disc, "番茄光盘（符号版）"),
         ("B", "00-04-02", plan_disc_face, "番茄光盘 + 脸"),
         ("C", "00-04-03", plan_flame, "烧录番茄（符号版）"),
         ("D", "00-04-04", plan_flame_face, "烧录番茄 + 脸"),
         ("E", "00-04-05", plan_two, "番茄 + 光盘 + 脸"),
         ("F", "00-04-06", plan_usb_face, "番茄 U 盘 + 脸 + 腮红"),
         ("G", "00-04-07", plan_arrow, "向下写入箭头")]

if os.path.isdir(DST):
    shutil.rmtree(DST)
os.makedirs(DST)

for tag, t, fn, desc in PLANS:
    im = fn().resize((S, S), Image.LANCZOS)
    name = "%s_%s%s.png" % (tag, DAY, t)
    im.save(os.path.join(DST, name))
    print("%s  %-28s %s" % (tag, desc, name))

print("\n输出目录:", DST)

# ---- 界面 logo 专用源：白底重绘 F（不带圆角方块）-----------------------------
# 界面 logo 和系统图标是两条独立的线（用户 2026-10-13 明确要求过）：
#   · 系统图标（方案 A）= 深蓝圆角方块 + 番茄光盘 → assets/app-icon-source.png
#   · 界面 logo（方案 F）= 白底 + 番茄 U 盘 + 脸    → 本函数输出的白底图
# 为什么不在蓝底图上抠：方块的四个白角 b-r≈0，与番茄同为「非蓝」，
# 会把包围盒撑到整张图（实测 bbox 从 149 起，番茄只占 69% 宽），
# 且圆心会偏。白底重绘没有这个问题，形状参数与 F 完全一致。
LOGO_DST = os.path.join(ROOT, "assets", "_logo-src")


def plan_logo_f():
    im = Image.new("RGB", (W, W), WHITE)
    d = ImageDraw.Draw(im)
    tomato(d, cy=470, r=252)
    face(d, cy=470, r=252)
    usb_plug(d, top=680, half_w=150, bot=866, radius=42,
             hole_dx=30, hole_top=732, hole_bot=798, hole_w=58)
    return im


os.makedirs(LOGO_DST, exist_ok=True)
_logo = os.path.join(LOGO_DST, "f-white.png")
plan_logo_f().resize((S, S), Image.LANCZOS).save(_logo)
print("界面 logo 源:", _logo)
