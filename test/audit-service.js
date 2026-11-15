/* 框架服务 audit-service 测试（骨骼方案 S3） */
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}
const DIR = path.join(os.tmpdir(), "momo-audit-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

const TRIGGERS = [{ phrase: "放歌", id: "audio-play", label: "播放音乐/音频" }, { phrase: "放给你听", id: "audio-play", label: "播放音乐/音频" }];
const calls = { overclaim: [] };
const mod = require("../plugins/audit-service.js");
mod.init({
  DATA_DIR: DIR,
  SELF_DIR: DIR,
  log: () => {},
  getSetting: (k, d) => d,
  getApi: () => ({
    limitTriggers: () => TRIGGERS,
    noteOverclaim: (label, phrase) => calls.overclaim.push(label + "/" + phrase),
  }),
});
const a = mod.api.audit;

check("manifest system:true", mod.system === true);
check("manifest userScoped:false", mod.userScoped === false);

const r0 = a.auditReply("你先歇会儿吧。", []);
check("普通聊天放行", r0.blocked === false && r0.text === "你先歇会儿吧。");

const r1 = a.auditReply("好，我这就放给你听。", []);
check("编造「放给你听」被拦", r1.blocked === true && r1.text !== "好，我这就放给你听。", r1.text);
check("拦下时带回 label", r1.label === "播放音乐/音频");
check("noteOverclaim 被调用", calls.overclaim.length === 1);
check("写反思落盘", fs.existsSync(path.join(DIR, "reflections.json")));

const r2 = a.auditReply("好，我这就放给你听。", ["send_voice"]);
check("真有 send_voice 成功时放行", r2.blocked === false);

/* before_send 钩子 */
const p1 = { text: "好，我这就放给你听。", channel: "private", usedTools: [] };
mod.hooks.before_send(p1);
check("before_send 私聊改写文本", p1.text !== "好，我这就放给你听。");
const p2 = { text: "好，我这就放给你听。", channel: "group", usedTools: [] };
mod.hooks.before_send(p2);
check("before_send 群聊不动", p2.text === "好，我这就放给你听。");

/* 开关关掉 */
mod.init({
  DATA_DIR: DIR, SELF_DIR: DIR, log: () => {},
  getSetting: (k, d) => "false",
  getApi: () => ({ limitTriggers: () => TRIGGERS, noteOverclaim: () => {} }),
});
const r3 = mod.api.audit.auditReply("好，我这就放给你听。", []);
check("safety.audit.enabled=false 时不拦", r3.blocked === false);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
