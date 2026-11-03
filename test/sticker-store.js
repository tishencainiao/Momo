#!/usr/bin/env node
/* 表情包语义库测试（v1.46.0）：词表 / 迁移 / 生命周期 / 手动锁定 / 风险 / 发送去重 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const store = require(path.join(ROOT, "sticker-store.js"));
const srcStickers = fs.readFileSync(path.join(ROOT, "plugins/stickers.js"), "utf8");
const srcIndex = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const srcTeach = fs.readFileSync(path.join(ROOT, "plugins/teach.js"), "utf8");
const srcStore = fs.readFileSync(path.join(ROOT, "sticker-store.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

// ---------- 词表 ----------
check("情绪词表 15 个（含无聊）", store.MOOD_TAGS.length === 15, String(store.MOOD_TAGS.length));
check("情绪词表含项目既有情绪", ["开心", "害羞", "傲娇", "撒娇", "委屈", "吃醋", "紧张", "好奇", "惊讶"].every((x) => store.MOOD_TAGS.includes(x)));
check("场景词表 20 个", store.SCENE_TAGS.length === 20, String(store.SCENE_TAGS.length));
check("场景词表含接梗/吐槽", store.SCENE_TAGS.includes("接梗") && store.SCENE_TAGS.includes("吐槽"));
check("7 个生命周期状态", store.STATUSES.length === 7, String(store.STATUSES.length));

// ---------- 公开 ID ----------
check("内置图 ID 用文件名序号", store.publicIdOf("003_这用户发的啥啊.webp", "builtin") === "b.003");
check("收集图 ID 用哈希", store.publicIdOf("c761f8d1cc538.gif", "collected") === "c.761f8d1c", store.publicIdOf("c761f8d1cc538.gif", "collected"));
check("生图 ID 用 g 前缀", store.publicIdOf("gabc123.jpg", "collected") === "g.abc123");

// ---------- 风险识别 ----------
check("「别乱发」判高风险", store.riskFromText("这张有点色色的，尽量不要乱发") === "high");
check("普通描述判低风险", store.riskFromText("她在笑，很适合接梗") === "low");

// ---------- 标签推断 ----------
check("从文字推断情绪", store.inferMoodFromText("她睁大眼很疑惑") === "好奇");
const scene = store.inferSceneFromText("适合吐槽对方");
check("从文字推断场景", scene === "吐槽" || scene === "接梗", scene);

// ---------- 生命周期门槛 ----------
check("1 个来源 = observed", store.nextStatus({ sourceCount: 1, manualLocked: false, status: "observed" }) === "observed");
check("2 个来源 = understand_only", store.nextStatus({ sourceCount: 2, manualLocked: false, status: "observed" }) === "understand_only");
check("3 个来源 = verified", store.nextStatus({ sourceCount: 3, manualLocked: false, status: "observed" }) === "verified");
check("手动锁定优先于一切", store.nextStatus({ sourceCount: 9, manualLocked: true, status: "observed" }) === "manual_locked");
check("rejected 不会被自动升级", store.nextStatus({ sourceCount: 9, manualLocked: false, status: "rejected" }) === "rejected");

// ---------- 真实迁移（临时库） ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-stk-"));
store.init(path.join(tmp, "s.db"));

function scanReal() {
  const dirs = [
    [path.join(ROOT, "stickers"), "builtin"],
    [path.join(ROOT, "stickers/collected"), "collected"],
    [path.join(ROOT, "stickers/curated"), "curated"],
    [path.join(ROOT, "stickers/trash"), "trash"],
  ];
  const out = [];
  for (const [d, t] of dirs) {
    let es = [];
    try { es = fs.readdirSync(d); } catch (e) { continue; }
    for (const f of es) if (/\.(webp|jpg|jpeg|png|gif)$/i.test(f)) out.push({ fname: f, tier: t });
  }
  return out;
}
const files = scanReal();
const opts = {
  files,
  metaFile: path.join(ROOT, "stickers/meta.json"),
  descFile: path.join(ROOT, "stickers/collected/desc.json"),
  taughtFile: path.join(ROOT, "data/taught.json"),
};
const r1 = store.migrate(opts);
check("迁移把磁盘所有图都收进来", store.all().length === files.length, store.all().length + " vs " + files.length);
check("内置图迁移后可信（verified）", store.all().filter((s) => s.tier === "builtin").every((s) => s.status === "verified"));
check("内置图允许主动发", store.all().filter((s) => s.tier === "builtin").every((s) => s.allowProactive));
const r2 = store.migrate(opts);
check("重复迁移不会重复建条", store.all().length === files.length);
check("重复迁移被跳过", r2.imported === 0, String(r2.imported));

// ---------- 手动教学 ----------
const target = store.all().find((s) => s.tier === "collected");
const manual = store.applyManual(target.fname, { desc: "她生气地鼓腮，适合被气到的时候用", risk: "low", allowProactive: true });
check("手动教学后状态是 manual_locked", manual.status === "manual_locked");
check("手动教学会被锁住", manual.manualLocked === true);
check("手动教学来源记成 manual", manual.source === "manual");
const autoTry = store.addAuto(target.fname, { tier: "collected", desc: "AI 瞎猜的描述" });
check("自动流程不会覆盖主人教的", autoTry.desc === "她生气地鼓腮，适合被气到的时候用", autoTry.desc);

const risky = store.applyManual(target.fname, { desc: "这张有点色色的，别乱发", risk: "high", allowProactive: true });
check("高风险强制禁掉主动发", risky.allowProactive === false);
check("高风险保留描述", risky.desc.includes("色色"));

// ---------- 发送记录 / 去重 ----------
store.recordSend("a.gif", "u:1", Date.now());
store.recordSend("b.gif", "u:1", Date.now());
store.recordSend("c.gif", "u:1", Date.now());
const recent = store.recentSends("u:1", 2);
check("最近发送按时间倒序", recent[0].fname === "c.gif" && recent[1].fname === "b.gif", JSON.stringify(recent));
check("别的会话互不影响", store.recentSends("u:2", 3).length === 0);
check("能取到最后一次发送时间", store.lastSendTs("u:1") > 0);

// ---------- 源码级：接线是否都接上了 ----------
check("插件用语义库取代 meta.json 作为主源", srcStickers.includes('require("../sticker-store")'));
check("插件有主动发门禁", srcStickers.includes("function canProactive"));
check("插件有去重窗口", srcStickers.includes("recentFnames"));
check("插件暴露 teachSticker", srcStickers.includes("teachSticker"));
check("教学能按编号定位", srcStickers.includes("getByPublicId"));
check("教学绑定不到时如实失败", srcStickers.includes("我没法确定你说的「这张」是哪张"));
check("教学用模型判风险", srcStickers.includes("judgeRisk"));
check("内核有「这张」指代上下文", srcIndex.includes("stickerRefCtx"));
check("内核发图后回写", srcIndex.includes("noteStickerSent"));
check("教学插件走新接口", srcTeach.includes("teachSticker"));
check("语义库用内置 sqlite", srcStore.includes("node:sqlite"));

store.close();
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
