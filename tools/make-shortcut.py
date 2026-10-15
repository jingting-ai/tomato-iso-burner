# -*- coding: utf-8 -*-
"""用 ctypes 直接调 COM 的 IShellLink 读写 .lnk。
本机没有 pywin32（win32com / pythoncom 都缺），而 PowerShell 的
New-Object -ComObject WScript.Shell 在这个沙箱里被拦，所以只能自己接 vtable。

用法：
    python tools/make-shortcut.py read  <lnk>
    python tools/make-shortcut.py write <lnk> <target.exe> [workdir] [icon] [desc]
"""
import ctypes
import os
import sys
from ctypes import POINTER, byref, c_ubyte, c_uint16, c_uint32, c_void_p, c_wchar_p

ole32 = ctypes.WinDLL('ole32')
ole32.CoInitialize(None)

CLSCTX_INPROC_SERVER = 1
S_OK = 0


class GUID(ctypes.Structure):
    _fields_ = [
        ('Data1', c_uint32),
        ('Data2', c_uint16),
        ('Data3', c_uint16),
        ('Data4', c_ubyte * 8),
    ]

    def __init__(self, s):
        super().__init__()
        ole32.CLSIDFromString(c_wchar_p(s), byref(self))


CLSID_ShellLink = GUID('{00021401-0000-0000-C000-000000000046}')
IID_IShellLinkW = GUID('{000214F9-0000-0000-C000-000000000046}')
IID_IPersistFile = GUID('{0000010b-0000-0000-C000-000000000046}')


def vt(ptr, index, restype, *argtypes):
    """取 COM 接口第 index 个虚函数（0..2 是 IUnknown）。"""
    table = ctypes.cast(ptr, POINTER(POINTER(c_void_p))).contents
    proto = ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)
    return proto(table[index])


def _qi(ptr, iid):
    out = c_void_p()
    hr = vt(ptr, 0, ctypes.c_long, ctypes.POINTER(GUID), ctypes.POINTER(c_void_p))(
        ptr, byref(iid), byref(out))
    if hr != S_OK:
        raise OSError('QueryInterface 失败 0x%08X' % (hr & 0xFFFFFFFF))
    return out


def create_shell_link():
    p = c_void_p()
    hr = ole32.CoCreateInstance(byref(CLSID_ShellLink), None, CLSCTX_INPROC_SERVER,
                                byref(IID_IShellLinkW), byref(p))
    if hr != S_OK:
        raise OSError('CoCreateInstance 失败 0x%08X' % (hr & 0xFFFFFFFF))
    return p


def set_path(link, path):
    vt(link, 20, ctypes.c_long, c_wchar_p)(link, path)          # IShellLinkW::SetPath


def set_workdir(link, d):
    vt(link, 9, ctypes.c_long, c_wchar_p)(link, d)              # SetWorkingDirectory


def set_args(link, a):
    vt(link, 11, ctypes.c_long, c_wchar_p)(link, a)             # SetArguments


def set_icon(link, path, idx=0):
    vt(link, 17, ctypes.c_long, c_wchar_p, ctypes.c_int)(link, path, idx)


def set_desc(link, d):
    vt(link, 7, ctypes.c_long, c_wchar_p)(link, d)              # SetDescription


def save(link, lnk_path):
    pf = _qi(link, IID_IPersistFile)
    hr = vt(pf, 6, ctypes.c_long, c_wchar_p, ctypes.c_int)(pf, lnk_path, 1)  # Save
    if hr != S_OK:
        raise OSError('IPersistFile::Save 失败 0x%08X' % (hr & 0xFFFFFFFF))


def load(link, lnk_path):
    pf = _qi(link, IID_IPersistFile)
    hr = vt(pf, 5, ctypes.c_long, c_wchar_p, ctypes.c_int)(pf, lnk_path, 0)  # Load
    if hr != S_OK:
        raise OSError('IPersistFile::Load 失败 0x%08X' % (hr & 0xFFFFFFFF))


def get_path(link):
    buf = ctypes.create_unicode_buffer(1024)
    find = ctypes.c_void_p()          # WIN32_FIND_DATAW* 可为 NULL
    vt(link, 3, ctypes.c_long, c_wchar_p, ctypes.c_int,
       ctypes.c_void_p, ctypes.c_uint)(link, buf, 1024, find, 0)     # GetPath
    return buf.value


def get_workdir(link):
    buf = ctypes.create_unicode_buffer(1024)
    vt(link, 8, ctypes.c_long, c_wchar_p, ctypes.c_int)(link, buf, 1024)
    return buf.value


def do_write(lnk, target, workdir=None, icon=None, desc=None):
    lnk = os.path.abspath(lnk)
    target = os.path.abspath(target)
    workdir = workdir or os.path.dirname(target)
    os.makedirs(os.path.dirname(lnk), exist_ok=True)
    link = create_shell_link()
    set_path(link, target)
    set_workdir(link, workdir)
    set_icon(link, icon or target)
    set_desc(link, desc or os.path.basename(target))
    save(link, lnk)
    size = os.path.getsize(lnk)
    print('写出 %s  (%d B)' % (lnk, size))
    print('  target  = %s' % target)
    print('  workdir = %s' % workdir)
    return 0


def do_read(lnk):
    lnk = os.path.abspath(lnk)
    link = create_shell_link()
    load(link, lnk)
    print('%s  (%d B)' % (lnk, os.path.getsize(lnk)))
    print('  target  = %s  存在=%s' % (get_path(link), os.path.exists(get_path(link))))
    print('  workdir = %s' % get_workdir(link))
    return 0


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    mode = sys.argv[1]
    if mode == 'read':
        return do_read(sys.argv[2])
    if mode == 'write':
        return do_write(*sys.argv[2:7])
    print('未知模式: %s' % mode)
    return 2


if __name__ == '__main__':
    sys.exit(main())
