/* 插件：语音（TTS 发音 + 语音转文字：QQ原生转写→SAPI 兜底） */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
let _ctx = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wantsVoice(text) {
  return /语音|说句话|说一句|用声音|念给我|读给我|念一下|读一下/.test(text);
}
function stripStageDirections(text) {
  return String(text).replace(/[（(][^（()）]*[）)]/g, " ").replace(/\s+/g, " ").trim();
}
async function sendVoice(userId, text) {
  const py = _ctx.config.pet.python_path;
  const ttsScript = path.join(__dirname, "..", "tts.py");
  const voice = (_ctx.config.chat && _ctx.config.chat.tts && _ctx.config.chat.tts.voice) || "zh-CN-XiaoxiaoNeural";
  const t = stripStageDirections(text).slice(0, 200);
  if (!t) return;
  const tmp = path.join(_ctx.DATA_DIR, "voice-" + Date.now() + ".mp3");
  const r = spawnSync(py, [ttsScript, t, tmp, voice], { timeout: 60000, windowsHide: true });
  if ((r.status !== 0 && r.status !== null) || !fs.existsSync(tmp)) throw new Error("TTS 合成失败");
  await _ctx.onebotSend("send_msg", { message_type: "private", user_id: Number(userId), message: [{ type: "record", data: { file: "file:///" + tmp.replace(/\\/g, "/") } }] });
  setTimeout(() => { try { fs.unlinkSync(tmp); } catch (e) {} }, 60000);
  _ctx.log("info", `已发语音 → ${userId}（${t.length} 字）`);
}
function sapiTranscribe(wavPath) {
  try {
    const ps = `Add-Type -AssemblyName System.Speech; $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine("zh-CN"); $r.SetInputToWaveFile('${wavPath.replace(/\\/g, "\\\\")}'); $res = $r.Recognize(); if ($res) { $res.Text }`;
    const out = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 30000, windowsHide: true });
    return String(out.stdout || "").trim();
  } catch (e) { return ""; }
}
async function transcribeViaRecord(file) {
  const info = await _ctx.qzoneHttp("get_record", { file, out_format: "wav" });
  const b64 = String(info && info.base64 || "").trim();
  if (!b64) return "";
  const buf = Buffer.from(b64, "base64");
  const fp = path.join(_ctx.DATA_DIR, "ptt-" + Date.now() + ".wav");
  fs.writeFileSync(fp, buf);
  const text = sapiTranscribe(fp);
  try { fs.unlinkSync(fp); } catch (e) {}
  return text;
}
async function transcribeRecords(messageId, records) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const d = await _ctx.qzoneHttp("fetch_ptt_text", { message_id: Number(messageId) });
      const t = String((d && (d.text || d.ptt_text || d.result || d.content)) || (typeof d === "string" ? d : "") || "").trim();
      if (t) return t;
      if (attempt < 3) await sleep(2000);
    } catch (e) {
      _ctx.log("warn", `语音转文字失败(第${attempt}次): ${e.message.slice(0, 100)}`);
      if (attempt < 3) await sleep(2000);
    }
  }
  try {
    const rec = (records && records[0]) || {};
    const file = String(rec.file || rec.url || "");
    if (file) {
      const t = await transcribeViaRecord(file);
      if (t) { _ctx.log("info", "语音兜底转写成功: " + t.slice(0, 40)); return t; }
    }
  } catch (e) { _ctx.log("warn", "语音兜底转写失败: " + e.message.slice(0, 120)); }
  return "";
}

/* 语音预热：后台先拉起 TTS 服务（和聊天并行），减少真正发语音时的冷启动等待 */
let _lastWarm = 0;
function voiceName() {
  return (_ctx.config && _ctx.config.chat && _ctx.config.chat.tts && _ctx.config.chat.tts.voice) || "zh-CN-XiaoxiaoNeural";
}
function warmVoice() {
  const now = Date.now();
  if (now - _lastWarm < 5 * 60000) return { ok: false, skipped: true, reason: "throttled" };
  _lastWarm = now;
  try {
    const pet = (_ctx.config && _ctx.config.pet) || {};
    const py = pet.python_path;
    const ttsScript = path.join(__dirname, "..", "tts.py");
    if (!py) return { ok: false, reason: "no python_path" };
    if (!fs.existsSync(py)) return { ok: false, reason: "python not found" };
    if (!fs.existsSync(ttsScript)) return { ok: false, reason: "tts.py missing" };
    const { spawn } = require("child_process");
    const tmp = path.join(_ctx.DATA_DIR, "voice-warm-" + now + ".mp3");
    const child = spawn(py, [ttsScript, "嗯", tmp, voiceName()], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    setTimeout(() => { try { fs.unlinkSync(tmp); } catch (e) {} }, 180000);
    _ctx.log("info", "语音预热：已在后台拉起 TTS 服务");
    return { ok: true, pid: child.pid };
  } catch (e) {
    return { ok: false, reason: String(e.message).slice(0, 100) };
  }
}

/* ---- 语音自主（v3）：频率限制 + 待发队列 + send_voice 工具 ---- */
const RATE = { windowMs: 3600e3, perUserPerHour: 3, globalPerHour: 5, perUserPerDay: 20 };
let voiceStats = { day: "", perUser: {}, globalHour: [] };
const pendingVoice = new Map();   // userId -> { file, text, job }

function loadVoiceStats() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(_ctx.DATA_DIR, "voice-rate.json"), "utf8"));
    if (d && typeof d === "object") voiceStats = d;
  } catch (e) {}
  if (!voiceStats || typeof voiceStats !== "object") voiceStats = { day: "", perUser: {}, globalHour: [] };
  voiceStats.perUser = voiceStats.perUser || {};
  voiceStats.globalHour = voiceStats.globalHour || [];
}
function saveVoiceStats() {
  try {
    fs.mkdirSync(_ctx.DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(_ctx.DATA_DIR, "voice-rate.json"), JSON.stringify(voiceStats));
  } catch (e) {}
}
/* 频率：每会话 3 条/小时、全局 5 条/小时、每人每天 20 条 */
function voiceRateOk(userId, now) {
  const t = Number(now) || Date.now();
  const day = new Date(t).toDateString();
  if (!voiceStats.day) loadVoiceStats();
  if (voiceStats.day !== day) voiceStats = { day, perUser: {}, globalHour: [] };
  voiceStats.globalHour = (voiceStats.globalHour || []).filter((x) => t - Number(x) < RATE.windowMs);
  const key = String(userId);
  const u = voiceStats.perUser[key] || { hour: [], day: 0 };
  u.hour = (u.hour || []).filter((x) => t - Number(x) < RATE.windowMs);
  voiceStats.perUser[key] = u;
  if (u.hour.length >= RATE.perUserPerHour) return { ok: false, reason: "本会话这一小时语音已到 3 条上限" };
  if (voiceStats.globalHour.length >= RATE.globalPerHour) return { ok: false, reason: "这一小时语音总共已到 5 条上限" };
  if (Number(u.day || 0) >= RATE.perUserPerDay) return { ok: false, reason: "今天语音已到 20 条上限" };
  u.hour.push(t); u.day = Number(u.day || 0) + 1;
  voiceStats.globalHour.push(t);
  saveVoiceStats();
  return { ok: true };
}

function synthesize(text, file) {
  return new Promise((resolve) => {
    try {
      const pet = (_ctx.config && _ctx.config.pet) || {};
      const py = pet.python_path;
      const script = path.join(__dirname, "..", "tts.py");
      if (!py) return resolve({ ok: false, error: "no python_path" });
      const { spawn } = require("child_process");
      const child = spawn(py, [script, String(text).slice(0, 200), file, voiceName()], { windowsHide: true });
      let err = "";
      child.stderr.on("data", (d) => { err += d.toString(); });
      child.on("error", (e) => resolve({ ok: false, error: String(e.message) }));
      const timer = setTimeout(() => { try { child.kill(); } catch (e) {} resolve({ ok: false, error: "合成超时" }); }, 120000);
      child.on("close", (code) => {
        clearTimeout(timer);
        try { if (fs.existsSync(file) && fs.statSync(file).size > 1000) return resolve({ ok: true, file }); } catch (e) {}
        resolve({ ok: false, error: err.slice(-200) || ("tts exit " + code) });
      });
    } catch (e) { resolve({ ok: false, error: String(e.message).slice(0, 120) }); }
  });
}

/* 备好一条语音（后台合成），等这条回复发出后由 reply 钩子补发 */
function prepareVoice(userId, text) {
  const t = stripStageDirections(String(text || "")).slice(0, 200);
  if (!t) return { ok: false, reason: "内容为空" };
  const key = String(userId);
  const file = path.join(_ctx.DATA_DIR, "voice-" + Date.now() + "-" + key + ".mp3");
  const prev = pendingVoice.get(key);
  if (prev) { try { fs.unlinkSync(prev.file); } catch (e) {} }
  pendingVoice.set(key, { file, text: t, job: synthesize(t, file) });
  return { ok: true, text: t };
}
function takePendingVoice(userId) { return pendingVoice.get(String(userId)) || null; }
function clearPendingVoice(userId) { const k = String(userId); const p = pendingVoice.get(k); pendingVoice.delete(k); return p; }
function hasPendingVoice(userId) { return pendingVoice.has(String(userId)); }
function voiceOnlyReply() {
  try { return _ctx.getSetting("qq.voice_only", true) !== false; } catch (e) { return true; }
}

module.exports = {
  name: "voice",
  version: "1.2.0",
  init(ctx) { _ctx = ctx; },
  settings: [
    { key: "qq.debounce_ms", label: "等消息窗口（毫秒）", type: "number", default: 20000, min: 3000, max: 60000, desc: "对方最后一条消息后等多久再回复；越大越能让你把话说完" },
    { key: "qq.max_wait_ms", label: "连发时最长等待（毫秒）", type: "number", default: 40000, min: 10000, max: 120000, desc: "无论连发多少条，最多等这么久就回复" },
    { key: "qq.voice_warm", label: "语音预热", type: "boolean", default: true, desc: "收到语音请求时后台先拉起 TTS 服务，减少等待" },
    { key: "qq.voice_only", label: "发语音时不配文字", type: "boolean", default: true, desc: "开着：语音回复只发语音；关掉：文字+语音两条都发" },
  ],
  api: { voice: { wantsVoice, sendVoice, warmVoice, transcribeRecords, voiceRateOk, prepareVoice, takePendingVoice, clearPendingVoice, hasPendingVoice, voiceOnlyReply } },
  tools: [{
    def: {
      type: "function",
      function: {
        name: "send_voice",
        description: "用语音说一句话（只发私聊）。想用声音撒娇、说晚安、念一段话、表达语气时调用；语音会在你这条文字回复之后自动发出，不要为了发语音而重复发文字说明。",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "要用语音说出的话（≤200字，别带括号动作描写）" } },
          required: ["text"],
        },
      },
    },
    async handler(args, info) {
      const uid = Number(info && info.userId) || 0;
      if (!uid) return "（不知道发给谁）";
      if (info && info.groupId) return "（语音只在私聊发，群里先发文字吧）";
      const r = voiceRateOk(uid);
      if (!r.ok) return "（这次先不发语音：" + r.reason + "）";
      const p = prepareVoice(uid, String((args && args.text) || ""));
      if (!p.ok) return "（语音没准备好：" + p.reason + "）";
      return "（语音已开始合成，会在这条回复之后自动发出）";
    },
  }],
  hooks: {
    reply(payload) {
      const { userId, channel } = payload || {};
      if (!userId || (channel && channel !== "private")) return;
      const p = takePendingVoice(userId);
      if (!p) return;
      clearPendingVoice(userId);
      p.job.then(async (r) => {
        if (!r.ok) {
          try { _ctx.log("warn", "语音补发失败: " + (r.error || "")); } catch (e) {}
          /* 只发语音模式下，合成失败就补发文字兜底，别让她哑掉 */
          try {
            if (voiceOnlyReply() && payload && payload.reply) await _ctx.sendPrivate(userId, String(payload.reply));
          } catch (e) {}
          return;
        }
        try {
          await _ctx.onebotSend("send_msg", { message_type: "private", user_id: Number(userId), message: [{ type: "record", data: { file: "file:///" + String(r.file).replace(/\\/g, "/") } }] });
          _ctx.log("info", `语音已随回复发出 → ${userId}`);
        } catch (e) { _ctx.log("warn", "语音发送失败: " + String(e.message).slice(0, 120)); }
        finally { setTimeout(() => { try { fs.unlinkSync(r.file); } catch (e) {} }, 60000); }
      });
    },
  },
};
