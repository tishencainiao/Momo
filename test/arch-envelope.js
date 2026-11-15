// R1 身份信封：agentChatOnce 两参签名 + buildPersonContext 唯一装配器（静态 + vm 行为断言）
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
let pass = 0, fail = 0;
const T = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log("FAIL " + name + (extra ? " :: " + extra : "")); } };

// 1. 结构静态断言
T("buildPersonContext 定义", /function buildPersonContext\(env, opts\)/.test(src));
T("群聊分支按群过滤记忆", /env\.channel === "group"/.test(src) && /filterMemoriesForGroup\(loadMemories\(userId\), groupId\)/.test(src));
T("群聊 max_tokens 上限 250 在装配器内", /settings\.max_tokens = Math\.min\(settings\.max_tokens \|\| 2048, 250\);/.test(src));
T("pet 分支 petMode+无摘要", /extraInfo = \{ petMode: true \}/.test(src) && /summaryKey = null;/.test(src));
T("agentChatOnce 两参信封签名", /async function agentChatOnce\(history, userText, pctx\)/.test(src));
T("旧 11 参签名已不存在", !/agentChatOnce\(history, userText, settings, memories, persona, call, userId, taskCtx, shortMemories, summaryKey, extraInfo\)/.test(src));
const n = (src.match(/buildPersonContext\(\{ sender:/g) || []).length;
T("4 个入口都用装配器（实际 " + n + "）", n === 4);
T("私聊入口带 settings 覆盖", /buildPersonContext\(\{ sender: userId, room: 0, channel: "private" \}, \{ taskCtx, settings \}\)/.test(src));
T("群聊入口带 room 与 messageId", /buildPersonContext\(\{ sender: userId, room: groupId, channel: "group" \}, \{ taskCtx: gCtx, messageId: GROUP_LAST_MSGID/.test(src));
T("proactive 入口", /buildPersonContext\(\{ sender: userId, room: 0, channel: "proactive" \}\)/.test(src));
T("pet 入口带 taskCtx", /buildPersonContext\(\{ sender: master, room: 0, channel: "pet" \}, \{ taskCtx: petCtx \}\)/.test(src));

// 2. vm 行为断言：提取 buildPersonContext，stub 依赖后按通道断言装配结果
(function () {
  try {
    const m = src.match(/function buildPersonContext\(env, opts\) \{[\s\S]*?\n\}\nasync function agentChatOnce/);
    if (!m) { T("vm 提取 buildPersonContext", false, "正则未命中"); return; }
    const fnSrc = m[0].slice(0, m[0].lastIndexOf("}\nasync function") + 1);
    const sandbox = {
      resolveChatSettings: () => ({ max_tokens: 2048, history_limit: 40, history_chars: 24000, persona: "P" }),
      loadMemories: (u) => [{ content: "m" + u }],
      pruneShortMemories: (u) => [{ content: "s" + u }],
      userPersona: (u, s) => "persona-" + u,
      resolveCall: (u) => "U" + u,
      host: { apis: { get: (ns) => ({ filterMemoriesForGroup: (arr, g) => arr.map((x) => ({ content: "g" + g + x.content })) }) } },
    };
    vm.runInNewContext("f = " + fnSrc, sandbox);
    const f = sandbox.f;
    const priv = f({ sender: 7, room: 0, channel: "private" }, {});
    T("private 装配", priv.userId === 7 && priv.call === "U7" && priv.persona === "persona-7" && priv.summaryKey === undefined && priv.taskCtx === "" && priv.memories.length === 1 && priv.settings.max_tokens === 2048 && priv.extraInfo === null);
    const grp = f({ sender: 7, room: 42, channel: "group" }, { taskCtx: "gctx", messageId: "m1" });
    T("group 装配", grp.summaryKey === "g42_7" && grp.extraInfo.groupId === 42 && grp.extraInfo.messageId === "m1" && grp.taskCtx === "gctx" && grp.settings.max_tokens === 250 && grp.memories[0].content === "g42m7" && grp.shortMemories[0].content === "g42s7");
    const pet = f({ sender: 9, room: 0, channel: "pet" }, { taskCtx: "petCtx" });
    T("pet 装配", pet.summaryKey === null && pet.extraInfo.petMode === true && pet.taskCtx === "petCtx" && pet.call === "U9" && pet.userId === 9);
    const pro = f({ sender: 7, room: 0, channel: "proactive" }, {});
    T("proactive 装配", pro.summaryKey === undefined && pro.taskCtx === "" && pro.call === "U7" && pro.extraInfo === null);
    const privCapped = f({ sender: 7, room: 0, channel: "private" }, { settings: { max_tokens: 200 }, taskCtx: "t" });
    T("settings 覆盖保留（预算耗尽降 200）", privCapped.settings.max_tokens === 200 && privCapped.taskCtx === "t");
  } catch (e) { T("vm 提取 buildPersonContext", false, String(e)); }
})();

console.log(`arch-envelope: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
