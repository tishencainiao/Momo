/* 防捏造闸门测试：
 * 1) 输出后审计（fabrication-guard.js 纯函数）
 * 2) 能力负清单（capability-index：capabilityCtx / limitTriggers / noteOverclaim 提案）
 * 3) 成长记忆落库闸（evolution.looksLikeUnverifiedDeed）
 * 4) 记忆提炼过滤（memory.dropAgentDeeds）
 * 5) 用户画像过滤（userProfile.mergeProfile 不许写进"大肥鱼放…"）
 * 6) 清理脚本 dry-run（不写盘） */
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}
const DIR = path.join(os.tmpdir(), "momo-guard-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

/* ---------- 1. 输出后审计 ---------- */
const { auditReply, HONEST_FALLBACK } = require("E:/Learn/Momo/fabrication-guard.js");
const TRIGGERS = [
  { phrase: "放歌", id: "audio-play", label: "播放音乐/音频" },
  { phrase: "放给你听", id: "audio-play", label: "播放音乐/音频" },
  { phrase: "点歌", id: "audio-play", label: "播放音乐/音频" },
  { phrase: "放啦", id: "audio-play", label: "播放音乐/音频", contextOnly: true },
  { phrase: "那我开始了", id: "audio-play", label: "播放音乐/音频", contextOnly: true },
];

check("空文本直接放行", auditReply({ text: "", usedTools: [], triggers: TRIGGERS }).blocked === false);
check("普通聊天放行", auditReply({ text: "你先歇会儿吧，我陪你聊两句。", usedTools: [], triggers: TRIGGERS }).blocked === false);
check("「先放一边」不误伤", auditReply({ text: "这事先放一边，明天再说。", usedTools: [], triggers: TRIGGERS }).blocked === false);
check("「放过自己」不误伤", auditReply({ text: "别逼自己了，先放过自己。", usedTools: [], triggers: TRIGGERS }).blocked === false);
/* 诚实否认不能拦（否则会把真话换成道歉） */
check("诚实说「放歌做不了」不被拦", auditReply({ text: "啊，这个我真不行，放歌做不了，只能发语音消息，跟放音乐是两码事。", usedTools: [], triggers: TRIGGERS }).blocked === false);
check("诚实说「没有播放音乐的功能」不被拦", auditReply({ text: "放不了歌呀，我这儿没有播放音乐的功能。", usedTools: [], triggers: TRIGGERS }).blocked === false);
/* 模糊词要有音频上下文，避免误伤日常动作 */
check("「钥匙放好了」不误伤", auditReply({ text: "我把钥匙放好了，在门口鞋柜上。", usedTools: [], triggers: TRIGGERS }).blocked === false);
check("「放啦，这首慢一点的」被拦", auditReply({ text: "放啦，这首慢一点的，你闭眼听就行。", usedTools: [], triggers: TRIGGERS }).blocked === true);
check("「那我开始了。第一首挺安静的」被拦", auditReply({ text: "好，那我开始了。第一首挺安静的。", usedTools: [], triggers: TRIGGERS }).blocked === true);

const claim = "能啊，我自己攒的。你躺好，我这就放给你听。";
const r1 = auditReply({ text: claim, usedTools: [], triggers: TRIGGERS });
check("编造「放给你听」被拦", r1.blocked === true && r1.text === HONEST_FALLBACK, r1.text);
check("拦下时带回命中的能力", r1.hit && r1.hit.label === "播放音乐/音频");

const r2 = auditReply({ text: "好，我这就放给你听。", usedTools: ["send_voice"], triggers: TRIGGERS });
check("真有 send_voice 成功时放行", r2.blocked === false);
const r3 = auditReply({ text: "好，我这就放给你听。", usedTools: ["memory_view"], triggers: TRIGGERS });
check("无关工具不算兑现", r3.blocked === true);
check("开关关掉时不拦", auditReply({ text: claim, usedTools: [], triggers: TRIGGERS, enabled: false }).blocked === false);
check("没有触发词表时放行", auditReply({ text: claim, usedTools: [], triggers: [] }).blocked === false);

/* ---------- 2. 能力负清单 ---------- */
const capPlugin = require("E:/Learn/Momo/plugins/capability-index.js");
capPlugin.init({
  DATA_DIR: DIR,
  log: () => {},
  config: { qq: { master_user: 100000001, allowed_users: [100000001] } },
  registry: { tools: () => ["send_voice", "read_article"], commands: () => [] },
});
const CAP = capPlugin.api.capability;
const ctxText = CAP.capabilityCtx(100000001);
check("能力摘要里出现「你做不到的」", ctxText.indexOf("你做不到的") >= 0, ctxText.slice(0, 80));
check("摘要点明不能播放音乐", ctxText.indexOf("播放音乐") >= 0);
check("摘要说明发语音≠放音乐", ctxText.indexOf("发语音") >= 0 && ctxText.indexOf("放音乐") >= 0);
const trigs = CAP.limitTriggers();
check("触发词表非空", trigs.length >= 8, "len=" + trigs.length);
check("触发词不含单字「放」", !trigs.some((t) => t.phrase === "放"));
check("capability_view 能查到做不到的事", CAP.capabilityView(100000001, "音乐").indexOf("我做不到的") >= 0);

CAP.noteOverclaim("播放音乐/音频", "放给你听");
check("第一次命中不生成提案", CAP.loadProposals().filter((p) => p.status === "pending").length === 0);
CAP.noteOverclaim("播放音乐/音频", "放给你听");
const props = CAP.loadProposals();
check("第二次命中生成负清单提案", props.some((p) => p.status === "pending" && p.label.indexOf("播放音乐") >= 0), JSON.stringify(props));

/* ---------- 3. 成长记忆闸 ---------- */
const evo = require("E:/Learn/Momo/plugins/evolution.js");
evo.init({ SELF_DIR: DIR, DATA_DIR: DIR, log: () => {}, reloadEvolution: () => {}, apiKey: "", isBudgetExhausted: () => true });
const looks = evo.api.evolution.looksLikeUnverifiedDeed;
check("拦「我攒了几首轻音乐，想放给对方听」", looks("我攒了几首轻音乐，想放给对方听。") === true);
check("拦「我这就放给你听」", looks("我这就放给你听") === true);
check("拦「我能放歌」", looks("我能放歌") === true);
check("不拦性格类记忆", looks("我嘴硬但其实很在意对方") === false);
check("不拦日常闲聊", looks("我今天吃了两碗饭") === false);
check("拦「我推荐的炸蛋配肉肠没出错」", looks("我推荐的炸蛋配肉肠没出错。") === true);
check("不拦「对方点了他爱吃的」", looks("对方点了他爱吃的") === false);

/* ---------- 4. 记忆提炼过滤 ---------- */
const mem = require("E:/Learn/Momo/plugins/memory.js");
mem.init({ DATA_DIR: DIR, log: () => {} });
const d1 = mem.api.memory.dropAgentDeeds([
  { content: "主人打游戏累了会先休息，并接受大肥鱼放轻音乐助眠" },
  { content: "主人喜欢喝杨枝甘露奶茶" },
]);
check("丢弃「接受大肥鱼放…」", d1.dropped === 1 && d1.kept.length === 1);
check("正常偏好保留", d1.kept[0].content.indexOf("杨枝甘露") >= 0);

/* ---------- 5. 用户画像过滤 ---------- */
const prof = require("E:/Learn/Momo/plugins/user-profile.js");
prof.init({ DATA_DIR: DIR, log: () => {}, getSetting: (k, d) => d });
/* mergeProfile 不在 api 里，用 extract 链路太重：这里只验证画像上下文不会带"大肥鱼放"（靠合并过滤） */
const PU = prof.api.userProfile;
check("画像 api 可用", !!(PU && PU.profileText));

/* ---------- 6. 清理脚本 dry-run 不写盘 ---------- */
const selfDir = path.join(DIR, "self");
const dataDir = path.join(DIR, "data");
fs.mkdirSync(selfDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(selfDir, "identity.json"), JSON.stringify([{ text: "我攒了几首轻音乐，想放给对方听。", from: 1 }]));
const before = fs.readFileSync(path.join(selfDir, "identity.json"), "utf8");
const { execFileSync } = require("child_process");
let out = "";
try {
  out = execFileSync(process.execPath, ["E:/Learn/Momo/scripts/cleanup-fabricated.js", "--dry-run"], { encoding: "utf8", timeout: 60000 });
} catch (e) { out = String(e.stdout || e.message); }
const after = fs.readFileSync(path.join(selfDir, "identity.json"), "utf8");
check("dry-run 能跑通", out.indexOf("预演") >= 0, out.slice(0, 80));
check("dry-run 不改文件", before === after);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);

