# 身体（body/）架构

> 版本：v0.1.1 · 更新：2026-11-06
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
- **托盘**：身体自带托盘图标（一个图标同时管大脑和身体），是「关掉窗口之后唯一能把她叫回来」的入口。

## 3. 目录

```
body/
├── main.py            启动入口（--selftest / --scale；单实例；托盘接线）
├── pet_app.py         透明置顶窗：绘制、拖拽、右键菜单、大小档位、位置记忆
├── anim.py            frameseq 扫描 + Clip + 按 fps 推进的 Player
├── sound.py           音效（QSoundEffect 低延迟；无 QtMultimedia 时降级 winsound）
├── netapi.py          本地接口：HTTP 指令 + SSE 事件 + token 鉴权
├── bubble.py          头顶说话气泡（圆角 + 小尖角 + 自动消失）
├── tray.py            系统托盘：状态显示 + 显示/隐藏/重启身体 + 重启/停止大脑 + 音效 + 日志
├── bodyicon.py        从 idle 帧生成多尺寸 .ico（纯 Qt，无 Pillow）
├── cfg.py             默认配置 + body/config.json 覆盖 + data/body-state.json 状态
├── selftest.py        五组自检（素材 / 帧图 / 播放器 / 配置 / 音效与图标）
├── requirements.txt   PySide6-Essentials>=6.8（唯一硬依赖）
├── config.example.json
└── assets/            素材（359MB，gitignore，脚本从旧桌宠复制；含自动生成的 icon.ico）
```

## 4. 运行

```powershell
# 首次：装依赖（清华源已配好；只要 Essentials，约 82MB）
python -m pip install -r body\requirements.txt

# 复制素材（约 360MB，几秒钟）
powershell -File scripts\convert-assets.ps1

# 自检（不弹窗，24 项）
python body\main.py --selftest

# 建桌面 / 开始菜单 / 开机自启快捷方式（-Remove 全删，-NoAutostart 只建前两个）
powershell -File scripts\install-shortcuts.ps1

# 启动
python body\main.py
# 或双击 scripts\run-body.vbs（pythonw，无控制台）／桌面「Momo 身体」
```

- **单实例**：用 `QSharedMemory` 守着，已经在跑时再启动会直接退出（避免快捷方式、开机自启、托盘「重启身体」打架）。
- **关窗 ≠ 退出**：有托盘时关窗只是隐藏；只有菜单里的「退出身体」才真退出（托盘一起消失），之后靠桌面快捷方式召回。

## 5. 配置

`body/config.json`（不存在则用内置默认；示例见 `config.example.json`；托盘改音量/静音会自动写回这里）：

| 键 | 默认 | 说明 |
|---|---|---|
| `scale` | 0.40 | 画布 640×360，0.40 倍时角色约 108px 高 |
| `tiers` | [0.30, 0.40, 0.50] | 右键三档（小/中/大），另有 ±0.05 微调（范围 0.15~1.0） |
| `always_on_top` | true | 置顶（每 3 秒重申一次，防被浏览器窗口盖住） |
| `fps_cap` | 30 | 素材 24fps，再高没意义 |
| `click_response` | true | 点一下播回应动画 |
| `squash_enabled` | true | 点击 Q 弹挤压（像被戳了一下的软体） |
| `squash_duration_ms` | 320 | 一次「压下去 + 回弹过冲」的总时长 |
| `click_through` | false | 整窗鼠标穿透（右键菜单也能切） |
| `sound_enabled` | true | 音效总开关 |
| `volume` | 70 | 点击音效音量 0~100 |
| `mute` | false | 静音（托盘可切） |
| `frameseq_dir` | frameseq | 换成 `frameseq-hi` 即用高清帧 |
| `port` | 4010 | 本地接口端口（占用时自动往后找） |
| `api_enabled` | true | 关掉就只显示、不接受任何指令 |
| `away_after_s` | 180 | 键鼠空闲超过多少秒算「主人不在电脑前」 |
| `sense_interval_ms` | 5000 | 感官采样间隔 |

运行时状态（位置/缩放）写 `data/body-state.json`；日志写 `data/body.log`。

## 6. 交互（v0.2）

| 操作 | 效果 |
|---|---|
| 左键拖拽 | 跟手移动，松手记住位置 |
| 左键单击 | 随机播一段「点击回应」动画 + 播 `click.wav`，同时身体**Q 弹挤压**一下（横向鼓、纵向压，脚底不动），播完回待机 |
| 大脑指令 | `say` 说任意话（气泡+说话动画）/ `play` 点播动画 / `state` 待机或睡觉 / `move` 移动 / `show`·`hide` 显隐 / `scale` 改大小 |
| 双击 | 随机小剧场（random 类 89 段之一） |
| 右键 | 点播动作（random/click/turn/move/drag）· 大小三档 + ±0.05 · 鼠标穿透 · 回到右下角 · 隐藏身体 · 退出身体 |
| 托盘左键 | 显示/隐藏切换 |
| 托盘右键 | 状态行（大脑 PID/守护在不在、身体显隐）· 显示/隐藏身体 · 重启身体 · 重启大脑 · 停止大脑（含守护，二次确认）· 音效（静音 / 40% / 70% / 100%）· 查看日志 · 退出身体 |

## 7. 本地接口（v0.2 起）

大脑指挥身体走的是**本机 HTTP + SSE**（默认 127.0.0.1:4010，token 在 ody/body-token）：

- POST /cmd/say|play|state|move|show|hide|scale —— 指令，入队后立刻返回，具体动作在 GUI 线程执行；
- GET /status —— 快照（状态/动画/显隐/大小/位置/最近说的话）；
- GET /events —— SSE 事件流（点击、拖拽、显隐、换动画、说话…），v0.4 起回流给大脑做记忆与情绪输入。

完整契约（含字段与示例）见 [body-api.md](body-api.md)；大脑侧客户端是 plugins/pet-body.js（6 个工具 + /身体 命令，仅主人可用，超时 2.5s，离线给可操作提示）。

## 8. 点击 Q 弹（squash & stretch）

- 触发：左键按下瞬间（`mousePressEvent`）以及拖动落地（强度 0.65）；不再等松手，手感更跟手。
- 曲线：总时长 `squash_duration_ms`（320ms），前 25% 用 ease-out 压到位，之后 `(1-u)·cos(1.6πu)` 回弹并轻微过冲（负值＝拉长），所以会有「压扁 → 弹高 → 归位」三段。
- 变换：以**脚底中点**为锚点做 `QPainter.scale`（横 1+0.16·s，纵 1−0.20·s），底边不位移，看起来是站在地上被压扁。
- 实测（离屏逐帧量 bbox）：静止 84×107 → 60ms 时 98×85（+17% 宽 / −21% 高）→ 230ms 时 80×114（回弹拉长）→ 330ms 归位 84×107，底边始终在 131 附近。
- 关掉：`body/config.json` 里 `"squash_enabled": false`。

## 9. 音效
- 文件：`body/assets/sounds/click.wav`（点击）、`agent/{start,done,error}.wav`（v0.3 起给状态用）、`duck/*.mp3`（预留，QSoundEffect 播不了 mp3）。
- **后端：QSoundEffect（PySide6-Addons 里的 QtMultimedia）**——Qt 内部维护常驻音频输出，设备只开一次，点击即出声；自带 0~1 音量与多路混音。启动时 `preload()` 把 click + agent 音效都加载就绪，避免第一次点击还在开设备。
- **为什么换掉 winsound（2026-11-06 实测）**：这段 160ms 的点击音，`winsound.PlaySound` 一次调用要阻塞约 **970ms**（大头是每次重新打开音频设备 + 系统音频栈里的 FxSound / 虚拟声卡）；本机 MCI 常驻通道也要 418~597ms。入队到真正调播放只花 0.5ms，所以延迟不在我们的线程/队列上。
- **降级**：只装了 PySide6-Essentials 的机器上 `import QtMultimedia` 失败，会自动退回 winsound 后端（功能不中断，只是延迟高）——日志里会打 `音效后端=winsound`。
- **坑**：winsound 不允许「内存 + 异步」同时用（`Cannot play asynchronously from memory`），所以降级后端只能后台线程同步播；QSoundEffect 则没有这个限制。


### 9.1 桌面语音（v0.3）

- 链路：pet_speak → 大脑侧 oice.synthesizeToFile()（复用 tts.py 的克隆音色，产出 mp3）→ POST /cmd/speak {path,text} → 身体用 **QMediaPlayer** 播放 + 气泡按时长对齐。
- 为什么不用 QSoundEffect：它只吃未压缩 WAV，而 tts.py 产出的是 mp3；QMediaPlayer 还能取时长。
- **合成不能进回复链路**：GSV 冷启动可达几十秒，会把联脑 30 秒超时拖爆（实测第一次就这么挂的）。所以 pet_speak 先弹气泡立刻返回，合成与播放在后台完成，失败只记 action + warn。
- 临时文件：data/tts-body-*.mp3，播完自动删；voice.js 另有 2 小时兜底清理。
- 音量：oice_volume（默认 85）与点击音效分开；每次播放前重绑默认输出设备。
## 10. 感官回流（v0.4）

身体只负责**采集**，判断留给大脑：

| 感官 | 实现 | 频率/开销 |
|---|---|---|
| 键鼠空闲 | `GetLastInputInfo`（ctypes） | 5 秒一次，几乎零开销；≥180 秒判「可能离开」 |
| 前台窗口 | `GetForegroundWindow` + 标题 + `QueryFullProcessImageNameW` 取进程名 | 同上，仅在变化时发事件 |
| 锁屏 | `OpenInputDesktop` 打不开即视为锁屏/安全桌面 | 同上，仅变化时发事件 |
| 截图 | 只有大脑调 `/cmd/look` 才抓（`QScreen.grabWindow` → 1280 宽 jpg，留最近 20 张） | 触发式 |
| 被点/被拖/收文件 | 鼠标事件与拖放事件 | 事件驱动 |

回流路径：身体 → SSE `/events` → `plugins/pet-body.js` 维护最新快照并落 `data/body-events.jsonl` → 每轮通过 `contextProvider` 注入一行【身体感觉】（在电脑前否 / 前台程序 / 锁屏 / 最近被点 / 最近收文件）。

大脑侧的 `pet_look` 会把截图路径交给 `describeImageFile()`（复用 chat.vision 视觉模型）转成文字，所以「她看了一眼屏幕就能说出你在干嘛」是真的看图，不是猜的；单次约 ¥0.001~0.002，20 秒内重复看会被拦。

## 11. 物理与情绪（v0.5）

**走路**：速度不靠拍脑袋——素材里 `move_strides.json` 标了每段移动动画「一圈走多少像素」，速度 = stride × fps ÷ 帧数（如左转奔跑 240×24÷241 ≈ 23.9 px/s），走起来才不会「滑步」。朝左走时水平镜像（`text_clips.json` 里 6 段含文字的片段不镜像，否则字会反）。

**甩抛**：拖拽时记最近 6 个鼠标轨迹点估速度，松手速度 ≥520 px/s 才算「甩出去」，之后按抛物线走：重力 2600 px/s²、四边反弹保留 55% 速度、落地水平摩擦 0.78，慢到 40 px/s 停住。物理计算全在 `body/physics.py` 里写成纯函数（不碰 Qt），自检能直接断言。

**情绪 → 动作**：大脑每 5 分钟把 `mood/boredom/emotion` 推给身体（`/cmd/mood`，纯本地不花钱）；身体据此决定：无聊度 ≥60 时自己找事做的概率 55%、心情 ≤-40 时改播小憩/哈欠类、点她时按情绪挑回应（开心→元气/开心类，生气/傲娇→傲娇类）。被点一下也会回流给大脑：心情 +2、无聊 -6（20 秒内只算一次）。

## 12. 陪伴外挂（v0.6）

全部逻辑在大脑的 `plugins/pet-body.js` 里，身体只做「弹气泡 / 发声 / 播动画」：

| 外挂 | 触发 | 身体做什么 |
|---|---|---|
| 整点报时 | 每小时一次（默认 8~23 点） | 气泡说一句随机报时（可选语音） |
| 早间播报 | 7~10 点每天第一次 | 天气 + 节日 + 叫起床，走 `/cmd/speak` 用克隆音色说出来 |
| 节日问候 | 早间播报时顺带 | 一句「今天是 X 哦」 |
| 余额 | `pet_balance` / 问生活费 | 按已用百分比播 6 档余额动画 + 报账 |
| 抽签 | `pet_fortune` | 气泡报今日运势 |
| 待办 | `reminders` 到期 | 除了 QQ + Toast，还调 `api.body.announce()` 在桌面说一句 |

对外播报入口：`api.body.announce(text,{voice,duration_ms})` —— 任何插件都能让身体开口，不用自己拼 HTTP。

## 13. 托盘与大脑控制（安全口径）

- 找进程**按命令行匹配**，不按进程名：大脑必须是 `node.exe` 且命令行含 `Momo\index.js`；守护必须是 `powershell.exe` 且含 `-File ...supervise.ps1`；并且都要排除「正在跑查询的 powershell 自己」（`$_.ProcessId -ne $PID`）。
- **重启大脑 = 停守护 → 杀 node → 起一个守护**（不是「只杀不拉」）。原因：机器上可能有多个 `supervise.ps1`（手动 + 自启），只杀 node 会让它们同时拉起、抢 3999 端口。
- **停止大脑**会连守护一起停（否则杀了立刻被拉起），操作前二次确认。
- 实测（2026-11-06）：重启后 2 秒新 node 起来，`bridge.log` 出现「OneBot WS 已连接 / Bot 上线」。

## 14. 动画与素材

- 101 段，7 类：`idle 1 / click 5 / drag 1 / events 1（balance 6 段）/ move 3 / random 89 / turn 1`，共 25,529 帧，24fps，每段约 241 帧（10s）。
- 帧序列已由上游解码好（webp，**640×360 画布**；角色在画布中约占 220×270，四周是透明留白，方便放道具/特效），运行时**不需要 ffmpeg**。
- 想更清晰：`scripts\convert-assets.ps1 -HiRes` 用 ffmpeg 从 `videos/*.webm`（640×360 VP9 alpha）重抠 320×180 帧到 `frameseq-hi/`，再把 `frameseq_dir` 改成 `frameseq-hi`。
- 素材授权与署名见 [body-attribution.md](body-attribution.md)。

> **DPI 踩坑（2026-11-06 实测）**：这台机器屏幕是 1920×1080、Windows 缩放 125%，Qt 的逻辑坐标是 1536×864（devicePixelRatio=1.25）。用 DPI 未感知的进程（如部分 PowerShell 会话）截图，拿到的是被系统虚拟化过的画面，看起来像是「身体被裁掉/位置偏移」——**其实是截图的锅**。要核对显示效果，用 `QScreen.grabWindow(0)` 在 Qt 进程里截，得到的是真实 1920×1080 画面。

## 15. 自检口径

`python body/main.py --selftest`（offscreen，不弹窗，24 项断言）：

1. **素材**：≥100 段、7 个分类齐全、events 含嵌套 balance；
2. **帧图**：抽样解码成功；
3. **播放器**：帧号推进、可停止；
4. **配置**：scale / fps_cap / port / 三档升序合法；
5. **音效与图标**：click.wav 在、音量上下夹紧、静音不出声、能生成多尺寸 .ico（ICO 头校验）。

## 16. 后续批次

见 [body-roadmap.md](body-roadmap.md)（v0.2 接口 → v0.8 运维）与主 CHANGELOG。
