<#
  番茄镜像刻录工具 —— U 盘一键修复

  用途：刻录失败后 U 盘变成「未知容量 / RAW / 无法访问」时，重建分区表并格式化，恢复正常。

  安全设计：
    * 必须管理员权限；
    * 绝对拒绝系统盘 / 启动盘 / 含 C: 的磁盘；
    * 可用 -ExpectedSizeGB 校验容量，防止选错盘；
    * 操作前打印清单并要求确认（-Force 可跳过）。

  用法：
    # 只看磁盘列表（不需要管理员）
    powershell -ExecutionPolicy Bypass -File repair-usb-auto.ps1 -List
    # 自动识别 USB 盘并修复（推荐双击「一键修复U盘.cmd」）
    powershell -ExecutionPolicy Bypass -File repair-usb-auto.ps1
    # 手动指定 2 号盘，并校验容量约 58GB
    powershell -ExecutionPolicy Bypass -File repair-usb-auto.ps1 -DiskNumber 2 -ExpectedSizeGB 58 -Force
#>
param(
  [switch]$List,
  [int]$DiskNumber = -1,
  [double]$ExpectedSizeGB = 0,
  [string]$FileSystem = 'exfat',
  [string]$Label = 'USB',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

# 日志同时落盘：提权运行的新窗口看不到输出，靠这个文件回读
$script:TomatoLogFile = if ($env:TOMATO_REPAIR_LOG) { $env:TOMATO_REPAIR_LOG } else { Join-Path $env:TEMP 'tomato-repair-latest.log' }
try { if (Test-Path $script:TomatoLogFile) { Remove-Item $script:TomatoLogFile -Force -ErrorAction SilentlyContinue } } catch { }
try { "[$(Get-Date -Format s)] Tomato USB Repair start" | Out-File -FilePath $script:TomatoLogFile -Encoding utf8 } catch { }

function Say($text, $color = 'Gray') {
  Write-Host $text -ForegroundColor $color
  try { [string]$text | Out-File -Append -FilePath $script:TomatoLogFile -Encoding utf8 } catch { }
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Rows {
  $rows = @()
  foreach ($d in (Get-Disk -ErrorAction SilentlyContinue | Sort-Object Number)) {
    $letters = @()
    try {
      foreach ($p in @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue)) {
        $dl = ([string]$p.DriveLetter).Trim()
        if ($dl -and $dl -ne "`0") { $letters += $dl }
      }
    } catch { }
    $sys = ([bool]$d.IsSystem) -or ([bool]$d.IsBoot) -or ($letters -contains 'C')
    $rows += [pscustomobject]@{
      Number   = [int]$d.Number
      Name     = [string]$d.FriendlyName
      SizeGB   = [math]::Round($d.Size / 1GB, 2)
      Bus      = [string]$d.BusType
      Style    = [string]$d.PartitionStyle
      Letters  = ($letters -join ',')
      System   = $sys
      ReadOnly = [bool]$d.IsReadOnly
      Offline  = [bool]$d.IsOffline
    }
  }
  return , $rows
}

function Show-List {
  Say ''
  Say '本机磁盘列表：' 'Cyan'
  foreach ($r in (Get-Rows)) {
    if ($r.System) { $tag = '[系统盘-禁止操作]'; $col = 'Red' }
    else { $tag = ''; $col = 'Green' }
    Say ("  磁盘 #{0,-3} {1,-26} {2,8:N2} GB  {3,-6} 分区表={4,-5} 盘符={5,-8} {6}" -f `
      $r.Number, $r.Name, $r.SizeGB, $r.Bus, $r.Style, $r.Letters, $tag) $col
  }
  Say ''
}

if ($List) { Show-List; exit 0 }

if (-not (Test-Admin)) {
  Say ''
  Say '错误：本脚本必须以【管理员身份】运行，否则无法重建分区表。' 'Red'
  Say '最简单的办法：双击同目录下的「一键修复U盘.cmd」，它会自动弹出 UAC 让你点「是」。' 'Yellow'
  Say ''
  exit 1
}

# ---------- 选定目标磁盘 ----------
$rows = Get-Rows

if ($DiskNumber -lt 0) {
  $cands = @($rows | Where-Object { (-not $_.System) -and ($_.Bus -eq 'USB') })
  if ($cands.Count -eq 1) {
    $DiskNumber = $cands[0].Number
    Say ''
    Say ("自动识别到 USB 磁盘：#$DiskNumber  $($cands[0].Name)  $($cands[0].SizeGB) GB") 'Cyan'
  }
  elseif ($cands.Count -eq 0) {
    Show-List
    Say '错误：没有自动识别到 USB 磁盘。请从上面列表手动指定，例如： -DiskNumber 2' 'Red'
    exit 1
  }
  else {
    Show-List
    Say '检测到多块 USB 磁盘，为避免误操作，请手动指定，例如： -DiskNumber 2' 'Yellow'
    exit 1
  }
}

$target = $rows | Where-Object { $_.Number -eq $DiskNumber } | Select-Object -First 1
if ($null -eq $target) {
  Show-List
  Say "错误：本机没有编号为 $DiskNumber 的磁盘。" 'Red'
  exit 1
}

if ($target.System) {
  Say ''
  Say "错误：磁盘 #$DiskNumber 是系统盘 / 启动盘 / 含 C: 盘，严禁擦除！已中止。" 'Red'
  Say ''
  exit 1
}

if ($ExpectedSizeGB -gt 0) {
  $diff = [math]::Abs($target.SizeGB - $ExpectedSizeGB)
  if ($diff -gt 1.5) {
    Say ''
    Say ("错误：容量校验不通过。磁盘 #{0} 实际 {1:N2} GB，你填的是 {2:N2} GB。已中止。" -f $DiskNumber, $target.SizeGB, $ExpectedSizeGB) 'Red'
    Say ''
    exit 1
  }
}

Say ''
Say '即将对以下磁盘执行【重建分区表 + 格式化】：' 'Yellow'
Say ("  磁盘 #{0}   {1}   {2:N2} GB   {3}   当前盘符={4}   只读={5}   脱机={6}" -f `
  $target.Number, $target.Name, $target.SizeGB, $target.Bus, $target.Letters, $target.ReadOnly, $target.Offline) 'Yellow'
Say ''
Say '⚠️  该操作会【清空这块磁盘上的全部数据】，且不可撤销！' 'Red'
Say ''

if (-not $Force) {
  $ans = Read-Host '确认要继续吗？输入 YES 继续，直接回车取消'
  if ($ans -ne 'YES') {
    Say '已取消，未对磁盘做任何操作。' 'Cyan'
    exit 0
  }
}

$n = $DiskNumber

# ---------- 第 1 步：非破坏性准备 ----------
Say ''
Say '第 1 步：清除只读 / 确保联机' 'Cyan'
try { Set-Disk -Number $n -IsReadOnly $false -ErrorAction Stop; Say '  ✔ 已清除只读属性' 'Green' }
catch { Say "  ! 清只读跳过：$($_.Exception.Message)" 'DarkYellow' }
try { Set-Disk -Number $n -IsOffline $false -ErrorAction Stop; Say '  ✔ 磁盘已联机' 'Green' }
catch { Say "  ! 联机跳过：$($_.Exception.Message)" 'DarkYellow' }

# 移除残留分区（幽灵分区也能被清掉）
try {
  $parts = @(Get-Partition -DiskNumber $n -ErrorAction SilentlyContinue)
  foreach ($p in $parts) {
    try { Remove-Partition -DiskNumber $n -PartitionNumber $p.PartitionNumber -Confirm:$false -ErrorAction SilentlyContinue } catch { }
  }
  Say "  ✔ 已尝试移除残留分区（$($parts.Count) 个）" 'Green'
} catch { }

# 清除「幽灵盘符」：容量 0 且无文件系统的卷，会让 Windows 拒绝 clean
try {
  $ghosts = @(Get-Volume -ErrorAction SilentlyContinue | Where-Object {
    $_.DriveLetter -and ($_.Size -eq 0 -or $_.Size -eq $null) -and ([string]$_.FileSystem).Trim() -eq ''
  })
  foreach ($g in $ghosts) {
    $L = [string]$g.DriveLetter
    Say "  → 发现幽灵卷 ${L}:（容量 0、无文件系统），正在移除其盘符挂载点…" 'DarkYellow'
    try {
      & mountvol.exe "${L}:" /D 2>&1 | Out-Null
      Say "  ✔ 已移除幽灵盘符 ${L}:" 'Green'
    } catch { Say "  ! 移除 ${L}: 失败：$($_.Exception.Message)" 'DarkYellow' }
  }
} catch { }

# ---------- 第 2 步：清空分区表 ----------
Say ''
Say '第 2 步：清空分区表' 'Cyan'
$cleared = $false

try {
  Clear-Disk -Number $n -RemoveData -RemoveOEM -Confirm:$false -ErrorAction Stop
  $cleared = $true
  Say '  ✔ 已清空（Clear-Disk）' 'Green'
} catch {
  Say "  ! Clear-Disk 失败：$($_.Exception.Message)" 'DarkYellow'
}

if (-not $cleared) {
  # 脱机 / 联机循环，强制 Windows 重新枚举磁盘（对付幽灵卷很有效）
  Say '  → 尝试脱机/联机循环强制重新枚举…' 'Cyan'
  try {
    Set-Disk -Number $n -IsOffline $true -ErrorAction Stop
    Start-Sleep -Milliseconds 900
    Set-Disk -Number $n -IsOffline $false -ErrorAction Stop
    Start-Sleep -Milliseconds 900
    Say '  ✔ 已重新枚举' 'Green'
  } catch { Say "  ! 重新枚举失败：$($_.Exception.Message)" 'DarkYellow' }

  try {
    Clear-Disk -Number $n -RemoveData -RemoveOEM -Confirm:$false -ErrorAction Stop
    $cleared = $true
    Say '  ✔ 已清空（Clear-Disk 重试成功）' 'Green'
  } catch {
    Say "  ! 重试仍失败，改用 diskpart clean" 'DarkYellow'
  }
}

if (-not $cleared) {
  $tmp = Join-Path $env:TEMP ('tomato-repair-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $sc = "select disk $n`r`nattributes disk clear readonly`r`nonline disk`r`nclean`r`nexit`r`n"
  [System.IO.File]::WriteAllText($tmp, $sc, [System.Text.Encoding]::ASCII)
  try {
    $out = & diskpart.exe /s $tmp 2>&1 | Out-String
    Say $out 'DarkGray'
    Say '  → diskpart 已执行（上方输出可确认是否成功）' 'Cyan'
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

# ---------- 第 3 步：重建分区并格式化 ----------
Say ''
Say '第 3 步：重建分区并格式化' 'Cyan'
$done = $false

try {
  try { Set-Disk -Number $n -PartitionStyle MBR -ErrorAction SilentlyContinue } catch { }
  $part = New-Partition -DiskNumber $n -UseMaximumSize -AssignDriveLetter -ErrorAction Stop
  $letter = [string]$part.DriveLetter
  Say "  ✔ 已创建主分区，盘符 $letter`:" 'Green'
  Start-Sleep -Milliseconds 700

  $fs = $FileSystem
  try {
    Format-Volume -DriveLetter $letter -FileSystem $fs -NewFileSystemLabel $Label -Confirm:$false -ErrorAction Stop
  } catch {
    Say "  ! $fs 格式化失败，改用 NTFS 重试" 'DarkYellow'
    $fs = 'NTFS'
    Format-Volume -DriveLetter $letter -FileSystem NTFS -NewFileSystemLabel $Label -Confirm:$false -ErrorAction Stop
  }
  Say "  ✔ 格式化完成（$fs）" 'Green'
  $done = $true
} catch {
  Say "  ! PowerShell 方式失败：$($_.Exception.Message)" 'DarkYellow'
}

if (-not $done) {
  Say '  → 改用 diskpart 完整流程重试…' 'Cyan'
  $tmp2 = Join-Path $env:TEMP ('tomato-repair-' + [Guid]::NewGuid().ToString('N') + '.txt')
  $sc2 = @"
select disk $n
attributes disk clear readonly
online disk
clean
create partition primary
format fs=$FileSystem quick
label=$Label
assign
exit
"@
  [System.IO.File]::WriteAllText($tmp2, $sc2, [System.Text.Encoding]::ASCII)
  try {
    $out2 = & diskpart.exe /s $tmp2 2>&1 | Out-String
    Say $out2 'DarkGray'
    $done = $true
  } finally {
    Remove-Item $tmp2 -Force -ErrorAction SilentlyContinue
  }
}

Start-Sleep -Milliseconds 900
try { Update-HostStorageCache -ErrorAction SilentlyContinue } catch { }

# ---------- 结果 ----------
Say ''
$after = (Get-Rows) | Where-Object { $_.Number -eq $n } | Select-Object -First 1
if ($after -and $after.Letters) {
  Say ("修复完成 ✔  磁盘 #{0} 现在盘符：{1}，分区表：{2}，容量 {3:N2} GB" -f $after.Number, $after.Letters, $after.Style, $after.SizeGB) 'Green'
  Say '请打开「此电脑」或按 F5 刷新，确认容量已恢复正常。' 'Green'
} else {
  Say '脚本已执行完毕，但暂时没检测到盘符。请依次尝试：' 'Yellow'
  Say '  1) 拔下 U 盘，等 10 秒后重新插入；' 'Yellow'
  Say '  2) 在「此电脑」里按 F5 刷新；' 'Yellow'
  Say '  3) 重新运行本工具一次（有时需要第二轮）；' 'Yellow'
  Say '  4) 若仍不行，可能是主控固件异常，需要厂商量产工具低格。' 'Yellow'
}
Say ''
try { "[$(Get-Date -Format s)] Tomato USB Repair end" | Out-File -Append -FilePath $script:TomatoLogFile -Encoding utf8 } catch { }
