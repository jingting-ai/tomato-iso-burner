<#
.SYNOPSIS
  把最新的写盘 / 修复脚本同步进「安装版」目录，消除多个入口版本不一致的问题。

.DESCRIPTION
  安装版的脚本放在安装目录的 resources\ 下，快捷方式启动的都是它们；
  每次修了脚本（burn.ps1 / repair.ps1），装版里那份不会自己更新。
  本脚本会把两个脚本的最新版都复制过去，并校验哈希确保真的换掉了。

  需要管理员权限（写 Program Files），由「一键更新安装版.cmd」自动申请 UAC。
#>
param([switch]$Force)

$ErrorActionPreference = 'Stop'
# 注意：不要设置 [Console]::OutputEncoding —— 它会改变控制台输出代码页，
# 导致回到调用方（cmd.exe）后中文回显变乱码。保持默认即可。

# ---------------------------------------------------------------------------
# 0. 提权检查（提权由「一键更新安装版.cmd」负责，本脚本只做检查）
# ---------------------------------------------------------------------------
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host ''
  Write-Host '错误：需要管理员权限（要写入 C:\Program Files）。' -ForegroundColor Red
  Write-Host '请双击同目录下的「一键更新安装版.cmd」运行 —— 它会自动申请管理员权限。' -ForegroundColor Yellow
  Write-Host ''
  Read-Host '按回车键退出'
  exit 1
}

function Get-Sha([string]$p) {
  if (-not (Test-Path $p)) { return '' }
  $b = [System.IO.File]::ReadAllBytes($p)
  $h = [System.Security.Cryptography.SHA256]::Create().ComputeHash($b)
  return (($h | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16)
}

# 要同步的脚本清单：写盘 + 修复（新增脚本时往这里加一行即可）
$names = @('burn.ps1', 'repair.ps1')

Write-Host ''
Write-Host '════════════════════════════════════════════════════' -ForegroundColor DarkCyan
Write-Host '   番茄镜像刻录工具 —— 同步最新脚本到安装版' -ForegroundColor Cyan
Write-Host '════════════════════════════════════════════════════' -ForegroundColor DarkCyan
Write-Host ''

# ---- 1. 找源脚本（本脚本旁边，或绿色版目录）----
$srcDir = $null
foreach ($c in @($PSScriptRoot, 'E:\番茄镜像刻录工具\resources')) {
  $hit = $names | Where-Object { Test-Path (Join-Path $c $_) }
  if ($hit) { $srcDir = [string]$c; break }
}
if ($null -eq $srcDir) {
  Write-Host ('错误：找不到源脚本（' + ($names -join ' / ') + '）。') -ForegroundColor Red
  Write-Host '检查过本脚本同目录和 E:\番茄镜像刻录工具\resources\。' -ForegroundColor Red
  Write-Host '请把本文件放在脚本所在目录里再运行。' -ForegroundColor Yellow
  Read-Host '按回车键退出'; exit 1
}
Write-Host ('源目录（最新）：' + $srcDir) -ForegroundColor Green
foreach ($n in $names) {
  $p = Join-Path $srcDir $n
  if (Test-Path $p) {
    Write-Host ('  {0,-12} {1,8} 字节   sha {2}' -f $n, (Get-Item $p).Length, (Get-Sha $p)) -ForegroundColor Green
  } else {
    Write-Host ('  {0,-12} （源目录里没有，跳过）' -f $n) -ForegroundColor DarkGray
  }
}
Write-Host ''

# ---- 2. 找安装版的 resources 目录 ----
# ⚠️ 历史版本改名后出现过 C:\Program Files\doro-iso-burner\tomato-iso-burner\
#    这种嵌套目录，所以除了固定候选还要按通配扫两层。
$dirs = @(
  'C:\Program Files\tomato-iso-burner\resources',
  'C:\Program Files (x86)\tomato-iso-burner\resources',
  (Join-Path $env:LOCALAPPDATA 'Programs\tomato-iso-burner\resources')
)
$dirs += @(
  Get-ChildItem 'C:\Program Files\*\resources\burn.ps1',
             'C:\Program Files\*\*\resources\burn.ps1' -ErrorAction SilentlyContinue |
    ForEach-Object { Split-Path $_.FullName }
)
$dirs = @($dirs | Where-Object { Test-Path $_ } | Select-Object -Unique)

if ($dirs.Count -eq 0) {
  Write-Host '未检测到安装版目录（说明你只装了绿色版，或安装路径非默认）。' -ForegroundColor Yellow
  Write-Host '绿色版不受影响，可以直接从桌面快捷方式启动。' -ForegroundColor Yellow
  Write-Host ''
  Read-Host '按回车键退出'; exit 0
}

Write-Host ('检测到 {0} 个安装目录，将逐个同步：' -f $dirs.Count) -ForegroundColor Yellow
$dirs | ForEach-Object { Write-Host ('  ' + $_) -ForegroundColor Yellow }
Write-Host ''

Write-Host '即将用最新脚本覆盖安装版里的同名文件（旧版自动备份为 .bak）。' -ForegroundColor Cyan
if (-not $Force) {
  $ans = Read-Host '确认请输入 YES'
  if ($ans -ne 'YES') { Write-Host '已取消。' -ForegroundColor Cyan; exit 0 }
}

# ---- 3. 逐目录、逐脚本同步 ----
$fail = 0
foreach ($dir in $dirs) {
  foreach ($n in $names) {
    $src = Join-Path $srcDir $n
    if (-not (Test-Path $src)) { continue }   # 源目录里没有这个脚本就跳过
    $dst = Join-Path $dir $n
    $srcSha = Get-Sha $src
    if ((Get-Sha $dst) -eq $srcSha) {
      Write-Host ('= {0} 已是最新，跳过' -f (Join-Path $dir $n)) -ForegroundColor DarkGray
      continue
    }
    try {
      if (Test-Path $dst) { Copy-Item $dst ($dst + '.bak') -Force }
      Copy-Item $src $dst -Force
      if ((Get-Sha $dst) -eq $srcSha) {
        Write-Host ('✔ 已更新 {0}' -f $dst) -ForegroundColor Green
      } else {
        Write-Host ('⚠ 更新后哈希不一致：{0}' -f $dst) -ForegroundColor Red
        $fail++
      }
    } catch {
      Write-Host ('✘ 更新失败 {0}：{1}' -f $dst, $_.Exception.Message) -ForegroundColor Red
      $fail++
    }
  }
}

Write-Host ''
if ($fail -eq 0) {
  Write-Host '✔ 全部同步完成。现在从【开始菜单 / 任务栏 / 桌面】任意入口启动，用的都是新脚本。' -ForegroundColor Green
} else {
  Write-Host ('⚠ 有 {0} 项更新失败。请确认程序已完全退出（占用会锁住文件）后重试。' -f $fail) -ForegroundColor Red
}
Write-Host ''
Read-Host '按回车键退出'
