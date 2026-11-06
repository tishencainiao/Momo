<#
  身体守护：崩了自动拉起（和大脑的 supervise.ps1 一个套路）

  用法：
    powershell -WindowStyle Hidden -File scripts\supervise-body.ps1     # 前台/隐藏窗口跑守护
  说明：
    - 用 pythonw 启动，崩溃后 3 秒重启；连续崩溃会逐步放慢到 30 秒，避免疯狂刷屏。
    - 想彻底停：任务管理器结束这段 powershell（或托盘 → 退出身体，再把本守护关掉）。
    - 日志仍写 data/body.log（超过 2MB 自动轮转成 .1）。
#>
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $root "body\main.py"
$lock = Join-Path $root "body-supervisor.lock"

if (-not (Test-Path $entry)) { Write-Error "找不到 $entry"; exit 1 }

# 单实例：锁文件里是活着的 PID 就直接退出
if (Test-Path $lock) {
    $old = Get-Content $lock -ErrorAction SilentlyContinue
    if ($old -match '^\d+$' -and (Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue)) { exit }
}
Set-Content -Path $lock -Value $PID

$pyw = "pythonw.exe"
$delay = 3
while ($true) {
    $started = Get-Date
    & $pyw $entry
    $ran = ((Get-Date) - $started).TotalSeconds
    if ($ran -gt 60) { $delay = 3 } else { $delay = [Math]::Min(30, $delay + 3) }
    Start-Sleep -Seconds $delay
}
