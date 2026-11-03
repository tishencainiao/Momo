#!/usr/bin/env node
/* 防重复回复测试：补回消息的宽限期 + 技能规则标记已读 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function extractFunc(s, name) {
  const start = s.indexOf("async function " + name + "(");
  const start2 = start >= 0 ? start : s.indexOf("function " + name + "(");
  if (start2 < 0) return null;
  let i = s.indexOf("{", start2), depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) break; }
  }
  return s.slice(start2, i + 1);
}

// 1. 源码级：技能规则分支里必须有 saveSeenMsg
const ruleIdx = src.indexOf("const skillRule = matchSkillRule");
const ruleBlock = ruleIdx >= 0 ? src.slice(ruleIdx, ruleIdx + 1200) : "";
check("技能规则分支存在", ruleIdx >= 0);
check("技能规则分支里标记了已读", ruleBlock.indexOf("saveSeenMsg(userId, msgTime)") >= 0,
  ruleBlock.slice(0, 200));

// 2. 行为级：宽限期过滤
const fnSrc = extractFunc(src, "catchUpMissedMessages");
check("提取到 catchUpMissedMessages", !!fnSrc);
check("源码里有宽限期常量", fnSrc && fnSrc.indexOf("GRACE_SEC") >= 0);

const nowSec = Math.floor(Date.now() / 1000);
let recovered = [];
const ctx = {
  cfg: { qq: { allowed_users: [1000] } },
  loadSeenMsg: () => ({ "1000": nowSec - 300 }),
  saveSeenMsg: () => {},
  log: () => {},
  textOfMessage: (m) => String(m || ""),
  enqueuePrivateChat: (u, text) => { recovered.push({ u, text }); },
  qzoneHttp: async () => ({
    messages: [
      { user_id: 1000, time: nowSec - 120, message: "两分钟前的（该补）" },
      { user_id: 1000, time: nowSec - 5, message: "五秒前的（可能正在处理，别补）" },
      { user_id: 1000, time: nowSec - 200, message: "老消息（已读之后？不，比 seen 新）" },
      { user_id: 2000, time: nowSec - 120, message: "别人发的（不该补）" },
    ],
  }),
};
vm.createContext(ctx);
vm.runInContext(fnSrc + "\nthis.catchUp = catchUpMissedMessages;", ctx);
ctx.catchUp().then(() => {
  const texts = recovered.map((r) => r.text).join("|");
  check("补回了 2 分钟前的消息", texts.indexOf("两分钟前的") >= 0, texts);
  check("没补 5 秒前的新消息", texts.indexOf("五秒前的") < 0, texts);
  check("没补别人的消息", texts.indexOf("别人发的") < 0, texts);
  check("补回的是合并成一条", recovered.length === 1, JSON.stringify(recovered));

  // 3. 全部都在宽限期内 → 一条都不补
  recovered = [];
  ctx.qzoneHttp = async () => ({ messages: [{ user_id: 1000, time: nowSec - 3, message: "刚刚" }] });
  return ctx.catchUp();
}).then(() => {
  check("全在宽限期内时不补", recovered.length === 0, JSON.stringify(recovered));
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error("测试异常:", e.message);
  process.exit(1);
});
