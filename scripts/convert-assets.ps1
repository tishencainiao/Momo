<#
  把旧桌宠的角色素材复制到 body/assets/（该目录不进版本库）

  用法：
    powershell -File scripts/convert-assets.ps1                 # 复制已解码的 frameseq（快，几秒）
    powershell -File scripts/convert-assets.ps1 -HiRes          # 额外从 videos/*.webm 抠高清帧到 frameseq-hi
    powershell -File scripts/convert-assets.ps1 -Size 480x270   # 自定义高清帧尺寸

  说明：
    - 素材来源是第三方桌宠 dsh-pet（PC2005-cloud/dsh-pet 及其桌面移植版），
      授权见 docs/body-attribution.md：可开源使用、禁止商用。
    - 本脚本只做复制/转码，不改动旧桌宠目录（只读）。
#>
param(
    [switch]$HiRes,
    [string]$Size = "320x180",
    [int]$Quality = 80,
    [string]$AssetsRoot = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root "body\assets"

if (-not $AssetsRoot) {
    $AssetsRoot = Join-Path $env:LOCALAPPDATA "Programs\dsh-pet-standalone-webm-chat\_internal\assets"
}
$char = Join-Path $AssetsRoot "characters\shenshen"
if (-not (Test-Path $char)) { throw "找不到角色素材目录：$char" }

Write-Host "素材源：$char"
Write-Host "目标：  $dest"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# 1) 逐帧序列（运行时直接播放，不需要 ffmpeg）
Write-Host "[1/3] 复制 frameseq ..."
robocopy (Join-Path $char "frameseq") (Join-Path $dest "frameseq") /E /NFL /NDL /NJH /NJS /NP | Out-Null
$frames = (Get-ChildItem (Join-Path $dest "frameseq") -Recurse -File -Filter *.webp -ErrorAction SilentlyContinue).Count
Write-Host "      frameseq 帧数：$frames"

# 2) 元数据 + 音效
Write-Host "[2/3] 复制元数据与音效 ..."
foreach ($f in @("manifest.json", "move_strides.json", "text_clips.json")) {
    $src = Join-Path $char "videos\$f"
    if (Test-Path $src) { Copy-Item $src (Join-Path $dest $f) -Force }
}
$soundsSrc = Join-Path $AssetsRoot "sounds"
if (Test-Path $soundsSrc) {
    robocopy $soundsSrc (Join-Path $dest "sounds") /E /NFL /NDL /NJH /NJS /NP | Out-Null
}

# 3) 可选：从 webm 抠更高分辨率的逐帧（v0.2 起配合 config.frameseq_dir = "frameseq-hi"）
if ($HiRes) {
    Write-Host "[3/3] 生成高清帧 $Size ..."
    $ffmpeg = Get-ChildItem (Join-Path $AssetsRoot "..\imageio_ffmpeg\binaries") -Filter "ffmpeg*.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $ffmpeg) { Write-Warning "没找到 ffmpeg，跳过高清帧生成"; return }

    $videos = Get-ChildItem (Join-Path $char "videos") -Recurse -Filter *.webm
    $hiRoot = Join-Path $dest "frameseq-hi"
    New-Item -ItemType Directory -Force -Path $hiRoot | Out-Null
    $i = 0
    foreach ($v in $videos) {
        $i++
        $cat = $v.Directory.Name
        $name = [System.IO.Path]::GetFileNameWithoutExtension($v.Name)
        $outDir = Join-Path $hiRoot "$cat\$name"
        if (Test-Path (Join-Path $outDir "meta.json")) { continue }
        New-Item -ItemType Directory -Force -Path $outDir | Out-Null
        & $ffmpeg.FullName -hide_banner -loglevel error -y -i $v.FullName `
            -vf "fps=24,scale=$Size`:flags=lanczos" -c:v libwebp -quality $Quality -compression_level 4 `
            (Join-Path $outDir "f_%04d.webp")
        $n = (Get-ChildItem $outDir -Filter *.webp).Count
        if ($n -gt 0) {
            $meta = @{ fps = 24.0; source = $v.Name; frames = $n; encoder = "ffmpeg webp q$Quality scale $Size" } |
                ConvertTo-Json -Compress
            [System.IO.File]::WriteAllText((Join-Path $outDir "meta.json"), $meta, [System.Text.Encoding]::UTF8)
            Write-Host ("      [{0}/{1}] {2} -> {3} 帧" -f $i, $videos.Count, $name, $n)
        } else {
            Write-Warning "      $name 没有生成帧（转码失败？）"
        }
    }
} else {
    Write-Host "[3/3] 跳过高清帧（要更清晰加 -HiRes）"
}

$size = [math]::Round(((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "完成：$dest（$size MB）"
