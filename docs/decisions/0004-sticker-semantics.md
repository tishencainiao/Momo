# 0004 · 表情包语义理解（画面 / 文字 / 梗 / 场景）

- 状态：v1 已落地（2026-11-05），v2 已落地（2026-11-05），v3 待做
- 相关：`sticker-store.js`、`plugins/stickers.js`、`scripts/annotate-stickers.js`、`docs/decisions/0002-sticker-semantic-store.md`

## 背景

现状「理解」表情包靠文件名猜标签（`desc_` ← fname），`mood_tag`/`scene_tag` 由关键词表从 desc 猜；实测 `scene_tag` 大量是「表达疑惑」。挑图只按情绪关键词召回、把「文件名 label」给 LLM 选序号——她其实没看过画面，也没读懂图上的字和梗。

目标：入库时给每张表情包做结构化语义标注，挑选与收图都读同一份标注。

## 方案要点

1. 标注引擎：复用现有云端视觉模型（`config.chat.vision`，空则回落 `config.chat.model`），每张 1 次调用，输出严格 JSON。
2. 新增列（`sticker-store.js` 幂等迁移，旧库零影响）：
   `what`（画面）、`text_in_image`（图上文字原样）、`meaning`（梗/语气/潜台词）、`usage`（适用场景）、`tags`（JSON 数组）、`annotate_confidence`、`annotated_at`、`annotate_model`、`annotate_status`（ok / low_conf）。
3. 保护：`manual_locked=1` 的条目自动流程一律跳过；`desc_`/`mood_tag`/`scene_tag`/`status`/`risk`/`allow_proactive` 语义不变，只新增不改写。
4. 分批上线：v1 标注地基 → v2 检索/精排换内核 → v3 收图接话 + 增量标注 + 复核入口。

## 实测（2026-11-05）

- 脚本：`node scripts/annotate-stickers.js`（`--limit N --dry` 试标，`--force` 重标，跳过 manual_locked）
- 结果：128 张中 125 张成功标注（3 张 manual_locked 跳过），ok 119 / low_conf 6，失败 0
- 耗时 236 秒；Token 入 51567 / 出 11734 ≈ ¥0.1（按 budget 单价估算）
- 质量抽样：能准确读出图上文字（含长截图里的多行字），含义/场景判断合理；低置信条目会自动标 low_conf 不进主动发
- 未做：挑图仍走旧逻辑（v2）、收图未用标注（v3）

## v2 实测（2026-11-05）

- `candidatesByEmotion` 改为语义召回：情绪「傲娇」召回 24 张，全部带标注
- `pickStickerSmart` prompt 已是「画面 / 图上字 / 含义 / 场景」四行，候选池默认 8（`stickers.rank_pool`）
- `low_conf` 条目不参与主动发；被点名仍可发
- `send_sticker` 结果附「这张的含义/场景」，模型可顺势接一句；`stickerRefCtx` 也带含义
- 新增 `test/sticker-semantic.js`（4 断言），42 个测试文件全过
- 未做：收图接话与增量标注（v3）

## 验证方式（v2 起）

1. 10 个测试句（emo/被老板气到/周一不想上班…）看 Top5 贴切占比 ≥ 70%
2. 私聊/群聊、主人/朋友分别测场景与 `allow_proactive` 是否生效
3. `manual_locked` 条目覆盖数 = 0；41 个测试文件全过
