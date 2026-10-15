# -*- coding: utf-8 -*-
"""
把 tools/_readme_<版本>.txt 这类纯文本说明，写成「带 UTF-8 BOM + 全 CRLF」的成品文件。

为什么要 BOM + CRLF：这份说明是给 Windows 记事本看的。没有 BOM，记事本会按
ANSI(GBK) 打开，中文全成乱码；只有 LF 的话老版本记事本不换行。

用法：
    python tools/make-readme.py <源文件> <目标文件>
例：
    python tools/make-readme.py tools/_readme_1212.txt "E:/DoroBurner-1.2.12/使用说明-1.2.12.txt"
"""
import sys


def convert(src, dst):
    with open(src, "r", encoding="utf-8") as f:
        text = f.read()
    text = text.lstrip("\ufeff")
    # 先归一化成 LF，再统一成 CRLF，避免出现 \r\r\n
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
    data = b"\xef\xbb\xbf" + text.encode("utf-8")
    with open(dst, "wb") as f:
        f.write(data)
    return len(data)


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    n = convert(sys.argv[1], sys.argv[2])
    print("[OK] %s -> %s  (%d 字节, UTF-8 BOM + CRLF)" % (sys.argv[1], sys.argv[2], n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
