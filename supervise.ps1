# 鱼脑桥接守护进程：崩溃自动重启
$ErrorActionPreference = 'SilentlyContinue'
$dir = $PSScriptRoot
$lock = Join-Path $dir 'supervisor.lock'
if (Test-Path $lock) {
  $old = Get-Content $lock
  if ($old -match '^\d+$' -and (Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue)) { exit }
}
Set-Content -Path $lock -Value $PID
# 优先用 DSH runtime node（系统 node 可能是 v18：无 WebSocket 导致 QQ 断连、无 node:sqlite 导致插件加载失败）
$node = 'C:\Users\<你的用户名>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) {
  $candidate = Join-Path $dir 'runtime\node\node.exe'
  if (Test-Path $candidate) { $node = $candidate }
}
if (-not $node) { throw '找不到 Node.js；请安装 Node 24+ 或在主界面查看启动错误。' }
$app  = Join-Path $dir 'index.js'
while ($true) {
  & $node $app
  Start-Sleep -Seconds 3
}
