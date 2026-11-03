# 0001 · 用 git tag 取代 versions/ 快照

- 日期：2026-11-02
- 状态：已采纳

## 背景

项目一直有两套"回到旧版本"的手段：手拷一份整目录快照到 `versions/base/<版本>/`，以及 git。
到 v1.46.0 时 `versions/` 已积了 136 个目录、3295 个文件、44MB，**全部被 git 跟踪** —— 同一份代码在仓库里存了两遍。
同时 `data/` 也被跟踪，每聊一句就有几十个文件变红，`git status` 完全没法看。

## 决定

1. 弃用 `versions/` 快照，历史版本统一走 **git tag**（`v1.x.y`）。
2. `versions/` 与 `data/` 加入 `.gitignore`，移出版本库。
3. 已有的 136 个快照目录直接删除（对象仍在 git 历史里，需要时 `git checkout <commit>^ -- versions/` 可找回）。
4. **不重写 git 历史**来瘦身 —— 收益不抵风险。

## 后果

- 回滚方式变了：`git checkout v1.45.0 -- index.js plugins/` → 重启。
- 发版多一步：`git commit` 后要 `git tag v<版本号>`。
- `data/`（记忆、会话、教学、表情包语义库）**没有版本历史了**，要备份必须单独拷。
- 仓库体积暂时仍是 28.8MB（历史没动），只是不再增长。

## 备选方案（未采纳）

- 只做 `.gitignore` 不删快照：仓库照样臃肿。
- 用 filter-repo 重写历史：能缩到几 MB，但会改掉所有 commit hash，风险高。
