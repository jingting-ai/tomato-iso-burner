# 校验各 exe 里是否真的嵌入了我们的图标（纯字节比对，不依赖任何系统 API / Add-Type）
#
# 原理：rcedit 会把 .ico 里每个尺寸的图像原样写进 PE 的 RT_ICON 资源，
#       所以 build/icon.ico 中每个尺寸的图像数据（前 64 字节特征）应当能在 exe 中找到。
#       反过来，没换过图标的 exe（Electron 默认图标）一个都找不到 —— 正好用作对照。
#
# 用法：
#   python tools/verify-icon.py                 # 只查 dist 下的打包产物
#   python tools/verify-icon.py <exe> [<exe>…]  # 额外查指定的 exe（例如已部署的绿色版）
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICO = os.path.join(ROOT, 'build', 'icon.ico')
DIST = os.path.join(ROOT, 'dist')


def read_ico(path):
    b = open(path, 'rb').read()
    _, _, count = struct.unpack('<HHH', b[:6])
    items = []
    for i in range(count):
        e = b[6 + i * 16: 6 + (i + 1) * 16]
        w, h, _colors, _res, _planes, bpp, size, offset = struct.unpack('<BBBBHHII', e)
        items.append({
            'w': w or 256, 'h': h or 256, 'bpp': bpp,
            'size': size, 'data': b[offset:offset + size],
        })
    return items


def _pkg():
    try:
        import json
        with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def app_version():
    return _pkg().get('version', '')


def product_name():
    # 从 package.json 取，避免产品改名后这里又跟丢（v1.2.35 就踩过一次）
    return _pkg().get('productName') or '番茄镜像刻录工具'


def probe(label, exe_path):
    print('=== %s' % label)
    print('   ', exe_path)
    if not os.path.exists(exe_path):
        print('    (不存在，跳过)')
        print()
        return
    exe = open(exe_path, 'rb').read()
    print('    exe %d bytes' % len(exe))
    all_hit = True
    for ic in read_ico(ICO):
        at = exe.find(ic['data'][:64])
        kind = 'PNG' if ic['data'][:4] == b'\x89PNG' else 'BMP'
        ok = at >= 0
        all_hit = all_hit and ok
        print('    %3dx%-3d %-3s %6dB  ->  %s' % (
            ic['w'], ic['h'], kind, ic['size'],
            ('命中 @0x%X' % at) if ok else '未找到'))
    print('    结论:', '图标已嵌入 OK' if all_hit else '图标未嵌入 !!')
    print()


def main():
    if not os.path.exists(ICO):
        print('缺少 %s —— 请先运行：python tools/make-icon.py' % ICO)
        return 1
    v = app_version()
    name = product_name()
    print('图标源: %s' % ICO)
    print('版本: v%s   产品名: %s' % (v, name))
    print()

    # dist 下的打包产物（版本号 / 产品名都从 package.json 取）
    candidates = [
        ('绿色版 win-unpacked', os.path.join(DIST, 'win-unpacked', name + '.exe')),
        ('便携版 portable', os.path.join(DIST, '%s-%s-portable.exe' % (name, v))),
        ('安装包 nsis', os.path.join(DIST, '%s-%s-win-x64.exe' % (name, v))),
    ]
    for label, p in candidates:
        probe(label, p)

    # 命令行额外指定的 exe
    for p in sys.argv[1:]:
        probe('指定文件', p)

    return 0


if __name__ == '__main__':
    sys.exit(main())
