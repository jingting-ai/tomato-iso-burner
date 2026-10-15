<#
.SYNOPSIS
  番茄镜像刻录工具 —— U 盘还原（程序内调用版）

.DESCRIPTION
  由 tools/修复U盘.ps1 派生：P/Invoke 与辅助函数整段原样保留，
  只把「交互式 Read-Host 流程」换成程序可消费的 JSONL 日志。

  · -List                      列出所有物理磁盘（含磁盘管理器里看不到的「隐身盘」）
  · -DiskNumber N -Force       执行修复：清只读 → 刷几何 → 头部写零 → 重建分区表 → 格式化

  安全设计（与交互版一致，一条都不能少）：
  · 内置盘 / 系统盘 / 含 C: 的盘一律进黑名单，脚本拒绝操作；
  · 只允许操作 USB 总线的盘；
  · 破坏性动作全部排在「已打开设备且身份校验通过」之后。

  日志协议（与 burn.ps1 同款）：每行一个 JSON，type ∈ started/info/warn/progress/
  disk/error/done。调用方按「以换行结尾的完整行」增量消费 —— 只写了一半的行
  直接解析会失败并被永久跳过，界面上就看不到真正的错误原因。
#>
param(
  [switch]$List,
  [int]$DiskNumber = -1,
  [string]$FileSystem = 'ntfs',
  [string]$Label = '番茄U盘',  # 卷标（存储兜底路径会用；最终由主进程 Set-Volume 统一设，支持中文）
  [int]$ZeroMB = 32,
  [string]$LogFile = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 0. 日志：一律写 JSONL；控制台不再输出（程序靠读文件拿进度，避免编码问题）
# ---------------------------------------------------------------------------
function Log($obj) {
  if ($script:LogFile -eq '') { return }
  try {
    $line = ($obj | ConvertTo-Json -Compress -Depth 6)
    [System.IO.File]::AppendAllText($script:LogFile, $line + "`n",
      [System.Text.UTF8Encoding]::new($false))
  } catch { }
}

function Log-Step([string]$msg) { Log @{ type = 'info'; message = $msg } }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Log @{ type = 'error'; message = '需要管理员权限才能修复 U 盘。请以管理员身份运行本程序（界面右上角有「以管理员重启」按钮）。' }
  exit 1
}

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
# 3. 列出所有盘（-List）
# ---------------------------------------------------------------------------
$disks   = Get-AllDisks
$builtin = Get-BuiltInSet

if ($List) {
  foreach ($d in $disks) {
    Log @{
      type     = 'disk'
      number   = [int]$d.Number
      name     = [string]$d.Name
      bus      = [string]$d.Bus
      size     = [int64]$d.Size
      letters  = [string]$d.Letters
      visible  = [bool]$d.Visible
      readable = [bool]$d.Readable
      err      = [int]$d.ReadErr
      bad      = [bool]$builtin.Contains([int]$d.Number)
    }
  }
  Log @{ type = 'done' }
  exit 0
}

# ---------------------------------------------------------------------------
# 4. 安全校验
# ---------------------------------------------------------------------------
Log @{ type = 'started' }
Log-Step ('还原脚本已启动（目标磁盘 #' + $DiskNumber + '，文件系统 ' + $FileSystem + '）')

$target = $disks | Where-Object { [int]$_.Number -eq $DiskNumber } | Select-Object -First 1
if ($null -eq $target) {
  Log @{ type = 'error'; message = "本机没有编号为 $DiskNumber 的物理磁盘。请先插入 U 盘，等 5 秒后点「重新扫描」再试。" }
  exit 1
}
if ($builtin.Contains([int]$DiskNumber)) {
  Log @{ type = 'error'; message = "磁盘 #$DiskNumber 是内置盘 / 系统盘 / 含 C: 的盘，严禁操作。已中止，目标盘未被改动。" }
  exit 1
}
if (-not $Force) {
  Log @{ type = 'error'; message = '缺少 -Force 确认参数，已中止（程序内调用必须先让用户勾选确认）。' }
  exit 1
}

Log-Step ("目标：磁盘 #$DiskNumber  $($target.Name)  $([math]::Round($target.Size / 1GB, 2)) GB  总线=$($target.Bus)  盘符=$($target.Letters)")
Log @{ type = 'progress'; percent = 5 }

# ---------------------------------------------------------------------------
# 5. 步骤 ①：打开设备并清除只读属性
# ---------------------------------------------------------------------------
Log-Step '① 打开设备并清除只读属性'
$open = Open-Physical $DiskNumber 0
if ($open.Handle -eq [IntPtr]::Zero) {
  $ec = $open.Error
  $hint = if ($ec -eq 5) { '权限不足，请以管理员身份运行' }
          elseif ($ec -eq 2) { '找不到设备，U 盘可能没插好' }
          elseif ($ec -eq 21) { '设备未就绪，换一个 USB 口再试' }
          elseif ($ec -eq 1112) { '没有媒体（读卡器里没插卡，或主控已掉线）' }
          else { '请重新插拔 U 盘后重试' }
  Log @{ type = 'error'; message = "无法打开 \\.\PhysicalDrive$DiskNumber（Win32 错误码 $ec）：$hint。目标盘未被改动。" }
  exit 1
}
$h = $open.Handle
Log-Step ('   已打开 \\.\PhysicalDrive' + $DiskNumber)

$ro = Clear-ReadOnlyAttr $h
if ($ro.Ok) {
  Log-Step ('   已清除只读属性（IOCTL 0x{0:X8}）' -f $ro.Io)
} else {
  Log @{ type = 'warn'; message = "只读属性清除失败（错误码 $($ro.Error)），继续尝试后续步骤…" }
}
Log @{ type = 'progress'; percent = 15 }

# ---------------------------------------------------------------------------
# 6. 步骤 ②：刷新磁盘几何信息（修「0 字节 / 未初始化」）
# ---------------------------------------------------------------------------
Log-Step '② 刷新磁盘几何信息'
Update-DiskProps $h
$g2 = Get-Geometry $h
# ⚠️ Get-Geometry 返回的是 BytesPerSector（不是 Sector）—— 写错字段名日志里就只剩「扇区 字节」
if ($g2.Ok -and $g2.Size -gt 0) {
  Log-Step ('   容量 {0:N2} GB，扇区 {1} 字节' -f ($g2.Size / 1GB), $g2.BytesPerSector)
} else {
  Log @{ type = 'warn'; message = "读取几何信息失败（错误码 $(if ($g2.Error) { $g2.Error } else { '未知' })）—— 若后续分区表重建成功，通常不影响使用。" }
}
Log @{ type = 'progress'; percent = 25 }

# ---------------------------------------------------------------------------
# 7. 步骤 ③：把磁盘头部若干 MB 写零（抹掉 ISO9660 / UDF / 损坏的 GPT 残留）
# ---------------------------------------------------------------------------
Log-Step "③ 把磁盘头部 $ZeroMB MB 写零（抹掉损坏的分区表和镜像残留）"
$CHUNK = 1MB
$sector = if ($g2.Ok -and $g2.Sector -gt 0) { [int]$g2.Sector } else { 512 }
$buf = [TomatoRawDisk]::VirtualAlloc([IntPtr]::Zero, [UIntPtr]::new($CHUNK), 0x3000, 0x04)
if ($buf -eq [IntPtr]::Zero) {
  Log @{ type = 'warn'; message = '内存分配失败，跳过写零步骤（仍会继续重建分区表）。' }
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
      $pct = 25 + [int](($done / [double]$zeroTotal) * 45)
      Log @{ type = 'progress'; percent = $pct }
    }
    if ($failErr -eq 0) {
      Log-Step ('   已写零 ' + [math]::Round($done / 1MB, 1) + ' MB')
    } else {
      $zh = if ($failErr -eq 19) { '写保护（U 盘上的物理写保护开关）' }
            elseif ($failErr -eq 21) { '设备未就绪，换一个 USB 口' }
            elseif ($failErr -eq 1117) { 'I/O 设备错误（多半是硬件故障）' }
            else { '见错误码含义' }
      Log @{ type = 'warn'; message = "写零中断（Win32 错误码 $failErr：$zh，已写 $([math]::Round($done / 1MB, 1)) MB）。仍会继续尝试重建分区表。" }
    }
  } finally {
    [TomatoRawDisk]::VirtualFree($buf, [UIntPtr]::Zero, 0x8000) | Out-Null
  }
}
[TomatoRawDisk]::CloseHandle($h) | Out-Null
Log @{ type = 'progress'; percent = 72 }

# ---------------------------------------------------------------------------
# 8. 步骤 ④：重建分区表并格式化
# ---------------------------------------------------------------------------
Log-Step "④ 重建分区表并格式化为 $FileSystem（每一步单独调用 diskpart）"
# 大于 2 TB 的盘 MBR 装不下，改用 GPT；其余一律 MBR（兼容性最好）
$convert = if ($target.Size -ge 2199023255552) { 'convert gpt' } else { 'convert mbr' }
#
# ★ 为什么每一步单独起一次 diskpart（2026-10-14 连着踩两次坑）：
#   ① 一开始把命令堆在一个脚本里：第三条 online disk 报错，DiskPart【遇错即退】，
#      后面的 clean / 建分区 / 格式化 全没跑；
#   ② 改成每条带 noerr：结果 clean 直接拒收 noerr（「为此命令指定的参数无效 … HELP CLEAN」），分区表还是没清掉。
#   结论：不要在一个脚本里堆命令，也不要指望 noerr 对所有命令都通用。
#         每一步单独调一次，谁失败只影响谁，还能针对失败的步骤换别的招。
#
# a = 正常做法；b = 失败时的备选做法（没有就留空数组）
$dpSteps = @(
  @{ n = '清只读属性';   a = @('attributes disk clear readonly'); b = @() },
  @{ n = '联机';         a = @('online disk');                   b = @() },
  @{ n = '清除分区表';   a = @('clean');                         b = @('offline disk', 'clean', 'online disk') },
  @{ n = '初始化分区表'; a = @($convert);                        b = @() },
  @{ n = '新建主分区';   a = @('create partition primary');      b = @() },
  @{ n = '格式化';       a = @('select partition 1', "format fs=$FileSystem quick"); b = @('select partition 1', "format fs=$FileSystem quick") },
  @{ n = '分配盘符';     a = @('select partition 1', 'assign');  b = @() }
)

function Invoke-DpStep([string[]]$cmds) {
  $lines = @("select disk $DiskNumber") + $cmds + @('exit')
  $tmp = Join-Path $env:TEMP ('tomato-dp-' + [Guid]::NewGuid().ToString('N') + '.txt')
  [System.IO.File]::WriteAllText($tmp, (($lines -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)
  $out = ''
  try { $out = (& diskpart.exe /s $tmp 2>&1 | Out-String) }
  catch { $out = '调用 diskpart 失败：' + $_.Exception.Message }
  finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  # DiskPart 出错不一定改退出码，靠关键字判断；成功信息里不会出现这些字
  $bad = ($out -match '(?i)(错误|失败|error|拒绝|无效|无法|不可用)')
  return @{ out = $out; bad = $bad }
}

# 先让系统重扫一遍（前面刚把盘头写零），再逐条执行
Log-Step '   正在让系统重新扫描磁盘…'
[void](Invoke-DpStep @('rescan'))

foreach ($st in $dpSteps) {
  $r = Invoke-DpStep $st.a
  if ($r.bad -and $st.b.Count -gt 0) {
    Log-Step ('   「' + $st.n + '」没成功，换一种方式再试一次…')
    $r = Invoke-DpStep $st.b
  }
  foreach ($ln in ($r.out -split "`r?`n")) {
    $t = $ln.Trim()
    # 掐掉每次都会重复的 DiskPart 开场白，日志才看得下去
    if ($t -eq '') { continue }
    if ($t -match '^(Microsoft DiskPart|Copyright|在计算机上|DiskPart 正在扫描|DiskPart 已扫描完)') { continue }
    Log-Step ('   [' + $st.n + '] ' + $t)
  }
  if ($r.bad) { Log @{ type = 'warn'; message = "步骤「$($st.n)」没成功，继续后面的步骤…" } }
  else { Log-Step ('   ✓ ' + $st.n) }
}
Log @{ type = 'progress'; percent = 92 }

# ---------------------------------------------------------------------------
# 9. 结果：有没有拿到盘符 = 能不能直接用
# ---------------------------------------------------------------------------
Start-Sleep -Seconds 2
$after = ''
try {
  $ps = @(Get-Partition -DiskNumber $DiskNumber -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter })
  if ($ps.Count -gt 0) { $after = (($ps | ForEach-Object { $_.DriveLetter }) -join ',') }
} catch { }

# diskpart 没拿到盘符：换 PowerShell 存储模块再试一次（走的是另一条管道）。
# 有些盘 diskpart 的 VDS 路径过不去、Storage cmdlets 却能成 —— 多一条命。
if ($after -eq '') {
  Log-Step 'diskpart 没拿到盘符，改用 PowerShell 存储模块再试一次…'
  try {
    $part = New-Partition -DiskNumber $DiskNumber -UseMaximumSize -AssignDriveLetter -ErrorAction Stop
    [void](Format-Volume -Partition $part -FileSystem $FileSystem -NewFileSystemLabel $Label -ErrorAction Stop)
    Log-Step ('   存储模块已重建分区并格式化（分区 #' + $part.PartitionNumber + '）')
  } catch {
    Log @{ type = 'warn'; message = "存储模块兜底也失败：$($_.Exception.Message)" }
  }
  Start-Sleep -Seconds 2
  try {
    $ps2 = @(Get-Partition -DiskNumber $DiskNumber -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter })
    if ($ps2.Count -gt 0) { $after = (($ps2 | ForEach-Object { $_.DriveLetter }) -join ',') }
  } catch { }
}

if ($after -ne '') {
  Log-Step "还原完成：磁盘 #$DiskNumber 现在是 $FileSystem 格式，盘符 $after，可以正常使用了。"
  Log @{ type = 'done'; ok = $true; letters = $after; fs = $FileSystem; percent = 100 }
} else {
  Log @{ type = 'warn'; message = '分区与格式化命令已执行，但没有检测到盘符。建议：① 拔下 U 盘等 10 秒重插；② 在「此电脑」按 F5 刷新；③ 打开磁盘管理（diskmgmt.msc）看它是否显示为「未分配」或「无媒体」；若显示「无媒体」或容量 0，多半是 U 盘主控硬件故障，软件修不了。' }
  Log @{ type = 'done'; ok = $false; letters = ''; fs = $FileSystem; percent = 100 }
}
exit 0
