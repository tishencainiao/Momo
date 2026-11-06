# 身体本地接口（body/ 对外契约）

> 版本：protocol 1 · 落地：v1.65.0（身体 v0.2）
> 监听：`127.0.0.1:<port>`（默认 4010，`body/config.json` 可改；占用时自动往后找 10 个端口）
> 用途：让**大脑（Node，index.js）**指挥**身体（Python，body/）**——说话、播动作、切状态、移动、显隐。

## 1. 鉴权

- 启动时在 `body/body-token` 生成 32 位十六进制 token（已在 `.gitignore`）。
- 每个请求都要带其中一个头：
  - `Authorization: Bearer <token>`
  - `X-Momo-Token: <token>`
- 缺 token / 不匹配 → `401 {"ok":false,"error":"unauthorized"}`。
- 只监听 `127.0.0.1`，不对外网开放；这是本机进程间通信的最小面。

## 2. 指令（POST /cmd/*）

所有指令都是**异步**的：服务端只把指令塞进队列，立刻返回 `{"ok":true,"queued":true}`；
真正的动作在身体 GUI 线程里执行（Qt 控件必须在自己的线程里碰）。想知道执行结果，读 `/status` 或看 `data/body.log`。

| 路径 | 入参 | 说明 |
|---|---|---|
| `POST /cmd/say` | `{"text":"...","duration_ms":5000}` | 头顶气泡说出这句话 + 播一段说话类动画（碎碎念/是啊吃什么/随机），气泡到时自动消失 |
| `POST /cmd/speak` | `{"path":"C:/.../tts-body-xxx.mp3","text":"...","duration_ms":0}` | 播一段**真实语音**（大脑先用 tts.py 合成到文件）+ 头顶气泡；气泡时长按音频长度自动对齐，播完自动删掉临时文件 |
| `POST /cmd/play` | `{"name":"优雅女仆舞"}` 或 `{"category":"random"}` | 点播动画；`name` 支持中文片段模糊匹配，`category` 可取 `random/click/turn/move/drag` |
| `POST /cmd/state` | `{"state":"idle"\|"sleep"}` | `idle` 回待机；`sleep` 播小憩/沉眠类动画并进入休眠状态 |
| `POST /cmd/move` | `{"dx":20,"dy":-10}` 或 `{"to_x":900,"to_y":500}` | 相对/绝对移动，位置会写进 `data/body-state.json` |
| `POST /cmd/show` | `{}` | 显示身体（托盘里点显示等价） |
| `POST /cmd/hide` | `{}` | 隐藏身体（进程还在，随时可叫回） |
| `POST /cmd/scale` | `{"scale":0.4}` | 改大小，夹紧在 0.15~1.0 |
| `POST /cmd/sense` | `{}` | 返回感官快照：`idle_s` / `presence`(active·away) / `foreground{title,pid,app}` / `locked` / `last_look` |
| `POST /cmd/look` | `{}` | 抓一张全屏（缩到 1280 宽存 jpg，只留最近 20 张），返回 `{path,width,height,ts}` |

> 语音链路：`plugins/pet-body.js` 的 `pet_speak` → `voice.synthesizeToFile()`（复用 tts.py 的克隆音色）→ `POST /cmd/speak`。合成放后台，不在回复链路里干等。

返回示例：`{"ok":true,"queued":true,"cmd":"say"}`
错误：`400` 请求体不是 JSON 对象；`503` 队列满（身体忙不过来）；`404` 未知路径；`401` 鉴权失败。

## 3. 状态（GET /status）

```json
{"ok":true,"protocol":"1","pid":24208,"port":4010,
 "state":"talk","anim":"深度思考碎碎念","visible":true,"scale":0.4,
 "pos":[1248,536],"last_say":"我先去看看书，一会儿回来～"}
```

| 字段 | 含义 |
|---|---|
| `state` | `idle` / `talk` / `sleep` |
| `anim` | 当前正在播的片段名 |
| `visible` / `scale` / `pos` | 显隐、缩放倍数、窗口左上角坐标 |
| `last_say` | 最近一次说的话（截断 80 字） |
| `protocol` | 接口协议版本，大脑据此判断兼容性 |

## 4. 事件流（GET /events，SSE）

`text/event-stream`，每行 `event: <名字>` + `data: <JSON>`；15 秒无事件发一次 `: ping` 心跳。

| 事件 | 字段 | 触发 |
|---|---|---|
| `sense` | 完整快照 | 感官首次采样 / 状态变化 |
| `presence` | `presence,idle_s` | 键鼠空闲跨过阈值（默认 180 秒）时说「主人可能走了/回来了」 |
| `foreground` | `title,pid,app` | 前台窗口变了 |
| `lock` | `locked` | 锁屏/解锁 |
| `drop` | `files[]` | 往她身上拖了文件（投喂） |
| `look` | `path,ts` | 被要求看了一眼屏幕 |
| `click` | `x,y,sound` | 主人点了她一下 |
| `drag_end` | `x,y` | 拖拽放下（位置已保存） |
| `visibility` | `visible` | 显示/隐藏 |
| `scale` | `scale` | 大小变化 |
| `anim` | `name,category` | 切换动画 |
| `state` | `state` | 状态切换（sleep/talk 等） |
| `say` | `text` | 大脑让她说了话 |
| `moved` | `x,y` | 被移动 |

> 用途（v0.4 起）：把「被点了/被拖了/她说过了」回流给大脑，变成记忆和情绪输入。

## 5. 大脑侧怎么调

`plugins/pet-body.js` 是唯一的客户端，提供 6 个工具：`pet_say` / `pet_play` / `pet_state` / `pet_move` / `pet_body_status` / `pet_body_link`，外加 `/身体` 命令。

- 全部**仅主人可用**（`isMaster`）。
- 超时 2.5 秒；身体没启动/连不上时返回「身体好像没在跑 + 怎么叫回来」，不抛错、不影响 QQ 聊天链路。
- 每次调用都会落一条 `actions` 记录，便于事后追。

```bash
# 手工冒烟（PowerShell）
$tok = (Get-Content body\body-token -Raw).Trim()
$h = @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json; charset=utf-8" }
Invoke-RestMethod -Uri http://127.0.0.1:4010/status -Headers $h
Invoke-RestMethod -Uri http://127.0.0.1:4010/cmd/say -Method Post -Headers $h -Body (@{text="你好呀"} | ConvertTo-Json)
```

## 6. 安全红线

1. 只绑 `127.0.0.1`，不提供任何公网能力。
2. token 每次启动前都要求存在（缺失会自动生成），请求恒定时间比对。
3. 身体**没有**执行外部命令、读写任意文件的接口——它只能说话、播动画、移动、显隐。大脑那边才是能力边界所在。
