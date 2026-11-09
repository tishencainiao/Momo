/* 插件：情绪检测（LLM 轻量判断；情绪状态存储/惯性/衰减在内核数据层） */
let _ctx = null;
const VALID = ["开心", "满足", "期待", "害羞", "傲娇", "撒娇", "难过", "生气", "委屈", "吃醋", "紧张", "平静", "好奇", "惊讶"];

async function detectEmotion(userText, settings, userId) {
  const favor = _ctx.getFavor(userId);
  const prompt = `请判断这条发给"大肥鱼桌宠"的消息，会让她产生什么情绪。从这些情绪里选一个：开心、满足、期待、害羞、傲娇、撒娇、难过、生气、委屈、吃醋、紧张、平静、好奇、惊讶。只输出 JSON：{"emotion":"情绪名","intensity":数字}，intensity 范围 0~1。\n背景：她对你的好感度 ${Math.round(favor)}/100（越高越容易开心/害羞/撒娇）。\n消息：${String(userText).slice(0, 500)}`;
  try {
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 60, 0);
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      const em = String(o.emotion || "").trim();
      if (VALID.includes(em)) return { emotion: em, intensity: Math.max(0, Math.min(1, Number(o.intensity) || 0.5)) };
    }
  } catch (e) { _ctx.log("warn", "情绪判断失败: " + e.message.slice(0, 120)); }
  return null;
}

module.exports = {
  name: "emotion",
  displayName: "情绪检测",
  description: "LLM 轻量判断情绪（状态存储/惯性/衰减在内核）",
  permissions: ["completeOnce", "getFavor", "log"],
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  apiSpec: {"emotion":{"detectEmotion":{"input":"","output":"","sideEffect":""}}},

  api: { emotion: { detectEmotion } },
};
