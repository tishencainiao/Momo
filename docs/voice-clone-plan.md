# Momo 本地语音克隆实施方案（GPT-SoVITS + edge-tts 兜底）

> 状态：已落地 v1.47.0 · 2026-11-04
> 决策：参考音=先用占位参考音（晓晓 8.18s 克隆，主人确认用这条）/ 服务=按需启停 / 安装路径=E:\Learn\tools\gpt-sovits

## 1. 目标

给 Momo 换一副「自己的嗓子」：本地 GPT-SoVITS 零样本克隆音色（免费、自然、可换），
服务没起/挂了自动回退 edge-tts，保证她永远不哑。Node 侧几乎零改动。

## 2. 架构（说话链路）

```
主人说「用语音说句话」/ /语音
  → index.js wantsVoice() 命中（不动）
  → voice.js sendVoice()：去舞台指示、截断 ≤200 字（不动）
  → spawnSync(python, [tts.py, text, out.mp3, voice], timeout=60s)
  → tts.py 路由：
      本地 GSV(127.0.0.1:9880) 优先 → 失败/超时 → edge-tts 兜底
  → 写 out.mp3，exit 0
  → voice.js onebotSend(send_msg, record) → NapCat 转 silk → QQ 语音条
```

## 3. 改动清单

| 文件 | 改动 | 说明 |
|---|---|---|
| `tts.py` | 新建 | 纯标准库；GSV 优先 + edge-tts 兜底 |
| `gsv-guard.py` | 新建 | 空闲看门狗（15 分钟；按需启停用） |
| `config.json` | 加 `chat.tts.voice` = `"default"` | voice.js 已会读，Node 零改动 |
| `data/tts-config.json` | 新建（gitignored） | 服务地址/超时/开关 |
| `data/tts-profiles.json` | 新建（gitignored） | voice 名 → 参考音频+逐字稿+参数 |
| `data/voice-refs/` | 新建（gitignored） | 参考音文件，永不外泄 |
| `sync-to-public.ps1` | 白名单加 `tts.py`（+`gsv-guard.py`） | 公开同步 |
| Python 环境 | 独立 venv（E 盘） | 不污染 DSH 运行时 python |

## 4. 影响范围

- 会变：QQ 私聊语音从「坏的」变成「可用 + 克隆音色」；音色变了；首次回复可能慢几秒。
- 不变：桌宠、群聊语音（仍不发）、听语音转文字、聊天文字、其余插件。

## 5. 服务管理（已选 B 按需启停）

| 方案 | 显存 | 体验 |
|---|---|---|
| A 常驻 | 3.4GB 常占 | 随时秒出 |
| **B 按需（选定）** | 闲时 0 | 第二次起秒出；首次可能走兜底 |
| C 常驻+空闲停 | 同 B | 停后再用要冷启动 |

实现：`tts.py` 发现 9880 不在 → `Popen` 拉起 api_v2（不阻塞），轮询就绪 ≤35s；
`gsv-guard.py` 每 30s 检查 `data/tts-last-used.txt`，空闲超 15 分钟则停服务并退出。

## 6. 实施阶段

1. **环境**：E 盘独立 venv（Python 3.11）+ CUDA 版 torch（cu121）+ edge-tts。
2. **GPT-SoVITS**：代码 + 权重（v2Pro，走 hf-mirror）+ ffmpeg + G2PWModel
   （`pretrained_models/G2PWModel` → `GPT_SoVITS/text/G2PWModel`）。
3. **参考音**：主人录 5~10 秒（安静、无音乐、逐字稿一字不差），放 `data/voice-refs/`。
4. **代码**：tts.py + gsv-guard.py + 配置。
5. **验证 + 提交**：QQ 实测听感；`sync-to-public.ps1`；v1.47.0。

## 7. 关键设计

- 超时预算（硬约束 <60s）：探测 2s + 拉起 ~1s + 等就绪 ≤35s + GSV 合成 ≤10s + edge 兜底 ≤10s ≈ 55s。
- 冷启动首次可能走 edge-tts 兜底（预期内）；第二次起是克隆音色。
- voice 名查不到 profile 时，当 edge-tts voice 名直接用（天然软回退开关）。

## 8. 风险与回退

| 风险 | 应对 | 一键回退 |
|---|---|---|
| OOM / 显存被占 | v2Pro/v3 权重；is_half、sample_steps=24、expandable_segments | 自动兜底 edge-tts |
| 冷启动超时 | 等 35s 未就绪即兜底 | 同上 |
| G2PW 缺失 | 安装时复制到位 | 重新复制 |
| ffmpeg 缺失 | 放进仓库根目录 | 重新放 |
| 参考音质量差 | 按规范重录 | 换文件 + 改 ref_text |
| edge-tts 网络不稳 | 只作兜底，主链路本地 | 自动恢复 |
| 公开泄露音频 | data/ gitignore + 白名单不含 | git log 核查 |

## 9. 验证清单

1. api_v2 起来：`http://127.0.0.1:9880` 可通，无 OOM。
2. 私聊 `/语音 你好`：收到语音条，音色=克隆音。
3. 听感：像同一个人，无爆音/电流声。
4. 停 api_v2 再发 `/语音`：仍收到语音条（edge 音色）。
5. 空闲 15 分钟：GSV 进程退出，显存回落。
6. `data/tts.log` 有 `gsv ok` / `edge ok` 记录。
7. 公开同步：tts.py 入库，无 data/、无参考音。
