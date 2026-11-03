/* 表情包升级测试：三级图库维护（升级/下沉/清理）+ 候选筛选 + 智能挑选回退 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(os.tmpdir(), "momo-sticker-test-" + Date.now());
const PEND = path.join(ROOT, "collected");
const CUR = path.join(ROOT, "curated");
const TRASH = path.join(ROOT, "trash");
const META = path.join(ROOT, "meta.json");
for (const d of [PEND, CUR, TRASH]) fs.mkdirSync(d, { recursive: true });

const plugin = require("E:/Learn/Momo/plugins/stickers.js");
plugin.init({
  log: () => {}, canAfford: () => false, settings: () => ({}), completeOnce: async () => "1",
  getSetting: () => undefined, mimeOf: () => "image/png",
  STICKER_DB: path.join(ROOT, "stickers.db"), DATA_DIR: ROOT,
});
const S = plugin.api.stickers;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

const now = Date.now();
const DAY = 86400e3;

// 造数据：1 张用得多的、1 张全新的、1 张 40 天没用的、1 张回收站里 70 天的
fs.writeFileSync(path.join(PEND, "hot.png"), "x");
fs.writeFileSync(path.join(PEND, "new.png"), "x");
fs.writeFileSync(path.join(PEND, "stale.png"), "x");
fs.writeFileSync(path.join(TRASH, "old.png"), "x");
fs.writeFileSync(META, JSON.stringify({
  "hot.png": { desc: "常用的", used: 5, matched: 4, addedAt: now - 5 * DAY, tier: "pending" },
  "new.png": { desc: "刚收的", used: 0, matched: 0, addedAt: now - 1 * DAY, tier: "pending" },
  "stale.png": { desc: "很久没用", used: 0, matched: 0, addedAt: now - 40 * DAY, tier: "pending" },
  "old.png": { desc: "回收站旧图", used: 0, matched: 0, addedAt: now - 70 * DAY, tier: "trash" },
}));

// 1. 维护
const LOGF = path.join(ROOT, "maintain-log.json");
const r = S.maintain({ pendingDir: PEND, curatedDir: CUR, trashDir: TRASH, metaFile: META, maintainFile: LOGF, now });
check("用得多的升为收藏", r.promoted === 1, JSON.stringify(r));
check("长期没用的沉到回收站", r.demoted === 1);
check("回收站超时的被清理", r.purged === 1);
check("维护日志已写入", fs.existsSync(LOGF));
const ml = JSON.parse(fs.readFileSync(LOGF, "utf8"));
check("日志记录数量正确", ml.promoted === 1 && ml.demoted === 1 && ml.purged === 1, JSON.stringify(ml));

// 2. 目录结果
check("hot.png 进 curated", fs.existsSync(path.join(CUR, "hot.png")));
check("hot.png 离开 pending", !fs.existsSync(path.join(PEND, "hot.png")));
check("new.png 留在 pending", fs.existsSync(path.join(PEND, "new.png")));
check("stale.png 进 trash", fs.existsSync(path.join(TRASH, "stale.png")));
check("old.png 被删除", !fs.existsSync(path.join(TRASH, "old.png")));

// 3. 语义库随之更新（v1.46.0 起 tier 写在 sticker-store 里）
const store = S.store();
check("语义库标记 hot 为 curated", store.get("hot.png") && store.get("hot.png").tier === "curated");
check("语义库标记 stale 为 trash", store.get("stale.png") && store.get("stale.png").tier === "trash");
check("语义库删掉 old 记录", !store.get("old.png"));

// 4. 二次维护幂等（没有可动的）
const r2 = S.maintain({ pendingDir: PEND, curatedDir: CUR, trashDir: TRASH, metaFile: META, now: now + 1000 });
check("二次维护无变化", r2.promoted === 0 && r2.demoted === 0 && r2.purged === 0, JSON.stringify(r2));
check("new.png 仍在 pending", fs.existsSync(path.join(PEND, "new.png")));

// 5. 候选筛选：无此情绪关键词时返回空（用真实内置库）
const none = S.candidatesByEmotion("不存在的情绪");
check("未知情绪返回空候选", none.length === 0);
const happy = S.candidatesByEmotion("开心");
check("开心有候选（内置库）", happy.length > 0, "共 " + happy.length);
check("候选不含问候类", happy.every((s) => !/早上好|早安|晚安/.test(s.label)));

// 6. 收图返回状态（让 Momo 知道存没存上）
const big = Buffer.alloc(300 * 1024, 1);   // >200KB 且不是 GIF → 不算表情包
const rc = S.maybeCollect(big, "太大的一张图");
check("收图返回状态对象", rc && typeof rc === "object" && rc.ok === false, JSON.stringify(rc));
check("附带拒收原因", !!rc.reason, rc.reason);

// 7. 智能挑选：预算不足时应退回随机而不是报错
(async () => {
  const picked = await S.pickStickerSmart("开心", "今天好开心呀");
  check("预算紧时也能挑出图", !!picked && !!picked.file, picked && picked.label);
  const noEmo = await S.pickStickerSmart("不存在的情绪", "随便");
  check("无候选时返回 null", noEmo === null);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
