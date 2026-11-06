# Momo 看门狗：每 5 分钟由计划任务调用，检查守护/桥接进程，异常就拉起
$ErrorActionPreference = 'SilentlyContinue'
$momo = 'E:\Learn\Momo'
$log = Join-Path $momo 'watchdog.log'

function Stamp { Get-Date -Format 'yyyy-MM-dd HH:mm:ss' }

$bridge = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'Momo\\index\.js' }
if ($bridge) { return }   # 桥接在跑，一切正常

$sup = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'supervise\.ps1' }
if ($sup) {
  # 有守护进程，可能正处在「node 重启」的空档，等 8 秒再看
  Start-Sleep -Seconds 8
  $bridge = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'Momo\\index\.js' }
  if ($bridge) { return }
  # 守护进程在但 node 起不来，先清掉守护进程再重来
  Stop-Process -Id $sup.ProcessId -Force
  Remove-Item (Join-Path $momo 'supervisor.lock') -Force
  Remove-Item (Join-Path $momo 'bridge.lock') -Force
  Add-Content -Path $log -Value ("{0} [watchdog] 守护进程卡死，已强制重启" -f (Stamp))
} else {
  Remove-Item (Join-Path $momo 'supervisor.lock') -Force
  Remove-Item (Join-Path $momo 'bridge.lock') -Force
  Add-Content -Path $log -Value ("{0} [watchdog] 守护进程不在，已拉起" -f (Stamp))
}

Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $momo 'supervise.ps1') `
  -WindowStyle Hidden

# 日志只保留最近 200 行
$lines = Get-Content $log -ErrorAction SilentlyContinue
if ($lines.Count -gt 200) { $lines | Select-Object -Last 200 | Set-Content $log }
