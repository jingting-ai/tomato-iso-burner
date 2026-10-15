# -*- coding: utf-8 -*-
"""生成器补丁：Label 默认值 / IconFile 参数 / 文案改「还原」/ diskpart 格式化不带中文卷标。
用 chr(39)=单引号、chr(34)=双引号 规避嵌套转义。"""
p = 'tools/_gen_repair_ps1.py'
s = open(p, encoding='utf-8').read()

Q1, Q2 = chr(39), chr(34)  # ' 和 "
subs = []

subs.append((
    "'  番茄镜像刻录工具 —— U 盘急救修复（程序内调用版）',",
    "'  番茄镜像刻录工具 —— U 盘还原（程序内调用版）',",
))

# 参数块：Label 默认值 + 新增 IconFile
old_label = '"  [string]$Label = ' + Q1 + 'USB' + Q1 + ','
new_label = '\n'.join([
    '"  [string]$Label = ' + Q1 + '番茄U盘' + Q1 + '  # 卷标 = 「此电脑」里显示的 U 盘名字",',
    '"  # 写进 U 盘根目录的番茄图标（配合 autorun.inf，让「此电脑」里显示番茄 logo）",',
    '"  [string]$IconFile = ' + Q1 + Q1 + '",',
])
subs.append((old_label, new_label))

# 启动日志：修复 → 还原
old_start = '"Log-Step (' + Q1 + '修复脚本已启动（目标磁盘 #' + ' + $DiskNumber + ' + Q1 + '，文件系统 ' + Q1 + ' + $FileSystem + ' + Q1 + '）' + Q1 + ')",'
new_start = '"Log-Step (' + Q1 + '还原脚本已启动（目标磁盘 #' + ' + $DiskNumber + ' + Q1 + '，文件系统 ' + Q1 + ' + $FileSystem + ' + Q1 + '）' + Q1 + ')",'
subs.append((old_start, new_start))

# diskpart 格式化步骤：去掉中文卷标（diskpart 脚本只吃 ASCII，中文会变问号）
old_fmt = ('"  @{ n = ' + Q1 + '格式化' + Q1 + ';       a = @(' + Q1 + 'select partition 1' + Q1 +
           ', \\' + Q2 + 'format fs=$FileSystem quick label=$Label\\' + Q2 + '); '
           'b = @(' + Q1 + 'select partition 1' + Q1 + ', \\' + Q2 + 'format fs=$FileSystem quick\\' + Q2 + ') },",')
new_fmt = ('"  @{ n = ' + Q1 + '格式化' + Q1 + ';       a = @(' + Q1 + 'select partition 1' + Q1 +
           ', \\' + Q2 + 'format fs=$FileSystem quick\\' + Q2 + '); '
           'b = @(' + Q1 + 'select partition 1' + Q1 + ', \\' + Q2 + 'format fs=$FileSystem quick\\' + Q2 + ') },",')
subs.append((old_fmt, new_fmt))

# 完成日志：修复 → 还原
old_done = '"  Log-Step \\' + Q2 + '修复完成：磁盘 #$DiskNumber 现在是 $FileSystem 格式，盘符 $after，可以正常使用了。' + Q2 + '\'",'
new_done = '"  Log-Step \\' + Q2 + '还原完成：磁盘 #$DiskNumber 现在是 $FileSystem 格式，盘符 $after，可以正常使用了。' + Q2 + '\'",'
subs.append((old_done, new_done))

miss = 0
for a, b in subs:
    if a not in s:
        print('!! 未命中:', a[:80])
        miss += 1
        continue
    s = s.replace(a, b)

# ---- 在「结果」主分支前插入：设卷标（支持中文）+ 写图标/autorun.inf ----
# 目标（还原后的 PS 代码）里的一行：
anchor_target = '"if ($after -ne ' + Q1 + Q1 + ') {"'
idx = s.find(anchor_target)
if idx < 0:
    print('!! 未找到结果判断锚点')
    miss += 1
else:
    L = []
    L.append('"# 卷标与图标：还原完的 U 盘要「名字叫番茄U盘、图标是番茄」",')
    L.append('"# ⚠️ 卷标不能用 diskpart 的 format label= 设 —— 那个脚本文件只吃 ASCII，中文会变问号；",')
    L.append('"#    改用 Set-Volume（走 Unicode，中文没问题）。",')
    L.append('"if ($after -ne ' + Q1 + Q1 + ') {",')
    L.append('"  $vol = $after.Split(' + Q1 + ',' + Q1 + ')[0]",')
    L.append('"  try {",')
    L.append('"    Set-Volume -DriveLetter $vol -NewFileSystemLabel $Label -ErrorAction Stop",')
    L.append('"    Log-Step (\'   卷标已设为「\' + $Label + \'」\')",')
    L.append('"  } catch {",')
    L.append('"    Log @{ type = \'warn\'; message = ' + Q2 + '设置卷标失败：$($_.Exception.Message)' + Q2 + ' }",')
    L.append('"  }",')
    L.append('"  if ($IconFile -and (Test-Path $IconFile)) {",')
    L.append('"    $driveRoot = $vol + ' + Q1 + ':\\\\' + Q1 + '",')
    L.append('"    try {",')
    L.append('"      Copy-Item $IconFile (Join-Path $driveRoot ' + Q1 + 'tomato-usb.ico' + Q1 + ') -Force",')
    autorun = ('[autorun]' + chr(13) + chr(10) + 'icon=tomato-usb.ico' + chr(13) + chr(10))
    L.append('"      [System.IO.File]::WriteAllText((Join-Path $driveRoot ' + Q1 + 'autorun.inf' + Q1 +
             '), ' + Q2 + autorun.replace(chr(13), '{CR}').replace(chr(10), '{LF}') + Q2 +
             '.Replace(\'{CR}\', \\"`r\\").Replace(\'{LF}\', \\"`n\\"), [System.Text.Encoding]::ASCII)",')
    L.append('"      Log-Step \'   已写入番茄图标与 autorun.inf ——「此电脑」里这块 U 盘就是番茄 logo\'",')
    L.append('"    } catch {",')
    L.append('"      Log @{ type = \'warn\'; message = ' + Q2 + '写图标失败：$($_.Exception.Message)' + Q2 + ' }",')
    L.append('"    }",')
    L.append('"  }",')
    L.append('"}"')
    # addition 里的行要逐行包成 Python 字符串（L 的元素已经是生成器文件的行文本）
    s = s[:idx] + '\n'.join(L) + '\n' + s[idx + len(anchor_target):]

open(p, 'w', encoding='utf-8').write(s)
print('完成，未命中', miss)
