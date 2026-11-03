/* 插件：目标系统（工具 set_goal + 命令 /目标 + 今日计划 + 上下文注入） */
const fs = require("fs");
const path = require("path");
let _dir = "", _ctx = null;
const goalsFile = () => path.join(_dir, "goals.json");
function loadGoals() {
  try {
    const d = JSON.parse(fs.readFileSync(goalsFile(), "utf8"));
    return { goals: (d.goals && d.goals.length) ? d.goals : ["让主人开心，做一只贴心的桌宠"], plan: d.plan || {} };
  } catch (e) { return { goals: ["让主人开心，做一只贴心的桌宠"], plan: {} }; }
}
function saveGoals(g) { try { fs.mkdirSync(_dir, { recursive: true }); fs.writeFileSync(goalsFile(), JSON.stringify(g)); } catch (e) {} }
function goalsCtx() {
  const g = loadGoals();
  const plan = (g.plan && g.plan.date === _ctx.dayStr(0) && g.plan.items && g.plan.items.length)
    ? `今日计划：${g.plan.items.join("；")}。` : "";
  return `你的长期目标：${g.goals.join("；")}。${plan}`;
}
let lastPlan = 0;

module.exports = {
  name: "goals",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; _dir = ctx.DATA_DIR; },
  api: { goalsCtx },
  tools: [{
    def: {
      type: "function",
      function: {
        name: "set_goal",
        description: "记录主人长期目标。当主人说「我的目标是X」时调用。",
        parameters: { type: "object", properties: { content: { type: "string", description: "主人原话" } }, required: ["content"] },
      },
    },
    handler(args, info) {
      if (!_ctx.isMaster(info.userId)) return "（只有主人能定我的长期目标哦）";
      const gm = String(args.content || "").match(/我的目标是\s*[:：]?\s*(.+)/);
      if (gm && gm[1]) {
        const g = loadGoals();
        const gt = String(gm[1]).trim().slice(0, 40);
        if (!g.goals.includes(gt)) { g.goals.push(gt); while (g.goals.length > 5) g.goals.shift(); saveGoals(g); }
        rec({ action: "set_goal", by: info.userId, detail: gt, ok: true });
        return `已记录目标：「${gt}」`;
      }
      return "（没听懂目标是什么）";
    },
  }, {
    def: {
      type: "function",
      function: {
        name: "goals_view",
        description: "查看长期目标和今日计划。当对方问「你的目标是什么」「今天计划是啥」时调用。",
        parameters: { type: "object", properties: {} },
      },
    },
    handler(args, info) {
      if (!_ctx.isMaster(info.userId)) return "（我的目标和计划只有主人能看哦）";
      const g = loadGoals();
      const lines = g.goals.map((x, i) => `${i + 1}. ${x}`).join("\n");
      const plan = (g.plan && g.plan.date === _ctx.dayStr(0) && g.plan.items && g.plan.items.length) ? `\n\n今日计划：\n${g.plan.items.map((x) => "- " + x).join("\n")}` : "";
      return `我的长期目标：\n${lines}${plan}`;
    },
  }],
  commands: [{
    key: "/目标",
    regex: /^\/目标/,
    handler(msg) {
      if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "我的目标只有主人能看哦～"); return; }
      const g = loadGoals();
      const lines = g.goals.map((x, i) => `${i + 1}. ${x}`).join("\n");
      const plan = (g.plan && g.plan.date === _ctx.dayStr(0) && g.plan.items && g.plan.items.length) ? `\n\n今日计划：\n${g.plan.items.map((x) => "- " + x).join("\n")}` : "";
      _ctx.sendPrivate(msg.userId, `我的长期目标：\n${lines}${plan}`);
    },
  }],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - lastPlan < 6 * 3600e3) return;
      lastPlan = now;
      if (_ctx.isBudgetExhausted()) return;
      const g = loadGoals();
      if (g.plan && g.plan.date === _ctx.dayStr(0)) return;
      const settings = _ctx.settings();
      const prompt = `你是 Momo（大肥鱼桌宠）。你的长期目标：${g.goals.join("；")}。请制定今天的「今日小目标」清单，只输出 JSON 字符串数组（2~4 条，每条以"今天我要..."开头，具体可执行、贴合目标）。`;
      _ctx.log("info", "今日计划生成中...");
      // 直接调用内核推理：通过 settings + 原生 fetch（插件内简化实现）
      (async () => {
        try {
          const body = JSON.stringify({ model: settings.reasoner_model || settings.model, messages: [{ role: "user", content: prompt }], stream: false, max_tokens: 600, temperature: 0.3 });
          const resp = await fetch(settings.base_url.replace(/\/+$/, "") + "/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + _ctx.apiKey }, body });
          if (!resp.ok) return;
          const j = await resp.json();
          const raw = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "");
          const arr = _ctx.parseMemoryJson(raw).slice(0, 4);
          if (arr.length) {
            g.plan = { date: _ctx.dayStr(0), items: arr };
            saveGoals(g);
            _ctx.log("info", `今日计划: ${arr.join("；").slice(0, 80)}`);
          }
        } catch (e) { _ctx.log("warn", "今日计划失败: " + e.message.slice(0, 120)); }
      })();
    },
  },
};
