# 身体（body/）架构

> 版本：v0.1 · 更新：2026-11-06
> 定位：给 Momo 换一个**自己的、能被她的大脑完全控制的身体**，替代现在这个第三方黑盒桌宠。

## 1. 为什么要自建身体

现桌宠是第三方打包程序（`dsh-pet-indesktop`，PyInstaller 只发二进制），大脑只能往它的 `agent-events/qq.jsonl` 追加**六态状态**，无法让她说任意话、播任意动作、也无法把「被点了/被拖了」回传大脑。长期目标是「电子生命」，身体必须是自己的。

## 2. 进程模型

```
QQ / 桌宠聊天 ──> 大脑（Node, index.js）  ──HTTP+SSE（v0.2 起）──> 身体（Python, body/）
                      │                                              │
                      └── data/*.json  记忆/情绪/预算                 └── body/assets 帧序列播放
```

- **大脑**：现有 `index.js` + 插件，一行核心逻辑不改（新增插件接入）。
- **身体**：独立 Python 进程（PySide6），崩了不影响 QQ，QQ 挂了身体也照常显示。
- **旧桌宠**：不卸载、不改动，与新身体并行；两者端口/目录/进程完全隔离，随时可切回。

## 3. 目录

```
body/
├── main.py            启动入口（--selftest / --scale）
├── pet_app.py         透明置顶窗：绘制、拖拽、右键菜单、位置记忆
├── anim.py            frameseq 扫描 + Clip + 按 fps 推进的 Player
├── cfg.py             默认配置 + body/config.json 覆盖 + data/body-state.json 状态
├── selftest.py        素材/帧图/播放器/配置四项自检
├── requirements.txt   PySide6>=6.8（唯一硬依赖）
├── config.example.json
└── assets/            素材（359MB，gitignore，脚本从旧桌宠复制）
```

## 4. 运行

```powershell
# 首次：装依赖（清华源已配好）
python -m pip install -r body\requirements.txt

# 复制素材（约 360MB，几秒钟）
powershell -File scripts\convert-assets.ps1

# 自检（不弹窗）
python body\main.py --selftest

# 启动
python body\main.py
# 或双击 scripts\run-body.vbs（pythonw，无控制台）
```

## 5. 配置

`body/config.json`（不存在则用内置默认；示例见 `config.example.json`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `scale` | 0.45 | 画布原生 640×360，0.45 倍时角色约 100×120px（接近旧桌宠体积） |
| `always_on_top` | true | 置顶 |
| `fps_cap` | 30 | 素材 24fps，再高没意义 |
| `click_response` | true | 点一下播回应动画 |
| `click_through` | false | 整窗鼠标穿透（右键菜单也能切） |
| `frameseq_dir` | frameseq | 换成 `frameseq-hi` 即用高清帧 |
| `port` | 4010 | v0.2 本地接口用 |

运行时状态（位置/缩放）写 `data/body-state.json`；日志写 `data/body.log`。

## 6. 交互（v0.1 已有）

| 操作 | 效果 |
|---|---|
| 左键拖拽 | 跟手移动，松手记住位置 |
| 左键单击 | 随机播一段「点击回应」动画，播完回待机 |
| 双击 | 随机小剧场（random 类 89 段之一） |
| 右键 | 点播动作（random/click/turn/move/drag 分类）· 大中小三档 · 鼠标穿透 · 回到右下角 · 退出 |

## 7. 动画与素材

- 101 段，7 类：`idle 1 / click 5 / drag 1 / events 1 / move 3 / random 89 / turn 1`，共 25,529 帧，24fps，每段约 241 帧（10s）。
- 帧序列已由上游解码好（webp，**640×360 画布**；角色在画布中约占 220×270，四周是透明留白，方便放道具/特效），运行时**不需要 ffmpeg**。
- 想更清晰：`scripts\convert-assets.ps1 -HiRes` 用 ffmpeg 从 `videos/*.webm`（640×360 VP9 alpha）重抠 320×180 帧到 `frameseq-hi/`，再把 `frameseq_dir` 改成 `frameseq-hi`。
- 素材授权与署名见 [body-attribution.md](body-attribution.md)。

> **DPI 踩坑（2026-11-06 实测）**：这台机器屏幕是 1920×1080、Windows 缩放 125%，Qt 的逻辑坐标是 1536×864（devicePixelRatio=1.25）。用 DPI 未感知的进程（如部分 PowerShell 会话）截图，拿到的是被系统虚拟化过的画面，看起来像是「身体被裁掉/位置偏移」——**其实是截图的锅**。要核对显示效果，用 `QScreen.grabWindow(0)` 在 Qt 进程里截，得到的是真实 1920×1080 画面。

## 8. 自检口径

`python body/main.py --selftest` 会断言：素材 ≥100 段、7 个分类都在、抽样帧图能解码、Player 帧号推进/停止、配置数值合法。全部通过退出码 0。

## 9. 后续批次

见 [body-roadmap.md](body-roadmap.md)（v0.2 接口 → v0.8 运维）与主 CHANGELOG。
