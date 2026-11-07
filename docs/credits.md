# 借鉴与出处（Credits & Third-party Notices）

> 本文件登记 Momo 使用或借鉴的第三方项目；原则见 [development.md](development.md) 第十节「代码复用原则」。
> 更新：2026-11-07（v1.72.0）

## 一、直接使用的第三方软件 / 模型

| 项目 | 作者 / 组织 | 许可证 | 用途 | 许可文本 |
|---|---|---|---|---|
| GPT-SoVITS | RVC-Boss | MIT | 本地 TTS 引擎（v1.47.0 起，本地语音克隆） | [GPT-SoVITS-LICENSE.txt](licenses/GPT-SoVITS-LICENSE.txt) |
| GPT-SoVITS 预训练权重 | lj1995 / XXXXRT（Hugging Face） | 随模型仓库声明 | v2Pro 权重、G2PW 中文模型 | 见模型仓库 |
| edge-tts | rany2 | 许可未明确标注（PyPI 显示 Other） | 兜底 TTS（仅调用，未复制其代码） | — |
| NapCatQQ | NapNeko | 协议端自带许可 | OneBot v11 协议端（用户自行安装，不包含在本仓库） | — |
| PySide6 (Qt for Python) | The Qt Company | LGPLv3 / 商业双许可 | 自建身体 GUI（`body/`，v0.1 起） | 见 PyPI 包内许可证 |
| PyInstaller | PyInstaller Development Team | GPL v2 + Bootloader 例外 | 身体打包 exe（v1.71.0 起） | 见 PyPI 包内许可证 |

## 二、借鉴的设计 / 代码

| 项目 | 作者 | 许可证 | 借鉴了什么 | 我们的做法 |
|---|---|---|---|---|
| [dsh-qqbot-muu](https://github.com/wuwo1979/dsh-qqbot-muu) | wuwo1979 | MIT | GPT-SoVITS 安装步骤（git clone / pip / 权重下载 / G2PW / ffmpeg）、6GB 显存调参（`is_half`、`sample_steps=24`、`expandable_segments`）、音色 profile 设计（voice → 参考音频 + 参考文本 + 语速/音高） | 步骤与参数参考；`tts.py` / `gsv-guard.py` 为本项目自己实现，未复制其代码 |
| [LLM-live2d / CyberWaifu](https://github.com/HPUhushicheng/LLM-live2d) | HPUhushicheng / Yuan | MIT | edge-tts 生成后以 `record` 消息发 QQ 语音条的做法 | 仅思路参考 |
| meme-pilot / nonebot-plugin-personification | 各自作者 | 各自 | 表情包系统两条设计：每张图稳定 ID、受控标签 + 生命周期 + 主动发门禁 | 实现全部重写（见 development.md 第十节） |

## 三、许可文本

- [GPT-SoVITS-LICENSE.txt](licenses/GPT-SoVITS-LICENSE.txt)
- [dsh-qqbot-muu-LICENSE.txt](licenses/dsh-qqbot-muu-LICENSE.txt)
- [LLM-live2d-LICENSE.txt](licenses/LLM-live2d-LICENSE.txt)

## 四、我们的义务

1. 保留上述项目的版权声明与许可证文本（随本仓库分发）。
2. 直接抄写的代码，在文件头写「来源：仓库 / 文章 URL（许可证）」。
3. 只借鉴设计或思路的，也要在本文件登记。
4. 公开发布时保留原作者署名（README → 借鉴与致谢 → 本文件）。
