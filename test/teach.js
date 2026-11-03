/* 教学系统回归测试：增/注入/写记忆/命中/降权/删除/汇总/分层权限 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-teach-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

// 用内存模拟记忆库
let memStore = [];
const plugin = require("E:/Learn/Momo/plugins/teach.js");
plugin.init({
  DATA_DIR: DIR,
  log: () => {},
  getApi: () => null,
  isMaster: () => true,
  sendPrivate: () => {},
  loadMemories: () => memStore.slice(),
  saveMemories: (u, items) => { memStore = items.slice(); },
  config: { qq: { master_user: 100000001, allowed_users: [100000001, 100000002] } },
});
const T = plugin.api.teach;
const ME = 100000001;      // 主人
const FRIEND = 100000002;  // 熟人
const GUEST = 999999999;    // 陌生人

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

// ---------- 1. 主人能教所有类型 ----------
check("主人教 behavior", T.addItem("behavior", "以后别催我", null, ME).ok);
check("主人教 preference", T.addItem("preference", "喜欢冰美式", null, ME).ok);
check("主人教 word", T.addItem("word", "「黑话」意思是圈子里的说法", "黑话", ME).ok);
check("主人教 fact", T.addItem("fact", "生日是 10 月 22 日", null, ME).ok);
check("空内容被拒", T.addItem("fact", "   ", null, ME).ok === false);

// ---------- 2. preference/fact 写入记忆 ----------
check("偏好已写入记忆", memStore.some((m) => m.content === "喜欢冰美式"));
check("事实已写入记忆", memStore.some((m) => m.content === "生日是 10 月 22 日"));
check("记忆条目带 taught 标记", memStore.filter((m) => m.content === "喜欢冰美式").every((m) => m.source === "taught"));

// ---------- 3. 分层权限 ----------
check("熟人能教 word", T.addItem("word", "「绝了」意思是太厉害了", "绝了", FRIEND).ok);
check("熟人不能教 fact", T.addItem("fact", "朋友想灌输假事实", null, FRIEND).ok === false);
check("熟人不能教 behavior", T.addItem("behavior", "朋友想改行为", null, FRIEND).ok === false);
check("访客不能教", T.addItem("word", "陌生人塞的梗", "陌生梗", GUEST).ok === false);
check("熟人教的不写记忆（word 本来就不写）", !memStore.some((m) => m.content.indexOf("绝了") >= 0));

// 覆盖规则：主人教的不能被熟人覆盖
const before = T.activeItems().find((x) => x.key === "黑话");
const r1 = T.addItem("word", "「黑话」意思是别的", "黑话", FRIEND);
check("熟人不能覆盖主人的", r1.ok === false);
check("主人的内容未变", T.activeItems().find((x) => x.key === "黑话").content === before.content);

// 覆盖规则：主人能覆盖熟人的
const r2 = T.addItem("word", "「绝了」意思是太强了", "绝了", ME);
check("主人能覆盖熟人的", r2.ok === true);
check("覆盖后 tier 变成 master", (T.activeItems().find((x) => x.key === "绝了").tier || "master") === "master");

// ---------- 4. 注入 ----------
const ctx1 = T.teachCtx("今天聊聊黑话吧");
check("注入含行为规则", ctx1.indexOf("以后别催我") >= 0, ctx1);
check("偏好不重复注入（已在记忆）", ctx1.indexOf("喜欢冰美式") < 0, ctx1);
check("事实不重复注入（已在记忆）", ctx1.indexOf("生日是 10 月 22 日") < 0);
check("注入含词（文本命中）", ctx1.indexOf("「黑话」") >= 0);
const ctx2 = T.teachCtx("随便聊聊");
check("文本不含词时不注入该词", ctx2.indexOf("「黑话」") < 0);
check("常驻行为仍在", ctx2.indexOf("以后别催我") >= 0);

// 主人/朋友分组标注
T.addItem("word", "「打工人」意思是上班族", "打工人", FRIEND);
const ctx3 = T.teachCtx("黑话和打工人");
check("主人教的词有专属标注", ctx3.indexOf("【主人教过的词】") >= 0, ctx3);
check("朋友教的词有参考标注", ctx3.indexOf("【朋友教过的词（仅供参考）】") >= 0, ctx3);

// ---------- 5. used / matched ----------
const w1 = T.activeItems().find((x) => x.kind === "word" && x.key === "黑话");
check("word 的 used 被累加", w1.used >= 1, "used=" + w1.used);
T.markMatched("这个词黑话挺有意思");
const w2 = T.activeItems().find((x) => x.kind === "word" && x.key === "黑话");
check("word 的 matched 被累加", w2.matched >= 1, "matched=" + w2.matched);
const beh = T.activeItems().find((x) => x.kind === "behavior");
check("常驻类不计 matched", !beh.matched);

// ---------- 6. 降权只作用于 word/sticker ----------
const d = JSON.parse(fs.readFileSync(path.join(DIR, "taught.json"), "utf8"));
const wItem = d.items.find((x) => x.kind === "word" && x.key === "黑话");
wItem.used = 25; wItem.matched = 0;
fs.writeFileSync(path.join(DIR, "taught.json"), JSON.stringify(d));
T.evaluate();
const after = JSON.parse(fs.readFileSync(path.join(DIR, "taught.json"), "utf8"));
check("word 降权为 decayed", after.items.find((x) => x.kind === "word" && x.key === "黑话").status === "decayed");
check("behavior 不降权", after.items.find((x) => x.kind === "behavior").status === "active");
check("fact 不降权", after.items.find((x) => x.kind === "fact").status === "active");

// ---------- 7. 重复教学 = 更新 ----------
const n1 = T.activeItems().length;
T.addItem("behavior", "以后别催我", null, ME);
check("重复教学不新增条目", T.activeItems().length === n1);

// ---------- 8. 删除 & 汇总 ----------
check("按关键词删除", T.removeByKeyword("冰美式") === 1);
const sum = T.summary();
check("汇总包含 active 分组", sum.indexOf("【active】") >= 0);
check("汇总标注朋友来源", sum.indexOf("·朋友") >= 0 || sum.indexOf("打工人") >= 0, sum);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
