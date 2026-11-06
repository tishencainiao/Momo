<#
  给「Momo 身体」创建快捷方式：桌面 + 开始菜单 +（可选）开机自启

  用法：
    powershell -File scripts/install-shortcuts.ps1              # 建桌面/开始菜单/启动项
    powershell -File scripts/install-shortcuts.ps1 -NoAutostart # 只建桌面和开始菜单
    powershell -File scripts/install-shortcuts.ps1 -Remove      # 全部删掉

  说明：
    - 快捷方式指向 scripts\run-body.vbs（pythonw 无控制台），图标用 body\assets\icon.ico。
    - 开机自启走「启动文件夹」，和 Momo 大脑的做法一致：删快捷方式即可关闭自启。
#>
param(
    [switch]$Remove,
    [switch]$NoAutostart
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root "scripts\run-body.vbs"
$icon = Join-Path $root "body\assets\icon.ico"
$name = "Momo 身体"
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"

if (-not (Test-Path $vbs)) { throw "找不到 $vbs" }
if (-not (Test-Path $icon)) { Write-Warning "还没有图标（$icon），先启动一次身体会自动生成；本次快捷方式将不带图标" }

$targets = @()
$targets += @{ dir = [Environment]::GetFolderPath("Desktop"); label = "桌面" }
$targets += @{ dir = Join-Path ([Environment]::GetFolderPath("Programs")) ""; label = "开始菜单" }
if (-not $NoAutostart) {
    $targets += @{ dir = [Environment]::GetFolderPath("Startup"); label = "开机自启" }
}

$wsh = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
    if (-not $t.dir) { continue }
    if (-not (Test-Path $t.dir)) { New-Item -ItemType Directory -Force -Path $t.dir | Out-Null }
    $lnk = Join-Path $t.dir ("{0}.lnk" -f $name)
    if ($Remove) {
        if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "已删除：$($t.label) → $lnk" }
        continue
    }
    $s = $wsh.CreateShortcut($lnk)
    $s.TargetPath = $wscript
    $s.Arguments = '"' + $vbs + '"'
    $s.WorkingDirectory = $root
    $s.Description = "Momo 桌面身体（双击叫回她）"
    if (Test-Path $icon) { $s.IconLocation = "$icon,0" }
    $s.Save()
    Write-Host "已创建：$($t.label) → $lnk"
}

if (-not $Remove) {
    Write-Host ""
    Write-Host "完成。提示："
    Write-Host "  · 双击桌面「$name」即可启动/叫回身体"
    Write-Host "  · 关窗只是隐藏，托盘图标点一下也能叫回"
    if (-not $NoAutostart) { Write-Host "  · 已加入开机自启（启动文件夹里的同名快捷方式，删掉即关闭）" }
}
