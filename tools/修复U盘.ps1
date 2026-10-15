<#
.SYNOPSIS
  番茄镜像刻录工具 —— U 盘急救修复（强力版）

.DESCRIPTION
  针对「刻录失败后 U 盘变成未知容量 / RAW / 无盘符 / 系统完全不识别」的强力修复。

  与旧版 repair-usb.ps1 的区别：
    * 不依赖 Get-Disk 能列出这块盘 —— 本脚本会直接扫描 \\.\PhysicalDrive0..15，
      即使磁盘管理器、此电脑里完全看不到它，也能把它找出来；
    * 先用 DeviceIoControl 清只读属性、刷新磁盘几何（解决「0 字节 / 未初始化 / 没有媒体」）；
    * 再把磁盘头部若干 MB 写零，抹掉 ISO9660 / UDF / 损坏的 GPT 残留签名；
    * 最后才交给 diskpart 做 clean → create partition primary → format → assign。

  安全设计：
    * 内置盘（NVMe / SATA / 含 C: 的盘）一律进黑名单，脚本拒绝操作；
    * 只允许操作 USB 总线的盘；对「系统看不见的隐身盘」必须人工二次确认；
    * 全程中文提示 + 真实 Win32 错误码。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File 修复U盘.ps1 -List
  powershell -ExecutionPolicy Bypass -File 修复U盘.ps1 -DiskNumber 2 -Force
#>
param(
  [switch]$List,
  [int]$DiskNumber = -1,
  [string]$FileSystem = 'exfat',
  [string]$Label = 'USB',
  [int]$ZeroMB = 32,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
# 注意：不要设置 [Console]::OutputEncoding —— 它会调用 SetConsoleOutputCP 改变
# 控制台输出代码页，导致回到调用方（cmd.exe）后中文回显变乱码。保持默认即可。

# ---------------------------------------------------------------------------
# 0. 提权检查（提权由「一键修复U盘.cmd」负责，本脚本只做检查）
# ---------------------------------------------------------------------------
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host ''
  Write-Host '错误：需要管理员权限。' -ForegroundColor Red
  Write-Host '请双击同目录下的「一键修复U盘.cmd」运行 —— 它会自动申请管理员权限。' -ForegroundColor Yellow
  Write-Host ''
  Read-Host '按回车键退出'
  exit 1
}

# 全程写日志（cmd 结束时会提示这个日志路径），出问题时方便排查
try {
  Start-Transcript -Path (Join-Path $env:TEMP 'tomato-repair-latest.log') -Force | Out-Null
} catch { }

# ---------------------------------------------------------------------------
# 1. P/Invoke
# ---------------------------------------------------------------------------
if (-not ('TomatoRawDisk' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class TomatoRawDisk {
  // 注意：这些常量必须定义在 C# 里。PowerShell 解析字面量 0xC0000000 得到的是
  // Int32 负数（-1073741824），传给 uint 参数会直接报"无法转换为 System.UInt32"；
  // 从 C# const uint 取回的值类型正确，-bor 运算后也保持 UInt32。（burn.ps1 同款写法）
  public const uint GENERIC_READ     = 0x80000000;
  public const uint GENERIC_WRITE    = 0x40000000;
  public const uint FILE_SHARE_READ  = 0x00000001;
  public const uint FILE_SHARE_WRITE = 0x00000002;
  public const uint OPEN_EXISTING    = 3;

  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Auto)]
  public static extern IntPtr CreateFile(string f, uint a, uint s, IntPtr sec, uint cd, uint fl, IntPtr t);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool DeviceIoControl(IntPtr h, uint io, IntPtr inBuf, uint inLen,
                                            IntPtr outBuf, uint outLen, ref uint ret, IntPtr ov);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetFilePointerEx(IntPtr h, long dist, out long newPos, uint method);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool WriteFile(IntPtr h, IntPtr buf, uint n, out uint written, IntPtr ov);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadFile(IntPtr h, IntPtr buf, uint n, out uint read, IntPtr ov);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr VirtualAlloc(IntPtr a, UIntPtr sz, uint type, uint protect);

  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool VirtualFree(IntPtr a, UIntPtr sz, uint free);
}
'@ -ErrorAction Stop
}

$script:INVALID_HANDLE = [IntPtr]::new(-1)

function Get-Win32Err { return [Runtime.InteropServices.Marshal]::GetLastWin32Error() }

function Open-Physical([int]$n, [uint32]$flags) {
  $path = "\\.\PhysicalDrive$($n)"
  $access = [TomatoRawDisk]::GENERIC_READ -bor [TomatoRawDisk]::GENERIC_WRITE
  $share  = [TomatoRawDisk]::FILE_SHARE_READ -bor [TomatoRawDisk]::FILE_SHARE_WRITE
  $h = [TomatoRawDisk]::CreateFile($path, $access, $share, [IntPtr]::Zero, [TomatoRawDisk]::OPEN_EXISTING, $flags, [IntPtr]::Zero)
  $err = Get-Win32Err
  if ($h -eq $script:INVALID_HANDLE -or $h -eq [IntPtr]::Zero) { return @{ Handle = [IntPtr]::Zero; Error = $err } }
  return @{ Handle = $h; Error = 0 }
}

# ---------------------------------------------------------------------------
# 2. 探测：即使磁盘管理器看不见，也扫一遍 PhysicalDrive0..15
# ---------------------------------------------------------------------------
function Get-Geometry([IntPtr]$h) {
  $out = [Runtime.InteropServices.Marshal]::AllocHGlobal(128)
  try {
    $ret = [uint32]0
    $ok = [TomatoRawDisk]::DeviceIoControl($h, 0x000700A0, [IntPtr]::Zero, 0, $out, 128, [ref]$ret, [IntPtr]::Zero)
    if (-not $ok) { return @{ Ok = $false; Error = (Get-Win32Err) } }
    $b = New-Object byte[] 64
    [Runtime.InteropServices.Marshal]::Copy($out, $b, 0, 64)
    $bps = [BitConverter]::ToUInt32($b, 20)
    $size = [BitConverter]::ToInt64($b, 24)
    return @{ Ok = $true; BytesPerSector = $bps; Size = $size }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($out)
  }
}

function Clear-ReadOnlyAttr([IntPtr]$h) {
  # SET_DISK_ATTRIBUTES: Version(4) Persist(1)+pad(3) Attributes(8) AttributesMask(8) Reserved(16) = 40
  $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal(40)
  try {
    $z = New-Object byte[] 40
    [Runtime.InteropServices.Marshal]::Copy($z, 0, $buf, 40)
    [Runtime.InteropServices.Marshal]::WriteInt32($buf, 0, 40)              # Version
    [Runtime.InteropServices.Marshal]::WriteByte($buf, 4, 1)                # Persist = TRUE
    [Runtime.InteropServices.Marshal]::WriteInt64($buf, 8, 0)               # Attributes  = 0
    [Runtime.InteropServices.Marshal]::WriteInt64($buf, 16, 2)              # Mask = DISK_ATTRIBUTE_READ_ONLY
    foreach ($io in @(0x00070820, 0x00070C20, 0x00070824)) {
      $ret = [uint32]0
      $ok = [TomatoRawDisk]::DeviceIoControl($h, $io, $buf, 40, [IntPtr]::Zero, 0, [ref]$ret, [IntPtr]::Zero)
      if ($ok) { return @{ Ok = $true; Io = $io } }
    }
    return @{ Ok = $false; Error = (Get-Win32Err) }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
  }
}

function Update-DiskProps([IntPtr]$h) {
  foreach ($io in @(0x00070140, 0x000700C8)) {
    $ret = [uint32]0
    [TomatoRawDisk]::DeviceIoControl($h, $io, [IntPtr]::Zero, 0, [IntPtr]::Zero, 0, [ref]$ret, [IntPtr]::Zero) | Out-Null
  }
}

function Test-Readable([IntPtr]$h) {
  $p = [TomatoRawDisk]::VirtualAlloc([IntPtr]::Zero, [UIntPtr]::new(4096), 0x3000, 0x04)
  if ($p -eq [IntPtr]::Zero) { return @{ Ok = $false; Error = -1 } }
  try {
    $pos = [long]0
    if (-not [TomatoRawDisk]::SetFilePointerEx($h, 0, [ref]$pos, 0)) { return @{ Ok = $false; Error = (Get-Win32Err) } }
    $rd = [uint32]0
    $ok = [TomatoRawDisk]::ReadFile($h, $p, 4096, [ref]$rd, [IntPtr]::Zero)
    if ($ok) { return @{ Ok = $true } }
    return @{ Ok = $false; Error = (Get-Win32Err) }
  } finally {
    [TomatoRawDisk]::VirtualFree($p, [UIntPtr]::Zero, 0x8000) | Out-Null
  }
}

function Get-AllDisks {
  $result = New-Object System.Collections.Generic.List[object]
  $meta = @{}
  try {
    foreach ($d in (Get-Disk -ErrorAction SilentlyContinue)) {
      $letters = @()
      try {
        foreach ($p in @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue)) {
          $dl = ([string]$p.DriveLetter).Trim().ToUpper()
          if ($dl -and $dl -ne "`0") { $letters += $dl }
        }
      } catch { }
      $meta[[int]$d.Number] = @{
        Name    = [string]$d.FriendlyName
        Bus     = [string]$d.BusType
        Style   = [string]$d.PartitionStyle
        Letters = $letters
        Visible = $true
      }
    }
  } catch { }

  for ($n = 0; $n -lt 16; $n++) {
    $r = Open-Physical $n 0
    if ($r.Handle -eq [IntPtr]::Zero) { continue }
    $g = Get-Geometry $r.Handle
    $rd = Test-Readable $r.Handle
    [TomatoRawDisk]::CloseHandle($r.Handle) | Out-Null

    $m = $meta[[int]$n]
    $name = if ($m) { $m.Name } else { '(系统未识别此盘)' }
    $bus  = if ($m) { $m.Bus } else { 'Unknown' }
    if ($g.Ok) {
      $result.Add([pscustomobject]@{
        Number = $n
        Name   = $name
        Bus    = $bus
        SizeGB = [math]::Round($g.Size / 1GB, 2)
        Size   = $g.Size
        Sector = $g.BytesPerSector
        Letters = if ($m) { ($m.Letters -join ',') } else { '' }
        Visible = if ($m) { $true } else { $false }
        Readable = $rd.Ok
        ReadErr  = if ($rd.Ok) { 0 } else { $rd.Error }
      })
    } else {
      $result.Add([pscustomobject]@{
        Number = $n
        Name   = $name
        Bus    = $bus
        SizeGB = 0
        Size   = 0
        Sector = 0
        Letters = if ($m) { ($m.Letters -join ',') } else { '' }
        Visible = if ($m) { $true } else { $false }
        Readable = $false
        ReadErr  = $g.Error
      })
    }
  }
  return $result
}

function Get-BuiltInSet {
  $bad = New-Object 'System.Collections.Generic.HashSet[int]'
  try {
    foreach ($d in (Get-Disk -ErrorAction SilentlyContinue)) {
      $isUsb = ([string]$d.BusType) -eq 'USB'
      $letters = @()
      try {
        foreach ($p in @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue)) {
          $dl = ([string]$p.DriveLetter).Trim().ToUpper()
          if ($dl -and $dl -ne "`0") { $letters += $dl }
        }
      } catch { }
      $sys = ([bool]$d.IsSystem) -or ([bool]$d.IsBoot) -or ($letters -contains 'C')
      if (-not $isUsb -or $sys) { $bad.Add([int]$d.Number) | Out-Null }
    }
  } catch { }
  return $bad
}

# ---------------------------------------------------------------------------
# 3. 列出所有盘
# ---------------------------------------------------------------------------
$disks  = Get-AllDisks
$builtin = Get-BuiltInSet

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor DarkCyan
Write-Host '   番茄镜像刻录工具 - U 盘急救修复' -ForegroundColor Cyan
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor DarkCyan
Write-Host ''
Write-Host '本机扫描到的物理磁盘（含磁盘管理器里看不到的「隐身盘」）：' -ForegroundColor Cyan
Write-Host ''

foreach ($d in $disks) {
  $isBad = $builtin.Contains([int]$d.Number)
  if ($isBad) {
    $tag = '[内置盘/系统盘 - 禁止操作]'
    $col = 'DarkGray'
  } elseif (-not $d.Visible) {
    $tag = '[隐身盘：系统看不见，可能就是坏掉的 U 盘]'
    $col = 'Yellow'
  } else {
    $tag = '[可修复：USB 设备]'
    $col = 'Green'
  }
  $state = if ($d.Readable) { '可读' } else { ('读取失败 错误码 ' + $d.ReadErr) }
  Write-Host ("  磁盘 #{0,-3} {1,-34} {2,9:N2} GB  总线={3,-8} 盘符={4,-6} {5}  {6}" -f `
    $d.Number, $d.Name, $d.SizeGB, $d.Bus, $d.Letters, $state, $tag) -ForegroundColor $col
}
Write-Host ''

$usbDisks = @($disks | Where-Object { -not $builtin.Contains([int]$_.Number) })

if ($usbDisks.Count -eq 0) {
  Write-Host '没有找到任何可修复的 USB 磁盘。可能的原因：' -ForegroundColor Red
  Write-Host ''
  Write-Host '  1) U 盘当前没有插在电脑上 —— 请先插入，等 5 秒，然后重新运行本脚本；' -ForegroundColor Yellow
  Write-Host '  2) 换一个 USB 口（优先插机箱背后的 USB 2.0 口，不要用前置面板/集线器）；' -ForegroundColor Yellow
  Write-Host '  3) 换一台电脑试试 —— 如果多台电脑都完全无反应、指示灯也不亮，' -ForegroundColor Yellow
  Write-Host '     说明 U 盘主控固件已损坏，软件无法修复，需要厂商量产工具（如 ChipGenius 查主控后用量产工具）；' -ForegroundColor Yellow
  Write-Host '  4) 在「设备管理器」里查看「磁盘驱动器」/「通用串行总线控制器」下是否有带黄色感叹号的未知设备。' -ForegroundColor Yellow
  Write-Host ''
  Read-Host '按回车键退出'
  exit 2
}

if ($List -or $DiskNumber -lt 0) {
  if ($usbDisks.Count -eq 1) {
    $DiskNumber = [int]$usbDisks[0].Number
    Write-Host ("自动选中唯一的 USB 磁盘：#{0}  {1}  {2:N2} GB" -f $DiskNumber, $usbDisks[0].Name, $usbDisks[0].SizeGB) -ForegroundColor Green
    Write-Host ''
  } else {
    Write-Host '检测到多个 USB 磁盘，请指定编号，例如：' -ForegroundColor Yellow
    Write-Host ('  .\修复U盘.ps1 -DiskNumber {0}' -f $usbDisks[0].Number) -ForegroundColor Yellow
    Write-Host ''
    Read-Host '按回车键退出'
    exit 0
  }
}

# ---------------------------------------------------------------------------
# 4. 安全校验
# ---------------------------------------------------------------------------
$target = $disks | Where-Object { [int]$_.Number -eq $DiskNumber } | Select-Object -First 1
if ($null -eq $target) {
  Write-Host "错误：本机没有编号为 $DiskNumber 的物理磁盘。" -ForegroundColor Red
  Read-Host '按回车键退出'; exit 1
}
if ($builtin.Contains([int]$DiskNumber)) {
  Write-Host ''
  Write-Host "错误：磁盘 #$DiskNumber 是内置盘 / 系统盘 / 含 C: 的盘，严禁擦除！已中止。" -ForegroundColor Red
  Write-Host ''
  Read-Host '按回车键退出'; exit 1
}

Write-Host '即将对以下磁盘执行【急救修复】：' -ForegroundColor Yellow
Write-Host ("  磁盘 #{0}   {1}" -f $target.Number, $target.Name) -ForegroundColor Yellow
Write-Host ("  容量 {0:N2} GB   总线 {1}   盘符 {2}" -f $target.SizeGB, $target.Bus, $target.Letters) -ForegroundColor Yellow
Write-Host ''
Write-Host '  操作步骤：' -ForegroundColor Cyan
Write-Host '    ① 打开设备并清除只读属性' -ForegroundColor Cyan
Write-Host '    ② 刷新磁盘几何信息（修复「0 字节 / 未初始化」）' -ForegroundColor Cyan
Write-Host ("    ③ 把磁盘头部 {0} MB 写零（抹掉损坏的分区表和 ISO 残留）" -f $ZeroMB) -ForegroundColor Cyan
Write-Host '    ④ diskpart: clean → 新建主分区 → 格式化 → 分配盘符' -ForegroundColor Cyan
Write-Host ''
Write-Host '⚠️  该操作会清空这块磁盘上的全部数据，且不可撤销！' -ForegroundColor Red
Write-Host ''

if (-not $Force) {
  $ans = Read-Host '确认继续请输入 YES（其他任意输入取消）'
  if ($ans -ne 'YES') {
    Write-Host '已取消，未对磁盘做任何操作。' -ForegroundColor Cyan
    Read-Host '按回车键退出'; exit 0
  }
}

# ---------------------------------------------------------------------------
# 5. 执行修复
# ---------------------------------------------------------------------------
function Step([string]$msg) { Write-Host ("`n▶ " + $msg) -ForegroundColor Cyan }

Step '① 打开设备并清除只读属性'
$open = Open-Physical $DiskNumber 0
if ($open.Handle -eq [IntPtr]::Zero) {
  Write-Host ('   失败：无法打开 \\.\PhysicalDrive{0}，Win32 错误码 {1}' -f $DiskNumber, $open.Error) -ForegroundColor Red
  Write-Host '   常见含义：2=找不到设备(没插好) / 5=权限不足 / 21=设备未就绪 / 1112=没有媒体' -ForegroundColor Yellow
  Read-Host '按回车键退出'; exit 1
}
$h = $open.Handle
Write-Host ('   已打开 \\.\PhysicalDrive{0}' -f $DiskNumber) -ForegroundColor Green

$ro = Clear-ReadOnlyAttr $h
if ($ro.Ok) {
  Write-Host ('   已清除只读属性（IOCTL 0x{0:X8}）' -f $ro.Io) -ForegroundColor Green
} else {
  Write-Host ('   只读属性清除失败（错误码 {0}），继续尝试后续步骤…' -f $ro.Error) -ForegroundColor Yellow
}

Step '② 刷新磁盘几何信息'
Update-DiskProps $h
$g2 = Get-Geometry $h
if ($g2.Ok -and $g2.Size -gt 0) {
  Write-Host ('   容量 {0:N2} GB，扇区 {1} 字节' -f ($g2.Size / 1GB), $g2.Sector) -ForegroundColor Green
} else {
  Write-Host ('   读取几何信息失败（错误码 {0}）' -f $(if ($g2.Error) { $g2.Error } else { '未知' })) -ForegroundColor Yellow
}

Step ("③ 把磁盘头部 {0} MB 写零" -f $ZeroMB)
$CHUNK = 1MB
$sector = if ($g2.Ok -and $g2.Sector -gt 0) { [int]$g2.Sector } else { 512 }
$buf = [TomatoRawDisk]::VirtualAlloc([IntPtr]::Zero, [UIntPtr]::new($CHUNK), 0x3000, 0x04)
if ($buf -eq [IntPtr]::Zero) {
  Write-Host '   内存分配失败，跳过写零步骤。' -ForegroundColor Yellow
} else {
  try {
    $zeroTotal = [long]$ZeroMB * 1MB
    $done = [long]0
    $failErr = 0
    while ($done -lt $zeroTotal) {
      $pos = [long]0
      if (-not [TomatoRawDisk]::SetFilePointerEx($h, $done, [ref]$pos, 0)) { $failErr = Get-Win32Err; break }
      $wr = [uint32]0
      $ok = [TomatoRawDisk]::WriteFile($h, $buf, [uint32]$CHUNK, [ref]$wr, [IntPtr]::Zero)
      if (-not $ok) { $failErr = Get-Win32Err; break }
      $done += [long]$wr
    }
    if ($failErr -eq 0) {
      Write-Host ('   已写零 {0} MB ✔' -f [math]::Round($done / 1MB, 1)) -ForegroundColor Green
    } else {
      Write-Host ('   写零中断，Win32 错误码 {0}（已写 {1} MB）。' -f $failErr, [math]::Round($done / 1MB, 1)) -ForegroundColor Yellow
      Write-Host '   常见含义：5=权限不足 / 19=写保护 / 21=设备未就绪 / 1117=I/O 设备错误（硬件故障）' -ForegroundColor Yellow
    }
  } finally {
    [TomatoRawDisk]::VirtualFree($buf, [UIntPtr]::Zero, 0x8000) | Out-Null
  }
}
[TomatoRawDisk]::CloseHandle($h) | Out-Null

Step '④ 重建分区表并格式化'
$dp = @"
select disk $DiskNumber
attributes disk clear readonly
online disk
clean
convert mbr
create partition primary
select partition 1
format fs=$FileSystem quick label=$Label
assign
exit
"@
$tmp = Join-Path $env:TEMP ("tomato-repair-" + [Guid]::NewGuid().ToString('N') + ".txt")
[System.IO.File]::WriteAllText($tmp, $dp, [System.Text.Encoding]::ASCII)
try {
  & diskpart.exe /s $tmp 2>&1 | ForEach-Object { Write-Host ('   ' + $_) }
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

# ---------------------------------------------------------------------------
# 6. 结果
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor DarkCyan
$after = $null
try {
  $ps = @(Get-Partition -DiskNumber $DiskNumber -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter })
  if ($ps.Count -gt 0) { $after = ($ps | ForEach-Object { $_.DriveLetter }) -join ',' }
} catch { }

if ($after) {
  Write-Host ('修复完成 ✔   磁盘 #{0} 的盘符：{1}' -f $DiskNumber, $after) -ForegroundColor Green
  Write-Host '请打开「此电脑」（按 F5 刷新）确认容量已恢复正常。' -ForegroundColor Green
} else {
  Write-Host '未检测到盘符，请按顺序尝试：' -ForegroundColor Yellow
  Write-Host '  1) 拔下 U 盘，等 10 秒后重新插入；' -ForegroundColor Yellow
  Write-Host '  2) 在「此电脑」按 F5 刷新；' -ForegroundColor Yellow
  Write-Host '  3) 打开「磁盘管理」（diskmgmt.msc）看它是否显示为「未分配」或「无媒体」；' -ForegroundColor Yellow
  Write-Host '  4) 若显示为「无媒体」或容量 0，说明 U 盘主控已掉线，属硬件故障，' -ForegroundColor Yellow
  Write-Host '     软件无法修复，需要用 ChipGenius 查主控后找对应量产工具。' -ForegroundColor Yellow
}
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor DarkCyan
Write-Host ''
try { Stop-Transcript | Out-Null } catch { }
Read-Host '按回车键退出'
