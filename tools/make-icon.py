# -*- coding: utf-8 -*-
"""生成应用图标：build/icon.ico（多尺寸）+ build/icon.png（1024）

用法：python tools/make-icon.py

**v1.2.35 起换了产品名**：产品从「Doro镜像刻录工具」改名成「番茄镜像刻录工具」，
图标不再画角色，改成一颗番茄 —— 符号更简单，缩到 16px 也不会糊。

**v1.2.36 起源图改成手绘的**：不再用 AI 出图（AI 理解的"扁平矢量"一定会叠立体高光、
柔和渐变和微阴影，缩到 32px 就剩一股素材站的味儿），改用 `tools/_tomato_geo.py`
用代码画的纯色几何番茄。当前源图 = **方案 A「番茄光盘」**
（银灰盘缘 + 红盘面 + 白中心孔 + 萼片，无脸）。
换源图后**必须**加 `TOMATO_ICON_NO_CLEAN=1`：手绘图没有水印，而清洗判据会命中
圆角弧线上的抗锯齿过渡（实测 95 个像素），扩散填充又把这些像素改亮，
修补后判据命中数反向涨到 433 —— 越"修"越脏。

为什么单独拆出来：
  界面里的 logo（顶栏 / 关于面板）**不用这张图** —— 用户要求界面内保持白底徽标。
  界面 logo 由 tools/make-logo-tomato.py 生成。本脚本只负责 **系统图标**：
  exe、安装包、任务栏、窗口、桌面/开始菜单快捷方式。

源图是**满幅**圆角方块（蓝底贴满画布、白只留在四个角），要过四道处理：

  1. **量圆角半径**：沿对角线找「白角 → 底色」的 50% 交叉点再换算。⚠️ 判据不能写死成
     「蓝得够不够」—— 低饱和深藏青的源图会一个像素都不命中，量出 800 这种荒唐值。
     真的量不出来就用 TOMATO_ICON_RADIUS 指定。
  2. **抹水印**：右下角压着一层近白色的「AI生成」字样，位置实测为 WM_BOX。
     ⚠️ 只对 AI 源图成立；手绘源图用 TOMATO_ICON_NO_CLEAN=1 整段跳过（见 build_master）。
  3. **圆角 alpha**：用几何圆角矩形刷出 alpha，白角连白角上的水印一并丢掉。
  4. **收边**：alpha 向内收几个像素再羽化。源图方块边缘是「白角 ↔ 底色」的抗锯齿过渡，
     只收 1px 会留下四千多个近白色像素，在四周显出一圈若有若无的亮边。
     `MinFilter` 只会啃**圆角附近**（那里的近邻有 alpha=0），边的中段一点不动 ——
     所以内收不会让方块整体变小，只是把四个角多圆一点。
     收 2px 时 PIL 画圆角弧线的栅格化毛刺还残留 2 个像素（距圆心 290.4，正好压在边界上），
     收到 3px 才彻底干净。
"""
import os
import struct

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 两个都可以用环境变量顶掉，方便拿候选图干跑一遍、不碰 build/ 里的正式图标：
#   TOMATO_ICON_SRC=<候选图> TOMATO_ICON_OUT=<临时目录> python tools/make-icon.py
OUT_DIR = os.environ.get('TOMATO_ICON_OUT') or os.path.join(ROOT, 'build')
SRC = os.environ.get('TOMATO_ICON_SRC') or os.path.join(ROOT, 'assets', 'app-icon-source.png')

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
MASTER = 1024               # 源图与 build/icon.png 的边长
WHITE = 245                 # 灰度 ≥ 它算白底
R_MIN, R_MAX = 0.08, 0.34   # 圆角半径的合理区间（占边长比例）
ALPHA_INSET = 3             # alpha 向内收的像素数（只啃圆角附近，边的中段不受影响）
RIM_TOL = 12                # 边缘亮边容差，见 main() 里的说明

# 圆角半径正常是量出来的。万一量不出来（源图不是「白角 + 满幅方块」这种画法），
# 就靠这个环境变量显式指定，值可以写比例（0.22）或像素（225）：
#   TOMATO_ICON_RADIUS=0.28 python tools/make-icon.py
RADIUS_ENV = 'TOMATO_ICON_RADIUS'

# 手绘源图（tools/_tomato_geo.py 出的那批）没有水印，清洗会误伤 ⇒ 置 1 跳过：
#   TOMATO_ICON_NO_CLEAN=1 python tools/make-icon.py
NO_CLEAN_ENV = 'TOMATO_ICON_NO_CLEAN'

# 右下角「AI生成」水印区域（在 1024×1024 源图上实测出来的近白像素外接框）
WM_BOX = (820, 815, 1024, 1024)
WM_LIFT, WM_BR = 12, 15     # 比局部背景亮多少算水印；b-r 至少还剩多少


# --------------------------------------------------------------------------
# 工具（tools/_icon_compare.py 也 import 这几个，别改成不兼容的签名）
# --------------------------------------------------------------------------
def diffusion_fill(im: Image.Image, mask: Image.Image, iters: int = 60,
                   radius: float = 1.1) -> Image.Image:
    """把 mask=255 的像素用邻域扩散出来的颜色填满（简易 inpaint）。

    每轮把整图高斯模糊一次，但**只往 mask 里的像素写回**，所以未遮罩的像素
    原样不动。反复迭代，边界外的好像素会一圈圈渗进遮罩区，收敛成平滑渐变 ——
    正好适合本图这种「平滑蓝渐变背景」。
    """
    work = im.copy()
    for _ in range(iters):
        work.paste(work.filter(ImageFilter.GaussianBlur(radius)), (0, 0), mask)
    return work


def corner_radius(im: Image.Image) -> tuple:
    """圆角半径：沿四条**对角线**找「白角 → 方块底色」的 50% 交叉点，再换算回半径。

    为什么不沿边量「第一个非白像素」：源图方块的四个角是**软过渡**（白↔底色之间一段
    渐变），沿边量到的是过渡的外沿，半径会量小一圈 —— 实测沿边 187、沿对角线换算 212。
    量小了 alpha 就比方块胖，边缘那截白被留在图里，在深色任务栏上就显出一圈白边。
    对角线上的边界到圆心的距离是 r - r/√2 = 0.2929r，所以 r = 对角距离 / 0.2929。

    ⚠️ **判据不能写死成「蓝得够不够」**（曾用 `b - r > 30`）：有的源图底色是低饱和深藏青
    （`assets/tomato-q-candidates` 里那张「番茄=U盘」实测 b-r 只有 28），一个像素都命中不了，
    对角线会一路走到第 235 步、换算出 802 这种荒唐值。
    现在分两趟：先按「近白」把**底色自举采样**出来（从白的外沿再往里 60px，那处必定是
    实心底色），再按「离底色比离白更近」找 50% 交叉点 —— 这对任何底色都成立，
    不依赖色相。

    底色取样点也跟着对角线走，右下角那条会被水印盖住 —— 取四值中位数即可。
    """
    w, h = im.size
    px = im.convert('RGB').load()
    K = 1 - 0.5 ** 0.5          # 0.29289
    runs = [(0, 0, 1, 1), (w - 1, 0, -1, 1), (0, h - 1, 1, -1), (w - 1, h - 1, -1, -1)]
    limit = min(w, h) // 2

    def near_white(c):
        return c[0] >= WHITE and c[1] >= WHITE and c[2] >= WHITE

    # 第一趟：白区的外沿（只用于自举底色，不参与报数）
    fringes = []
    for sx, sy, dx, dy in runs:
        n = 0
        while n < limit and near_white(px[sx + dx * n, sy + dy * n]):
            n += 1
        fringes.append(n)
    samples = []
    for (sx, sy, dx, dy), n in zip(runs, fringes):
        m = min(n + 60, limit - 1)
        samples.append(px[sx + dx * m, sy + dy * m])
    samples.sort()
    tile = samples[len(samples) // 2]

    def is_tile(c):
        return (sum((c[i] - tile[i]) ** 2 for i in range(3))
                < sum((c[i] - 255) ** 2 for i in range(3)))

    # 第二趟：50% 交叉点
    rs = []
    for sx, sy, dx, dy in runs:
        n = 0
        while n < limit and not is_tile(px[sx + dx * n, sy + dy * n]):
            n += 1
        rs.append(int(round(n / K)))
    rs.sort()
    return rs[len(rs) // 2], rs


def pick_radius(im: Image.Image) -> int:
    """定圆角半径：能量就量，量不出来就要求显式指定。

    量出来的值超出合理区间一律当"量歪了"，直接报错并提示怎么指定 —— 宁可停下，
    也不要拿一个荒唐的半径去刷 alpha（1600 的半径会把图标刷成一个圆饼）。
    """
    w, h = im.size
    override = os.environ.get(RADIUS_ENV)
    if override:
        v = float(override)
        r = int(round(v * w)) if v <= 1 else int(round(v))
        print('圆角半径 %d（%s=%s 指定，占边长 %.1f%%）' % (r, RADIUS_ENV, override, r / w * 100))
        return r
    r, all_r = corner_radius(im)
    lo, hi = int(R_MIN * w), int(R_MAX * w)
    if not (lo < r < hi):
        raise SystemExit(
            '圆角半径量出 %d（四边 %s），超出合理区间 (%d, %d)。\n'
            '源图多半不是「白角 + 满幅方块」这种画法 —— '
            '请用 %s=0.28 显式指定（也可以直接写像素，如 %s=290）。'
            % (r, all_r, lo, hi, RADIUS_ENV, RADIUS_ENV))
    print('圆角半径 %d（四边量得 %s，占边长 %.1f%%）' % (r, all_r, r / w * 100))
    return r


def watermark_mask(im: Image.Image, box: tuple = None) -> tuple:
    """找出右下角那层「AI生成」水印，返回 (mask 图, 像素数)。

    判据（默认在实测量出来的 WM_BOX 里找，也可以传别的 box —— tools/_icon_compare.py
    要对一批尺寸未知的候选图统一处理，就传一个按比例算出来的框）：
      ① `lum > 局部背景 + 12` —— 水印是**白色覆盖**，比它底下的蓝底亮。
      ② `b - r > 15` —— 白色覆盖只会把 b-r **按比例缩小**、不会抹平：
         50% 的白压在 (36,52,80) 上得到 (143,151,167)，b-r 仍是 24；而方块外那片
         白角的 b-r 是 0，被这条干净地排除。方块自身的深蓝 b-r≈44，但它的亮度
         不比局部背景亮，被 ① 排除。

    ⚠️ 试过但**不要再用**的判据（都栽过，记在这儿免得再走一遍）：
      ✗ 「灰度 140~230 + 低饱和」：蓝调会渗进水印，它并不"灰"，只抓到 88 个像素。
      ✗ 「比局部背景亮 + 5×5 邻域内没有黑像素」：蓝底自己亮度就 50~70，
        邻域无黑这条会把整块底图挡掉；把黑像素阈值放宽到 30，又反过来让 AI 出图的
        水平色带全部命中，一次遮掉 1 万多个像素、把右下角抹成一片。
      ✗ 「min(RGB) > 170 判近白」：只抓到字最亮的核心，字的淡淡外沿留下半个「AI」。
    """
    w, h = im.size
    bx0, by0, bx1, by1 = box or WM_BOX
    bx0, by0 = max(0, bx0), max(0, by0)
    bx1, by1 = min(bx1, w), min(by1, h)
    lum = im.convert('L')
    lp = lum.load()
    bp = lum.filter(ImageFilter.GaussianBlur(26)).load()
    px = im.load()

    mask = Image.new('L', (w, h), 0)
    mp = mask.load()
    n = 0
    for y in range(by0, by1):
        for x in range(bx0, bx1):
            if lp[x, y] <= bp[x, y] + WM_LIFT:
                continue
            r, _g, b = px[x, y]
            if b - r <= WM_BR:
                continue
            mp[x, y] = 255
            n += 1
    return mask, n


def remove_watermark(im: Image.Image, box: tuple = None) -> tuple:
    """抹掉压在方块上的水印，返回 (新图, 修补像素数)。"""
    x0, y0 = (box or WM_BOX)[0], (box or WM_BOX)[1]
    w, h = im.size
    mask, n = watermark_mask(im, box)
    if not n:
        return im, 0
    mask = mask.filter(ImageFilter.MaxFilter(5))     # 膨胀，把字的抗锯齿边一起吃掉

    # 预填：每列被遮掉的像素直接沿用**正上方那颗干净像素**的值。
    # 这样横向天然连续（等于复制了一整行），不会像「按列线性外推」那样因为相邻列
    # 斜率不同而留下高频接缝。水印纵向只有几十像素，竖直方向那点渐变靠扩散补齐。
    pre = im.copy()
    pp = pre.load()
    for x in range(x0, w):
        last = None
        for y in range(y0, h):
            if mask.getpixel((x, y)):
                if last is not None:
                    pp[x, y] = last
            else:
                last = pp[x, y]
    out = diffusion_fill(pre, mask, iters=120, radius=1.1)
    # 只把遮罩区结果贴回去 —— 其余像素一个都不许动
    return Image.composite(out, im, mask), n


def tile_alpha(im: Image.Image, radius: int = None) -> Image.Image:
    """几何圆角矩形的 alpha：满幅方块的轮廓就是它自己的外接框 + 圆角。

    radius 给 None 时才现量 —— tools/_icon_compare.py 会先把半径量好再传进来，
    免得同一张图量两遍（而且它那批候选里有的量不出来，必须走显式指定）。
    """
    r = pick_radius(im) if radius is None else radius
    w, h = im.size
    a = Image.new('L', (w, h), 0)
    ImageDraw.Draw(a).rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=255)
    return a


def build_master(radius: int = None) -> Image.Image:
    src = Image.open(SRC).convert('RGB')
    print('源图:', SRC, src.size)

    # 手绘源图（tools/_tomato_geo.py 出的那批）本来就没有水印，判据只会误伤：
    # 「比局部背景亮 + b-r>15」会命中圆角弧线上的抗锯齿过渡像素（实测 95 个），
    # 而扩散填充把这些像素改亮之后，判据命中数反而涨到 433 —— 越修越"脏"。
    # 手绘源图请加 TOMATO_ICON_NO_CLEAN=1。
    if os.environ.get(NO_CLEAN_ENV) == '1':
        print('去水印: 跳过（%s=1；已确认源图无水印，清洗判据反而会误伤浅色元素）' % NO_CLEAN_ENV)
    else:
        before = watermark_mask(src)[1]
        src, fixed = remove_watermark(src)
        after = watermark_mask(src)[1]
        print('去水印: 定向修补 %d 个像素；水印判据命中 %d → %d' % (fixed, before, after))
        if fixed == 0:
            # 不是所有源图都带水印（比如那把「番茄 = U 盘」的图就干干净净）。
            # 但判据本身失效也是这个现象，所以只在控制台提醒，让人去看预览图。
            print('  ⚠️ 一个像素都没补：要么这张源图本来没水印（正常），'
                  '要么判据失效了 —— 请打开预览图核对右下角。')
        # ⚠️ 下面这个数字只当诊断：补丁与周边的接缝、以及方块外的纯白角都会算进来，
        #    抹干净了也不会归零。真正的确认靠导出的预览 + 人工核对。
        assert after <= before, '水印越抹越多了（%d → %d）' % (before, after)

    alpha = tile_alpha(src, radius)
    alpha = alpha.filter(ImageFilter.MinFilter(2 * ALPHA_INSET + 1))
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.8))     # 羽化，消除硬齿

    # 轻微提饱和 / 加对比，再锐化 —— 源图是 AI 生成的，偏软
    rgb = ImageEnhance.Color(src).enhance(1.06)
    rgb = ImageEnhance.Contrast(rgb).enhance(1.03)
    rgb = rgb.filter(ImageFilter.UnsharpMask(radius=1.2, percent=88, threshold=2))

    icon = rgb.convert('RGBA')
    icon.putalpha(alpha)
    return icon


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    raw = Image.open(SRC).convert('RGB')
    w, h = raw.size
    r = pick_radius(raw)

    icon = build_master(r)

    # ---- 自检 ----
    a = icon.getchannel('A').load()
    px = icon.load()
    w, h = icon.size
    assert a[1, 1] == 0 and a[w - 2, 1] == 0 and a[1, h - 2] == 0 and a[w - 2, h - 2] == 0, \
        '四角没抠成透明'
    assert a[w // 2, 2] == 255, '顶边中点应该是实心（方块贴边）'
    print('四角 alpha: %d %d %d %d（都应为 0）' % (
        a[1, 1], a[w - 2, 1], a[1, h - 2], a[w - 2, h - 2]))

    # 边缘亮环：要防的是「源图方块的白角被 alpha 留在图里」，现象是 alpha 边界那一圈
    # 混进近白像素。所以只看**贴着 alpha 边界的 3px 窄带**（= 把 alpha==0 的区域向外
    # 膨胀 3px，再和 alpha>128 相交）。
    # ⚠️ 不能拿「整个外圈」去查 —— 满幅直角方块的源图里，亮银灰的 U 盘金属壳本来就
    #    落在画面外圈，那种源图会误报两万多个像素（实测 25400）而其实一点问题没有。
    # 阈值 238 而不是 245 —— 残边是抗锯齿的浅色，比纯白暗一点。
    # 留 12 的容差：PIL 画圆角弧线的栅格化会在切点附近多涂 1~2 个像素，而源图那里还是
    # 白角的抗锯齿浅色，怎么调内收量都甩不掉（只会在 275/276 之间挪）。1024 图上的
    # 两个像素是亚像素级的，肉眼不可见；而当初那个真 bug 是 **2467** 个像素 —— 差三个
    # 数量级，容差放在这里照样拦得住回归。
    av = icon.getchannel('A')
    outside = av.point(lambda v: 255 if v == 0 else 0)
    band = outside.filter(ImageFilter.MaxFilter(7)).point(lambda v: 255 if v else 0)
    band = ImageChops.multiply(band, av.point(lambda v: 255 if v > 128 else 0))
    bp = band.load()
    rim = [(x, y) for y in range(h) for x in range(w)
           if bp[x, y] and min(px[x, y][:3]) > 238]
    print('边缘 3px 带上的近白不透明像素: %d（应为 0，容差 %d）' % (len(rim), RIM_TOL))
    assert len(rim) <= RIM_TOL, \
        '方块边缘还留着亮边，共 %d 个像素（容差 %d），例：%s' % (len(rim), RIM_TOL, rim[:5])

    # ---- 导出 ----
    ico_path = os.path.join(OUT_DIR, 'icon.ico')
    icon.save(ico_path, format='ICO', sizes=ICO_SIZES)
    png_path = os.path.join(OUT_DIR, 'icon.png')
    icon.resize((MASTER, MASTER), Image.LANCZOS).save(png_path, optimize=True)
    print('输出:', ico_path, '%.1f KB' % (os.path.getsize(ico_path) / 1024))
    print('输出:', png_path, '%.1f KB' % (os.path.getsize(png_path) / 1024))

    with open(ico_path, 'rb') as f:
        count = struct.unpack('<H', f.read(6)[4:6])[0]
        entries = []
        for _ in range(count):
            b = f.read(16)
            iw, ih = b[0] or 256, b[1] or 256
            bpp = struct.unpack('<H', b[6:8])[0]
            size = struct.unpack('<I', b[8:12])[0]
            entries.append('%dx%d@%dbpp/%dB' % (iw, ih, bpp, size))
    print('ICO 内含', count, '个尺寸:', ' '.join(entries))
    assert count == len(ICO_SIZES), 'ICO 尺寸数不对'

    # ---- 预览：深浅两种任务栏底色下的实际观感 ----
    preview = os.path.join(ROOT, 'dist', '_icon_preview')
    os.makedirs(preview, exist_ok=True)
    show = [256, 48, 32, 16]
    pad = 22
    row_h = 256 + pad * 2
    canvas = Image.new('RGB', (max(560, sum(s + pad * 2 for s in show)), row_h * 2),
                       (243, 244, 246))
    ImageDraw.Draw(canvas).rectangle([0, row_h, canvas.width, row_h * 2], fill=(32, 33, 36))
    for row, bg in enumerate([(243, 244, 246), (32, 33, 36)]):
        x = pad
        for s in show:
            tile = Image.new('RGBA', (s + pad * 2, s + pad * 2), bg + (255,))
            tile.alpha_composite(icon.resize((s, s), Image.LANCZOS), (pad, pad))
            canvas.paste(tile.convert('RGB'), (x, pad + row * row_h))
            x += s + pad * 2
    canvas.save(os.path.join(preview, 'sizes.png'))
    print('预览:', os.path.join(preview, 'sizes.png'))


if __name__ == '__main__':
    main()
