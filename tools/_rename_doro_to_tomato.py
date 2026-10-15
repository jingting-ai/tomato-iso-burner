# -*- coding: utf-8 -*-
"""把产品名从「Doro镜像刻录工具」改成「番茄镜像刻录工具」。

三个必须小心的地方：
  1. **项目根目录仍叫 `E:\\开发\\Doro镜像刻录工具`，不能跟着改** —— 所有 tools 脚本都用绝对路径
     指着它。所以先把根路径替换成占位符，全部替换完再还原。
  2. **混了三种编码**：`.nsh`/`.ps1` 是 UTF-8 **带 BOM**（缺 BOM 会被 PowerShell/makensis 按
     GBK 读，出假语法错误）；`.cmd` 是 **GBK**（cmd.exe 用系统 ANSI 码页读）；其余是无 BOM 的
     UTF-8。必须按各自编码读出来再写回去。
  3. **替换顺序**：先长后短。先干掉 `DoroIsoBurner` 才不会在后面被 `Doro` 的兜底规则切成
     `番茄IsoBurner`。
"""
import io
import os

ROOT = r"E:\开发\Doro镜像刻录工具"
SENTINEL = "\u0000DOROROOT\u0000"

PROTECT = [
    r"E:\\开发\\Doro镜像刻录工具",
    r"E:\开发\Doro镜像刻录工具",
    "E:/开发/Doro镜像刻录工具",
]

RULES = [
    ("DoroIsoBurner", "TomatoIsoBurner"),
    ("doro-iso-burner", "tomato-iso-burner"),
    ("DoroBurner", "番茄镜像刻录工具"),
    ("Doro镜像刻录工具", "番茄镜像刻录工具"),
    ("Doro 镜像刻录工具", "番茄镜像刻录工具"),
    ("doro-logo", "app-logo"),
    ("doroLogo", "appLogo"),
    ("doro.theme", "tomato.theme"),
    ("DORO_", "TOMATO_"),
    ("doro-selftest", "tomato-selftest"),
    ("doro-repair", "tomato-repair"),
    ("Doro", "番茄"),
]

FILES = [
    "package.json", "package-lock.json", "electron-builder.yml", "README.md",
    "build/installer.nsh", "assets/burn.ps1",
    "src/shared/version.ts", "src/renderer/index.html",
    "src/renderer/src/App.tsx", "src/renderer/src/styles.css",
    "src/renderer/src/components/AboutWindow.tsx",
    "src/renderer/src/components/ErrorBoundary.tsx",
    "src/main/index.ts", "src/main/windowsBurn.ts",
    "tools/version.cjs", "tools/package-win.cjs", "tools/verify-asar.cjs",
    "tools/check-syntax.ps1", "tools/diagnose-disk.ps1", "tools/probe-volumes.ps1",
    "tools/repair-usb.ps1", "tools/repair-usb-auto.ps1", "tools/selftest-vhd.ps1",
    "tools/修复U盘.ps1", "tools/同步脚本到安装版.ps1",
    "tools/一键修复U盘.cmd", "tools/一键写盘自检.cmd", "tools/一键更新安装版.cmd",
    "tools/查看当前版本.cmd", "tools/更新Doro刻录工具到最新版.cmd",
    "tools/_deploy_cmds.py", "tools/_deploy_cmds_v2.py", "tools/_about-realapp.cjs",
    "tools/ui-gallery.cjs", "tools/ui-shot.cjs", "tools/ui-shot-preload.cjs",
]


def read(path):
    """返回 (文本, 编码, 是否带 BOM)。"""
    raw = open(path, "rb").read()
    if raw[:3] == b"\xef\xbb\xbf":
        return raw[3:].decode("utf-8"), "utf-8", True
    try:
        return raw.decode("utf-8"), "utf-8", False
    except UnicodeDecodeError:
        return raw.decode("gbk"), "gbk", False


def write(path, text, enc, bom):
    data = text.encode(enc)
    if bom:
        data = b"\xef\xbb\xbf" + data
    open(path, "wb").write(data)


def main():
    total = 0
    for rel in FILES:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            print(f"  跳过（不存在）{rel}")
            continue
        text, enc, bom = read(path)
        for p in PROTECT:
            text = text.replace(p, SENTINEL)
        n = 0
        for old, new in RULES:
            n += text.count(old)
            text = text.replace(old, new)
        text = text.replace(SENTINEL, PROTECT[1])
        if n:
            write(path, text, enc, bom)
            total += n
        print(f"  {n:4d} 处  {enc}{'+BOM' if bom else '     '}  {rel}")
    print(f"\n共替换 {total} 处")


main()
