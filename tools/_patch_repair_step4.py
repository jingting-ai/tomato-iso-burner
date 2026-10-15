# -*- coding: utf-8 -*-
"""把 repair.ps1 生成器的「步骤 ④」从「单脚本 + noerr」改成「每步单独一次 diskpart」。"""
import io, sys

P = 'tools/_gen_repair_ps1.py'
lines = open(P, encoding='utf-8').read().split('\n')

start = next(i for i, l in enumerate(lines) if '④ diskpart' in l)
end = next(i for i, l in enumerate(lines) if "percent = 92" in l and i > start)

NL = '\n'
new = [
    '"Log-Step \\"④ 重建分区表并格式化为 $FileSystem（每一步单独调用 diskpart）\\"",',
    '"# 大于 2 TB 的盘 MBR 装不下，改用 GPT；其余一律 MBR（兼容性最好）",',
    '"$convert = if ($target.Size -ge 2199023255552) { \'convert gpt\' } else { \'convert mbr\' }",',
    '"#",',
    '"# ★ 为什么每一步单独起一次 diskpart（2026-10-14 连着踩两次坑）：",',
    '"#   ① 一开始把命令堆在一个脚本里：第三条 online disk 报错，DiskPart【遇错即退】，",',
    '"#      后面的 clean / 建分区 / 格式化 全没跑；",',
    '"#   ② 改成每条带 noerr：结果 clean 直接拒收 noerr',
    '"#      （「为此命令指定的参数无效 … HELP CLEAN」），分区表还是没清掉。",',
    '"#   结论：不要在一个脚本里堆命令，也不要指望 noerr 对所有命令都通用。",',
    '"#         每一步单独调一次，谁失败只影响谁，还能针对失败的步骤换别的招。",',
    '"#",',
    '"# a = 正常做法；b = 失败时的备选做法（没有就留空数组）",',
    '"$dpSteps = @(",',
    '"  @{ n = \'清只读属性\';   a = @(\'attributes disk clear readonly\'); b = @() },",',
    '"  @{ n = \'联机\';         a = @(\'online disk\');                   b = @() },",',
    '"  @{ n = \'清除分区表\';   a = @(\'clean\');                         b = @(\'offline disk\', \'clean\', \'online disk\') },",',
    '"  @{ n = \'初始化分区表\'; a = @($convert);                        b = @() },",',
    '"  @{ n = \'新建主分区\';   a = @(\'create partition primary\');      b = @() },",',
    '"  @{ n = \'格式化\';       a = @(\'select partition 1\', \\"format fs=$FileSystem quick label=$Label\\"); b = @(\'select partition 1\', \\"format fs=$FileSystem quick\\") },",',
    '"  @{ n = \'分配盘符\';     a = @(\'select partition 1\', \'assign\');  b = @() }",',
    '")",',
    '"",',
    '"function Invoke-DpStep([string[]]$cmds) {",',
    '"  $lines = @(\\"select disk $DiskNumber\\") + $cmds + @(\'exit\')",',
    '"  $tmp = Join-Path $env:TEMP (\'tomato-dp-\' + [Guid]::NewGuid().ToString(\'N\') + \'.txt\')",',
    '"  [System.IO.File]::WriteAllText($tmp, (($lines -join \\"`r`n\\") + \\"`r`n\\"), [System.Text.Encoding]::ASCII)",',
    '"  $out = \'\'",',
    '"  try { $out = (& diskpart.exe /s $tmp 2>&1 | Out-String) }",',
    '"  catch { $out = \'调用 diskpart 失败：\' + $_.Exception.Message }",',
    '"  finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }",',
    '"  # DiskPart 出错不一定改退出码，靠关键字判断；成功信息里不会出现这些字",',
    '"  $bad = ($out -match \'(?i)(错误|失败|error|拒绝|无效|无法|不可用)\')",',
    '"  return @{ out = $out; bad = $bad }",',
    '"}",',
    '"",',
    '"# 先让系统重扫一遍（前面刚把盘头写零），再逐条执行",',
    '"Log-Step \'   正在让系统重新扫描磁盘…\'",',
    '"[void](Invoke-DpStep @(\'rescan\'))",',
    '"",',
    '"foreach ($st in $dpSteps) {",',
    '"  $r = Invoke-DpStep $st.a",',
    '"  if ($r.bad -and $st.b.Count -gt 0) {",',
    '"    Log-Step (\'   「\' + $st.n + \'」没成功，换一种方式再试一次…\')",',
    '"    $r = Invoke-DpStep $st.b",',
    '"  }",',
    '"  foreach ($ln in ($r.out -split \\"`r?`n\\")) {",',
    '"    $t = $ln.Trim()",',
    '"    # 掐掉每次都会重复的 DiskPart 开场白，日志才看得下去",',
    '"    if ($t -eq \'\') { continue }",',
    '"    if ($t -match \'^(Microsoft DiskPart|Copyright|在计算机上|DiskPart 正在扫描|DiskPart 已扫描完)\') { continue }",',
    '"    Log-Step (\'   [\' + $st.n + \'] \' + $t)",',
    '"  }",',
    '"  if ($r.bad) { Log @{ type = \'warn\'; message = \\"步骤「$($st.n)」没成功，继续后面的步骤…\\" } }",',
    '"  else { Log-Step (\'   ✓ \' + $st.n) }",',
    '"}",',
]

lines[start:end] = new
open(P, 'w', encoding='utf-8').write(NL.join(lines))
print('生成器已更新：步骤 ④ 改成每步单独调用 diskpart')
