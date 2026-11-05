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

module.exports = {
  name: "voice",
  version: "1.1.0",
  init(ctx) { _ctx = ctx; },
  settings: [
    { key: "qq.debounce_ms", label: "等消息窗口（毫秒）", type: "number", default: 20000, min: 3000, max: 60000, desc: "对方最后一条消息后等多久再回复；越大越能让你把话说完" },
    { key: "qq.max_wait_ms", label: "连发时最长等待（毫秒）", type: "number", default: 40000, min: 10000, max: 120000, desc: "无论连发多少条，最多等这么久就回复" },
    { key: "qq.voice_warm", label: "语音预热", type: "boolean", default: true, desc: "收到语音请求时后台先拉起 TTS 服务，减少等待" },
  ],
  api: { voice: { wantsVoice, sendVoice, warmVoice, transcribeRecords } },
};
