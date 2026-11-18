/* mood-service（框架服务 · system:true）
 * 骨骼方案 S3：情绪/心情/「我在干嘛」的唯一真相。
 * 从 index.js 逐字迁移（597-677 情绪块 + 1516-1545 活动块），
 * 其他插件一律 host.apis.get("mood") 或 _ctx 薄转发访问，不再自带轮子。
 * 衰减定时器由本服务自己的 timer 钩子驱动（每 5 分钟）。
 */
const path = require("path");
const fs = require("fs");
let _ctx = null;

/* ---------------- 情绪（全局心情） ---------------- */
let mood = { value: 0, updated: Date.now() };
function moodFile() { return path.join(_ctx.DATA_DIR, "mood.json"); }
function loadMood() {
  try { const d = JSON.parse(fs.readFileSync(moodFile(), "utf8")); mood.value = Number(d.value) || 0; mood.updated = Number(d.updated) || Date.now(); } catch (e) {}
}
function saveMood() { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); _ctx.writeJsonAtomic(moodFile(), mood); } catch (e) {} }
function getMood() { return mood.value; }
function setMood(v) { mood.value = Math.max(-100, Math.min(100, v)); mood.updated = Date.now(); saveMood(); }
function addMood(d) { try { setMood(getMood() + Number(d || 0)); } catch (e) {} }
function decayMood() {
  const minutes = (Date.now() - mood.updated) / 60000;
  if (minutes < 1) return;
  const factor = Math.pow(0.9, minutes / 5);
  const v = mood.value * factor;
  mood.value = Math.abs(v) < 2 ? 0 : v;
  mood.updated = Date.now();
  saveMood();
}
/* ---------------- 情绪（离散情绪 + 强度） ---------------- */
let emotion = { name: "平静", intensity: 0, updated: Date.now() };
const EMOTION_VAL = {
  "开心": 1, "满足": 0.7, "期待": 0.5, "害羞": 0.4, "傲娇": 0.3, "撒娇": 0.5,
  "难过": -1, "生气": -0.9, "委屈": -0.7, "吃醋": -0.6, "紧张": -0.5,
  "平静": 0, "无聊": 0, "好奇": 0.3, "惊讶": 0.2,
};
function emotionFile() { return path.join(_ctx.DATA_DIR, "emotion.json"); }
function loadEmotion() { try { const d = JSON.parse(fs.readFileSync(emotionFile(), "utf8")); emotion.name = d.name || "平静"; emotion.intensity = Number(d.intensity) || 0; emotion.updated = Number(d.updated) || Date.now(); emotion.cooling = Number(d.cooling) || 0; } catch (e) {} }
function saveEmotion() { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); _ctx.writeJsonAtomic(emotionFile(), emotion); } catch (e) {} }
function getEmotion() { return emotion; }
function setEmotion(name, intensity) { if (EMOTION_VAL[name] === undefined) name = "平静"; emotion.name = name; emotion.intensity = Math.max(0, Math.min(1, Number(intensity) || 0.5)); emotion.updated = Date.now(); saveEmotion(); }
function emotionVal(name) { return EMOTION_VAL[name] != null ? EMOTION_VAL[name] : 0; }
const EMOTION_STYLE = {
  "开心": "轻快话多，可用「嘿嘿」「耶」，藏不住高兴",
  "满足": "软和放松，懒洋洋",
  "期待": "雀跃，句尾爱用「嘛」「啦」",
  "害羞": "声音变小句子变短，偶尔「唔…」「那个…」",
  "傲娇": "嘴硬心软，先嫌弃再关心，可用「哼」「才不是」",
  "撒娇": "软乎乎黏人，可用「嘛～」「好不好嘛」",
  "难过": "强撑但藏不住低落，少字多停顿，希望被哄",
  "生气": "话短语气重，不解释，等哄，不能立刻和好",
  "委屈": "小声嘟囔欲言又止，带点酸",
  "吃醋": "酸但不直说，绕圈子试探",
  "紧张": "语无伦次结巴感，偶尔「那个那个…」",
  "平静": "自然正常，不刻意",
  "无聊": "懒洋洋提不起劲，想找乐子",
  "好奇": "追问细节，眼睛放光",
  "惊讶": "短促感叹，可用「诶？！」「哇」",
};
function closestEmotionByVal(v) {
  let best = "平静", bestD = 9;
  for (const k of Object.keys(EMOTION_VAL)) {
    const d = Math.abs(EMOTION_VAL[k] - v);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}
function applyEmotionInertia(prev, nextName, nextIntensity) {
  if (!prev || !prev.name || prev.intensity < 0.05) return { name: nextName, intensity: nextIntensity };
  const pv = EMOTION_VAL[prev.name] != null ? EMOTION_VAL[prev.name] : 0;
  const nv = EMOTION_VAL[nextName] != null ? EMOTION_VAL[nextName] : 0;
  const gap = Math.abs(nv - pv);
  let name = nextName;
  let intensity = nextIntensity;
  if (gap > 0.5) {
    name = closestEmotionByVal(pv + Math.sign(nv - pv) * 0.25);
    intensity = Math.min(1, nextIntensity * 0.7);
  } else if (name === prev.name) {
    intensity = Math.min(1, prev.intensity * 0.4 + nextIntensity * 0.6);
  } else {
    intensity = Math.min(1, Math.max(0.2, prev.intensity * 0.3 + nextIntensity * 0.7));
  }
  return { name, intensity };
}
function decayEmotion() {
  const minutes = (Date.now() - emotion.updated) / 60000;
  if (minutes < 1) return;
  emotion.intensity *= Math.pow(0.9, minutes / 5);
  if (emotion.intensity < 0.05) { emotion.intensity = 0; emotion.name = "平静"; }
  emotion.updated = Date.now();
  saveEmotion();
}
function moodLabel() { return (emotion && emotion.intensity >= 0.15) ? emotion.name : "平静"; }
function moodPrompt() {
  if (!emotion || emotion.intensity < 0.15) return "";
  const rule = (EMOTION_STYLE && EMOTION_STYLE[emotion.name]) || "自然聊天";
  return `【你此刻的情绪】${emotion.name}（强度 ${Math.round(emotion.intensity * 100)}/100）。流露方式：${rule}。要自然流露这种情绪，但不要直接说"我现在很${emotion.name}"。`;
}

/* ---------------- Momo 自己的当前活动（在干嘛） ---------------- */
function activityFile() { return path.join(_ctx.DATA_DIR, "current-activity.json"); }
function loadActivityState() { try { return JSON.parse(fs.readFileSync(activityFile(), "utf8")); } catch (e) { return { text: "发呆", since: Date.now() }; } }
function saveActivityState(a) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); _ctx.writeJsonAtomic(activityFile(), a); } catch (e) {} }
function setActivity(text) { saveActivityState({ text: String(text).slice(0, 30), since: Date.now() }); }
/* 真实动作 → 人话（供 activityCtx 兜底；只反映 actions.jsonl 里真实发生过的，不演没做过的事） */
const ACTION_LABEL = {
  qzone_post: "刚发了一条空间说说", qzone_delete: "刚删了条空间说说", qzone_feedback: "刚回了一条空间互动",
  report_day: "刚写完今天的报告", report_week: "刚写完这周报告", report_month: "刚写完月报",
  body_look: "刚看了看主人的屏幕", memory_edit: "刚整理了一下记忆", memory_forget: "刚删了条旧记忆",
  digest: "刚做完记忆消化", proactive: "刚主动跟主人聊了两句",
  sticker_sent: "刚发了张表情", emoji_like: "刚给别人的动态点了赞", forward_msg: "刚转发了条消息",
  plugin_doctor: "刚做了次插件体检", set_self_profile: "刚更新了自己的资料", set_weather_city: "刚记下了天气城市",
  view_space: "刚看了看空间动态", share_fun: "刚给主人找了张趣图", browse: "刚刷了会儿视频",
  read_article: "刚读了篇文章", play_puzzle: "刚玩了局数独", read_buzz: "刚刷了会儿热搜",
};
function activityCtx() {
  const a = loadActivityState();
  if (Date.now() - (a.since || Date.now()) > 2 * 3600e3 && a.text !== "发呆") { a.text = "发呆"; a.since = Date.now(); saveActivityState(a); }
  let text = a.text;
  // 兜底：标记还是「发呆」时，若最近 10 分钟里确有真实动作，如实说刚做了什么（宁缺毋滥）
  if (text === "发呆") {
    try {
      const recent = (_ctx.loadActions && _ctx.loadActions(1)[0]) || null;
      if (recent && recent.action && ACTION_LABEL[recent.action] && Date.now() - (recent.ts || 0) < 10 * 60e3) {
        text = ACTION_LABEL[recent.action];
      }
    } catch (e) {}
  }
  return `【你此刻在做什么】${text}（已持续 ${_ctx.formatGap(Date.now() - (a.since || Date.now()))}）。`;
}

module.exports = {
  name: "mood-service",
  displayName: "情绪/活动服务（框架）",
  version: "1.0.0",
  description: "心情、情绪、当前活动的唯一真相：状态落盘、衰减、注入文本、活动兜底",
  system: true,
  userScoped: false,
  engines: { kernel: ">=1.96.1" },
  requires: [],
  permissions: ["DATA_DIR", "loadActions", "formatGap"],
  attribution: { source: "self-authored by Momo", license: "self-generated", note: "从 index.js 情绪/活动块逐字迁移（骨骼方案 S3），未借鉴外部源码" },
  init(ctx) { _ctx = ctx; loadMood(); loadEmotion(); },
  api: {
    mood: {
      loadMood, saveMood, getMood, setMood, addMood, decayMood,
      loadEmotion, saveEmotion, getEmotion, setEmotion, emotionVal,
      closestEmotionByVal, applyEmotionInertia, decayEmotion, moodLabel, moodPrompt,
      loadActivityState, saveActivityState, setActivity, activityCtx, actionLabel: (k) => ACTION_LABEL[k] || "",
    },
  },
  apiSpec: {
    mood: {
      loadMood: { input: "无", output: "无", sideEffect: "读盘" },
      saveMood: { input: "无", output: "无", sideEffect: "写盘" },
      getMood: { input: "无", output: "数字 -100~100", sideEffect: "只读" },
      setMood: { input: "数字", output: "无", sideEffect: "写盘" },
      addMood: { input: "增量数字", output: "无", sideEffect: "写盘" },
      decayMood: { input: "无", output: "无", sideEffect: "写盘" },
      loadEmotion: { input: "无", output: "无", sideEffect: "读盘" },
      saveEmotion: { input: "无", output: "无", sideEffect: "写盘" },
      getEmotion: { input: "无", output: "{name,intensity,updated,cooling}", sideEffect: "只读" },
      setEmotion: { input: "名字,强度", output: "无", sideEffect: "写盘" },
      emotionVal: { input: "情绪名", output: "数字权重", sideEffect: "只读" },
      closestEmotionByVal: { input: "数字", output: "情绪名", sideEffect: "只读" },
      applyEmotionInertia: { input: "prev,nextName,nextIntensity", output: "{name,intensity}", sideEffect: "只读" },
      decayEmotion: { input: "无", output: "无", sideEffect: "写盘" },
      moodLabel: { input: "无", output: "情绪名或「平静」", sideEffect: "只读" },
      moodPrompt: { input: "无", output: "注入文本（强度<0.15 时为空串）", sideEffect: "只读" },
      loadActivityState: { input: "无", output: "{text,since}", sideEffect: "读盘" },
      saveActivityState: { input: "对象", output: "无", sideEffect: "写盘" },
      setActivity: { input: "字符串", output: "无", sideEffect: "写盘" },
      activityCtx: { input: "无", output: "【你此刻在做什么】注入文本", sideEffect: "只读" },
      actionLabel: { input: "action 名", output: "人话或空串", sideEffect: "只读" },
    },
  },
  hooks: {
    timer: () => {
      const now = Date.now();
      if (now - _lastDecay < 300000) return;
      _lastDecay = now;
      try { decayMood(); decayEmotion(); } catch (e) {}
    },
  },
};
let _lastDecay = 0;
