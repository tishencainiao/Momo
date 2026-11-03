# 鱼脑桥接守护进程：崩溃自动重启
$ErrorActionPreference = 'SilentlyContinue'
$dir = 'E:\Learn\Momo'
$lock = Join-Path $dir 'supervisor.lock'
if (Test-Path $lock) {
  $old = Get-Content $lock
  if ($old -match '^\d+$' -and (Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue)) { exit }
}
Set-Content -Path $lock -Value $PID
$node = 'C:\Users\<你的用户名>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$app  = Join-Path $dir 'index.js'
while ($true) {
  & $node $app
  Start-Sleep -Seconds 3
}
