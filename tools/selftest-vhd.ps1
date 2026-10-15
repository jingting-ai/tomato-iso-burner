<#
  番茄镜像刻录工具 —— 写盘链路自检（虚拟磁盘版 v2）

  目的：在【完全不碰你的 U 盘】的前提下，用虚拟磁盘（VHD）走一遍真实的写盘链路，
        验证 burn.ps1 在各种目标盘状态下都能正确工作。

  为什么要跑两个用例：
    用例 A：VHD 已格式化并分配了盘符  → 走「锁定并卸除卷」路径
    用例 B：VHD 有分区但没有盘符、Windows 未挂载（Linux 分区 / 分区表损坏的状态）
            → 这正是「刻录过一次 Linux ISO 的 U 盘」或「被写坏过的 U 盘」的样子。
              v1.2.0 及更早版本会在这里误判为「卷被占用」并中止刻录，
              v1.2.1 起应当直接写入并成功。

  需要管理员权限。VHD 建在 %TEMP%，用完自动删除。

  用法：
    powershell -ExecutionPolicy Bypass -File selftest-vhd.ps1
    powershell -ExecutionPolicy Bypass -File selftest-vhd.ps1 -ImageSizeMB 256 -Keep
#>
param(
  [int]$VhdSizeGB = 2,
  [int]$ImageSizeMB = 128,
  [switch]$Keep,
  [string]$BurnScript = ''
)

$ErrorActionPreference = 'Stop'

# 日志同时落盘，方便事后回看结果
$script:TomatoLogFile = if ($env:TOMATO_SELFTEST_LOG) { $env:TOMATO_SELFTEST_LOG } else { Join-Path $env:TEMP 'tomato-selftest-latest.log' }
try { if (Test-Path $script:TomatoLogFile) { Remove-Item $script:TomatoLogFile -Force -ErrorAction SilentlyContinue } } catch { }
function LogLine($t) { try { [string]$t | Out-File -Append -FilePath $script:TomatoLogFile -Encoding utf8 } catch { } }
LogLine "[$(Get-Date -Format s)] 番茄 Burn Self-Test v2 start"

function Say($msg, $color = 'Gray') {
  Write-Host $msg -ForegroundColor $color
  LogLine $msg
}

function IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Run-Diskpart([string]$scriptText) {
  $tmp = Join-Path $env:TEMP ("tomato-selftest-" + [Guid]::NewGuid().ToString('N') + ".txt")
  [System.IO.File]::WriteAllText($tmp, $scriptText, [System.Text.Encoding]::ASCII)
  try {
    return (& diskpart.exe /s $tmp 2>&1 | Out-String)
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TomatoSelfTestNative {
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
    IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr h);
  public const uint GENERIC_READ  = 0x80000000;
  public const uint FILE_SHARE_READ  = 0x00000001;
  public const uint FILE_SHARE_WRITE = 0x00000002;
  public const uint OPEN_EXISTING = 3;
}
"@

function Get-DeviceSha256([string]$devicePath, [long]$length, [int]$chunk = 4194304) {
  $h = [TomatoSelfTestNative]::CreateFile($devicePath,
    ([TomatoSelfTestNative]::GENERIC_READ),
    ([TomatoSelfTestNative]::FILE_SHARE_READ -bor [TomatoSelfTestNative]::FILE_SHARE_WRITE),
    [IntPtr]::Zero, [TomatoSelfTestNative]::OPEN_EXISTING, 0, [IntPtr]::Zero)
  if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr](-1)) {
    $ec = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "无法打开设备进行校验（错误码 $ec）"
  }
  try {
    $fs = New-Object System.IO.FileStream(
      (New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($h, $false)),
      [System.IO.FileAccess]::Read, $chunk, $false)
    [void]$fs.Seek(0, [System.IO.SeekOrigin]::Begin)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $buf = New-Object byte[] $chunk
    $read = 0L
    while ($read -lt $length) {
      $want = [math]::Min([long]$chunk, $length - $read)
      $r = $fs.Read($buf, 0, [int]$want)
      if ($r -le 0) { break }
      $sha.TransformBlock($buf, 0, $r, $null, 0) | Out-Null
      $read += $r
    }
    $sha.TransformFinalBlock($buf, 0, 0) | Out-Null
    $fs.Close()
    if ($read -ne $length) { throw "只读回 $read 字节，期望 $length 字节" }
    return ([System.BitConverter]::ToString($sha.Hash)).Replace('-', '').ToLower()
  } finally {
    try { [void][TomatoSelfTestNative]::CloseHandle($h) } catch { }
  }
}

# 生成确定性内容的测试镜像（用 Array.Copy 倍增 + 每块写入序号，秒级完成且各块可区分）
function New-TestImage([string]$imgPath, [int]$sizeMB) {
  $imgBytes = [int64]$sizeMB * 1MB
  $blk = New-Object byte[] (1MB)
  for ($i = 0; $i -lt 250; $i++) { $blk[$i] = (($i * 37 + 11) -band 0xff) }
  $filled = 250
  while ($filled -lt $blk.Length) {
    $n2 = [math]::Min($filled, $blk.Length - $filled)
    [Array]::Copy($blk, 0, $blk, $filled, $n2)
    $filled += $n2
  }
  $fsImg = [System.IO.File]::Create($imgPath)
  $remaining = $imgBytes
  $seed = 0
  while ($remaining -gt 0) {
    $n = [math]::Min([int64]$blk.Length, $remaining)
    $b = [System.BitConverter]::GetBytes([int]$seed)
    [Array]::Copy($b, 0, $blk, 0, 4)
    $fsImg.Write($blk, 0, [int]$n)
    $remaining -= $n
    $seed++
  }
  $fsImg.Close()
  return $imgBytes
}

# ---------------------------------------------------------------- 准备
Say ''
Say '========== 番茄 写盘链路自检（虚拟磁盘版 v2）==========' 'Cyan'

if (-not (IsAdmin)) {
  Say '错误：必须以【管理员身份】运行才能进行自检（虚拟磁盘需要管理员权限）。' 'Red'
  Say '最简单的办法：双击「一键写盘自检.cmd」，它会自动弹出 UAC 让你点「是」。' 'Yellow'
  exit 1
}

if (-not $BurnScript) {
  $cands = @(
    (Join-Path $PSScriptRoot '..\assets\burn.ps1'),
    (Join-Path $PSScriptRoot 'burn.ps1')
  )
  foreach ($c in $cands) { if (Test-Path $c) { $BurnScript = (Resolve-Path $c).Path; break } }
}
if (-not $BurnScript -or -not (Test-Path $BurnScript)) {
  Say "错误：找不到 burn.ps1。请用 -BurnScript 指定路径。" 'Red'
  exit 1
}
Say ("写盘脚本：{0}" -f $BurnScript)

# ---- 把 burn.ps1 的「函数 + Add-Type」原样加载进来（不执行主流程）----
#   数值边界自检要调用的 Get-EtaSeconds / HumanSize 就是 burn.ps1 里的真代码，
#   不是复制品 —— 否则自检本身可能在骗人。
$script:BurnText = [System.IO.File]::ReadAllText($BurnScript)
$marker    = '# ---------------------------------------------------------------- main'
$idx       = $script:BurnText.IndexOf($marker)
$startIdx  = $script:BurnText.IndexOf('$ErrorActionPreference')
if ($idx -lt 0 -or $startIdx -lt 0 -or $startIdx -ge $idx) {
  Say '错误：无法定位 burn.ps1 的结构标记，脚本结构可能已变化。' 'Red'
  exit 1
}
$LogFile    = Join-Path $env:TEMP 'tomato-selftest-prelude.jsonl'
$CancelFlag = ''
$Verify     = $false
$Wipe       = $false
$ChunkSize  = 1048576
$TotalBytes = 0
$ImagePath  = ''
$DevicePath = ''
try { Invoke-Expression $script:BurnText.Substring($startIdx, $idx - $startIdx) }
catch { Say ("错误：加载 burn.ps1 函数失败 —— {0}" -f $_.Exception.Message) 'Red'; exit 1 }

$stamp   = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$imgPath = Join-Path $env:TEMP ("tomato-selftest-$stamp.img")

$vhdList = New-Object System.Collections.ArrayList   # 需要清理的 VHD 路径

# ---- 生成测试镜像 ----
Say ''
Say ("[1/4] 生成测试镜像 {0} MB …" -f $ImageSizeMB)
$imgBytes = New-TestImage $imgPath $ImageSizeMB
$srcSha = (Get-FileHash $imgPath -Algorithm SHA256).Hash.ToLower()
Say ("      镜像 SHA256 = {0}" -f $srcSha) 'DarkGray'

$results = New-Object System.Collections.ArrayList

# ---- 数值边界自检（大镜像 Int32 溢出）----
#   背景：刻录大镜像（>2 GiB）时，若代码里出现 [int] 转换了超过 2147483647 的值，
#   PowerShell 会抛「值对于 Int32 太大或太小」并让整个刻录中断。
#   8 MB 的小镜像测不出来，必须拿 >2 GiB 的数直接算。
Say ''
Say '[1b/4] 数值边界自检（>2 GiB 运算不会中断刻录）…'
$boundaryFail = New-Object System.Collections.ArrayList
$bigNum = [int64]2306867200   # 2.3 GiB

function Check-Expr([string]$name, [scriptblock]$sb) {
  try { $null = & $sb; Say ("      ✔ {0}" -f $name) 'DarkGray' }
  catch { Say ("      ✘ {0} —— {1}" -f $name, $_.Exception.Message) 'Red'; [void]$boundaryFail.Add($name) }
}

# 与 burn.ps1 热路径一一对应
Check-Expr '校验循环取块 [int64]Min'      { [math]::Min([int64]1048576, [int64]$bigNum) }
Check-Expr '写盘循环扇区对齐 Ceiling'      { [int][math]::Ceiling(1048576 / 4096) * 4096 }
Check-Expr 'ETA 计算（极慢速度）'          { Get-EtaSeconds ([double]$bigNum) 0.5 }
Check-Expr 'ETA 计算（正常速度）'          { Get-EtaSeconds ([double]$bigNum) 41943040 }
Check-Expr '容量校验 [int64]Ceiling'       { [int64][math]::Ceiling($bigNum / 4096) * 4096 }
Check-Expr '人类可读容量'                  { HumanSize $bigNum }

# 静态检查：确认 burn.ps1 里这两处防溢出的写法没有被改回去
foreach ($needle in @('[int64]$ChunkSize', 'Get-EtaSeconds')) {
  if ($script:BurnText.Contains($needle)) { Say ("      ✔ 源码含防护写法 {0}" -f $needle) 'DarkGray' }
  else { Say ("      ✘ 源码缺少防护写法 {0}" -f $needle) 'Red'; [void]$boundaryFail.Add($needle) }
}

$boundaryPass = ($boundaryFail.Count -eq 0)
if ($boundaryPass) { Say '  ✔ 数值边界自检通过' 'Green' }
else { Say ("  ✘ 数值边界自检失败：{0}" -f ($boundaryFail -join '、')) 'Red' }

# ---- 单个用例 ----
function Run-Case([string]$title, [string]$vhdPath, [string]$diskpartSetup, [string]$expectDesc) {
  Say ''
  Say ("---------------- $title ----------------") 'Cyan'
  Say ("场景：$expectDesc") 'DarkGray'

  if (Test-Path $vhdPath) { Remove-Item $vhdPath -Force -ErrorAction SilentlyContinue }
  $before = @(Get-Disk -ErrorAction SilentlyContinue | ForEach-Object { $_.Number })
  $out = Run-Diskpart $diskpartSetup
  [void]$vhdList.Add($vhdPath)
  Say ($out.Trim()) 'DarkGray'

  $after = @(Get-Disk -ErrorAction SilentlyContinue | ForEach-Object { $_.Number })
  $new = $after | Where-Object { $before -notcontains $_ }
  if (-not $new) {
    Say '  ✘ 未能挂载虚拟磁盘，用例跳过' 'Red'
    return [pscustomobject]@{ Name = $title; Pass = $false; Reason = 'VHD 挂载失败' }
  }
  $diskNo = [int]($new | Select-Object -First 1)
  Say ("      虚拟磁盘 = \\.\PhysicalDrive{0}" -f $diskNo) 'DarkGray'
  Start-Sleep -Milliseconds 900

  # 打印该盘的卷状态，方便核对是否真的复现了目标场景
  try {
    foreach ($p in @(Get-Partition -DiskNumber $diskNo -ErrorAction SilentlyContinue)) {
      Say ("      分区#{0} 盘符=[{1}] AccessPaths=[{2}]" -f $p.PartitionNumber, $p.DriveLetter, (($p.AccessPaths) -join ' ; ')) 'DarkGray'
    }
  } catch { }

  # 走真实写盘脚本
  $logPath = Join-Path $env:TEMP ("tomato-selftest-$stamp-$diskNo.jsonl")
  if (Test-Path $logPath) { Remove-Item $logPath -Force }
  Say '      → 调用 burn.ps1 …' 'DarkGray'

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $BurnScript `
      -ImagePath $imgPath `
      -DevicePath ("\\.\PhysicalDrive{0}" -f $diskNo) `
      -LogFile $logPath `
      -TotalBytes $imgBytes `
      -ChunkSize 1048576 `
      -Verify `
      -Wipe | Out-Null
  $burnExit = $LASTEXITCODE
  Say ("      burn.ps1 退出码 = {0}" -f $burnExit) 'DarkGray'

  $errText = ''
  if (Test-Path $logPath) {
    Say '      -------- 写盘日志 --------' 'DarkGray'
    foreach ($ln in (Get-Content $logPath -Encoding utf8)) {
      if ($ln -match '"type":"error"') { Say ("      " + $ln) 'Red'; $errText = $ln }
      elseif ($ln -match '"type":"warn"') { Say ("      " + $ln) 'Yellow' }
      elseif ($ln -match '"type":"progress"') { }
      else { Say ("      " + $ln) 'DarkGray' }
    }
    Say '      --------------------------' 'DarkGray'
  }

  # 独立复核 SHA256
  Start-Sleep -Milliseconds 500
  $devSha = ''
  try { $devSha = Get-DeviceSha256 ("\\.\PhysicalDrive{0}" -f $diskNo) $imgBytes } catch { $devSha = "读取失败：$($_.Exception.Message)" }
  Say ("      镜像 SHA256 = {0}" -f $srcSha) 'DarkGray'
  Say ("      磁盘 SHA256 = {0}" -f $devSha) 'DarkGray'

  # 卸载
  try {
    [void](Run-Diskpart "select vdisk file=`"$vhdPath`"`r`ndetach vdisk`r`nexit`r`n")
  } catch { }
  Start-Sleep -Milliseconds 600

  $ok = ($devSha -eq $srcSha) -and ($burnExit -eq 0)
  if ($ok) { Say "  ✔ 用例通过：$title" 'Green' }
  else { Say "  ✘ 用例失败：$title" 'Red' }
  return [pscustomobject]@{ Name = $title; Pass = $ok; Reason = $errText }
}

# ---- 用例 A：已格式化 + 有盘符（真实「卷占用」场景）----
Say ''
Say '[2/4] 用例 A：VHD 已格式化并分配盘符（验证「锁定并卸除卷」路径）'
$vhdA = Join-Path $env:TEMP ("tomato-selftest-$stamp-a.vhd")
$setupA = @"
create vdisk file="$vhdA" maximum=$([int]($VhdSizeGB * 1024)) type=expandable
attach vdisk
create partition primary
format fs=ntfs quick
assign
exit
"@
$rA = Run-Case '用例 A：有盘符的普通 U 盘' $vhdA $setupA '分区已格式化并分配盘符，Windows 已挂载该卷'
[void]$results.Add($rA)

# ---- 用例 B：有分区但无盘符、未挂载（复现被写坏 / Linux 分区的 U 盘）----
Say ''
Say '[3/4] 用例 B：VHD 有分区但【没有盘符、Windows 未挂载】（复现你的 U 盘状态）'
$vhdB = Join-Path $env:TEMP ("tomato-selftest-$stamp-b.vhd")
$setupB = @"
create vdisk file="$vhdB" maximum=$([int]($VhdSizeGB * 1024)) type=expandable
attach vdisk
create partition primary
select partition 1
set id=83
exit
"@
$rB = Run-Case '用例 B：无盘符 / 未挂载的目标盘' $vhdB $setupB '有分区但 Windows 不挂载（Linux 分区 / 分区表损坏），此时"没有任何东西需要锁定"，应该直接写入'
[void]$results.Add($rB)

# ---- 清理 ----
Say ''
Say '[4/4] 清理虚拟磁盘 …'
foreach ($v in $vhdList) {
  try { [void](Run-Diskpart "select vdisk file=`"$v`"`r`ndetach vdisk`r`nexit`r`n") } catch { }
}
Start-Sleep -Milliseconds 800
if (-not $Keep) {
  foreach ($v in $vhdList) { Remove-Item $v -Force -ErrorAction SilentlyContinue }
  Remove-Item $imgPath -Force -ErrorAction SilentlyContinue
} else {
  foreach ($v in $vhdList) { Say ("已保留：{0}" -f $v) 'Yellow' }
  Say ("已保留：{0}" -f $imgPath) 'Yellow'
}

# ---- 汇总 ----
Say ''
Say '================== 自检结果 ==================' 'Cyan'
$allPass = $true
if (-not $boundaryPass) {
  Say ("  ✘ FAIL  数值边界自检（大镜像 Int32 溢出）：{0}" -f ($boundaryFail -join '、')) 'Red'
  $allPass = $false
} else {
  Say '  ✔ PASS  数值边界自检（>2 GiB 运算）' 'Green'
}
foreach ($r in $results) {
  if ($r.Pass) { Say ("  ✔ PASS  {0}" -f $r.Name) 'Green' }
  else { Say ("  ✘ FAIL  {0}" -f $r.Name) 'Red'; if ($r.Reason) { Say ("           {0}" -f $r.Reason) 'Red' }; $allPass = $false }
}
Say ''
if ($allPass) {
  Say '全部通过 ✔ 写盘链路在「有盘符」和「无盘符 / 未挂载」两种目标盘状态下都能正常工作。' 'Green'
  Say '说明刻录程序本身没问题。若刻录某块 U 盘仍失败，问题在具体那块盘或其占用状态上，' 'Green'
  Say '请把 %LOCALAPPDATA%\TomatoIsoBurner\logs\burn-latest.jsonl 发出来。' 'Green'
} else {
  Say '存在失败用例 ✘ 写盘链路有真实问题，请把上面完整输出发出来。' 'Red'
}
LogLine "[$(Get-Date -Format s)] 番茄 Burn Self-Test v2 end (pass=$allPass)"

if ($allPass) { exit 0 } else { exit 1 }
