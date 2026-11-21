#!/usr/bin/env node
/* 阶段三（Kimi 审查）回归：成长记忆治理
 * - self-report 不再直接 verified:true；分类型（trait/agreement/physical-claim/self-report）
 * - 负证据（对方没回/没来）不固化；物理经历只进待核实
 * - 同主题近重复只增证据次数不新增条目
 * - evolIdentityText 同主题注入上限 3 条（源码级）
 * - 审查脚本 dry-run 可跑（只读真实 self/，不写）
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

/* ---------- 源码级（index.js evolIdentityText + Kimi 返修2 默认不可信；三轮：topic 上限已移除） ---------- */
check("evolIdentityText 已移除用 kind 冒充 topic 的上限（Kimi 三轮：无可靠分类就不设上限）", !src.includes("topicCount[key] <= 3") && !src.includes("e.topic"));
check("evolIdentityText 保留事实分层", src.includes("别当成事实"));
check("evolIdentityText 默认不可信（仅 verified===true 进事实区）", src.includes("if (e.verified === true) plain.push(t)"));
check("evolIdentityText 纯字符串旧条目进待核实", src.includes("typeof e === \"string\") { claims.push(e); continue; }"));

/* ---------- 行为级（vm：旧格式不得进事实人格） ---------- */
(function () {
  try {
    const vm = require("vm");
    const m = src.match(/function evolIdentityText\(userId, limit\) \{[\s\S]*?\n\}/);
    if (!m) { check("vm 提取 evolIdentityText", false, "正则未命中"); return; }
    const sandbox = { evolve: { identity: [
      { text: "我是事实(已证实)", from: 0, verified: true },
      { text: "我说过但没证实", from: 0, verified: false },
      { text: "旧格式没有字段", from: 0 },
      "纯字符串旧条目",
    ] } };
    vm.runInNewContext("f = " + m[0], sandbox);
    const out = sandbox.f(1, 20);
    const factsAt = out.indexOf("我是事实(已证实)");
    const claimHead = out.indexOf("别当成事实");
    check("verified:true 进事实区", factsAt >= 0 && (claimHead < 0 || factsAt < claimHead));
    check("verified:false 进待核实区", out.indexOf("我说过但没证实") > claimHead && claimHead >= 0);
    check("缺 verified 旧格式进待核实区", out.indexOf("旧格式没有字段") > claimHead);
    check("纯字符串旧条目进待核实区", out.indexOf("纯字符串旧条目") > claimHead);
  } catch (e) { check("vm 提取 evolIdentityText", false, String(e)); }
})();

/* ---------- 行为级（evolution.js 插件 + 临时 SELF_DIR） ---------- */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "momo-identgov-"));
const SELF = path.join(DIR, "self");
fs.mkdirSync(SELF, { recursive: true });
let fakeReply = "";
const writes = [];
const evo = require("../plugins/evolution.js");
evo.init({
  SELF_DIR: SELF, DATA_DIR: DIR, BASE_VERSION: "1.0.0",
  log: () => {}, config: { qq: { master_user: 1000 } }, sendPrivate: async () => {},
  isBudgetExhausted: () => false,
  completeOnce: async () => fakeReply,
  reasonComplete: async () => "",
  writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); writes.push(f); },
  writeFileAtomic: (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); },
  reloadEvolution: () => {}, textSimilar: (a, b) => String(a).slice(0, 8) === String(b).slice(0, 8),
  getSetting: (k, d) => d, settings: () => ({}), isMaster: () => true,
  loadEvolution: () => ({}), canAfford: () => true, recordAndSend: () => {},
});
const E = evo.api.evolution;
const readIdentity = () => JSON.parse(fs.readFileSync(path.join(SELF, "identity.json"), "utf8"));
const realNow = Date.now;
let off = 0;
const skipTime = () => { off += 31 * 60 * 1000; Date.now = () => realNow() + off; };
const restoreTime = () => { Date.now = realNow; };

(async () => {
  /* 1. 普通性格条目：kind=trait, verified:false */
  fakeReply = "我喜欢酸酸的味道";
  await E.extractSelfIdentity("你喝咖啡", "我喜欢酸酸的", {}, 1000);
  let id = readIdentity();
  check("性格条目 verified:false", id[0].verified === false);
  check("性格条目 kind=trait", id[0].kind === "trait");
  check("性格条目有 evidences", Number(id[0].evidences) === 1);

  /* 2. 物理经历：kind=physical-claim, verified:false */
  skipTime();
  fakeReply = "[PHY]我摸到他的手好暖";
  await E.extractSelfIdentity("他递了热饮", "[PHY]我摸到他的手好暖", {}, 1000);
  restoreTime();
  id = readIdentity();
  const phy = id.find((x) => x.kind === "physical-claim");
  check("物理经历 kind=physical-claim", !!phy);
  check("物理经历 verified:false", phy && phy.verified === false);
  check("物理经历 [PHY] 前缀被剥掉", phy && phy.text.startsWith("我摸到"));

  /* 3. 负证据不固化 */
  skipTime();
  fakeReply = "对方没回我消息";
  await E.extractSelfIdentity("在吗", "对方没回我消息", {}, 1000);
  id = readIdentity();
  check("「对方没回」不固化", !id.some((x) => String(x.text).includes("没回")));

  /* 4. 同主题近重复只增证据次数 */
  skipTime();
  fakeReply = "我喜欢喝冰美式";
  await E.extractSelfIdentity("你喝啥", "我喜欢喝冰美式", {}, 1000);
  skipTime();
  fakeReply = "我喜欢喝冰美式，酸一点才带劲";
  await E.extractSelfIdentity("加酸吗", "我喜欢喝冰美式，酸一点才带劲", {}, 1000);
  restoreTime();
  id = readIdentity();
  const coffee = id.filter((x) => String(x.text).includes("冰美式"));
  check("冰美式同主题只保留一条", coffee.length === 1, JSON.stringify(coffee));
  check("同主题 evidences 累加为 2", coffee[0] && Number(coffee[0].evidences) === 2);

  /* 5. 外部写入同样 verified:false（不再 verified:true） */
  check("外部写入 verified:false", E.addIdentityItem("我其实不太喜欢香菜", 1000) === true);
  id = readIdentity();
  const xc = id.find((x) => String(x.text).includes("香菜"));
  check("外部写入 kind=self-report", xc && xc.kind === "self-report");
  check("外部写入 verified:false", xc && xc.verified === false);
  check("外部写入重复拒绝", E.addIdentityItem("我其实不太喜欢香菜", 1000) === false);

  /* 7. Kimi 返修3：近重复只在同一个 from 内合并（不跨用户串数据） */
  check("跨用户近重复不合并：from=1000 写入", E.addIdentityItem("我爱吃辣火锅", 1000) === true);
  check("跨用户近重复不合并：from=2000 再写", E.addIdentityItem("我爱吃辣火锅呢", 2000) === true);
  id = readIdentity();
  const hotpot = id.filter((x) => String(x.text).includes("辣火锅"));
  check("两个 from 各一条（不串数据）", hotpot.length === 2 && hotpot[0].from !== hotpot[1].from, JSON.stringify(hotpot));
  check("跨用户后对方 evidences 未被动", hotpot.every((x) => Number(x.evidences) === 1));
  E.addIdentityItem("我爱吃辣火锅啦", 1000);
  id = readIdentity();
  const mine = id.find((x) => Number(x.from) === 1000 && String(x.text).includes("辣火锅"));
  check("同 from 近重复合并 evidences=2", mine && Number(mine.evidences) === 2);
  /* 8. Kimi 三轮返修1：完全相同文本也按 from 隔离——两个用户写一字不差的话，各保留一条 */
  const a1 = E.addIdentityItem("我今天晚饭吃的红烧肉", 1000);
  const a2 = E.addIdentityItem("我今天晚饭吃的红烧肉", 2000);
  id = readIdentity();
  const dupText = id.filter((x) => String(x.text).includes("红烧肉"));
  check("完全相同文本跨用户各保留一条", a1 === true && a2 === true && dupText.length === 2 && dupText[0].from !== dupText[1].from, JSON.stringify(dupText));

  /* 6. 审查脚本 dry-run 只读可跑（真实 self/ 不写） */
  const nodeBin = process.execPath;
  try {
    const out = execFileSync(nodeBin, [path.join(ROOT, "scripts", "audit-identity.js")], { encoding: "utf8", timeout: 20000 });
    check("audit-identity dry-run 可跑且输出报告", out.includes("成长记忆审查") && out.includes("DRY-RUN"));
  } catch (e) { check("audit-identity dry-run 可跑且输出报告", false, String(e.message).slice(0, 120)); }

  console.log(`identity-governance: ${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("异常:", e.message); process.exit(1); });
