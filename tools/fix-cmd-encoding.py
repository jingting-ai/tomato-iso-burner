# -*- coding: utf-8 -*-
"""把 .cmd 文件转换为 cmd.exe 可靠读取的编码三要素：
   1) 无 BOM      （有 BOM 时 cmd.exe 会把前几个字节当命令，报 '错诺"echo' 不是内部或外部命令）
   2) GBK (936)   （中文 Windows 控制台 ANSI 代码页；不要切 chcp 65001，反而乱码）
   3) CRLF 行尾   （cmd.exe 只认 CRLF，LF 会把一行拆成多条碎片命令）
用法: python fix-cmd-encoding.py <文件.cmd> [更多.cmd...]
"""
import sys
import io

def convert(path):
    with open(path, 'rb') as f:
        raw = f.read()
    # 按 UTF-8（兼容带/不带 BOM）解码，UTF-16 也兼容一下
    if raw.startswith(b'\xff\xfe') or raw.startswith(b'\xfe\xff'):
        text = raw.decode('utf-16')
    else:
        text = raw.decode('utf-8-sig')
    # 统一行尾为 LF 再转 CRLF，避免混用
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    out = text.replace('\n', '\r\n').encode('gbk')  # GBK，无 BOM
    with open(path, 'wb') as f:
        f.write(out)
    # 自检
    with open(path, 'rb') as f:
        chk = f.read()
    assert not chk.startswith(b'\xef\xbb\xbf'), '仍有 BOM!'
    assert b'\n' not in chk.replace(b'\r\n', b''), '存在非 CRLF 行尾!'
    chk.decode('gbk')  # 确认可被 GBK 解码
    print('OK  %s  %d bytes  (GBK / CRLF / no BOM)' % (path, len(out)))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for p in sys.argv[1:]:
        convert(p)
