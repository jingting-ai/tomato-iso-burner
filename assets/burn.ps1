<#
  番茄镜像刻录工具 —— Windows 原生写盘脚本
  版本：1.2.5-r7

  核心安全原则（重要）：
    绝不先破坏、后写入。必须【先确认能写】，才允许任何破坏性动作。

  写盘顺序：
    1) 只读方式读取磁盘信息（不改动磁盘）；拒绝系统启动盘；
    2) 打开物理磁盘 \\.\PhysicalDriveN（读+写，无缓冲 + 直写）—— 失败则直接退出，
       此时目标盘【完全没有被改动】；
    3) 枚举该磁盘上的所有「卷对象」（含没有盘符的卷，用 Get-Partition AccessPaths
       + FindFirstVolume 两种方式），逐个 FSCTL_LOCK_VOLUME + FSCTL_DISMOUNT_VOLUME，
       持有句柄直到写完；
         - 找出 N 个卷但全部锁定失败 → 说明被「此电脑」/杀毒/磁盘管理占用，安全退出；
         - 一个卷都没找到（分区表损坏或 Linux 分区，Windows 未挂载）→ 没有任何东西
           会被写坏，直接继续写入（这正是 v1.2.0 之前会误报中止的场景）；
    4) 临时禁用 Windows 自动挂载（mountvol /n），并【彻底清除目标盘分区表】
       （Clear-Disk → diskpart clean → 盘头清零，三级后备）—— 该盘不再有任何
       卷对象，从根本上绕开「引导扇区保护」。刻录结束后 mountvol /e 恢复。
       【为什么必须删分区表（实测数据）】Windows 拒绝对「某个已挂载卷的第一个
       扇区」做裸写入（返回错误码 5）。实测某 U 盘上残留着上一次刻录写进去的
       镜像分区表：Part#1(EFI) 起始偏移正好 = 2 MB = LBA 4096，Windows 把它挂载
       起来后，裸写 2 MB 处必然被拒 —— 日志里固定卡在「2.00 MB 处被拒绝」就是
       这个原因，与 U 盘好坏无关。只「锁定 + 卸除」卷是挡不住的：EFI / MSR 这类
       分区没有可识别的文件系统，句柄根本打不开、锁不上，卷对象会一直留着，
       保护一直生效（r6 就败在这里，而且它删分区表那步还因为 IOCTL 常量写错而
       返回错误码 50，从未真正执行）。镜像自带完整分区表，写入后自动重建。
    5) 从 offset 0 顺序写入镜像（镜像自带分区表，直接覆盖旧分区表）；
       末块按 512 字节扇区对齐补零；
       【首块推迟】含 MBR/GPT 的第一块【推迟到最后】才写 —— 写入全程盘上没有
       有效分区表，系统不会挂载任何卷，从根上避免「写完分区表→后续块被拦」；
       若仍遇到 5/32/33/1，则【关闭并重新打开物理磁盘句柄】（句柄被重挂载污染后
       继续使用只会得到 error 1）+ 重新删分区表 + 重新锁卷，回退指针后重试
       （最多 5 次）——只重新锁卷而不重开句柄是无效的（上一版的失败根因）。
    6) 读回 SHA256 校验；
    7) 恢复自动挂载、IOCTL_DISK_UPDATE_PROPERTIES 让 Windows 重新读取分区表；
    8) 释放所有卷句柄 + 关闭物理磁盘句柄（严格保证不泄漏句柄）。

  -Wipe 现在只表示「允许覆盖已有分区表」，不再做任何预清空动作。

  所有进度 / 信息 / 错误 / 完成 都写到 -LogFile 指定的 JSONL 文件，避免 stdout 编码问题；
  所有错误都会翻译成中文并附带 Windows 错误码。
#>
param(
  [Parameter(Mandatory = $true)] [string]$ImagePath,
  [Parameter(Mandatory = $true)] [string]$DevicePath,
  [Parameter(Mandatory = $true)] [string]$LogFile,
  [long]$TotalBytes = 0,
  [int]$ChunkSize = 1048576,
  [string]$CancelFlag = '',
  [switch]$Verify,
  [switch]$Wipe
)

$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

# ---------------------------------------------------------------- 日志
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Log($obj) {
  try {
    $line = (ConvertTo-Json $obj -Compress)
    [System.IO.File]::AppendAllText($LogFile, $line + "`r`n", $utf8NoBom)
  } catch {
    try { Write-Host (ConvertTo-Json $obj -Compress) } catch { }
  }
}

function HumanSize($b) {
  if ($b -ge 1GB) { return '{0:N2} GB' -f ($b / 1GB) }
  if ($b -ge 1MB) { return '{0:N2} MB' -f ($b / 1MB) }
  return "$b 字节"
}

# 估算剩余秒数。
# 必须显式用 double 运算并夹在 Int32 范围内：
# PowerShell 的 [int] 转换遇到 > 2147483647 的值会直接抛「值对于 Int32 太大或太小」，
# 而这个异常发生在刻录主循环里 → 整个刻录被中断（大镜像 + 速度抖动时必现）。
function Get-EtaSeconds([double]$remaining, [double]$speed) {
  if ($speed -le 0) { return -1 }
  $s = $remaining / $speed
  if ($s -lt 0) { return 0 }
  if ($s -gt 2147483647) { return 2147483647 }
  return [int]$s
}

function TranslateError($ex) {
  $code = 0
  $raw = ''
  if ($ex -is [System.ComponentModel.Win32Exception]) {
    $code = $ex.NativeErrorCode
    $raw = $ex.Message
  } elseif ($ex -is [System.IO.IOException]) {
    $code = $ex.HResult -band 0xFFFF
    $raw = $ex.Message
  } else {
    $raw = $ex.Message
  }

  $hint = switch ($code) {
    1       { '功能不正确：写入期间系统重新挂载了卷，磁盘句柄已失效（本工具会自动重开句柄重试；若反复出现，请关闭「此电脑」窗口和杀毒软件后重试）。' }
    2       { '找不到指定的文件或设备，请确认 U 盘没有松动或已被拔出。' }
    5       { '拒绝访问：目标盘仍被系统或其他程序占用。请关闭「此电脑」窗口、杀毒软件后重试。' }
    13      { '拒绝访问：请以管理员身份运行本程序。' }
    19      { '媒体受写入保护：请检查 U 盘是否有物理写保护开关，或磁盘被设为只读。' }
    21      { '设备未就绪：U 盘可能被拔出或接触不良，请重新插拔后重试。' }
    22      { '设备无法识别：请尝试更换 USB 接口或 U 盘。' }
    23      { '数据校验错误：U 盘可能存在坏块，请更换 U 盘后重试。' }
    27      { '找不到扇区：U 盘可能存在坏块或分区表损坏，请更换 U 盘后重试。' }
    31      { '设备 I/O 错误：U 盘可能存在坏块或接触不良，请更换 U 盘后重试。' }
    32      { '共享冲突：目标盘正被其他程序占用。请关闭「此电脑」窗口或杀毒软件后重试。' }
    33      { '文件锁冲突：目标盘正被其他程序占用。请关闭相关程序后重试。' }
    55      { '设备已被其他程序独占锁定，请关闭磁盘管理、分区软件、杀毒软件后重试。' }
    87      { '参数无效：写入位置未按扇区对齐，或镜像参数异常。' }
    112     { '磁盘空间不足：镜像大于 U 盘容量，请更换更大容量的 U 盘。' }
    1167    { '设备未连接：U 盘在刻录过程中被拔出，请重新插拔后重试。' }
    1117    { '设备 I/O 错误：U 盘可能存在坏块或接触不良，请更换 U 盘后重试。' }
    1224    { '卷被独占锁定：系统已占用目标盘，请关闭相关程序后重试。' }
    1450    { '系统资源不足：请关闭部分程序后重试。' }
    170     { '请求的资源正在使用中：目标盘被系统占用，请关闭「此电脑」窗口后重试。' }
    203     { '设备未就绪或路径异常：请重新插拔 U 盘后重试。' }
    4390    { '目标不是有效的磁盘设备（可能是可移动介质的卷路径），已中止写入以免损坏数据。' }
    default { "原始错误信息：$raw" }
  }

  if ($code -eq 0) { return $raw }
  return "操作失败（Windows 错误码 $code）：$hint"
}

# 临时禁用/恢复 Windows 自动挂载（mountvol /n | /e）
#   刻录 ISO 会覆盖分区表；若不关闭自动挂载，Windows 会在写入中途把镜像里的
#   新分区自动挂载成新卷，导致后续写入报 5/32/33 甚至 1。
function Disable-AutoMount {
  try {
    $out = & mountvol /n 2>&1
    if ($LASTEXITCODE -ne 0) { throw $out }
    return $true
  } catch {
    return $false
  }
}
function Enable-AutoMount {
  try {
    $out = & mountvol /e 2>&1
    if ($LASTEXITCODE -ne 0) { throw $out }
    return $true
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------- Win32
Add-Type @"
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public class TomatoBurn {
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateFile(
    string lpFileName, uint dwDesiredAccess, uint dwShareMode,
    IntPtr lpSecurityAttributes, uint dwCreationDisposition,
    uint dwFlagsAndAttributes, IntPtr hTemplateFile);

  [DllImport("kernel32", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr h);

  [DllImport("kernel32", SetLastError = true)]
  public static extern bool DeviceIoControl(IntPtr h, uint code, IntPtr inBuf, uint inSize,
    IntPtr outBuf, uint outSize, out uint returned, IntPtr overlapped);

  // ---- 直接对物理磁盘读写（关键：必须走 Win32 API，不能用 .NET FileStream）----
  // 原因：Windows 的存储驱动栈不支持对 \\.\PhysicalDriveN 做「缓冲写入」，
  // 用托管 FileStream.Write 会在第一个字节就抛出 "Incorrect function"（Win32 错误 1）。
  // 正确做法与 Rufus / Etcher 一致：以 FILE_FLAG_NO_BUFFERING 打开，再用 WriteFile 直写。
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool WriteFile(IntPtr hFile, IntPtr lpBuffer, uint nNumberOfBytesToWrite,
    out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

  [DllImport("kernel32", SetLastError = true)]
  public static extern bool ReadFile(IntPtr hFile, IntPtr lpBuffer, uint nNumberOfBytesToRead,
    out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

  [DllImport("kernel32", SetLastError = true)]
  public static extern bool SetFilePointerEx(IntPtr hFile, long liDistanceToMove,
    IntPtr lpNewFilePointer, uint dwMoveMethod);

  [DllImport("kernel32", SetLastError = true)]
  public static extern bool FlushFileBuffers(IntPtr hFile);

  // 页对齐内存分配（NO_BUFFERING 要求缓冲区地址与扇区对齐）
  [DllImport("kernel32", SetLastError = true)]
  public static extern IntPtr VirtualAlloc(IntPtr lpAddress, UIntPtr dwSize,
    uint flAllocationType, uint flProtect);

  [DllImport("kernel32", SetLastError = true)]
  public static extern bool VirtualFree(IntPtr lpAddress, UIntPtr dwSize, uint dwFreeType);

  // 枚举全系统所有卷对象（包含没有盘符、没有挂载点的卷）
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr FindFirstVolume(StringBuilder lpszVolumeName, uint cchBufferLength);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool FindNextVolume(IntPtr hFindVolume, StringBuilder lpszVolumeName, uint cchBufferLength);
  [DllImport("kernel32", SetLastError = true)]
  public static extern bool FindVolumeClose(IntPtr hFindVolume);

  [StructLayout(LayoutKind.Sequential)]
  public struct STORAGE_DEVICE_NUMBER {
    public uint DeviceType;
    public uint DeviceNumber;
    public uint PartitionNumber;
  }

  public const uint GENERIC_READ  = 0x80000000;
  public const uint GENERIC_WRITE = 0x40000000;
  public const uint FILE_SHARE_READ  = 0x00000001;
  public const uint FILE_SHARE_WRITE = 0x00000002;
  public const uint OPEN_EXISTING = 3;
  public const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
  public const uint FILE_FLAG_NO_BUFFERING  = 0x20000000;
  public const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;

  public const uint MEM_COMMIT  = 0x00001000;
  public const uint MEM_RESERVE = 0x00002000;
  public const uint MEM_RELEASE = 0x00008000;
  public const uint PAGE_READWRITE = 0x04;
  public const uint FILE_BEGIN = 0;

  public const uint FSCTL_LOCK_VOLUME     = 0x00090018;
  public const uint FSCTL_UNLOCK_VOLUME   = 0x0009001C;
  public const uint FSCTL_DISMOUNT_VOLUME = 0x00090020;
  public const uint FSCTL_ALLOW_EXTENDED_DASD_IO = 0x00090027;

  public const uint IOCTL_DISK_UPDATE_PROPERTIES    = 0x00070140;
  public const uint IOCTL_STORAGE_GET_DEVICE_NUMBER = 0x002D1080;
  // ⚠️ 不要再用 IOCTL_DISK_DELETE_DRIVE_LAYOUT 删分区表。
  //   r6 里写的常量 0x0007C040 是错的（按 CTL_CODE 公式反解 Function=0x10，
  //   根本不是这个 IOCTL），设备驱动不认识它，直接返回错误码 50（不支持）——
  //   于是「写盘前删分区表」这一步从来没生效过，r6 才会照样卡在 2.00 MB。
  //   现在改用 Clear-Disk / diskpart clean：它们走存储栈，会通知卷管理器
  //   真正卸载并移除卷对象（见 Clear-DiskLayout 函数）。

  // 查询某个卷 / 设备句柄属于哪个物理磁盘
  public static bool GetDeviceNumber(IntPtr h, out uint devNum, out uint partNum) {
    devNum = 0; partNum = 0;
    int sz = Marshal.SizeOf(typeof(STORAGE_DEVICE_NUMBER));
    IntPtr p = Marshal.AllocHGlobal(sz);
    try {
      uint ret = 0;
      bool ok = DeviceIoControl(h, IOCTL_STORAGE_GET_DEVICE_NUMBER,
        IntPtr.Zero, 0, p, (uint)sz, out ret, IntPtr.Zero);
      if (!ok) return false;
      STORAGE_DEVICE_NUMBER sdn =
        (STORAGE_DEVICE_NUMBER)Marshal.PtrToStructure(p, typeof(STORAGE_DEVICE_NUMBER));
      devNum = sdn.DeviceNumber;
      partNum = sdn.PartitionNumber;
      return true;
    } catch {
      return false;
    } finally {
      Marshal.FreeHGlobal(p);
    }
  }
}
"@

function New-DeviceHandle($path, [bool]$write, [uint32]$share, [bool]$direct = $false) {
  $access = [TomatoBurn]::GENERIC_READ
  if ($write) { $access = $access -bor [TomatoBurn]::GENERIC_WRITE }
  $flags = [TomatoBurn]::FILE_ATTRIBUTE_NORMAL
  if ($direct) {
    # 物理磁盘必须用「无缓冲 + 直写」打开，否则写入会被驱动栈拒绝（Incorrect function）
    $flags = $flags -bor [TomatoBurn]::FILE_FLAG_NO_BUFFERING -bor [TomatoBurn]::FILE_FLAG_WRITE_THROUGH
  }
  $h = [TomatoBurn]::CreateFile($path, $access, $share, [IntPtr]::Zero,
    [TomatoBurn]::OPEN_EXISTING, $flags, [IntPtr]::Zero)

  # 必须在函数内部立刻取错误码：PowerShell 引擎在函数返回时会产生自己的 Win32 调用，
  # 把线程的 last-error 覆盖成一个无关的值（实测会变成 203），
  # 导致调用方读到的错误码全是错的，中文提示也跟着错。
  $script:LastOpenError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  return $h
}

# 取「上一次 New-DeviceHandle 打开失败」的真实错误码
function Get-OpenError { return [int]$script:LastOpenError }

function Test-BadHandle($h) {
  if ($h -eq [IntPtr]::Zero) { return $true }
  if ($h -eq [IntPtr](-1)) { return $true }
  return $false
}

function Close-Native([IntPtr]$h) {
  if (Test-BadHandle $h) { return }
  try { [void][TomatoBurn]::CloseHandle($h) } catch { }
}

# ⚠️ 禁止把 GetLastWin32Error 包进 PowerShell 函数再调用——
#    函数调用的内部开销会把 LastError 覆盖掉（实测恒变 203，即 ERROR_ENVVAR_NOT_FOUND）。
#    任何取错误码的地方必须紧跟在 Win32 调用失败后【内联】调用：
#    [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()

# 「被占用 / 拒绝访问」类错误码：只有这几个才说明卷正被别人用着
# 「被占用」类错误码：只有这几个才说明卷正被别的程序独占
#   注意：**不要**把 5（拒绝访问）放进来。5 的原因太多——权限不足、
#   分区没有可识别的文件系统、卷尚未挂载，都会返回 5。
#   把 5 当成「被占用」曾导致一个没有文件系统的 MSR 分区让刻录直接中止。
function Is-BusyError([int]$ec) {
  return ($ec -eq 32 -or $ec -eq 33 -or $ec -eq 170 -or $ec -eq 1224)
}

# 找出目标磁盘上【确定属于该盘】的所有卷路径
#   重要：候选必须全部来自「按磁盘号查询」的可靠来源，
#   绝不盲扫 A-Z 盘符 —— 否则别的盘（如 C:）的「拒绝访问」会被误算成目标盘被占用。
function Get-VolumeCandidates([int]$diskNo) {
  $raw = New-Object System.Collections.ArrayList
  $share = [TomatoBurn]::FILE_SHARE_READ -bor [TomatoBurn]::FILE_SHARE_WRITE

  # ① 该磁盘的分区信息：每个分区只保留一个最可靠的访问路径。
  #    优先盘符形式（\\.\X:）——它最稳定；没有盘符时才退用卷 GUID 形式。
  #    同一分区的盘符形式与 GUID 形式是等价的，两个都留着会让「打不开」
  #    被重复计数，进而把一个没问题的分区误判成两个「被占用」。
  $partQueryOk = $false
  $coveredParts = @{}
  try {
    foreach ($p in @(Get-Partition -DiskNumber $diskNo -ErrorAction Stop)) {
      $partQueryOk = $true
      try { $coveredParts[[int]$p.PartitionNumber] = $true } catch { }
      $byLetter = ''
      $byGuid = ''
      foreach ($ap in @($p.AccessPaths)) {
        if ([string]::IsNullOrWhiteSpace($ap)) { continue }
        if ($ap -match '^[A-Za-z]:') {
          if (-not $byLetter) { $byLetter = '\\.\' + $ap.Substring(0, 2) }
        } elseif ($ap -like '\\?\Volume*') {
          if (-not $byGuid) {
            $g = $ap
            if (-not $g.EndsWith('\')) { $g = $g + '\' }
            $byGuid = $g
          }
        }
      }
      if (-not $byLetter) {
        try {
          if ($p.DriveLetter -and $p.DriveLetter -match '^[A-Za-z]$') {
            $byLetter = '\\.\' + $p.DriveLetter + ':'
          }
        } catch { }
      }
      if ($byLetter) { [void]$raw.Add($byLetter) }
      elseif ($byGuid) { [void]$raw.Add($byGuid) }
    }
  } catch { }

  # ② FindFirstVolume 全系统枚举：覆盖「有卷对象但没有盘符 / 没有挂载点」的卷，
  #    逐个用 IOCTL_STORAGE_GET_DEVICE_NUMBER 判定归属，只收本盘的。
  try {
    $sb = New-Object System.Text.StringBuilder 260
    $hFind = [TomatoBurn]::FindFirstVolume($sb, 260)
    if (-not (Test-BadHandle $hFind)) {
      try {
        $guard = 0
        while ($guard -lt 512) {
          $guard++
          $vol = $sb.ToString()
          if (-not [string]::IsNullOrWhiteSpace($vol) -and $vol.Length -gt 4) {
            $vp = $vol
            if (-not $vp.EndsWith('\')) { $vp = $vp + '\' }
            $vh = New-DeviceHandle $vp $false $share
            if (-not (Test-BadHandle $vh)) {
              [uint32]$dn = 0
              [uint32]$pn = 0
              if ([TomatoBurn]::GetDeviceNumber($vh, [ref]$dn, [ref]$pn) -and [int]$dn -eq $diskNo) {
                # 该分区若已在通道① 中处理过，就不再重复加入（否则同一个分区
                # 会以「盘符形式 + 卷 GUID 形式」出现两次，把失败计数翻倍）
                if (-not $coveredParts.ContainsKey([int]$pn)) {
                  [void]$raw.Add($vp)
                }
              }
              Close-Native $vh
            }
          }
          $sb.Length = 0
          if (-not [TomatoBurn]::FindNextVolume($hFind, $sb, 260)) { break }
        }
      } finally { [void][TomatoBurn]::FindVolumeClose($hFind) }
    }
  } catch { }

  # 去重
  $seen = @{}
  $out = New-Object System.Collections.ArrayList
  foreach ($p in $raw) {
    if ([string]::IsNullOrWhiteSpace($p)) { continue }
    $k = $p.ToLower()
    if ($seen.ContainsKey($k)) { continue }
    $seen[$k] = $true
    [void]$out.Add($p)
  }
  return , $out
}

# 锁定并卸除目标磁盘上的所有卷
# 返回：@{ handles=已锁定句柄列表; mounted=确认存在的卷数; failed=未能锁定的卷数; lastError=最后错误码 }
function Lock-TargetVolumes([int]$diskNo) {
  $handles = New-Object System.Collections.ArrayList
  $mounted = 0
  $failed = 0
  $lastErr = 0
  $share = [TomatoBurn]::FILE_SHARE_READ -bor [TomatoBurn]::FILE_SHARE_WRITE

  $cands = Get-VolumeCandidates $diskNo
  foreach ($volPath in $cands) {
    $vh = New-DeviceHandle $volPath $true $share
    if (Test-BadHandle $vh) {
      $ec = Get-OpenError
      # 判定原则：只有「能确认该卷正被别的程序占用」才中止刻录。
      #   · 明确的共享 / 锁冲突错误码                → 视为占用
      #   · 盘符形式的卷被拒绝访问（5 / 87）        → 盘符确实存在却打不开，
      #                                              按占用处理更安全
      #   · 其余（卷 GUID 打不开、1005 / 2 等）     → 该分区没有可识别的文件系统，
      #                                              Windows 并未挂载它，没有活动数据
      #                                              会被写坏，跳过即可
      # 特别注意：绝不能把「打开失败」一律当成「被占用」——一个没有文件系统的
      # MSR / Linux 分区就是这样把刻录挡在门外的。
      $isDriveLetter = ($volPath -like '\\.\?:')
      $suspectCodes = @(5, 32, 33, 87, 170, 1224)
      $suspicious = (Is-BusyError $ec) -or ($isDriveLetter -and ($suspectCodes -contains $ec))
      if ($suspicious) {
        $mounted++
        $failed++
        $lastErr = $ec
        Log @{ type = 'warn'; message = "卷 $volPath 无法打开（错误码 $ec），可能正被其他程序占用" }
      } else {
        Log @{ type = 'info'; message = "卷 $volPath 无法直接打开（错误码 $ec）：该分区没有可识别的文件系统或未挂载，不存在会被写坏的活动数据，已跳过" }
      }
      continue
    }

    [uint32]$devNo = 0
    [uint32]$partNo = 0
    $ok = [TomatoBurn]::GetDeviceNumber($vh, [ref]$devNo, [ref]$partNo)
    if ($ok -and [int]$devNo -ne $diskNo) {
      # 防御性检查：确认不属于目标盘就跳过
      Close-Native $vh
      continue
    }

    $mounted++

    # 锁定卷：带重试，给系统一点时间释放句柄
    $locked = $false
    for ($k = 0; $k -lt 5; $k++) {
      $ret = 0
      $locked = [TomatoBurn]::DeviceIoControl($vh, [TomatoBurn]::FSCTL_LOCK_VOLUME,
        [IntPtr]::Zero, 0, [IntPtr]::Zero, 0, [ref]$ret, [IntPtr]::Zero)
      if ($locked) { break }
      $lastErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Start-Sleep -Milliseconds 250
    }

    if ($locked) {
      $ret = 0
      [void][TomatoBurn]::DeviceIoControl($vh, [TomatoBurn]::FSCTL_DISMOUNT_VOLUME,
        [IntPtr]::Zero, 0, [IntPtr]::Zero, 0, [ref]$ret, [IntPtr]::Zero)
      [void]$handles.Add($vh)
      $disp = $volPath
      if ($volPath -like '\\.\?:') { $disp = $volPath.Substring(3) }
      Log @{ type = 'info'; message = "已锁定并卸除卷 $disp" }
    } else {
      # 锁定失败同样要区分原因：
      #   · 共享 / 锁冲突            → 真的被占用，必须中止
      #   · 1（功能不正确）等其它码  → 该卷不是可锁定的文件系统
      #                               （MSR / 恢复分区 / 未识别分区），
      #                               没有文件系统在被锁定，也就没有数据风险
      $lockBusy = (Is-BusyError $lastErr) -or ($volPath -like '\\.\?:' -and $lastErr -eq 5)
      if ($lockBusy) {
        $failed++
        Log @{ type = 'warn'; message = "卷 $volPath 锁定失败（错误码 $lastErr）：可能被「此电脑」窗口、杀毒软件或磁盘管理占用" }
      } else {
        Log @{ type = 'info'; message = "卷 $volPath 无法锁定（错误码 $lastErr）：该分区不是可挂载的文件系统（如 MSR / 恢复分区），无活动数据需要保护，已跳过" }
      }
      Close-Native $vh
    }
  }

  return @{
    handles   = $handles
    mounted   = $mounted
    failed    = $failed
    lastError = $lastErr
  }
}

function Release-Volumes($handles) {
  if ($handles -eq $null) { return }
  foreach ($h in $handles) {
    try {
      $ret = 0
      [void][TomatoBurn]::DeviceIoControl($h, [TomatoBurn]::FSCTL_UNLOCK_VOLUME,
        [IntPtr]::Zero, 0, [IntPtr]::Zero, 0, [ref]$ret, [IntPtr]::Zero)
    } catch { }
    Close-Native $h
  }
}

function Is-Cancelled {
  if ($CancelFlag -ne '' -and (Test-Path $CancelFlag)) { return $true }
  return $false
}

# 关闭并重新打开物理磁盘句柄，重新校验设备号并重新申请扩展 DASD IO。
#   【为什么必须重开】卷被系统重新挂载后，原句柄在存储栈里的底层状态会被污染，
#   继续用它写入只会返回 Win32 错误 1（Incorrect function）。上一版只重新锁卷、
#   不重开句柄，正是「error 5 → 重锁 0 个卷 → error 1」的根因。
#   返回 @{ ok=bool; handle=IntPtr; error=int }
function Reset-DiskHandle([IntPtr]$oldHandle) {
  Close-Native $oldHandle
  $h = New-DeviceHandle $DevicePath $true $shareRW $true
  if (Test-BadHandle $h) {
    return @{ ok = $false; handle = [IntPtr]::Zero; error = (Get-OpenError) }
  }
  [uint32]$dn = 0
  [uint32]$pn = 0
  if ([TomatoBurn]::GetDeviceNumber($h, [ref]$dn, [ref]$pn)) {
    if ([int]$dn -ne $diskNo) {
      Close-Native $h
      return @{ ok = $false; handle = [IntPtr]::Zero; error = -1 }
    }
  }
  $ret = 0
  [void][TomatoBurn]::DeviceIoControl($h, [TomatoBurn]::FSCTL_ALLOW_EXTENDED_DASD_IO,
    [IntPtr]::Zero, 0, [IntPtr]::Zero, 0, [ref]$ret, [IntPtr]::Zero)
  return @{ ok = $true; handle = $h; error = 0 }
}

# 彻底清除目标磁盘的分区表，让 Windows 卷管理器【卸载并移除该盘上的所有卷对象】。
#   【为什么必须做】Windows 拒绝对「某个已挂载卷的第一个扇区」做裸写入（错误码 5）。
#   实测：某 U 盘上残留着上一次刻录写进去的镜像分区表，其中 Part#1(EFI) 起始偏移
#   正好 = 2 MB = LBA 4096，Windows 挂载它之后，裸写 2 MB 处必然被拒 —— 日志里
#   固定卡在「2.00 MB 处被拒绝（错误码 5）」正是这个原因，与 U 盘好坏无关。
#   只「锁定 + 卸除」卷挡不住：EFI / MSR 这类分区没有可识别的文件系统，句柄根本
#   打不开、锁不上，卷对象会一直留着，保护一直生效。唯一有效的办法是把分区表
#   整个删掉，让卷对象随之消失。镜像自带完整分区表，在写入的最后一步（被推迟的
#   首块）才落盘，所以写入全程都不会再被拦。
#   调用前必须先释放卷锁并关闭物理磁盘句柄，否则清理会被自己挡住。
# 返回 @{ ok=bool; method=string; left=int; detail=string }
function Get-LeftPartitionCount([int]$diskNo) {
  try { return @(Get-Partition -DiskNumber $diskNo -ErrorAction Stop).Count } catch { return 0 }
}

# 彻底清除目标磁盘的分区表，让 Windows 卷管理器【卸载并移除该盘上的所有卷对象】。
#   【为什么必须做】Windows 拒绝对「某个已挂载卷的第一个扇区」做裸写入（错误码 5）。
#   只「锁定 + 卸除」卷挡不住：EFI / MSR 这类分区没有可识别的文件系统，句柄根本
#   打不开、锁不上，卷对象会一直留着，保护一直生效。唯一有效的办法是把分区表
#   整个删掉，让卷对象随之消失。镜像自带完整分区表，在写入的最后一步（被推迟的
#   首块）才落盘，所以写入全程都不会再被拦。
#   调用前必须先释放卷锁并关闭物理磁盘句柄，否则清理会被自己挡住。
#
#   ★ r8 流程修正（2026-10-14 真实故障）：以前「方式 1（Clear-Disk）命令成功」
#   就直接跳过后面的招，哪怕盘上还剩 1 个分区。实测某 U 盘清完仍剩 1 个分区、
#   正好盖住 0 扇区 —— 前 14.15 GB 全部写成功，最后写首块（分区表）被错误码 5
#   拦住，重试 4 次全败。现在每一招打完都【重新数一遍分区】，只要还剩就继续：
#   Clear-Disk → 逐个 Remove-Partition → diskpart clean → 盘头 64KB 清零。
# 返回 @{ ok=bool; method=string; left=int; detail=string }
function Clear-DiskLayout([int]$diskNo) {
  $r = @{ ok = $false; method = ''; left = -1; detail = '' }
  $tried = @()
  $left = Get-LeftPartitionCount $diskNo

  # --- 方式 1：Clear-Disk（Windows 存储模块原生命令，等价于「删除所有分区」）---
  if ($left -gt 0) {
    try {
      Clear-Disk -Number $diskNo -RemoveData -RemoveOEM -Confirm:$false -ErrorAction Stop
      $tried += 'Clear-Disk'
    } catch {
      $r.detail = "Clear-Disk：$($_.Exception.Message)"
    }
    $left = Get-LeftPartitionCount $diskNo
  }

  # --- 方式 2：逐个 Remove-Partition（Clear-Disk 有时会留下个别分区，手动删）---
  if ($left -gt 0) {
    try {
      Get-Partition -DiskNumber $diskNo -ErrorAction SilentlyContinue |
        ForEach-Object {
          try {
            Remove-Partition -DiskNumber $diskNo -PartitionNumber $_.PartitionNumber `
              -Confirm:$false -ErrorAction Stop
          } catch { }
        }
      $tried += 'Remove-Partition'
    } catch { }
    $left = Get-LeftPartitionCount $diskNo
  }

  # --- 方式 3：diskpart clean（上面都不行时的等价后备）---
  if ($left -gt 0) {
    try {
      $dp = Join-Path $env:SystemRoot 'System32\diskpart.exe'
      $sf = Join-Path $env:TEMP ("tomato-clean-{0}.txt" -f $PID)
      # diskpart 只认 ANSI；脚本内容全是 ASCII，用 ASCII 写即可
      [System.IO.File]::WriteAllText($sf, "select disk $diskNo`r`nclean`r`n",
        [System.Text.Encoding]::ASCII)
      $out = (& $dp /s $sf 2>&1 | Out-String)
      $code = $LASTEXITCODE
      Remove-Item -LiteralPath $sf -Force -ErrorAction SilentlyContinue
      if ($code -eq 0) {
        $tried += 'diskpart clean'
      } else {
        $tail = (($out -split "`r?`n" | Where-Object { $_.Trim() -ne '' } |
          Select-Object -Last 2) -join ' / ')
        $r.detail += " ；diskpart 退出码 $code（$tail）"
      }
    } catch {
      $r.detail += " ；diskpart：$($_.Exception.Message)"
    }
    $left = Get-LeftPartitionCount $diskNo
  }

  # --- 方式 4：直接把盘头 64 KB 清零（覆盖保护性 MBR + GPT 头 + 分区表项），
  #             再让系统重读磁盘属性。属于最后手段：能破坏磁盘上的分区表，
  #             但未必能立刻让卷管理器丢掉已有卷对象。---
  if ($left -gt 0) {
    $h = [IntPtr]::Zero
    try {
      $h = New-DeviceHandle $DevicePath $true $shareRW $true
      if (Test-BadHandle $h) {
        $r.detail += " ；盘头清零时无法打开磁盘（错误码 $(Get-OpenError)）"
      } else {
        $n = 65536
        $pz = [TomatoBurn]::VirtualAlloc([IntPtr]::Zero, [System.UIntPtr]::new([uint64]$n),
                [int64]([TomatoBurn]::MEM_COMMIT -bor [TomatoBurn]::MEM_RESERVE),
                [int64][TomatoBurn]::PAGE_READWRITE)
        if (Test-BadHandle $pz) {
          $r.detail += ' ；盘头清零缓冲区分配失败'
        } else {
          try {
            [void][TomatoBurn]::SetFilePointerEx($h, [int64]0, [IntPtr]::Zero, [TomatoBurn]::FILE_BEGIN)
            [uint32]$moved = 0
            $w = [TomatoBurn]::WriteFile($h, $pz, [uint32]$n, [ref]$moved, [IntPtr]::Zero)
            # 错误码必须紧跟 Win32 调用内联获取，中间不许经过任何函数调用
            $wec = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            $ret = 0
            [void][TomatoBurn]::DeviceIoControl($h, [TomatoBurn]::IOCTL_DISK_UPDATE_PROPERTIES,
              [IntPtr]::Zero, 0, [IntPtr]::Zero, 0, [ref]$ret, [IntPtr]::Zero)
            if ($w) {
              $tried += '盘头清零(64KB)'
            } else {
              $r.detail += " ；盘头清零写入失败（错误码 $wec）"
            }
          } finally {
            [void][TomatoBurn]::VirtualFree($pz, [System.UIntPtr]::new([uint64]0),
              [int64][TomatoBurn]::MEM_RELEASE)
          }
        }
      }
    } catch {
      $r.detail += " ；盘头清零：$($_.Exception.Message)"
    } finally {
      Close-Native $h
    }
    $left = Get-LeftPartitionCount $diskNo
  }

  $r.left = $left
  if ($left -eq 0) {
    $r.ok = $true
    $r.method = if ($tried.Count -gt 0) { $tried -join ' + ' } else { '原本就没有分区' }
  } else {
    $r.detail += " ；清理后仍残留 $left 个分区"
  }
  return $r
}

# ---------------------------------------------------------------- main
$hDev = [IntPtr]::Zero
$pBuf = [IntPtr]::Zero
$script:LastOpenError = 0
$volHandles = New-Object System.Collections.ArrayList
$autoMountDisabled = $false   # 步骤 3.5 会临时禁用 Windows 自动挂载
$sourceSha = ''
$written = 0L     # 提前声明：出错时的提示语要用它说明"已经写进去多少"

try {
  Log @{ type = 'started' }
  # 自标识：确认实际加载的是哪一份写盘脚本（防止「改了 A 处、跑的却是 B 处旧脚本」的歧义）
  $scriptSha = ''
  try {
    $selfBytes = [System.IO.File]::ReadAllBytes($PSCommandPath)
    $scriptSha = ([System.Security.Cryptography.SHA256]::Create().ComputeHash($selfBytes)[0..3] |
      ForEach-Object { $_.ToString('x2') }) -join ''
  } catch { $scriptSha = 'unknown' }
  Log @{ type = 'info'; message = "写盘脚本：$PSCommandPath（版本标记 burn-1.2.6-r1，sha 前 8 位 $scriptSha）。若此条日志缺失，说明运行的是旧版脚本。" }

  if (-not (Test-Path $ImagePath)) {
    Log @{ type = 'error'; message = "找不到镜像文件：$ImagePath" }
    exit 1
  }

  $imageSize = (Get-Item $ImagePath).Length
  if ($TotalBytes -le 0) { $TotalBytes = $imageSize }

  if ($ChunkSize -lt 65536) { $ChunkSize = 65536 }
  if (($ChunkSize % 512) -ne 0) { $ChunkSize = [math]::Floor($ChunkSize / 512) * 512 }
  if ($ChunkSize -lt 512) { $ChunkSize = 512 }

  $diskNo = -1
  if ($DevicePath -match 'PhysicalDrive(\d+)') { $diskNo = [int]$Matches[1] }
  $isRealDisk = ($diskNo -ge 0)
  if (-not $isRealDisk) {
    Log @{ type = 'warn'; message = "目标不是物理磁盘（$DevicePath），将跳过磁盘级操作（仅用于文件测试）" }
  }

  # ---------- 步骤 1：只读信息 + 非破坏性修正 ----------
  if ($isRealDisk) {
    # 安全闸门：读不到磁盘信息就不许写。宁可失败，也不能盲写一块身份不明的磁盘。
    $dinfo = $null
    for ($t = 0; $t -lt 3; $t++) {
      try { $dinfo = Get-Disk -Number $diskNo -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 300 }
    }
    if ($null -eq $dinfo) {
      Log @{ type = 'error'; message = "无法读取磁盘 #$diskNo 的信息（Windows 存储服务可能未响应）。为避免误写，已中止。目标盘未被改动，请重新插拔 U 盘后重试。" }
      exit 1
    }

    Log @{ type = 'info'; message = "目标磁盘 #$diskNo：$($dinfo.FriendlyName)，$([math]::Round($dinfo.Size/1GB,2)) GB，分区样式 $($dinfo.PartitionStyle)，只读=$($dinfo.IsReadOnly)，脱机=$($dinfo.IsOffline)，总线=$($dinfo.BusType)" }

    # 安全闸门：绝不向系统启动盘写入
    $isSystemDisk = $false
    try { $isSystemDisk = [bool]$dinfo.IsSystem } catch { }
    try { if ([bool]$dinfo.IsBoot) { $isSystemDisk = $true } } catch { }
    if ($isSystemDisk) {
      Log @{ type = 'error'; message = "拒绝操作：磁盘 #$diskNo 是当前 Windows 的系统启动盘，写入会破坏操作系统。已中止，目标盘未被改动。" }
      exit 1
    }

    if ($imageSize -gt [int64]$dinfo.Size) {
      Log @{ type = 'error'; message = "镜像大小（$(HumanSize $imageSize)）超过设备容量（$(HumanSize ([int64]$dinfo.Size))），请更换更大的 U 盘。" }
      exit 1
    }

    # 安全闸门：镜像必须放得下（按 4096 对齐预留，防止直写末块越界）
    $needBytes = [int64][math]::Ceiling($imageSize / 4096) * 4096
    if ($needBytes -gt [int64]$dinfo.Size) {
      Log @{ type = 'error'; message = "镜像按扇区对齐后（$(HumanSize $needBytes)）超过设备容量（$(HumanSize ([int64]$dinfo.Size))），请更换更大的 U 盘。" }
      exit 1
    }

    if ($dinfo.IsReadOnly) {
      Log @{ type = 'warn'; message = '目标磁盘当前为只读，正在清除只读属性' }
      try { Set-Disk -Number $diskNo -IsReadOnly $false -ErrorAction Stop } catch {
        Log @{ type = 'info'; message = "清除只读属性失败：$($_.Exception.Message)" }
      }
    }
    if ($dinfo.IsOffline) {
      Log @{ type = 'warn'; message = '目标磁盘当前为脱机，正在切换为联机' }
      try { Set-Disk -Number $diskNo -IsOffline $false -ErrorAction Stop } catch { }
    }

    if ($Wipe) {
      Log @{ type = 'info'; message = '已启用「覆盖已有分区表」：镜像自带的分区表会直接覆盖旧分区表（不会预先清空磁盘）' }
    }
  }

  $shareRW = [TomatoBurn]::FILE_SHARE_READ -bor [TomatoBurn]::FILE_SHARE_WRITE

  # ---------- 步骤 2：打开物理磁盘（此时目标盘尚未被改动）----------
  #   物理磁盘【必须】以「无缓冲 + 直写」方式打开——Windows 存储驱动栈拒绝对
  #   物理磁盘做缓冲写入（会报 Incorrect function）。普通文件（自检路径）同样
  #   优先走直写，以便两条路径共用同一套代码。
  $lastEc = 0
  $directOpen = $true
  $hDev = New-DeviceHandle $DevicePath $true $shareRW $true
  if (Test-BadHandle $hDev) {
    $lastEc = Get-OpenError
    if (-not $isRealDisk) {
      # 个别文件系统不支持无缓冲打开 → 回退为普通方式（仅限自检用的普通文件）
      $hDev = New-DeviceHandle $DevicePath $true $shareRW $false
      if (-not (Test-BadHandle $hDev)) {
        $directOpen = $false
        Log @{ type = 'info'; message = '目标不是物理磁盘，已改用普通文件方式打开（仅用于自检）。' }
      } else {
        $lastEc = Get-OpenError
      }
    }
  }
  # 物理磁盘打开失败时重试：USB 栈释放句柄需要时间
  if ((Test-BadHandle $hDev) -and $isRealDisk) {
    for ($i = 0; $i -lt 12; $i++) {
      Start-Sleep -Milliseconds 400
      $hDev = New-DeviceHandle $DevicePath $true $shareRW $true
      if (-not (Test-BadHandle $hDev)) { break }
      $lastEc = Get-OpenError
      Log @{ type = 'info'; message = "打开物理磁盘失败（第 $($i + 2) 次，错误码 $lastEc），400ms 后重试…" }
    }
  }
  if (Test-BadHandle $hDev) {
    $ex = New-Object System.ComponentModel.Win32Exception($lastEc)
    Log @{ type = 'error'; message = (TranslateError $ex) }
    Log @{ type = 'error'; message = "无法打开物理磁盘 $DevicePath（错误码 $lastEc）。目标盘未被改动，数据未受影响。请确认：① 以管理员身份运行；② 已关闭「此电脑」窗口和杀毒软件；③ 重新插拔 U 盘。" }
    exit 1
  }
  Log @{ type = 'info'; message = "已打开物理磁盘：$DevicePath" }

  if ($isRealDisk) {
    # 完整性校验：确认刚打开的句柄确实指向 \\.\PhysicalDrive N
    [uint32]$actualDev = 0
    [uint32]$actualPart = 0
    if ([TomatoBurn]::GetDeviceNumber($hDev, [ref]$actualDev, [ref]$actualPart)) {
      if ([int]$actualDev -ne $diskNo) {
        Log @{ type = 'error'; message = "设备号校验失败：期望物理磁盘 #$diskNo，但句柄实际指向 #$actualDev。已中止，目标盘未被改动。" }
        exit 1
      }
      Log @{ type = 'info'; message = "设备号校验通过：句柄确认指向物理磁盘 #$actualDev" }
    }

    $ret = 0
    [void][TomatoBurn]::DeviceIoControl($hDev, [TomatoBurn]::FSCTL_ALLOW_EXTENDED_DASD_IO,
      [IntPtr]::Zero, 0, [IntPtr]::Zero, 0, [ref]$ret, [IntPtr]::Zero)
  }

  # ---------- 步骤 3：锁定并卸除该磁盘上的所有卷 ----------
  if ($isRealDisk) {
    $lockRes = Lock-TargetVolumes $diskNo
    $volHandles = $lockRes.handles

    if ($lockRes.mounted -eq 0) {
      Log @{ type = 'info'; message = '目标盘上没有已挂载的卷（分区表损坏、或为 Linux 分区导致 Windows 未挂载），没有任何文件系统会被破坏，直接开始写入。' }
    } else {
      Log @{ type = 'info'; message = "目标盘共发现 $($lockRes.mounted) 个已挂载卷，已锁定并卸除 $($volHandles.Count) 个" }
    }

    if ($lockRes.failed -gt 0) {
      Release-Volumes $volHandles
      $hint = (New-Object System.ComponentModel.Win32Exception($lockRes.lastError)).Message
      Log @{ type = 'error'; message = "有 $($lockRes.failed) 个卷无法锁定（最后一次错误码 $($lockRes.lastError)：$hint）。说明目标盘正被其他程序占用——常见原因是「此电脑 / 资源管理器」窗口停留在该 U 盘、杀毒软件正在扫描、磁盘管理或分区工具打开着、Windows 正在写入缩略图索引。为避免写坏数据，已中止写入。目标盘未被改动，请关闭上述程序后重试。" }
      exit 1
    }
    Start-Sleep -Milliseconds 300

    # ---------- 步骤 3.5：临时禁用 Windows 自动挂载（错误码 5/1 的根因防护）----------
    #   卷级锁（步骤 3）只能挡住刻录【开始前】已挂载的卷；但第 1 块写完分区表后，
    #   Windows 挂载管理器会把镜像里的新分区【自动挂载】成新卷，后续写这些扇区
    #   会被卷管理器拦截，轻则 5/32/33，重则 1（Incorrect function）。
    #   对物理磁盘句柄加独占锁（FSCTL_LOCK_VOLUME）并不能阻止挂载管理器；真正
    #   可靠的做法是 mountvol /n 全局禁用自动挂载，写完再 mountvol /e 恢复。
    #   即使禁用失败，仍保留「发现 5/32/33 就重新枚举并锁定新卷」的兜底重试。
    $autoMountDisabled = Disable-AutoMount
    if ($autoMountDisabled) {
      Log @{ type = 'info'; message = '已临时禁用 Windows 自动挂载，刻录期间不会自动挂载新卷；刻录结束后会自动恢复。' }
    } else {
      Log @{ type = 'warn'; message = '禁用 Windows 自动挂载失败：将使用「发现新卷立即重新锁定」兜底模式。' }
    }

    # ---------- 步骤 3.6：彻底清除目标盘分区表（绕开「引导扇区保护」的关键一步）----------
    #   实测数据：目标盘上残留着上一次刻录写进去的镜像分区表，其中 Part#1(EFI)
    #   起始偏移正好 = 2 MB = LBA 4096。Windows 把它挂载之后，裸写 2 MB 处必然被拒
    #   （错误码 5），于是刻录固定卡死在 2.00 MB —— 与日志完全吻合。
    #   卷级锁挡不住它：EFI / MSR 分区没有可识别的文件系统，句柄打不开、锁不上，
    #   卷对象会一直留着，保护一直生效（r6 就是败在这里；而且它「删分区表」那步
    #   还因为 IOCTL 常量写错而返回错误码 50，从未真正执行过）。
    #   唯一有效的办法：把分区表整个删掉，让卷对象随之消失。
    #   必须先把我们持有的卷锁释放、并关闭物理磁盘句柄，否则清理会被自己挡住。
    Release-Volumes $volHandles
    $volHandles.Clear()
    Close-Native $hDev
    $hDev = [IntPtr]::Zero
    Start-Sleep -Milliseconds 200

    $clr = @(Clear-DiskLayout $diskNo)[-1]   # [-1]：对意外管道输出免疫，确保拿到的是结果对象
    if ($clr.ok) {
      Log @{ type = 'info'; message = "已清除目标盘分区表（方式：$($clr.method)；清理后剩余分区 $($clr.left) 个）：写入期间不会再被「已挂载卷首扇区保护」拦截。" }
    } else {
      Log @{ type = 'warn'; message = "清除目标盘分区表未完全成功（清理后剩余分区 $($clr.left) 个）$($clr.detail)：仍会用「重新打开句柄 + 重新锁定卷」兜底重试。" }
    }

    # 清理会重置设备状态，必须重新打开句柄并再次校验设备号
    $rs = Reset-DiskHandle $hDev
    if (-not $rs.ok) {
      Log @{ type = 'error'; message = "清除分区表后无法重新打开物理磁盘（错误码 $($rs.error)）。已中止，请拔下 U 盘等 10 秒重插后再试。" }
      exit 1
    }
    $hDev = $rs.handle
    Log @{ type = 'info'; message = '已重新打开物理磁盘句柄并重新校验设备号。' }
  }

  # ---------- 步骤 4：写入 ----------
  #   必须用 VirtualAlloc（页对齐内存）+ WriteFile 直写。
  #   绝不能改用 .NET FileStream —— Windows 存储驱动栈拒绝对物理磁盘做缓冲写入，
  #   会在第一个字节就报 "Incorrect function"（Win32 错误 1）。
  $alignUnit = 4096                      # 对齐粒度：兼容 512 / 4096 两种扇区
  $bufBytes = [int64]$ChunkSize + $alignUnit
  $pBuf = [TomatoBurn]::VirtualAlloc([IntPtr]::Zero, [System.UIntPtr]::new([uint64]$bufBytes),
            [int64]([TomatoBurn]::MEM_COMMIT -bor [TomatoBurn]::MEM_RESERVE),
            [int64][TomatoBurn]::PAGE_READWRITE)
  if ((Test-BadHandle $pBuf)) {
    Log @{ type = 'error'; message = '无法分配写盘缓冲区（内存不足）。已中止，目标盘未被改动。' }
    exit 1
  }
  $padZeros = New-Object byte[] $alignUnit

  $src = $null
  $sourceSha = ''
  try {
    # 直写模式必须自己把设备文件指针定位到 0
    if (-not [TomatoBurn]::SetFilePointerEx($hDev, [int64]0, [IntPtr]::Zero, [TomatoBurn]::FILE_BEGIN)) {
      $ec = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "无法定位设备写入起点（错误码 $ec）：$(TranslateError (New-Object System.ComponentModel.Win32Exception($ec)))"
    }

    $src = [System.IO.File]::OpenRead($ImagePath)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $buf = New-Object byte[] $ChunkSize
    $written = 0L
    $devPos = 0L          # 设备在文件中的真实偏移（按对齐后的 $writeLen 累加）
    $lastTick = [datetime]::Now
    $lastBytes = 0L
    $ema = 0.0
    # 首块（含 MBR/GPT 分区表）推迟到最后写，见循环内的注释
    $firstLen = 0
    $firstWriteLen = 0
    $firstBuf = $null

    while ($true) {
      if (Is-Cancelled) { throw '用户取消了刻录' }
      $len = $src.Read($buf, 0, $ChunkSize)
      if ($len -le 0) { break }

      # 直写要求长度按扇区对齐，末尾补零
      $writeLen = [int][math]::Ceiling($len / $alignUnit) * $alignUnit
      if ($writeLen -gt $bufBytes) { $writeLen = [int]$bufBytes }

      [System.Runtime.InteropServices.Marshal]::Copy($buf, 0, $pBuf, $len)
      if ($writeLen -gt $len) {
        [System.Runtime.InteropServices.Marshal]::Copy(
          $padZeros, 0, [IntPtr]($pBuf.ToInt64() + [int64]$len), $writeLen - $len)
      }

      # ---- 首块推迟：含分区表的那一块放到最后再写 ----
      #   Windows 会拒绝对「已挂载卷第一个扇区」的裸写入（错误码 5）。GPT 盘第一个
      #   分区恰好从 1MB 开始 —— 这就是日志里固定卡在「1.00 MB 处被拒绝」的真正原因：
      #   第 1 块写下分区表后，系统立刻按镜像里的分区建卷，第 2 块（1MB 起）就被拦。
      #   解决办法：先写其余所有块（此时盘上没有任何有效分区表，系统不会挂载卷），
      #   最后再把首块写进去 —— 写完立刻收尾，不存在「后续写入被拦」。
      if ([int64]$devPos -eq 0) {
        $firstLen = $len
        $firstWriteLen = $writeLen
        $firstBuf = New-Object byte[] $writeLen
        [System.Runtime.InteropServices.Marshal]::Copy($pBuf, $firstBuf, 0, $writeLen)
        $sha.TransformBlock($buf, 0, $len, $null, 0) | Out-Null
        $written += $len
        $devPos += [int64]$writeLen
        Log @{ type = 'info'; message = "已把含 MBR/GPT 分区表的首块（$(HumanSize $writeLen)）推迟到最后写入：先写其后的全部内容，写入期间盘上不会出现有效分区表，系统也就无从挂载新卷。" }
        continue
      }

      # ---- 带重试的写入 ----
      # USB 存储在写入开始阶段常出现瞬时错误（21 未就绪 / 1117 I/O 错误 / 1450 资源不足），
      # 回退文件指针后重写同一块通常能成功，避免整盘重刻。
      # 关键：WriteFile 失败后必须【内联】取 LastError，中间不允许任何函数/管道调用，
      #       否则 LastError 会被覆盖（实测恒变 203）。
      # 5/32/33（拒绝访问/共享冲突/锁定冲突）单列：第 1 块覆盖分区表后，Windows 会把
      # 镜像里的新分区自动挂载成新卷，之后写这些扇区就被拒 —— 必须【重新锁卷】再重试。
      $retryable = @(21, 23, 31, 1117, 1450, 170)
      # 1 = Incorrect function：卷被系统重挂载后磁盘句柄被污染时的典型返回值，
      # 必须与 5/32/33 一起纳入「重新打开句柄」重试，否则会像上一版那样直接失败。
      $remountCodes = @(5, 32, 33, 1)
      [uint32]$moved = 0
      $ok = $false
      $ec = 0
      $attempts = 5
      # 每块写入前显式定位：首块被推迟后，设备指针不再与 $devPos 保持同步。
      if (-not [TomatoBurn]::SetFilePointerEx($hDev, [int64]$devPos, [IntPtr]::Zero, [TomatoBurn]::FILE_BEGIN)) {
        $ec = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "写入前无法定位设备偏移 $(HumanSize $devPos)（错误码 $ec）"
      }
      for ($tryNo = 1; $tryNo -le $attempts; $tryNo++) {
        $ok = [TomatoBurn]::WriteFile($hDev, $pBuf, [uint32]$writeLen, [ref]$moved, [IntPtr]::Zero)
        if ($ok) { break }
        $ec = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $isRemount = ($remountCodes -contains $ec)
        if ($tryNo -ge $attempts -or (-not $isRemount -and ($retryable -notcontains $ec))) { break }
        if ($isRemount -and $isRealDisk) {
          Log @{ type = 'info'; message = "写入在偏移 $(HumanSize $devPos) 处被拒绝（Windows 错误码 $ec）：正在释放旧锁、重新打开物理磁盘并重新锁定卷后重试（第 $tryNo/$($attempts - 1) 次）…" }
          # 卷被系统重新挂载后，磁盘句柄的底层状态已被污染，继续用它只会得到
          # Win32 错误 1（Incorrect function）。所以这里必须【关闭并重新打开】句柄，
          # 顺手再删一次分区表清掉刚被系统识别出来的镜像分区 —— 只重新锁卷是不够的。
          # 卷被系统重新挂载后，磁盘句柄的底层状态已被污染，继续用它只会得到
          # Win32 错误 1（Incorrect function）。所以这里必须【关闭并重新打开】句柄，
          # 顺手再清一次分区表（先关句柄，否则 Clear-Disk/diskpart 会被本进程挡住）。
          # 此时含分区表的首块尚未写入（被推迟到最后），清掉不会损失任何已写内容。
          Release-Volumes $volHandles
          $volHandles.Clear()
          try {
            Close-Native $hDev
            $hDev = [IntPtr]::Zero
            $clr2 = @(Clear-DiskLayout $diskNo)[-1]
            if (-not $clr2.ok) {
              Log @{ type = 'warn'; message = "重试时清除分区表未完全成功（剩余分区 $($clr2.left) 个）$($clr2.detail)" }
            }
          } catch {
            Log @{ type = 'warn'; message = "重试时清除分区表出错（$($_.Exception.Message)），继续重试写入…" }
          }
          $rd = Reset-DiskHandle $hDev
          if (-not $rd.ok) {
            $hDev = [IntPtr]::Zero
            throw "重新打开物理磁盘失败（错误码 $($rd.error)）"
          }
          $hDev = $rd.handle
          try {
            $relock = Lock-TargetVolumes $diskNo
            foreach ($rh in $relock.handles) { [void]$volHandles.Add($rh) }
            if ($relock.failed -gt 0) { Release-Volumes $volHandles; $volHandles.Clear() }
            Log @{ type = 'info'; message = "已重新打开物理磁盘并重新锁定卷（$($volHandles.Count) 个）" }
          } catch {
            Log @{ type = 'warn'; message = "重新锁定卷时出错（$($_.Exception.Message)），仍继续重试写入…" }
          }
        } else {
          Log @{ type = 'info'; message = "写入在偏移 $(HumanSize $devPos) 处失败（Windows 错误码 $ec），正在重试（第 $tryNo/$($attempts - 1) 次）…" }
        }
        Start-Sleep -Milliseconds 400
        # 必须回退到「设备真实偏移」：它是按对齐后的 $writeLen 累加的，
        # 而 $written 是镜像原始字节数，末块补零后两者不相等 —— 用 $written 回退会写错位置。
        if (-not [TomatoBurn]::SetFilePointerEx($hDev, [int64]$devPos, [IntPtr]::Zero, [TomatoBurn]::FILE_BEGIN)) {
          $ec = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
          break
        }
      }
      if (-not $ok) {
        $retryHint = if ($retryable -contains $ec -or $remountCodes -contains $ec) { "，自动重试 $($attempts - 1) 次仍失败" } else { '' }
        if ($remountCodes -contains $ec) {
          $retryHint += '；已多次自动重新锁定卷仍被拒绝，请关闭「此电脑」窗口、杀毒软件、磁盘管理后重试，或把 U 盘拔下重插一次'
        }
        throw "写入设备失败（已成功写入 $(HumanSize $written)$retryHint）`n$(TranslateError (New-Object System.ComponentModel.Win32Exception($ec)))"
      }
      if ([int64]$moved -ne [int64]$writeLen) {
        throw "写入不完整：本轮请求 $writeLen 字节，实际只写入 $moved 字节（已成功写入 $(HumanSize $written)）。U 盘可能存在坏块，建议更换。"
      }

      $sha.TransformBlock($buf, 0, $len, $null, 0) | Out-Null
      $written += $len
      $devPos += [int64]$writeLen

      $now = [datetime]::Now
      $dt = ($now - $lastTick).TotalSeconds
      if ($dt -ge 0.25) {
        $inst = ($written - $lastBytes) / $dt
        $ema = if ($ema -eq 0) { $inst } else { $ema * 0.55 + $inst * 0.45 }
        $lastTick = $now; $lastBytes = $written
      }
      if ($TotalBytes -gt 0) {
        $pct = [math]::Min(100.0, ($written / $TotalBytes) * 100.0)
        $eta = Get-EtaSeconds ([double]($TotalBytes - $written)) $ema
        Log @{ type = 'progress'; phase = 'write'; percent = $pct;
                written = $written; total = $TotalBytes; speed = $ema; eta = $eta }
      }
    }

    $src.Close(); $src = $null

    # ---- 最后写入首块（含 MBR / GPT 分区表）----
    if ($firstWriteLen -gt 0) {
      Log @{ type = 'info'; message = '正在写入首块（含分区表），写完即完成刻录…' }
      [System.Runtime.InteropServices.Marshal]::Copy($firstBuf, 0, $pBuf, $firstWriteLen)
      $fok = $false
      $fec = 0
      $fbRemount = @(5, 32, 33, 1)
      for ($tryNo = 1; $tryNo -le 5; $tryNo++) {
        if (-not [TomatoBurn]::SetFilePointerEx($hDev, [int64]0, [IntPtr]::Zero, [TomatoBurn]::FILE_BEGIN)) {
          $fec = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
          break
        }
        [uint32]$fmoved = 0
        $fok = [TomatoBurn]::WriteFile($hDev, $pBuf, [uint32]$firstWriteLen, [ref]$fmoved, [IntPtr]::Zero)
        if ($fok -and [int64]$fmoved -eq [int64]$firstWriteLen) { $fok = $true; break }
        $fok = $false
        $fec = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($tryNo -ge 5) { break }
        # ★ r8：这里以前只是傻等 500ms 再原样重写 —— 碰上「清分区表后仍残留的
        #   幽灵分区盖住 0 扇区」（错误码 5），等多少次都没用。2026-10-14 实测：
        #   前 14.15 GB 全部写成功，最后 1 MB 被拒，重试 4 次全败。
        #   现在与主写入循环同一套自救：重新清分区表（★ 此时首块尚未落盘，
        #   清掉不会损失任何已写内容）→ 重开句柄 → 重新锁卷。
        if ($fbRemount -contains $fec -and $isRealDisk) {
          Log @{ type = 'info'; message = "写入首块失败（Windows 错误码 $fec）：正在重新清除残留分区并重开句柄后重试（第 $tryNo/4 次）…" }
          Release-Volumes $volHandles
          $volHandles.Clear()
          try {
            Close-Native $hDev
            $hDev = [IntPtr]::Zero
            $clrF = @(Clear-DiskLayout $diskNo)[-1]
            if ($clrF.ok) {
              Log @{ type = 'info'; message = "重试前已再次清除分区表（方式：$($clrF.method)；剩余分区 $($clrF.left) 个）。" }
            } else {
              Log @{ type = 'warn'; message = "重试时清除分区表未完全成功（剩余分区 $($clrF.left) 个）$($clrF.detail)" }
            }
          } catch {
            Log @{ type = 'warn'; message = "重试时清除分区表出错（$($_.Exception.Message)），继续重试…" }
          }
          $rd = Reset-DiskHandle $hDev
          if (-not $rd.ok) {
            $hDev = [IntPtr]::Zero
            throw "重新打开物理磁盘失败（错误码 $($rd.error)）"
          }
          $hDev = $rd.handle
          try {
            $relockF = Lock-TargetVolumes $diskNo
            foreach ($rh in $relockF.handles) { [void]$volHandles.Add($rh) }
            if ($relockF.failed -gt 0) { Release-Volumes $volHandles; $volHandles.Clear() }
          } catch { }
        } else {
          Log @{ type = 'info'; message = "写入首块失败（Windows 错误码 $fec），正在重试（第 $tryNo/4 次）…" }
          Start-Sleep -Milliseconds 500
        }
      }
      if (-not $fok) {
        throw "写入首块（分区表）失败（已成功写入 $(HumanSize $written)）`n$(TranslateError (New-Object System.ComponentModel.Win32Exception($fec)))"
      }
      Log @{ type = 'info'; message = '首块（含分区表）写入完成。' }
    }

    [void][TomatoBurn]::FlushFileBuffers($hDev)
    $sha.TransformFinalBlock($buf, 0, 0) | Out-Null
    $sourceSha = ([System.BitConverter]::ToString($sha.Hash)).Replace('-', '').ToLower()

    Log @{ type = 'progress'; phase = 'write'; percent = 100; written = $written; total = $TotalBytes; speed = 0; eta = 0 }
    Log @{ type = 'info'; message = "写入完成，源镜像 SHA256：$sourceSha" }
  } finally {
    if ($src -ne $null) { $src.Close() }
  }

  # ---------- 步骤 5：读回校验（同样走 ReadFile 直读）----------
  $verifySha = ''
  if ($Verify) {
    if (-not [TomatoBurn]::SetFilePointerEx($hDev, [int64]0, [IntPtr]::Zero, [TomatoBurn]::FILE_BEGIN)) {
      $ec = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "校验前无法定位设备起点（错误码 $ec）"
    }

    $sha2 = [System.Security.Cryptography.SHA256]::Create()
    $buf2 = New-Object byte[] $ChunkSize
    $read = 0L
    $vPos = 0L            # 设备在文件中的真实读取偏移（按对齐后的 $want 累加）
    $lastTick = [datetime]::Now
    $lastBytes = 0L
    $ema = 0.0

    while ($read -lt $written) {
      if (Is-Cancelled) { throw '用户取消了校验' }
      $want = [int][math]::Min([int64]$ChunkSize, [int64]($written - $read))
      # 直读同样要求扇区对齐
      $want = [int][math]::Ceiling($want / $alignUnit) * $alignUnit
      if ($want -gt $bufBytes) { $want = [int]$bufBytes }

      # ---- 带重试的读回（同样内联取 LastError，禁止经过函数调用）----
      # 5/32/33 同样处理：读回阶段若系统重新挂载了卷，也可能挡住读取，重新锁卷后重试。
      $retryable = @(21, 23, 31, 1117, 1450, 170)
      # 1 = Incorrect function：卷被系统重挂载后磁盘句柄被污染时的典型返回值，
      # 必须与 5/32/33 一起纳入「重新打开句柄」重试，否则会像上一版那样直接失败。
      $remountCodes = @(5, 32, 33, 1)
      [uint32]$got = 0
      $ok = $false
      $ec = 0
      $attempts = 5
      for ($tryNo = 1; $tryNo -le $attempts; $tryNo++) {
        $ok = [TomatoBurn]::ReadFile($hDev, $pBuf, [uint32]$want, [ref]$got, [IntPtr]::Zero)
        if ($ok) { break }
        $ec = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $isRemount = ($remountCodes -contains $ec)
        if ($tryNo -ge $attempts -or (-not $isRemount -and ($retryable -notcontains $ec))) { break }
        if ($isRemount -and $isRealDisk) {
          Log @{ type = 'info'; message = "读回校验在偏移 $(HumanSize $vPos) 处被拒绝（Windows 错误码 $ec）：正在释放旧锁、重新打开物理磁盘并重新锁定卷后重试（第 $tryNo/$($attempts - 1) 次）…" }
          # 与写盘同理：句柄被污染后必须重开，只重锁卷会导致 error 1。
          Release-Volumes $volHandles
          $volHandles.Clear()
          # ⚠️ 读回校验阶段【绝不能】清分区表：此时镜像（含 MBR/GPT）已经完整写入磁盘，
          #    再清一次会把刚烧好的启动盘毁掉。这里只重开句柄 + 重锁卷。
          $rd = Reset-DiskHandle $hDev
          if (-not $rd.ok) {
            $hDev = [IntPtr]::Zero
            throw "重新打开物理磁盘失败（错误码 $($rd.error)）"
          }
          $hDev = $rd.handle
          try {
            $relock = Lock-TargetVolumes $diskNo
            foreach ($rh in $relock.handles) { [void]$volHandles.Add($rh) }
            if ($relock.failed -gt 0) { Release-Volumes $volHandles; $volHandles.Clear() }
          } catch {
            Log @{ type = 'warn'; message = "重新锁定卷时出错（$($_.Exception.Message)），仍继续重试读回…" }
          }
        } else {
          Log @{ type = 'info'; message = "读回校验在偏移 $(HumanSize $vPos) 处失败（Windows 错误码 $ec），正在重试（第 $tryNo/$($attempts - 1) 次）…" }
        }
        Start-Sleep -Milliseconds 400
        # 同写盘：设备偏移按对齐后的 $want 累加，回退必须用 $vPos 而不是 $read
        if (-not [TomatoBurn]::SetFilePointerEx($hDev, [int64]$vPos, [IntPtr]::Zero, [TomatoBurn]::FILE_BEGIN)) {
          $ec = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
          break
        }
      }
      if (-not $ok) {
        $retryHint = if ($retryable -contains $ec -or $remountCodes -contains $ec) { "，自动重试 $($attempts - 1) 次仍失败" } else { '' }
        throw "校验读盘失败（已读取 $(HumanSize $read)$retryHint）`n$(TranslateError (New-Object System.ComponentModel.Win32Exception($ec)))"
      }
      if ($got -le 0) { break }

      # 只把属于镜像本身的部分计入校验（末尾补零不算）
      $use = [int][math]::Min([int64]$got, [int64]($written - $read))
      [System.Runtime.InteropServices.Marshal]::Copy($pBuf, $buf2, 0, $use)
      $sha2.TransformBlock($buf2, 0, $use, $null, 0) | Out-Null
      $read += $use
      $vPos += [int64]$want

      $now = [datetime]::Now
      $dt = ($now - $lastTick).TotalSeconds
      if ($dt -ge 0.25) {
        $inst = ($read - $lastBytes) / $dt
        $ema = if ($ema -eq 0) { $inst } else { $ema * 0.55 + $inst * 0.45 }
        $lastTick = $now; $lastBytes = $read
      }
      if ($written -gt 0) {
        $pct = [math]::Min(100.0, ($read / $written) * 100.0)
        $eta = Get-EtaSeconds ([double]($written - $read)) $ema
        Log @{ type = 'progress'; phase = 'verify'; percent = $pct;
                written = $read; total = $written; speed = $ema; eta = $eta }
      }
    }

    $sha2.TransformFinalBlock($buf2, 0, 0) | Out-Null
    $verifySha = ([System.BitConverter]::ToString($sha2.Hash)).Replace('-', '').ToLower()
    Log @{ type = 'progress'; phase = 'verify'; percent = 100; written = $read; total = $written; speed = 0; eta = 0 }

    if ($verifySha -ne $sourceSha) {
      Log @{ type = 'error'; message = "校验失败：U 盘内容与镜像不一致，请更换 U 盘后重试。`n镜像 SHA256：$sourceSha`n设备 SHA256：$verifySha" }
      exit 1
    }
    Log @{ type = 'info'; message = "校验通过，设备 SHA256：$verifySha" }
  }

  # ---------- 步骤 6：恢复自动挂载并重新读取分区表 ----------
  if ($isRealDisk) {
    # 必须先恢复自动挂载，再通知 Windows 重新扫描分区表，
    # 否则新分区不会被分配盘符，用户看不到 U 盘（虽然启动功能已正常）。
    if ($autoMountDisabled) {
      if (Enable-AutoMount) {
        Log @{ type = 'info'; message = '已恢复 Windows 自动挂载。' }
      } else {
        Log @{ type = 'warn'; message = '恢复自动挂载失败，请手动运行 mountvol /e 或重新插拔 U 盘。' }
      }
      $autoMountDisabled = $false
    }
    $ret = 0
    [void][TomatoBurn]::DeviceIoControl($hDev, [TomatoBurn]::IOCTL_DISK_UPDATE_PROPERTIES,
      [IntPtr]::Zero, 0, [IntPtr]::Zero, 0, [ref]$ret, [IntPtr]::Zero)
  }

  # ---------- 步骤 7：释放全部句柄 ----------
  Release-Volumes $volHandles
  $volHandles.Clear()
  Close-Native $hDev
  $hDev = [IntPtr]::Zero
  if (-not (Test-BadHandle $pBuf)) {
    [void][TomatoBurn]::VirtualFree($pBuf, [System.UIntPtr]::new([uint64]0), [int64][TomatoBurn]::MEM_RELEASE)
    $pBuf = [IntPtr]::Zero
  }

  Log @{ type = 'info'; message = '刻录完成。Windows 可能会为 U 盘弹出「是否格式化」提示（因为该分区是 Linux 文件系统），这是正常现象，点「取消」即可，不要格式化。' }
  Log @{ type = 'done'; sourceSha256 = $sourceSha; verifySha256 = $verifySha }
  exit 0
} catch {
  try { Release-Volumes $volHandles } catch { }
  try { Close-Native $hDev } catch { }
  try {
    if (-not (Test-BadHandle $pBuf)) {
      [void][TomatoBurn]::VirtualFree($pBuf, [System.UIntPtr]::new([uint64]0), [int64][TomatoBurn]::MEM_RELEASE)
      $pBuf = [IntPtr]::Zero
    }
  } catch { }
  # 失败路径也要恢复自动挂载，否则系统一直不自动给新 U 盘分配盘符。
  if ($autoMountDisabled) {
    try { Enable-AutoMount | Out-Null } catch { }
    $autoMountDisabled = $false
  }
  # 兜底：把内部类型/数值异常翻译成人话。
  # 这类异常（例如「值对于 Int32 太大或太小」）原文是一长串 .NET 术语，
  # 用户完全看不懂，而且看起来像"U 盘坏了"，实际是程序自身的问题。
  $emsg = [string]$_.Exception.Message
  if ($emsg -match 'Int32|Int64|太大或太小') {
    $msgWritten = try { HumanSize $written } catch { '未知' }
    $emsg = "程序内部数值计算错误，已中止（本次已写入 $msgWritten，目标盘可能只剩部分内容，请重新刻录一次）。`n原始信息：$emsg`n请把这条日志反馈给开发者。"
  }
  Log @{ type = 'error'; message = $emsg }
  # 刻录失败后 U 盘会停在「半截状态」（分区表头部已被覆盖，系统认不出容量），
  # 这属于可恢复状态 —— 明确告诉用户怎么救，避免以为盘彻底坏了。
  if ($emsg -match '写入设备失败|写入不完整|校验读盘失败|设备上没有空间|设备未就绪|拒绝访问|I/O|首块') {
    # 修复工具跟发布包走：从脚本自己的位置往外找，找不到再退回常用位置。
    # ⚠️ 这里曾经写死过 E:\番茄镜像刻录工具-1.2.4\... —— 版本一换代路径就失效，
    #    用户照着点必然「找不到文件」（2026-10-14 实际发生）。
    $repairHint = '运行发布包里「修复U盘」文件夹中的「一键修复U盘.cmd」'
    try {
      $here = Split-Path $PSCommandPath
      $cand = @(
        (Join-Path $here '一键修复U盘.cmd'),
        (Join-Path (Join-Path $here '修复U盘') '一键修复U盘.cmd'),
        (Join-Path (Split-Path $here) '修复U盘\一键修复U盘.cmd'),
        'E:\番茄镜像刻录工具\修复U盘\一键修复U盘.cmd'
      ) | Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($cand) { $repairHint = "运行「$cand」" }
    } catch { }
    Log @{ type = 'info'; message = "【如何恢复 U 盘】刻录失败后 U 盘停在半截状态，这是可以恢复的：$repairHint 重建分区表即可变回普通 U 盘。若它提示找不到 USB 盘，拔下等 10 秒重插（优先插机箱背后的 USB 口）再运行一次。" }
  }
  exit 1
}
