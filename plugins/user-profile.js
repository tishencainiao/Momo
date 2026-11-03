/* 插件：结构化用户画像
 * 借鉴角色扮演提示词指南的「用户画像抽取」：从聊天里提炼稳定信息（名字/生日/兴趣/性格/心情/偏好）
 * 存 data/user-profile.json，注入上下文，让她真的"记得这个人"
 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const FILE = () => path.join(_ctx.DATA_DIR, "user-profile.json");
function loadAll() { try { return JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch (e) { return {}; } }
function saveAll(o) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(o, null, 2)); } catch (e) {} }

function cfgNum(k, d) { try { const v = Number(_ctx.getSetting(k, d)); return Number.isFinite(v) ? v : d; } catch (e) { return d; } }
function cfgBool(k, d) { try { const v = _ctx.getSetting(k, d); return v === false ? false : (v === true ? true : d); } catch (e) { return d; } }

const LABEL = { nickname: "称呼", birthday: "生日", interests: "兴趣", personality: "性格", mood: "最近状态", preferences: "偏好" };

/* 注入用的文本块 */
function profileCtx(userId) {
  const p = loadAll()[String(userId)];
  if (!p) return "";
  const lines = [];
  if (p.nickname) lines.push(`${LABEL.nickname}：${p.nickname}`);
  if (p.birthday) lines.push(`${LABEL.birthday}：${p.birthday}`);
  if (Array.isArray(p.interests) && p.interests.length) lines.push(`${LABEL.interests}：${p.interests.join("、")}`);
  if (Array.isArray(p.personality) && p.personality.length) lines.push(`${LABEL.personality}：${p.personality.join("、")}`);
  if (p.mood) lines.push(`${LABEL.mood}：${p.mood}`);
  if (Array.isArray(p.preferences) && p.preferences.length) lines.push(`${LABEL.preferences}：${p.preferences.join("、")}`);
  if (!lines.length) return "";
  return `【你对这个人的了解（从聊天里记下的，过期信息别当准）】\n${lines.join("\n")}`;
}

function uniqCap(arr, cap) {
  const out = [];
  for (const x of (arr || [])) {
    const s = String(x || "").trim();
    if (s && out.indexOf(s) < 0) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/* 合并：新的覆盖旧的，数组并集并限量 */
function mergeProfile(oldP, fresh) {
  const p = Object.assign({}, oldP || {});
  for (const k of ["nickname", "birthday", "mood"]) {
    if (fresh[k]) p[k] = String(fresh[k]).slice(0, 40);
  }
  for (const k of ["interests", "personality", "preferences"]) {
    const cap = k === "personality" ? 4 : 5;
    const merged = uniqCap([...(oldP && oldP[k] || []), ...(Array.isArray(fresh[k]) ? fresh[k] : [])], cap);
    if (merged.length) p[k] = merged;
  }
  p.updated = Date.now();
  return p;
}

/* 从最近对话里提炼（只提炼，不推测） */
async function extract(userId) {
  if (!cfgBool("profile.auto_extract", true)) return null;
  let msgs = [];
  try { msgs = _ctx.loadSession(userId) || []; } catch (e) { return null; }
  if (msgs.length < 8) return null;
  const recent = msgs.slice(-40)
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => `${m.role === "user" ? "对方" : "Momo"}：${String(m.content || "").slice(0, 150)}`)
    .join("\n");
  if (!recent) return null;
  const prompt = `你是用户画像整理专家。下面是一个人跟 Momo 的聊天记录。请提炼出关于「这个人」的**稳定信息**，输出纯 JSON（不要解释、不要代码块）。\n字段（没有就省略，**绝对不要推测或编造**）：\n- nickname: 他自称或被叫的名字\n- birthday: 生日（MM-DD 或 YYYY-MM-DD）\n- interests: 兴趣爱好数组，最多 5 个，只写明确提到的\n- personality: 性格特点数组，最多 4 个\n- mood: 他最近的心情或状态，一句话\n- preferences: 偏好数组，最多 5 个（比如喜欢的食物、游戏、作息）\n\n聊天记录：\n${recent}`;
  try {
    const settings = _ctx.settings();
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 400, 0.2);
    const t = String(raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const fresh = JSON.parse(m[0]);
    const all = loadAll();
    const key = String(userId);
    all[key] = mergeProfile(all[key], fresh);
    saveAll(all);
    _ctx.log("info", `用户画像已更新 user=${userId}: ${Object.keys(fresh).join(",")}`);
    return all[key];
  } catch (e) {
    _ctx.log("warn", "用户画像提取失败: " + String(e.message).slice(0, 100));
    return null;
  }
}

/* 每 N 次对话触发一次提炼 */
async function tick(userId) {
  if (!cfgBool("profile.auto_extract", true)) return;
  const all = loadAll();
  const key = String(userId);
  const rec = all[key] || {};
  const n = Number(rec._count || 0) + 1;
  const step = Math.max(5, cfgNum("profile.every_n", 15));
  if (n < step) { all[key] = Object.assign(rec, { _count: n }); saveAll(all); return; }
  all[key] = Object.assign(rec, { _count: 0 });
  saveAll(all);
  await extract(userId);
}

/* 查看（只给人看，模型用 profileCtx） */
function profileText(userId) {
  const p = loadAll()[String(userId)];
  if (!p) return "（还没记下什么关于他的稳定信息）";
  const c = profileCtx(userId);
  return c.replace(/^【[^\n]*】\n/, "") + `\n（更新于 ${new Date(p.updated || Date.now()).toLocaleString("zh-CN")}）`;
}

function resetProfile(userId) {
  const all = loadAll();
  delete all[String(userId)];
  saveAll(all);
  return true;
}

module.exports = {
  name: "user-profile",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  settings: [
    { key: "profile.auto_extract", label: "自动记录用户画像", type: "boolean", default: true, desc: "从聊天里提炼对方的兴趣、性格、偏好，记住他" },
    { key: "profile.every_n", label: "每几次对话提炼一次", type: "number", default: 15, min: 5, max: 100 },
  ],
  api: { userProfile: { profileCtx, extract, profileText, resetProfile } },
  tools: [{
    def: {
      type: "function",
      function: {
        name: "profile_view",
        description: "查看你记下的关于某人的画像（名字、生日、兴趣、性格、偏好）。当被问「你记得我什么」「你还记得我喜欢什么吗」时调用。",
        parameters: { type: "object", properties: { target: { type: "string", description: "谁的画像，留空=当前对话的人；只有主人能查别人" } } },
      },
    },
    handler: (args, info) => {
      const me = Number((info && info.userId) || 0);
      let uid = me;
      if (args && args.target) {
        if (!_ctx.isMaster(me)) return "（你只能看关于你自己的记录哦）";
        uid = _ctx.resolveTargetId(String(args.target)) || me;
      }
      return profileText(uid);
    },
  }],
  hooks: {
    reply(payload) {
      const uid = payload && payload.userId;
      if (!uid) return;
      tick(uid).catch(() => {});
    },
  },
};
