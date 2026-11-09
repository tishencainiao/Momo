/* 插件：生日（工具 set_birthday + 命令 /生日 + 每日祝福检查） */
const fs = require("fs");
const path = require("path");
let _dir = "", _ctx = null;
const bdFile = () => path.join(_dir, "birthdays.json");
function loadBirthdays() { try { return JSON.parse(fs.readFileSync(bdFile(), "utf8")); } catch (e) { return {}; } }
function saveBirthdays(b) { try { fs.mkdirSync(_dir, { recursive: true }); fs.writeFileSync(bdFile(), JSON.stringify(b)); } catch (e) {} }
function parseBirthday(text) {
  const m = String(text).match(/生日(?:是|在)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) return `${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  return null;
}
let lastCheck = 0;

module.exports = {
  name: "birthdays",
  displayName: "生日",
  description: "记生日、查生日、每日生日祝福检查",
  permissions: ["DATA_DIR", "dayStr", "log", "recordAndSend", "sendPrivate", "todayMMDD"],
  version: "1.0.0",
  init(ctx) { _ctx = ctx; _dir = ctx.DATA_DIR; },
  tools: [{
    def: {
      type: "function",
      function: {
        name: "set_birthday",
        description: "记录对方生日。当对方说「我的生日是X月X日」时调用。",
        parameters: { type: "object", properties: { content: { type: "string", description: "对方原话" } }, required: ["content"] },
      },
    },
    handler(args, info) {
      const bd = parseBirthday(String(args.content || ""));
      if (bd) {
        const b = loadBirthdays();
        b[String(info.userId)] = { date: bd, name: info.call || "你" };
        saveBirthdays(b);
        return `已记录生日：${bd.replace("-", "月")}日`;
      }
      return "（没听懂生日是哪天）";
    },
  }, {
    def: {
      type: "function",
      function: {
        name: "birthday_view",
        description: "查看记住的生日。当对方问「我的生日是哪天」「你记得我生日吗」时调用。",
        parameters: { type: "object", properties: {} },
      },
    },
    handler(args, info) {
      const b = loadBirthdays();
      const mine = b[String(info.userId)];
      return mine ? `我记住的你的生日：${mine.date.replace("-", "月")}日` : "我还不记得你的生日呢（说「我的生日是X月X日」告诉我）";
    },
  }],
  commands: [{
    key: "/生日",
    regex: /^\/生日/,
    handler(msg) {
      const b = loadBirthdays();
      const mine = b[String(msg.userId)];
      _ctx.sendPrivate(msg.userId, mine ? `我记住的你的生日：${mine.date.replace("-", "月")}日` : "我还不记得你的生日呢，说「我的生日是X月X日」告诉我吧～");
    },
  }],
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (now - lastCheck < 10 * 60000) return;
      lastCheck = now;
      const b = loadBirthdays();
      const today = _ctx.todayMMDD();
      const dateStr = _ctx.dayStr(0);
      let changed = false;
      for (const [uid, info] of Object.entries(b)) {
        if (info.date !== today || info.wished === dateStr) continue;
        const name = info.name || "你";
        _ctx.recordAndSend(Number(uid), `🎂 今天是你的生日呀！祝${name}生日快乐，天天开心，本鱼给你摇尾巴庆祝～`).catch(() => {});
        info.wished = dateStr;
        changed = true;
        _ctx.log("info", `生日祝福 → ${uid}`);
      }
      if (changed) saveBirthdays(b);
    },
  },
};
