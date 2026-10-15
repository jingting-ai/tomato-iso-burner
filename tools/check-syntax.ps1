param([string]$Path)
$err = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$null, [ref]$err)
$out = New-Object System.Collections.ArrayList
if ($err -and $err.Count -gt 0) {
  [void]$out.Add("SYNTAX ERRORS: " + $err.Count)
  foreach ($e in $err) {
    [void]$out.Add("  line $($e.Extent.StartLineNumber):$($e.Extent.StartColumnNumber)  $($e.Message)")
  }
} else {
  [void]$out.Add("SYNTAX OK")
}
# 列出函数定义
$fns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
[void]$out.Add("Functions: " + (($fns | ForEach-Object { $_.Name }) -join ', '))
[System.IO.File]::WriteAllText("C:\Users\jingt\AppData\Local\Temp\tomato-syntax.txt", ($out -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
