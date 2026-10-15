# -*- coding: utf-8 -*-
"""界面 logo 源图的公共处理：去噪、去水印、算裁切框。

**只服务于 tools/make-logo.py（界面里的白底头像）**，用于顶栏 38px 与
「关于」面板 46px 两处。

v1.2.27 起系统图标（exe / 安装包 / 任务栏 / 窗口 / 快捷方式）已经改用另一张图
（assets/app-icon-source.png，蓝底「Doro镜像刻录」风格），由 tools/make-icon.py
独立处理 —— 两边不再共用裁切框，改这个文件不会影响系统图标。

裁切框是怎么来的（2026-10-12 重新量过）：

  源图 960×960，画面内容（非白像素，已排除右下角水印）的外接框是
  (13, 171) → (839, 959)，即 **827 宽 × 789 高**。

  旧裁切框 (22, 168, 802, 948) 只有 780×780，比内容还窄 —— 结果是
  **左切 9px、右切 37px（右侧头发被切掉一截）、下切 11px，顶部只留 3px**，
  头像四周顶满、像被裁坏了。

  新裁切框边长 845，横向刚好把两侧头发都装进来（左右各留 8 / 11px），
  纵向**把富余量全部放到头顶**（上留 51px、下留 6px）。

  为什么纵向不做「上下均匀留白」：画面本身是**宽大于高**（827 > 789），
  塞进正方形必然多出 56px 纵向余量。均匀分的话身体那条截断线会悬在半空、
  下面空出一圈白，看着像浮起来；全部堆到头顶，身体就还是自然地切在底边上
  （与旧版一致的观感），只是头顶多了一点余量。

  背景补白：左边要补 5px、右边补 5px、下边补 6px（源图不够大），补的是纯白，
  与源图自带的白色背景无缝，看不出拼接痕迹。
"""
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CANDIDATES = [
    os.path.join(ROOT, 'assets', 'logo-source.jpg'),
    r"C:\Users\jingt\Downloads\DORO.JPG",
]
SRC = next((p for p in CANDIDATES if os.path.exists(p)), CANDIDATES[-1])

# 画面内容的外接框（量出来的，别手改）
CONTENT_BBOX = (13, 171, 839, 959)
CROP_SIDE = 845

# 相对于源图的裁切框；负数 / 超过 960 的部分由纯白补足
BOX = (5, 120, 850, 965)

# 右下角小红书水印（该区域经扫描确认不含人物内容）
WATERMARK = (700, 880)


def load_source(white_cut: int = 242) -> Image.Image:
    """读源图：把接近白的 JPEG 噪点压成纯白，并涂掉右下角水印。

    `white_cut` 是「算作白」的阈值；界面 logo 是白底，通常调大到 242，
    避免把描边的抗锯齿灰边也吃进去。

    注意：**这个源图只服务于界面里的 logo（tools/make-logo.py）**。
    系统图标（exe / 安装包 / 任务栏）从 v1.2.27 起换成 assets/app-icon-source.png，
    由 tools/make-icon.py 独立处理，两者不再共用任何东西。
    """
    im = Image.open(SRC).convert('RGB')
    w, h = im.size
    px = im.load()

    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r >= white_cut and g >= white_cut and b >= white_cut:
                px[x, y] = (255, 255, 255)

    wx, wy = WATERMARK
    for y in range(wy, h):
        for x in range(wx, w):
            px[x, y] = (255, 255, 255)

    return im


def head_crop(im: Image.Image) -> Image.Image:
    """按 BOX 裁出正方形头像，越界处用纯白补齐（源图不够大的边）。"""
    x0, y0, x1, y1 = BOX
    canvas = Image.new('RGB', (CROP_SIDE, CROP_SIDE), (255, 255, 255))
    # 目标画布左上角对应源图的 (x0, y0)；把源图里可见的那部分贴到正确位置
    src_box = (max(0, x0), max(0, y0), min(im.width, x1), min(im.height, y1))
    piece = im.crop(src_box)
    canvas.paste(piece, (src_box[0] - x0, src_box[1] - y0))
    return canvas


if __name__ == '__main__':
    src = load_source()
    crop = head_crop(src)
    print('源图:', SRC, src.size)
    print('裁切框:', BOX, '→', crop.size)
    print('内容外接框:', CONTENT_BBOX)
    print('四周留白: 左 %d 上 %d 右 %d 下 %d' % (
        CONTENT_BBOX[0] - BOX[0],
        CONTENT_BBOX[1] - BOX[1],
        BOX[2] - CONTENT_BBOX[2],
        BOX[3] - CONTENT_BBOX[3],
    ))
