#!/usr/bin/env node
/* 历史事件脱敏脚本测试（scripts/redact-body-events.js）
 * 用临时文件跑，不碰真实 data/body-events.jsonl
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "redact-body-events.js");
const TMP = path.join(os.tmpdir(), "momo-redact-test.jsonl");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

const lines = [
  { ts: 1, event: "foreground", title: "机密.docx", app: "WINWORD.EXE", pid: 9 },
  { ts: 2, event: "sense", presence: "active", foreground: { title: "机密.docx", app: "WINWORD.EXE", pid: 9 } },
  { ts: 3, event: "drop", files: ["C:\\Users\\x\\Desktop\\私密.pdf"] },
  { ts: 4, event: "click", x: 1, y: 2 },
];
fs.writeFileSync(TMP, lines.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");

function run(extraArgs) {
  return spawnSync(process.execPath, [SCRIPT, ...(extraArgs || [])], {
    env: Object.assign({}, process.env, { MOMO_BODY_EVENTS: TMP }),
    encoding: "utf8",
  });
}

console.log("\n[1] dry-run 不写盘");
const before = fs.readFileSync(TMP, "utf8");
const dry = run();
check("退出码 0", dry.status === 0, String(dry.status));
check("报告要脱敏 3 条", /需要脱敏: 3/.test(dry.stdout), dry.stdout.trim());
check("dry-run 后文件没变", fs.readFileSync(TMP, "utf8") === before);

console.log("\n[2] --apply 真的脱敏");
const applied = run(["--apply"]);
check("apply 退出码 0", applied.status === 0, String(applied.status));
const after = fs.readFileSync(TMP, "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("顶层 title 被删", !("title" in after[0]), JSON.stringify(after[0]));
check("保留了 app 与 pid", after[0].app === "WINWORD.EXE" && after[0].pid === 9, JSON.stringify(after[0]));
check("嵌套 foreground.title 被删", !after[1].foreground.title && after[1].foreground.app === "WINWORD.EXE",
  JSON.stringify(after[1].foreground));
check("投喂只留文件名", after[2].files[0] === "私密.pdf", JSON.stringify(after[2].files));
check("无关事件保持原样", after[3].event === "click" && after[3].x === 1, JSON.stringify(after[3]));
check("总条数不变", after.length === 4, String(after.length));

console.log("\n[3] 幂等");
const again = run(["--apply"]);
check("第二次跑报告无需脱敏", /已经是干净的|需要脱敏: 0/.test(again.stdout), again.stdout.trim());

try { fs.unlinkSync(TMP); } catch (e) {}
console.log("\n结果：" + pass + " 过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);
