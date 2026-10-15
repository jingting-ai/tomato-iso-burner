<#
  番茄镜像刻录工具 —— 目标磁盘「卷锁定」诊断工具

  用途：把 burn.ps1 里的函数原样加载进来，对指定磁盘跑一遍
        「卷枚举 + 卷锁定」，看清楚刻录前到底会看到什么、卡在哪里。

  只读探测；锁定成功后立刻解锁释放，不会写入任何数据。

  用法：
    powershell -ExecutionPolicy Bypass -File diagnose-disk.ps1 -DiskNumber 2
#>
param(
  [int]$DiskNumber = 0,   # 0 = 自动识别唯一的 USB 磁盘
  [string]$BurnScript = '',
  [switch]$NoLock         # 只枚举候选卷，不做锁定尝试（完全不触碰目标盘）
)

$ErrorActionPreference = 'Continue'

$out = New-Object System.Collections.ArrayList
function W($s) { [void]$out.Add([string]$s); Write-Host $s }
function Flush {
  try {
    [System.IO.File]::WriteAllText(
      (Join-Path $env:TEMP 'tomato-diagnose-disk.txt'),
      ($out -join "`r`n"),
      (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

# 自动识别唯一的 USB 磁盘
if ($DiskNumber -le 0) {
  $usb = @()
  try {
    foreach ($d in (Get-Disk -ErrorAction SilentlyContinue)) {
      $isSys = ([bool]$d.IsSystem) -or ([bool]$d.IsBoot)
      if ((-not $isSys) -and ([string]$d.BusType -eq 'USB')) { $usb += [int]$d.Number }
    }
  } catch { }
  if ($usb.Count -eq 1) { $DiskNumber = $usb[0] }
  else {
    W "无法自动识别 USB 磁盘（找到 $($usb.Count) 个）。请用 -DiskNumber N 指定。"
    try { Get-Disk | Select-Object Number,FriendlyName,Size,BusType | Format-Table -AutoSize | Out-String -Width 200 | ForEach-Object { W $_ } } catch { }
    Flush; exit 1
  }
}

if (-not $BurnScript) {
  $cands = @(
    (Join-Path $PSScriptRoot '..\assets\burn.ps1'),
    (Join-Path $PSScriptRoot 'burn.ps1')
  )
  foreach ($c in $cands) { if (Test-Path $c) { $BurnScript = (Resolve-Path $c).Path; break } }
}
if (-not $BurnScript -or -not (Test-Path $BurnScript)) {
  W "找不到 burn.ps1，请用 -BurnScript 指定路径"
  Flush; exit 1
}

# ---- 只加载 burn.ps1 的「函数 + Add-Type」部分，不执行主流程 ----
$text = [System.IO.File]::ReadAllText($BurnScript)
$marker = '# ---------------------------------------------------------------- main'
$idx = $text.IndexOf($marker)
$startMarker = '$ErrorActionPreference'
$startIdx = $text.IndexOf($startMarker)
if ($idx -lt 0 -or $startIdx -lt 0 -or $startIdx -ge $idx) { W "无法定位 burn.ps1 的结构标记，脚本结构可能已变化"; Flush; exit 1 }
# 跳过 param() 块，避免必填参数在加载时报错
$prelude = $text.Substring($startIdx, $idx - $startIdx)

$LogFile = Join-Path $env:TEMP 'tomato-diagnose-lock.jsonl'
$CancelFlag = ''
$Verify = $false
$Wipe = $false
$ChunkSize = 1048576
$TotalBytes = 0
$ImagePath = ''
$DevicePath = ''
try { Remove-Item $LogFile -Force -ErrorAction SilentlyContinue } catch { }

W "================ 番茄 卷锁定诊断 ================"
W ("写盘脚本：{0}" -f $BurnScript)
W ("日志文件：{0}" -f $LogFile)
W ""

try { Invoke-Expression $prelude } catch { W ("加载 burn.ps1 函数失败：{0}" -f $_.Exception.Message); Flush; exit 1 }

W "---- 磁盘信息 ----"
try {
  $d = Get-Disk -Number $DiskNumber -ErrorAction Stop
  W ("磁盘 #{0}  {1}  {2} GB  分区样式={3}  只读={4}  脱机={5}  系统盘={6}  BusType={7}" -f `
      $d.Number, $d.FriendlyName, [math]::Round($d.Size/1GB,2), $d.PartitionStyle, $d.IsReadOnly, $d.IsOffline, $d.IsSystem, $d.BusType)
} catch { W ("读取磁盘信息失败：{0}" -f $_.Exception.Message) }

W ""
W "---- 分区 (Get-Partition) ----"
try {
  $ps = @(Get-Partition -DiskNumber $DiskNumber -ErrorAction Stop)
  if ($ps.Count -eq 0) { W "  （无分区记录）" }
  foreach ($p in $ps) {
    W ("  part#{0}  {1} 类型={2} 盘符=[{3}]  AccessPaths=[{4}]" -f `
        $p.PartitionNumber, $p.Size, $p.Type, $p.DriveLetter, (($p.AccessPaths) -join ' ; '))
  }
} catch { W ("  Get-Partition 失败：{0}" -f $_.Exception.Message) }

W ""
W "---- 卷对象 (FindFirstVolume 全系统枚举) ----"
$sb = New-Object System.Text.StringBuilder 260
$hFind = [TomatoBurn]::FindFirstVolume($sb, 260)
if (Test-BadHandle $hFind) {
  W ("  FindFirstVolume 失败，错误码 {0}" -f (LastWin32Error))
} else {
  try {
    $g = 0
    while ($g -lt 512) {
      $g++
      $v = $sb.ToString()
      $probe = $v; if (-not $probe.EndsWith('\')) { $probe = $probe + '\' }
      $line = "  $v"
      $vh = New-DeviceHandle $probe $false ([TomatoBurn]::FILE_SHARE_READ -bor [TomatoBurn]::FILE_SHARE_WRITE)
      if (Test-BadHandle $vh) {
        $line += ("   [打开失败 错误码 {0}]" -f (LastWin32Error))
      } else {
        [uint32]$dn = 0; [uint32]$pn = 0
        if ([TomatoBurn]::GetDeviceNumber($vh, [ref]$dn, [ref]$pn)) {
          $line += ("   物理磁盘={0} 分区号={1}" -f $dn, $pn)
        } else {
          $line += ("   [取设备号失败 错误码 {0}]" -f (LastWin32Error))
        }
        Close-Native $vh
      }
      W $line
      $sb.Length = 0
      if (-not [TomatoBurn]::FindNextVolume($hFind, $sb, 260)) { break }
    }
  } finally { [void][TomatoBurn]::FindVolumeClose($hFind) }
}

W ""
W "---- burn.ps1 将要尝试的候选卷路径 ----"
$c = Get-VolumeCandidates $DiskNumber
if ($c.Count -eq 0) { W "  （无）" } else { foreach ($x in $c) { W ("  $x") } }

W ""
if ($NoLock) {
  W "---- 实际锁定尝试（已跳过：-NoLock）----"
  W "  （-NoLock 模式下不会锁定/卸除任何卷，目标盘状态不变）"
} else {
  W "---- 实际锁定尝试 ----"
  $res = Lock-TargetVolumes $DiskNumber
  W ("  确认挂载的卷数 = {0}" -f $res.mounted)
  W ("  已锁定        = {0}" -f $res.handles.Count)
  W ("  锁定失败      = {0}（最后错误码 {1}）" -f $res.failed, $res.lastError)

  if ($res.mounted -eq 0) {
    W "  ✔ 该盘上没有已挂载的卷 → burn.ps1 会直接写入（不会误报中止）"
  } elseif ($res.failed -gt 0) {
    W "  ✘ 有卷锁定失败 → burn.ps1 会安全中止，请关闭「此电脑」/杀毒/磁盘管理后重试"
  } else {
    W "  ✔ 全部卷锁定成功 → burn.ps1 会正常写入"
  }

  Release-Volumes $res.handles
}

W ""
W "---- burn.ps1 产生的日志 ----"
if (Test-Path $LogFile) {
  foreach ($ln in (Get-Content $LogFile -Encoding UTF8)) { W ("  $ln") }
} else { W "  （无）" }

W ""
W "================ 诊断结束 ================"
Flush
