#!/usr/bin/env node
/* WP3：digest.py 写侧验证（src_id 稳定性/validate_topics 拒绝分支/collect 遗忘不复活/跨语言哈希一致） */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DRIVER = path.join(ROOT, "data", "wp3-digest-driver.py");
const DIGEST = require(path.join(ROOT, "plugins", "memory-digest.js"));
const { srcId } = DIGEST.__test;

function py(mode, env) {
  const r = spawnSync("python", [DRIVER, mode], { env: Object.assign({}, process.env, env || {}), encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error("python 失败: " + (r.stderr || "").slice(0, 200));
  const line = (r.stdout || "").split("\n").find((l) => l.startsWith("JSON:"));
  if (!line) throw new Error("无 JSON 输出: " + (r.stdout || "").slice(0, 200));
  return JSON.parse(line.slice(5));
}

let n = 0;
function check(name, fn) { try { fn(); n++; console.log("  ✓ " + name); } catch (e) { console.error("  ✗ " + name + "  → " + e.message); process.exitCode = 1; } }

check("src_id：同输入稳定、内容变 id 变、scope 变 id 变", () => {
  const r = py("vectors");
  if (r.ids.length !== 5) throw new Error("向量数");
  if (!r.same) throw new Error("同输入应同 id");
  if (!r.diff_scope) throw new Error("scope 不同应不同 id");
});
check("跨语言一致：Node srcId 与 digest.py src_id 相同（4 个向量）", () => {
  const r = py("vectors");
  const exp = [
    srcId("mem", "user:42", "今晚吃了火锅"),
    srcId("mem", "user:42", "今晚吃了火锅"),
    srcId("mem", "group:7", "今晚吃了火锅"),
    srcId("ident", "self", "我是一只肥鱼"),
    srcId("refl", "user:100000001", "主人的电脑密码是生日。"),
  ];
  for (let i = 0; i < exp.length; i++) {
    if (r.ids[i] !== exp[i]) throw new Error("向量 " + i + " 不一致: py=" + r.ids[i] + " node=" + exp[i]);
  }
});
check("validate_topics：正常单作用域提交 + revision/privacy_scope/subject 补齐", () => {
  const r = py("validate");
  if (r.r1_topics !== 1) throw new Error("正常 topic 应留 1");
  if (r.r1_scope !== "user:42") throw new Error("privacy_scope 应来自证据: " + r.r1_scope);
  if (r.r1_subject !== "user") throw new Error("subject 应缺省为 user");
  if (!r.r1_rev) throw new Error("应补 revision");
});
check("validate_topics：伪造证据拒绝提交", () => {
  const r = py("validate");
  if (r.r2_topics !== 0) throw new Error("伪造证据应拒");
});
check("validate_topics：跨作用域证据拒绝提交", () => {
  const r = py("validate");
  if (r.r3_topics !== 0) throw new Error("跨 scope 应拒");
});
check("validate_topics：subject 反了拒绝提交（用户偏好≠Momo 偏好）", () => {
  const r = py("validate");
  if (r.r4_topics !== 0) throw new Error("subject=self 在 user 桶应拒");
});
check("validate_topics：无证据拒绝提交", () => {
  const r = py("validate");
  if (r.r5_topics !== 0) throw new Error("无证据应拒");
});
check("validate_topics：kept/dropped 过滤无效 id、missing 重算", () => {
  const r = py("validate");
  const idJia = srcId("mem", "user:42", "甲");
  const idYi = srcId("mem", "user:42", "乙");
  const idBing = srcId("mem", "group:7", "丙");
  if (r.r6_kept.length !== 1 || r.r6_kept[0] !== idJia) throw new Error("kept 口径: " + JSON.stringify(r.r6_kept));
  if (r.r6_dropped_ids.length !== 1 || r.r6_dropped_ids[0] !== idYi) throw new Error("dropped 应只剩有效 1 条");
  if (r.r6_missing.length !== 1 || r.r6_missing[0] !== idBing) throw new Error("missing 应为未出现的丙: " + JSON.stringify(r.r6_missing));
});
check("validate_topics：global 桶 public_self 布尔化", () => {
  const r = py("public_self");
  if (r.t1_public !== true) throw new Error("public_self=true 应保留");
  if (r.t2_public !== false) throw new Error("字符串 \"false\" 应布尔化为 false");
  if (r.t1_scope !== "self") throw new Error("self 桶 scope 应为 self");
});
check("B08：prefilter 同文不同 scope 都保留（去重 key=正文+scope）", () => {
  const r = py("prefilter_scope");
  const idG1 = srcId("mem", "group:1", "翻车视频合集");
  const idG2 = srcId("mem", "group:2", "翻车视频合集");
  if (r.out1.length !== 3) throw new Error("双群同文+私聊应全保留: " + JSON.stringify(r.out1));
  if (r.out1.indexOf(idG1) < 0 || r.out1.indexOf(idG2) < 0) throw new Error("双群证据都应在");
  if (r.drop1.length !== 0) throw new Error("不同 scope 不应去重");
});
check("B17：一条真实证据+一条伪造证据 → 整个 topic 拒绝（不过滤后继续）", () => {
  const r = py("fake_mixed");
  if (r.topics !== 0) throw new Error("混入伪造证据应整条拒绝: " + r.topics);
});
check("collect：遗忘后不复活（删除来源条目后 id 不再出现）", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "momo-wp3-"));
  fs.mkdirSync(path.join(TMP, "data", "memory"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "self"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "config.json"), JSON.stringify({ qq: { master_user: 100000001 } }));
  const mem42 = { items: [{ content: "甲", channel: "private", groupId: 0 }, { content: "乙", channel: "private", groupId: 0 }] };
  const mp = path.join(TMP, "data", "memory", "42.json");
  fs.writeFileSync(mp, JSON.stringify(mem42));
  fs.writeFileSync(path.join(TMP, "self", "identity.json"), JSON.stringify([]));
  fs.writeFileSync(path.join(TMP, "self", "reflections.json"), JSON.stringify([]));
  const before = py("collect", { DIGEST_TMP: TMP });
  const idJia = srcId("mem", "user:42", "甲");
  if (!(before["42"] || []).includes(idJia)) throw new Error("遗忘前应有甲");
  mem42.items.shift();
  fs.writeFileSync(mp, JSON.stringify(mem42));
  const after = py("collect", { DIGEST_TMP: TMP });
  if ((after["42"] || []).includes(idJia)) throw new Error("遗忘后甲不应再出现（不复活）");
  if (!(after["42"] || []).includes(srcId("mem", "user:42", "乙"))) throw new Error("乙应仍在");
});

console.log("通过 " + n + " / 失败 " + (process.exitCode ? 1 : 0));
process.exit(process.exitCode ? 1 : 0);
