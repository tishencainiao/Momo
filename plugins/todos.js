/* 插件：待办（add_todo/list_todo/complete_todo/remove_todo + /待办 + 到期提醒）
 * 借鉴 DSH dsh-memory-evolve 的 dtodo 思路，落地到 Momo 插件平台 */
const fs = require("fs");
const path = require("path");
let _dir = "", _ctx = null;
const todoFile = () => path.join(_dir, "todos.json");
function loadTodos() { try { return JSON.parse(fs.readFileSync(todoFile(), "utf8")); } catch (e) { return []; } }
function saveTodos(t) { try { fs.mkdirSync(_dir, { recursive: true }); fs.writeFileSync(todoFile(), JSON.stringify(t)); } catch (e) {} }
let lastCheck = 0;

function parseDue(text) {
  const s = String(text || "");
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59).getTime();
  m = s.match(/(\d+)\s*(天|日)\s*(?:后|之后)/);
  if (m) return Date.now() + Number(m[1]) * 86400e3;
  if (/后天/.test(s)) return Date.now() + 2 * 86400e3;
  if (/明天|明日/.test(s)) return Date.now() + 86400e3;
  return 0;
}
function qLabel(q) { return { q1: "重要紧急", q2: "重要不紧急", q3: "紧急不重要", q4: "不重要不紧急" }[q] || ""; }
function quadrantOf(imp, urg) { return imp && urg ? "q1" : (imp ? "q2" : (urg ? "q3" : "q4")); }
function mine(t, uid) { return t.filter((x) => x.status === "pending" && Number(x.userId) === Number(uid)); }

module.exports = {
  name: "todos",
  displayName: "待办",
  description: "待办增删查 + /待办 + 到期提醒",
  permissions: ["DATA_DIR", "formatGap", "log", "recordAndSend", "sendPrivate"],
  version: "1.0.0",
  attribution: {
    source: "DSH dsh-memory-evolve (dtodo)",
    license: "思路借鉴（未复用代码）",
    note: "待办数据结构 + 到期提醒思路",
    importedAt: "2026-11-09",
  },
  init(ctx) { _ctx = ctx; _dir = ctx.DATA_DIR; },
  tools: [
    {
      def: { type: "function", function: { name: "add_todo", description: "添加一条待办。当对方说「记住/我要做/帮我记个待办 XX」时调用。", parameters: { type: "object", properties: { content: { type: "string", description: "待办内容" }, due: { type: "string", description: "截止时间，如 2026-11-01 或 明天 或 3天后（可空）" }, important: { type: "boolean", description: "是否重要" }, urgent: { type: "boolean", description: "是否紧急" } }, required: ["content"] } } },
      handler(args, info) {
        const content = String(args.content || "").trim().slice(0, 100);
        if (!content) return "（待办内容为空）";
        const t = loadTodos();
        const dueTs = parseDue(String(args.due || ""));
        const imp = !!args.important, urg = !!args.urgent, q = quadrantOf(imp, urg);
        t.push({ id: "t" + Date.now().toString(36), userId: info.userId, content, dueTs, important: imp, urgent: urg, quadrant: q, status: "pending", created: Date.now() });
        saveTodos(t);
        let extra = "";
        if (dueTs) extra = `，截止${_ctx.formatGap(dueTs - Date.now())}后`;
        if (q !== "q4") extra += `，${qLabel(q)}`;
        return `已记下待办：${content}${extra}`;
      },
    },
    {
      def: { type: "function", function: { name: "list_todo", description: "查看待办清单。当对方说「我的待办有哪些」「看看待办」时调用。", parameters: { type: "object", properties: {} } } },
      handler(args, info) {
        const list = mine(loadTodos(), info.userId);
        if (!list.length) return "现在没有待办哦～";
        const s = list.map((x, i) => `${i + 1}. ${x.content}${x.dueTs ? `（${_ctx.formatGap(x.dueTs - Date.now())}后）` : ""}${x.quadrant !== "q4" ? `[${qLabel(x.quadrant)}]` : ""}`).join("\n");
        return `待办清单：\n${s}\n\n说「完成第N项」划掉，或「删除第N项」删掉`;
      },
    },
    {
      def: { type: "function", function: { name: "complete_todo", description: "划掉/完成一条待办。当对方说「XX做完了」「完成第N项」时调用。", parameters: { type: "object", properties: { index: { type: "number", description: "待办序号（1 开始）" } }, required: ["index"] } } },
      handler(args, info) {
        const t = loadTodos();
        const list = mine(t, info.userId);
        const idx = Number(args.index);
        if (isNaN(idx) || idx < 1 || idx > list.length) return "（没找到这条待办，说「待办」看清单再告诉我序号）";
        list[idx - 1].status = "done"; list[idx - 1].doneAt = Date.now();
        saveTodos(t);
        return `✅ 完成：${list[idx - 1].content}`;
      },
    },
    {
      def: { type: "function", function: { name: "remove_todo", description: "删除一条待办。当对方说「删掉待办第N项」时调用。", parameters: { type: "object", properties: { index: { type: "number", description: "待办序号（1 开始）" } }, required: ["index"] } } },
      handler(args, info) {
        const t = loadTodos();
        const list = mine(t, info.userId);
        const idx = Number(args.index);
        if (isNaN(idx) || idx < 1 || idx > list.length) return "（没找到这条待办）";
        list[idx - 1].status = "removed";
        saveTodos(t);
        return `已删除：${list[idx - 1].content}`;
      },
    },
  ],
  commands: [
    {
      key: "/待办",
      regex: /^\/待办/,
      handler(msg) {
        const arg = msg.text.replace(/^\/待办\s*/, "").trim();
        const t = loadTodos();
        const list = mine(t, msg.userId);
        if (/^(完成|删除)/.test(arg)) {
          const n = Number((arg.match(/(\d+)/) || [])[1]);
          if (!n || n < 1 || n > list.length) { _ctx.sendPrivate(msg.userId, "要说「待办 完成 N」或「待办 删除 N」（N 是清单里的序号）哦"); return; }
          if (arg.startsWith("删除")) { list[n - 1].status = "removed"; saveTodos(t); _ctx.sendPrivate(msg.userId, `已删除：${list[n - 1].content}`); }
          else { list[n - 1].status = "done"; list[n - 1].doneAt = Date.now(); saveTodos(t); _ctx.sendPrivate(msg.userId, `✅ 完成：${list[n - 1].content}`); }
          return;
        }
        if (arg) {
          const imp = /重要/.test(arg), urg = /紧急/.test(arg);
          const content = arg.replace(/(重要|紧急)/g, "").trim().slice(0, 100) || arg.slice(0, 100);
          const dueTs = parseDue(arg);
          t.push({ id: "t" + Date.now().toString(36), userId: msg.userId, content, dueTs, important: imp, urgent: urg, quadrant: quadrantOf(imp, urg), status: "pending", created: Date.now() });
          saveTodos(t);
          _ctx.sendPrivate(msg.userId, `已记下待办：${content}`);
          return;
        }
        if (!list.length) { _ctx.sendPrivate(msg.userId, "现在没有待办哦～"); return; }
        const s = list.map((x, i) => `${i + 1}. ${x.content}${x.dueTs ? `（${_ctx.formatGap(x.dueTs - Date.now())}后）` : ""}`).join("\n");
        _ctx.sendPrivate(msg.userId, `待办清单：\n${s}`);
      },
    },
  ],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - lastCheck < 60000) return;
      lastCheck = now;
      const t = loadTodos();
      let changed = false;
      for (const x of t) {
        if (x.status !== "pending" || !x.dueTs || x.reminded) continue;
        if (x.dueTs <= now) {
          x.reminded = true; changed = true;
          _ctx.recordAndSend(Number(x.userId), `📌 待办到期啦：${x.content}`).catch(() => {});
          _ctx.log("info", `待办到期提醒 → ${x.userId}: ${x.content.slice(0, 30)}`);
        }
      }
      if (changed) saveTodos(t);
    },
  },
};
