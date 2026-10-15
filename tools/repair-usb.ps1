<#
  番茄镜像刻录工具 —— U 盘修复工具

  用途：当刻录失败导致 U 盘变成「未知容量 / RAW / 无法访问」时，用它重建分区表并格式化，
        把 U 盘恢复成可正常使用的状态。

  安全设计（重要）：
    * 必须管理员运行；
    * 【绝对拒绝】系统盘 / 启动盘 / 含 C: 的磁盘；
    * 必须显式指定 -DiskNumber，并用 -ExpectedSizeGB 校验容量（防止选错盘）；
    * 执行前展示完整操作清单，需要 -Confirm 或交互确认。

  用法示例：
    # 先查看有哪些盘
    powershell -ExecutionPolicy Bypass -File repair-usb.ps1 -List
    # 修复 2 号盘（容量 58 左右 GB），文件系统 exfat，卷标 U盘
    powershell -ExecutionPolicy Bypass -File repair-usb.ps1 -DiskNumber 2 -ExpectedSizeGB 58 -Confirm
#>
param(
  [switch]$List,
  [int]$DiskNumber = -1,
  [double]$ExpectedSizeGB = 0,
  [string]$FileSystem = 'exfat',
  [string]$Label = 'USB',
  [switch]$Confirm
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-DiskRows {
  $sysDrive = ($env:SystemDrive -replace ':\\\\?$','').Trim().ToUpper()
  $rows = @()
  foreach ($d in (Get-Disk -ErrorAction SilentlyContinue | Sort-Object Number)) {
    $letters = @()
    try {
      foreach ($p in @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue)) {
        $dl = ([string]$p.DriveLetter).Trim().ToUpper()
        if ($dl -and $dl -ne "`0") { $letters += $dl }
      }
    } catch { }
    $isSystem = ([bool]$d.IsSystem) -or ([bool]$d.IsBoot) -or ($letters -contains $sysDrive) -or ($letters -contains 'C')
    $rows += [pscustomobject]@{
      Number  = [int]$d.Number
      Name    = [string]$d.FriendlyName
      SizeGB  = [math]::Round($d.Size / 1GB, 2)
      Bus     = [string]$d.BusType
      Style   = [string]$d.PartitionStyle
      Letters = ($letters -join ',')
      System  = $isSystem
    }
  }
  return $rows
}

if ($List -or $DiskNumber -lt 0) {
  Write-Host ''
  Write-Host '本机磁盘列表（请按容量确认你的 U 盘是哪一个）：' -ForegroundColor Cyan
  Write-Host ''
  $rows = Get-DiskRows
  foreach ($r in $rows) {
    $tag = if ($r.System) { '[系统盘-不可选]' } else { '' }
    $color = if ($r.System) { 'Red' } else { 'Green' }
    Write-Host ("  磁盘 #{0,-3} {1,-28} {2,8:N2} GB  {3,-8} 分区表={4,-5} 盘符={5,-8} {6}" -f `
      $r.Number, $r.Name, $r.SizeGB, $r.Bus, $r.Style, $r.Letters, $tag) -ForegroundColor $color
  }
  Write-Host ''
  if ($DiskNumber -lt 0) {
    Write-Host '用法：repair-usb.ps1 -DiskNumber <编号> -ExpectedSizeGB <容量> -Confirm' -ForegroundColor Yellow
    Write-Host ''
  }
  if ($DiskNumber -lt 0) { exit 0 }
}

if (-not (IsAdmin)) {
  Write-Host ''
  Write-Host '错误：必须以【管理员身份】运行 PowerShell 才能修复磁盘。' -ForegroundColor Red
  Write-Host '请右键「终端」或「PowerShell」→「以管理员身份运行」，再执行本脚本。' -ForegroundColor Red
  Write-Host ''
  exit 1
}

# ---- 定位目标磁盘并做安全检查 ----
$rows = Get-DiskRows
$target = $rows | Where-Object { $_.Number -eq $DiskNumber }
if ($null -eq $target) {
  Write-Host "错误：本机没有编号为 $DiskNumber 的磁盘。" -ForegroundColor Red
  exit 1
}

if ($target.System) {
  Write-Host ''
  Write-Host "错误：磁盘 #$DiskNumber 是系统盘 / 启动盘 / 含 C: 盘，严禁擦除！已中止。" -ForegroundColor Red
  Write-Host ''
  exit 1
}

if ($ExpectedSizeGB -gt 0) {
  $diff = [math]::Abs($target.SizeGB - $ExpectedSizeGB)
  if ($diff -gt 1.5) {
    Write-Host ''
    Write-Host ("错误：容量校验不通过。磁盘 #{0} 实际 {1:N2} GB，你填的是 {2:N2} GB。已中止，请重新确认。" -f $DiskNumber, $target.SizeGB, $ExpectedSizeGB) -ForegroundColor Red
    Write-Host ''
    exit 1
  }
}

Write-Host ''
Write-Host '即将对以下磁盘执行「重建分区表 + 格式化」：' -ForegroundColor Yellow
Write-Host ("  磁盘 #{0}  {1}  {2:N2} GB  {3}  当前盘符={4}" -f $target.Number, $target.Name, $target.SizeGB, $target.Bus, $target.Letters) -ForegroundColor Yellow
Write-Host ''
Write-Host '⚠️  该操作会【清空这块磁盘上的全部数据】，且不可撤销！' -ForegroundColor Red
Write-Host ''

if (-not $Confirm) {
  $ans = Read-Host "确认要继续吗？输入 YES 继续，其他任意键取消"
  if ($ans -ne 'YES') {
    Write-Host '已取消，未对磁盘做任何操作。' -ForegroundColor Cyan
    exit 0
  }
}

$dpScript = @"
select disk $DiskNumber
attributes disk clear readonly
online disk
clean
create partition primary
format fs=$FileSystem quick
label=$Label
assign
exit
"@

$tmp = Join-Path $env:TEMP ("tomato-repair-" + [Guid]::NewGuid().ToString('N') + ".txt")
[System.IO.File]::WriteAllText($tmp, $dpScript, [System.Text.Encoding]::ASCII)

Write-Host '正在修复…（请勿拔插 U 盘）' -ForegroundColor Cyan
try {
  $out = & diskpart.exe /s $tmp 2>&1 | Out-String
  Write-Host $out
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 800
$after = Get-DiskRows | Where-Object { $_.Number -eq $DiskNumber }
Write-Host ''
if ($after -and $after.Letters) {
  Write-Host ("修复完成 ✔  磁盘 #{0} 现在的盘符：{1}，分区表：{2}" -f $after.Number, $after.Letters, $after.Style) -ForegroundColor Green
  Write-Host '请打开「此电脑」确认容量已恢复正常。' -ForegroundColor Green
} else {
  Write-Host 'diskpart 已执行完毕，但没有检测到盘符。请尝试：' -ForegroundColor Yellow
  Write-Host '  1) 在「此电脑」中按 F5 刷新；' -ForegroundColor Yellow
  Write-Host '  2) 拔下 U 盘等 5 秒后重新插入；' -ForegroundColor Yellow
  Write-Host '  3) 若仍无法识别，可能是 U 盘主控固件异常，需要厂商的量产工具修复。' -ForegroundColor Yellow
}
Write-Host ''
