# -*- coding: utf-8 -*-
"""生成界面里的 logo：src/renderer/src/assets/app-logo.png

用法：python tools/make-logo.py

顶栏（38px）与「关于」面板（46px）里的头像，**白底**。

底色的一来一回（别再来回改了）：
  v1.2.18~1.2.22 白底 → v1.2.23 被改成灰底（我误以为要和系统图标统一）→
  **v1.2.27 用户明确纠正，改回白底**：
  「软件里面的 logo 不要动，还是白底就好了，是把外面的还有安装图标改成这个风格的」。

所以从 v1.2.27 起，两条线**彻底分开**：
  · 界面里：本脚本 —— 白底头像，来自 assets/logo-source.jpg；
  · 系统图标（exe / 安装包 / 任务栏 / 窗口 / 快捷方式）：
    tools/make-icon.py —— 蓝底「Doro镜像刻录」风格图，来自 assets/app-icon-source.png。
  两者不再共用任何东西，别再把它们「统一」到一起。

与系统图标的唯一共同点：**不加圆角 alpha 遮罩** —— 界面里圆角、描边、投影
由 CSS（.logo / .about-logo）负责，图片保持正方形白底即可。
"""
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from logo_common import head_crop, load_source  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'app-logo.png')

# 显示尺寸只有 38px（顶栏）/ 46px（关于面板），但高分屏会按 1.25~2 倍去取图，
# 256 足够。
SIZE = 256


def main() -> None:
    src = load_source(white_cut=238)
    crop = head_crop(src)
    out = crop.resize((SIZE, SIZE), Image.LANCZOS)
    print('源图 %s → 头像 %s → 界面 logo %dx%d' % (src.size, crop.size, SIZE, SIZE))

    os.makedirs(os.path.dirname(DST), exist_ok=True)
    out.save(DST, optimize=True)
    print('输出:', DST)
    print('尺寸:', out.size, ' 文件大小: %.1f KB' % (os.path.getsize(DST) / 1024))

    # 自检：① 四角必须是纯白底；② 中心区（人物）必须带彩色；
    # ③ 头顶 2px 必须是白底（留白到位，人物没贴顶）；
    # ④ 底边必须切在人物身上（裁切框下边只补了 6px 白）。
    px = out.load()

    def is_white(x, y):
        r, g, b = px[x, y][:3]
        return r >= 246 and g >= 246 and b >= 246

    def sat(x, y):
        r, g, b = px[x, y][:3]
        return max(r, g, b) - min(r, g, b)

    corners = [px[6, 6][:3], px[SIZE - 7, 6][:3],
               px[6, SIZE - 7][:3], px[SIZE - 7, SIZE - 7][:3]]
    white_ok = all(min(c) >= 246 for c in corners)
    q = SIZE // 4
    half = SIZE // 2
    mean_sat = sum(sat(x, y) for y in range(half - q, half + q)
                   for x in range(half - q, half + q)) / ((2 * q) ** 2)
    top_white = all(is_white(x, y) for x in range(SIZE) for y in (1, 2))
    bot_content = sum(1 for y in range(SIZE - 4, SIZE)
                      for x in range(SIZE) if not is_white(x, y))
    last_row = max(y for y in range(SIZE) for x in range(SIZE) if not is_white(x, y))

    print('四角 RGB:', corners, 'OK' if white_ok else '不是白底！')
    print('中心区平均饱和度: %.1f（应 >8，人物是彩色的）' % mean_sat)
    print('头顶 2px 全为白底: %s（应为 True）' % top_white)
    print('最底 4 行人物像素: %d（应 >0）；人物最低行 y=%d（应 ≥250）' % (bot_content, last_row))

    assert white_ok, '四角不是纯白底，白底逻辑没生效？'
    assert mean_sat > 8, '中心区几乎没有彩色，图里可能压根没有人物'
    assert top_white, '头顶贴边或顶部不是白底，留白不够'
    assert bot_content > 0, '底部没有人物内容，裁切框可能错位了'
    assert last_row >= SIZE - 6, '人物没有切在底边上（最低行 y=%d）' % last_row

    # 放大预览，便于人工核对
    preview = os.path.join(ROOT, 'dist', '_logo_preview')
    os.makedirs(preview, exist_ok=True)
    out.resize((512, 512), Image.LANCZOS).save(
        os.path.join(preview, 'final_preview.png'), optimize=True)


if __name__ == '__main__':
    main()
