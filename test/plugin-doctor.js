/* 测试 scripts/plugin-doctor.js 的体检规则 + plugins/plugin-doctor.js 的简报/感知 */
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { diagnose, formatText, satisfies } = require("../scripts/plugin-doctor");

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };

/* ---- satisfies 版本比较 ---- */
ok(satisfies(">=1.2.0", "1.3.0") === true, ">=1.2.0 满足 1.3.0");
ok(satisfies(">=1.2.0", "1.2.0") === true, ">=1.2.0 满足 1.2.0");
ok(satisfies(">=1.2.0", "1.0.0") === false, ">=1.2.0 不满足 1.0.0");
ok(satisfies("^1.80.0", "1.81.0") === true, "^1.80.0 满足 1.81.0");
ok(satisfies("1.81.0", "1.81.0") === true, "精确 1.81.0 满足 1.81.0");
ok(satisfies(undefined, "1.81.0") === true, "未声明 engine 放行");
ok(satisfies("bogus", "1.81.0") === true, "解析不了放行不误伤");

/* ---- diagnose 用临时 fixtures 目录 ---- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-doctor-"));
function write(f, body) { fs.writeFileSync(path.join(dir, f), body); }

write("good.js", `module.exports = { name: "good-tool", displayName: "好工具", description: "测", version: "1.0.0", permissions: ["log"], init(){} };`);
write("nometa.js", `module.exports = { name: "nometa", version: "1.0.0", init(){} };`);
write("badname.js", `module.exports = { name: "BadName", displayName: "坏名", description: "x", version: "1.0.0", permissions: ["log"], init(){} };`);
write("missing-req.js", `module.exports = { name: "missing-req", displayName: "缺依赖", description: "x", version: "1.0.0", permissions: ["log"], requires: ["nonexistent-ns"], init(){} };`);
write("dup.js", `module.exports = { name: "dup-a", displayName: "撞命名空间", description: "x", version: "1.0.0", permissions: ["log"], api: { shared: { a(){} } }, init(){} };`);
write("dup2.js", `module.exports = { name: "dup-b", displayName: "撞2", description: "x", version: "1.0.0", permissions: ["log"], api: { shared: { b(){} } }, init(){} };`);
write("api-nospec.js", `module.exports = { name: "api-nospec", displayName: "有api无契约", description: "x", version: "1.0.0", permissions: ["log"], api: { foo: { a(){} } }, init(){} };`);
write("api-badspec.js", `module.exports = { name: "api-badspec", displayName: "契约错命名空间", description: "x", version: "1.0.0", permissions: ["log"], api: { baz: { a(){} } }, apiSpec: { bar: { x: { input: "", output: "", sideEffect: "" } } }, init(){} };`);

const r = diagnose({ kernelVersion: "1.81.0", pluginsDir: dir });
const byName = (nm) => r.plugins.find((p) => p.name === nm);

ok(r.summary.total === 8, "总数 8");
ok(byName("good-tool").level === "green", "good-tool 绿");
ok(byName("nometa").level === "yellow", "nometa 黄（缺 displayName/description/permissions）");
ok(byName("BadName").level === "red", "BadName 红（camelCase）");
ok(byName("missing-req").level === "red", "missing-req 红（缺依赖）");
ok(byName("dup-a").level === "red", "dup-a 红（命名空间冲突）");
ok(byName("dup-b").level === "red", "dup-b 红（命名空间冲突）");
ok(byName("api-nospec").level === "yellow", "api-nospec 黄（有 api 缺 apiSpec）");
ok(byName("api-badspec").level === "red", "api-badspec 红（apiSpec 描述了不存在的命名空间）");
ok(r.summary.red === 5, "红 5（badname + missing-req + dup×2 + api-badspec）");
ok(r.summary.yellow === 2, "黄 2（nometa + api-nospec）");
ok(r.ok === false, "有红项 → ok=false");

ok(typeof formatText(r) === "string" && formatText(r).includes("插件体检"), "formatText 输出文本");

fs.rmSync(dir, { recursive: true, force: true });

/* ---- plugins/plugin-doctor.js 的 issueBrief（mock ctx）---- */
let savedJournal = null;
const mockCtx = {
  BASE_VERSION: "1.81.0",
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "momo-doc-ctx-")),
  SELF_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "momo-doc-self-")),
  config: { qq: { master_user: 100000001 } },
  getSetting: () => true,
  isMaster: () => true,
  log() {}, recordAction() {}, recordAndSend: async () => {}, sendPrivate() {},
};
const plugin = require("../plugins/plugin-doctor");
plugin.init(mockCtx);
const briefGreen = plugin.__test.issueBrief({ summary: { red: 0, yellow: 0 }, plugins: [] });
ok(briefGreen === "", "全绿 issueBrief 返回空串");
const briefBad = plugin.__test.issueBrief({ summary: { red: 1, yellow: 2 }, plugins: [
  { name: "x", level: "red", issues: [{ msg: "缺依赖" }] },
] });
ok(briefBad.includes("1 个硬问题"), "有问题 issueBrief 有内容");
plugin.__test.rememberIssue("测试感知");
const journal = JSON.parse(fs.readFileSync(path.join(mockCtx.SELF_DIR, "journal.json"), "utf8"));
ok(journal.length === 1 && journal[0].type === "plugin_issue", "rememberIssue 写 journal type=plugin_issue");

console.log(`plugin-doctor 测试通过（${n} 断言）`);
