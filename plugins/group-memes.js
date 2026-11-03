/* 插件：群梗 —— 学群里的黑话/梗，只在对应群里生效
 * 数据：data/group-memes.json = { groupId: [{meme, meaning, by, ts, used}] }
 * 学习途径：① 自动识别「X 的意思是 Y」② 模型调 group_meme_learn ③ 主人手动
 * 注入：groupMemes.ctx(groupId) 只给当前群，避免串群 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const file = () => path.join(_ctx.DATA_DIR, "group-memes.json");
function load() { try { const d = JSON.parse(fs.readFileSync(file(), "utf8")); return (d && typeof d === "object") ? d : {}; } catch (e) { return {}; } }
function save(d) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d)); } catch (e) {} }

/* 学一个梗（同群同梗去重，重复说会累加 used） */
function learn(groupId, meme, meaning, byUserId) {
  const g = String(groupId || "");
  const m = String(meme || "").trim().slice(0, 20);
  const s = String(meaning || "").trim().slice(0, 80);
  if (!g || !m) return { ok: false, msg: "（梗或群不对）" };
  const d = load();
  const arr = d[g] = d[g] || [];
  const hit = arr.find((x) => x.meme === m);
  if (hit) {
    if (s) hit.meaning = s;
    hit.used = (hit.used || 0) + 1;
    hit.ts = Date.now();
    save(d);
    return { ok: true, updated: true, msg: `「${m}」又出现了，已经记第 ${hit.used} 次` };
  }
  arr.push({ meme: m, meaning: s, by: Number(byUserId) || 0, ts: Date.now(), used: 1 });
  while (arr.length > 60) arr.shift();
  save(d);
  _ctx.log("info", `群梗+1 群${g}: ${m}${s ? " = " + s : ""}`);
  return { ok: true, msg: s ? `记住了，群里「${m}」是「${s}」` : `记下群里常说「${m}」了` };
}

/* 自动识别「X 的意思是 Y」「X 是 Y 的梗」这类说法 */
const PATTERNS = [
  /^(.{1,12}?)\s*(?:的意思|是啥意思|是啥|是什么意思)\s*[是为：:]\s*(.{1,60})$/,
  /^(.{1,12}?)\s*[，,]\s*(?:就是|意思是|指的是)\s*(.{1,60})$/,
  /^(.{1,12}?)\s*是\s*(?:个|一个)?.{0,4}梗[，,：:]?\s*(.{0,60})$/,
];
function detectAndLearn(groupId, text, userId) {
  const t = String(text || "").trim();
  if (!t || t.length > 80) return null;
  for (const re of PATTERNS) {
    const m = t.match(re);
    if (m && m[1] && m[1].length >= 1) {
      const meme = m[1].replace(/^["'「『]|["'」』]$/g, "").trim();
      const meaning = (m[2] || "").replace(/^["'「『]|["'」』]$/g, "").trim();
      if (!meme || meme.length > 12) continue;
      return learn(groupId, meme, meaning, userId);
    }
  }
  return null;
}

/* 注入当前群的梗（不含别的群） */
function ctx(groupId) {
  const arr = load()[String(groupId || "")] || [];
  if (!arr.length) return "";
  const top = arr.slice(-8).map((x) => (x.meaning ? `「${x.meme}」= ${x.meaning}` : `「${x.meme}」`));
  return `【这个群里的梗（只在当前群用，别拿到别处）】\n${top.join("；")}`;
}

function list(groupId) {
  const arr = load()[String(groupId || "")] || [];
  if (!arr.length) return "（这个群还没学到梗）";
  return arr.slice(-15).map((x, i) => `${i + 1}. 「${x.meme}」${x.meaning ? " = " + x.meaning : "（还没解释）"}（出现 ${x.used || 1} 次）`).join("\n");
}

module.exports = {
  name: "group-memes",
  version: "1.0.0",
  init(ctx2) { _ctx = ctx2; },
  api: { groupMemes: { learn, detectAndLearn, ctx, list } },
  tools: [
    {
      def: {
        type: "function",
        function: {
          name: "group_meme_view",
          description: "查看当前群里的梗和黑话（只在群聊可用）。当群友说「这梗什么意思」「你们说的X是啥」时调用。",
          parameters: { type: "object", properties: {} },
        },
      },
      handler(args, info) {
        if (!info || !info.groupId) return "（只有群聊里才有群梗）";
        return list(info.groupId);
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "group_meme_learn",
          description: "记下群里的一个梗/黑话。当群友解释某个说法是什么意思时调用。",
          parameters: {
            type: "object",
            properties: {
              meme: { type: "string", description: "梗本身，如「老八」" },
              meaning: { type: "string", description: "它的意思，如「游戏里垫底」" },
            },
            required: ["meme"],
          },
        },
      },
      handler(args, info) {
        if (!info || !info.groupId) return "（只有群聊里才能学群梗）";
        const r = learn(info.groupId, args.meme, args.meaning, info.userId);
        return r.msg;
      },
    },
  ],
};
