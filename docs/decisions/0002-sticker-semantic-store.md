# 0002 · 表情包语义用独立 sqlite 库

- 日期：2026-11-02
- 状态：已采纳

## 背景

用户教了 3 张表情包的含义，结果一张都没真记住：写到几小时前的旧图上、后教覆盖先教、第 3 张完全没记录，教完 30 秒又发了同一张。
根因三个：**没有身份**（只有 `last-collected.json` 这种全局指针）、**没有状态**（desc 只是一句话）、**没有回写**（发完图会话里什么都没记）。

调研了两个开源实现后确定方向：
- `northhalf/meme-pilot`：每张图有稳定公开 ID，所有操作都用 ID 指代
- `luojisama/nonebot-plugin-personification`：受控标签词表 + 7 态生命周期 + 手动锁定最高优先级

## 决定

1. 新建 `sticker-store.js`（根目录，非插件），用 **Node 内置 `node:sqlite`** 存语义，不引入任何 npm 依赖。
2. 语义字段：`mood_tag`(15) + `scene_tag`(20) 受控词表、`risk`、`allow_proactive`、`status`(7 态)、`source`、`confidence`、`manual_locked`。
3. 公开 ID：`b.<序号>` / `c.<哈希8位>` / `k.<序号>` / `g.<时间戳>`。
4. 磁盘仍是"有哪些图"的真相（四个目录）；sqlite 只管"这张什么意思、能不能主动发"。
5. 一次性迁移 `meta.json` + `desc.json` + `taught.json`，`meta.json` 备份为 `meta.pre-v146.json` 后转只读。

## 后果

- 教学能稳定绑定到具体某张；绑不上就如实说"我没法确定是哪张"，不再假成功。
- "这张别乱发"变成真的机制：`risk=high` 永远不进主动池。
- 主人手动教的一律 `manual_locked`，自动流程永不覆盖。
- 代价：多一个要维护的 sqlite 文件；`data/` 不进 git，所以它**也没有版本历史**。

## 踩过的坑

`upsert()` 里调用方传 `undefined` 字段时，会把整行写成 undefined 导致 sqlite 绑定报错 —— 错误被 catch 吞掉，表现为"教学静默失败"。已修：`undefined` 一律跳过、保留原值。
