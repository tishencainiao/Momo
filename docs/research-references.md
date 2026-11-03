# 前沿论文参考（Research References）

> 保存定位讨论中用的论文与「Momo 可以抄什么」。改记忆 / 进化系统前先看这里。

## 1. Generative Agents: Interactive Simulacra of Human Behavior

- arXiv:2304.03442 · 斯坦福 2023
- 核心：记忆流 → 定期反思合成高级认识 → 按「新鲜度 × 重要性 × 相关性」检索。
- Momo 可抄：记忆重要性分 + 每周反思合并（一周琐事 → 3~5 条「关于主人的新认识」）。

## 2. MemGPT: Towards LLMs as Operating Systems（现 Letta）

- arXiv:2310.08560 · 伯克利 2023
- 核心：分层内存 + AI 自己决定记什么、忘什么（自我编辑记忆）。
- Momo 可抄：给 Agent 加 write_memory / forget_memory 工具，让她主动管理记忆，而不是被动抽取。

## 3. CoALA: Cognitive Architectures for Language Agents

- arXiv:2309.02427 · 普林斯顿 2023
- 核心：语言智能体的统一框架——记忆模块 + 行动空间（内部记忆操作 / 外部环境操作）+ 决策循环。
- Momo 可抄：对照检查骨架（Momo 基本符合）；补上记忆模块内部的完整循环（写入 → 检索 → 更新 → 遗忘）。

## 4. ReasoningBank: Scaling Agent Self-Evolving with Reasoning Memory

- arXiv:2509.25140 · Google，ICLR 2026
- 核心：从成功 / 失败经验蒸馏可复用推理策略，记忆驱动自我进化。
- Momo 可抄：meta-cog / reflections 就是这个方向的雏形，先解决噪声问题。

## 5. H-MEM: Hierarchical Memory for High-Efficiency Long-Term Reasoning

- arXiv:2507.22925 · 2025
- 核心：按语义抽象度分层存储 + 索引路由检索。
- Momo 可抄：记忆分层（原始 → 事实 → 认识）的存储结构参考。

## 共同结论

生命感的工程本质 = 记忆的完整生命周期（编码 → 重要性评估 → 分层存储 → 语义检索 → 反思合成 → 遗忘 / 更新），而不是更多功能或更长的提示词。
