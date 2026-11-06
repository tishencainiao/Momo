<#
  把「身体」打包成独立 exe（PyInstaller onedir，无控制台窗口）

  用法：
    powershell -File scripts\build-body.ps1              # 打包到 body\dist\MomoBody\
    powershell -File scripts\build-body.ps1 -Clean       # 先清掉旧的 build/dist

  说明：
    - 只打 Python 代码 + PySide6 运行时；**素材不进包**（359MB），
      打包版靠 body\config.json 里的 assets_dir 指到素材目录（或把 assets 拷到 exe 同级）。
    - 打包完可跑 `body\dist\MomoBody\MomoBody.exe --selftest` 验证（退出码 0 = 通过）。
#>
param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$body = Join-Path $root "body"
$dist = Join-Path $body "dist"
$build = Join-Path $body "build"

if ($Clean) {
    foreach ($p in @($dist, $build, (Join-Path $body "MomoBody.spec"))) {
        if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
    }
    Write-Host "已清理旧的 build/dist"
}

Write-Host "开始打包（第一次要 1~3 分钟）…"
& python -m PyInstaller `
    --noconfirm `
    --windowed `
    --onedir `
    --name MomoBody `
    --distpath $dist `
    --workpath $build `
    --specpath $body `
    --paths $body `
    --hidden-import PySide6.QtMultimedia `
    --hidden-import PySide6.QtNetwork `
    --exclude-module tkinter `
    --exclude-module PySide6.QtWebEngineCore `
    --exclude-module PySide6.QtWebEngineWidgets `
    --exclude-module PySide6.Qt3DCore `
    --exclude-module PySide6.QtCharts `
    --exclude-module PySide6.QtDataVisualization `
    (Join-Path $body "main.py")

if ($LASTEXITCODE -ne 0) { throw "打包失败（exit $LASTEXITCODE）" }

$exe = Join-Path $dist "MomoBody\MomoBody.exe"
if (-not (Test-Path $exe)) { throw "没找到产物：$exe" }

# 把配置放到 exe 旁边（素材不打包，所以 assets_dir 必须指到真实素材目录）
$exeDir = Split-Path $exe
$localCfg = Join-Path $body "config.json"
$assetsDir = Join-Path $body "assets"
$source = if (Test-Path $localCfg) { $localCfg } else { Join-Path $body "config.example.json" }
$cfgObj = Get-Content $source -Raw | ConvertFrom-Json
$cfgObj | Add-Member -NotePropertyName assets_dir -NotePropertyValue $assetsDir -Force
$json = $cfgObj | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $exeDir "config.json"), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已写入 exe 目录的 config.json（assets_dir=$assetsDir）"

$size = [math]::Round((Get-ChildItem $exeDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host ""
Write-Host "完成：$exe（整个目录 $size MB）"
Write-Host "提示：素材不打包，配置里的 assets_dir 必须指向 body\assets（已自动写好）"
