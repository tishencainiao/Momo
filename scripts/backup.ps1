# Momo 数据备份：把 data/（记忆/会话/状态）+ .env + config.json 复制到备份目录
# 用法：手动运行，或由计划任务每日 4:00 自动跑
$ErrorActionPreference = 'SilentlyContinue'
$src = 'E:\Learn\Momo'
$backupRoot = 'E:\Learn\Momo-backups'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $backupRoot ("momo-" + $stamp)

New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $src 'data') (Join-Path $target 'data') -Recurse -Force
if (Test-Path (Join-Path $src '.env')) { Copy-Item (Join-Path $src '.env') (Join-Path $target '.env') -Force }
Copy-Item (Join-Path $src 'config.json') (Join-Path $target 'config.json') -Force

# 只保留最近 7 个备份，多的删掉
Get-ChildItem $backupRoot -Directory -Filter 'momo-*' | Sort-Object Name -Descending | Select-Object -Skip 7 | Remove-Item -Recurse -Force

Write-Output "备份完成: $target"
