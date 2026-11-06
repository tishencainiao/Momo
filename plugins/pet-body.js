/* 插件：身体联动（让大脑指挥桌面上的身体）
 *
 * 架构：大脑（本进程）── HTTP 127.0.0.1:4010 ──> 身体（body/，Python + PySide6）
 *   - 指令：POST /cmd/say|play|state|move|show|hide|scale
 *   - 状态：GET /status
 *   - 鉴权：请求头 Authorization: Bearer <body/body-token 里的 token>
 *
 * 设计口径：
 *   - 全部能力仅主人可用（指挥身体是敏感操作，避免朋友/访客乱动）；
 *   - 身体没启动时返回明确提示，绝不抛错、不影响聊天链路；
 *   - 超时 2.5 秒，避免"身体卡住把 QQ 回复也拖死"。
 */
const fs = require("fs");
const path = require("path");

let _ctx = null;

const TOKEN_FILES = () => {
  const list = [];
  if (process.env.MOMO_BODY_TOKEN) list.push(process.env.MOMO_BODY_TOKEN);
  list.push(path.join(__dirname, "..", "data", "body-token"));
  list.push(path.join(__dirname, "..", "body", "body-token"));
  return list;
};
const DEFAULT_URL = "http://127.0.0.1:4010";
const TIMEOUT_MS = 2500;

function baseUrl() {
  let v = "";
  try {
    v = String(_ctx.getSetting("body.url", DEFAULT_URL) || DEFAULT_URL);
  } catch (e) {
    v = DEFAULT_URL;
  }
  return v.replace(/\/+$/, "");
}

function token() {
  for (const p of TOKEN_FILES()) {
    try {
      const t = fs.readFileSync(p, "utf8").trim();
      if (t) return t;
    } catch (e) {}
  }
  return "";
}

function enabled() {
  try {
    return _ctx.getSetting("body.enabled", true) !== false;
  } catch (e) {
    return true;
  }
}

async function call(method, pathname, body, opts) {
  const url = baseUrl() + pathname;
  const headers = { Authorization: "Bearer " + token() };
  if (opts && opts.wait) headers["X-Momo-Wait"] = "1";
  if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeoutMs) || TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }
    return { status: res.status, data, text };
  } catch (e) {
    return { status: 0, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function offlineHint() {
  return "身体好像没在跑（连不上本机接口 http://127.0.0.1:4010）。双击桌面「Momo 身体」或托盘里点一下就能叫回来，然后再叫我一次。";
}

/* ---------------- 陪伴外挂（v0.6）：报时 / 早间播报 / 节日 / 抽签 / 余额 ----------------
 * 口径：逻辑全在大脑这边，身体只负责「弹字 + 发声 + 播对应动画」。
 */
const FESTIVALS = {
  "01-01": "元旦",
  "02-14": "情人节",
  "03-08": "妇女节",
  "04-01": "愚人节",
  "05-01": "劳动节",
  "06-01": "儿童节",
  "09-10": "教师节",
  "10-01": "国庆节",
  "12-24": "平安夜",
  "12-25": "圣诞节",
};

const CHIME_LINES = [
  "{h} 点啦，主人抬头看看远处呗～",
  "叮——{h} 点了，时间过得真快呀。",
  "{h} 点了哦，喝口水再继续嘛。",
  "整点报时：{h} 点。我在旁边陪着呢。",
  "又是新的一小时啦（{h} 点），主人还在忙吗？",
  "{h} 点整～伸个懒腰吧，我给你看着时间。",
];

const FORTUNES = [
  { luck: "大吉", text: "今天适合把拖着的事收个尾，顺手得像一条顺水的鱼。" },
  { luck: "中吉", text: "会遇到一点小麻烦，但都在能解决的范围内，别慌。" },
  { luck: "小吉", text: "适合吃点好的，肠胃开心人就开心。" },
  { luck: "吉", text: "有人会想起你——可能是很久没联系的那种。" },
  { luck: "平", text: "普普通通的一天，但普普通通也挺好。" },
  { luck: "小凶", text: "别熬夜，熬了明天会更烦。" },
  { luck: "凶", text: "今天少做决定，多喝水，多休息。" },
  { luck: "大凶", text: "什么也别干了，摸鱼吧——反正这签说你也干不成（我胡说的）。" },
];

const BALANCE_CLIPS = [
  "余额-钱袋满溢", "余额-金袋叮当", "余额-钱袋如常",
  "余额-数金皱眉", "余额-袋空如洗", "余额-分文不剩",
];

function todayKey(d = new Date()) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return mm + "-" + dd;
}

function hourNow() {
  return new Date().getHours();
}

/* 给别的插件用的「让身体播报」入口（提醒、晚report 之类都可以调） */
async function announce(text, opts) {
  const o = opts || {};
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "empty" };
  if (!enabled()) return { ok: false, error: "body disabled" };
  if (sense.dnd && !o.force) return { ok: false, error: "dnd" };   // 免打扰：不打扰
  const r = await call("POST", "/cmd/say", { text: t, duration_ms: Number(o.duration_ms) || 6000 });
  if (o.voice && token()) {
    try {
      const voice = _ctx.getApi("voice");
      if (voice && typeof voice.synthesizeToFile === "function") {
        voice.synthesizeToFile(t).then((syn) => {
          if (syn && syn.ok) {
            call("POST", "/cmd/speak", { path: syn.file, text: t, duration_ms: 0 }).catch(() => {});
          }
        }).catch(() => {});
      }
    } catch (e) {}
  }
  return { ok: !!(r.status === 200 && r.data && r.data.ok) };
}

/* 生活费：用今日花费比例挑 6 档余额动画 */
async function balanceLevel() {
  let pct = 0;
  let text = "";
  try {
    const br = _ctx.getApi("budgetReport");
    if (br && typeof br.dailyBill === "function") {
      const state = (typeof br.loadBudget === "function") ? br.loadBudget() : {};
      const raw = br.dailyBill(state || {});
      const s = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
      const m = s.match(/（(\d+)%）/) || s.match(/(\d+)%/);
      if (m) pct = Number(m[1]);
      const line = s.split("\n").find((l) => l.indexOf("生活费") >= 0);
      text = line ? line.replace(/^生活费：/, "").trim() : "";
    }
  } catch (e) {}
  if (!text) {
    try { text = String((_ctx.budgetLevel && _ctx.budgetLevel()) || ""); } catch (e) {}
  }
  pct = Math.max(0, Math.min(200, pct));
  const idx = Math.max(0, Math.min(5, Math.floor(pct / 20)));
  return { pct, text, idx, clip: BALANCE_CLIPS[idx] };
}

/* 整点报时的一句话（单独抽出来，方便测试） */
function buildChimeLine(h) {
  const line = CHIME_LINES[Math.floor(Math.random() * CHIME_LINES.length)];
  return line.replace("{h}", String(h));
}

/* ---------------- 感官回流（v0.4） ----------------
 * 身体用 SSE 把「在不在电脑前 / 前台是什么 / 锁屏 / 被点了 / 收文件 / 说过话」推过来，
 * 这里维护一份最新快照 + 落 data/body-events.jsonl，再通过 contextProvider 注入提示词。
 */
const DATA_DIR = () => path.join(__dirname, "..", "data");
// 测试可用 MOMO_BODY_EVENTS 指到临时文件，避免污染真实 data/
const EVENTS_FILE = () => process.env.MOMO_BODY_EVENTS || path.join(DATA_DIR(), 'body-events.jsonl');
const sense = {
  presence: "unknown", idle_s: null, foreground: null, locked: false,
  lastClickAt: 0, lastDropAt: 0, lastDrop: null, lastSayAt: 0, lastLook: null,
  updatedAt: 0, connected: false, dnd: false,
};

function appendEvent(obj) {
  try {
    // 落盘前脱敏：不留窗口标题（常含具体网页/文档名）、不留完整文件路径
    const o = Object.assign({}, obj);
    if (o.foreground && typeof o.foreground === "object") {
      o.foreground = { app: o.foreground.app || "", pid: o.foreground.pid || 0 };
    }
    if (Array.isArray(o.files)) {
      o.files = o.files.map((p) => String(p).split(/[\\/]/).pop()).slice(0, 10);
    }
    fs.mkdirSync(DATA_DIR(), { recursive: true });
    const line = JSON.stringify(o) + "\n";
    fs.appendFileSync(EVENTS_FILE(), line);
    try {
      if (fs.statSync(EVENTS_FILE()).size > 512 * 1024) {       // 半兆就截断重建，别无限长
        const keep = fs.readFileSync(EVENTS_FILE(), "utf8").trim().split("\n").slice(-200).join("\n") + "\n";
        fs.writeFileSync(EVENTS_FILE(), keep);
      }
    } catch (e) {}
  } catch (e) {}
}

/* 身体早期版本发的是秒级时间戳，统一成毫秒（v1.72.0） */
function normTs(v, fallback) {
  const n = Number(v);
  if (!n || !isFinite(n)) return fallback;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function handleBodyEvent(name, data) {
  const now = Date.now();
  const d = data || {};
  const ts = normTs(d.ts, now);
  sense.updatedAt = now;
  if (name === "presence") { sense.presence = d.presence || "unknown"; sense.idle_s = d.idle_s != null ? d.idle_s : null; }
  else if (name === "sense") {
    if (d.presence) sense.presence = d.presence;
    if (d.idle_s != null) sense.idle_s = d.idle_s;
    if (d.foreground) sense.foreground = d.foreground;
    if (d.locked != null) sense.locked = !!d.locked;
  }
  else if (name === "foreground") {
    // 落盘只留程序名与 pid，不留窗口标题（标题常含具体网页/文档名，属于私事）
    sense.foreground = d;
    appendEvent({ ts: ts, event: name, app: (d.app) || "", pid: (d.pid) || 0 });
    return;
  }
  else if (name === "lock") sense.locked = !!d.locked;
  else if (name === "dnd") sense.dnd = !!d.active;
  else if (name === "click") {
    sense.lastClickAt = now;
    // 被摸头也是互动：心情微涨、无聊度下降（20 秒内最多算一次，防连点刷）
    if (now - (sense._lastClickMood || 0) > 20000) {
      sense._lastClickMood = now;
      try { if (_ctx && _ctx.addMood) _ctx.addMood(2); } catch (e) {}
      try { if (_ctx && _ctx.addBoredom) _ctx.addBoredom(-6); } catch (e) {}
    }
  }
  else if (name === "drop") { sense.lastDropAt = now; sense.lastDrop = d.files || []; }
  else if (name === "say") sense.lastSayAt = now;
  else if (name === "look") sense.lastLook = data;
  appendEvent(Object.assign({}, d, { ts: ts, event: name }));
}

let sseStarted = false;
let lastMoodPush = 0;
let lastChimeHour = -1;
let lastMorningKey = "";

/* 报时/早间播报的「今天做过没」要跨重启记住，否则每次重启都会再报一遍 */
function stateFile() {
  return path.join(DATA_DIR(), "body-chime.json");
}
function loadChimeState() {
  try {
    const d = JSON.parse(fs.readFileSync(stateFile(), "utf8")) || {};
    if (d.date === new Date().toDateString()) {
      if (typeof d.hour === "number") lastChimeHour = d.hour;
      if (d.morning === d.date) lastMorningKey = d.date;
    }
    return d;
  } catch (e) {
    return {};
  }
}
function saveChimeState(patch) {
  try {
    const d = Object.assign(loadChimeState(), { date: new Date().toDateString() }, patch || {});
    fs.mkdirSync(DATA_DIR(), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(d));
  } catch (e) {}
}
async function startSse() {
  if (sseStarted) return;
  sseStarted = true;
  const backoff = [1000, 3000, 8000, 20000];
  let i = 0;
  while (true) {
    try {
      const res = await fetch(baseUrl() + "/events", {
        headers: { Authorization: "Bearer " + token() },
      });
      if (res.status !== 200 || !res.body) throw new Error("SSE " + res.status);
      sense.connected = true;
      i = 0;
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split("\n");
          const evLine = lines.find((l) => l.startsWith("event:"));
          const dataLine = lines.find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let payload = null;
          try { payload = JSON.parse(dataLine.slice(5).trim()); } catch (e) { continue; }
          handleBodyEvent((evLine ? evLine.slice(6).trim() : "message"), payload);
        }
      }
      sense.connected = false;
    } catch (e) {
      sense.connected = false;
    }
    await new Promise((r) => setTimeout(r, backoff[Math.min(i, backoff.length - 1)]));
    i++;
  }
}

function minutesAgo(ts) {
  if (!ts) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
}

function senseText() {
  if (!sense.updatedAt || Date.now() - sense.updatedAt > 10 * 60000) return "";
  const bits = [];
  if (sense.presence === "active") bits.push("主人在电脑前（刚有键鼠操作）");
  else if (sense.presence === "away" && sense.idle_s != null) {
    bits.push("主人可能离开了，键鼠已经 " + Math.round(sense.idle_s / 60) + " 分钟没动");
  }
  if (sense.locked) bits.push("屏幕锁着");
  if (sense.foreground && sense.foreground.app) {
    const t = String(sense.foreground.title || "").slice(0, 40);
    bits.push("前台是 " + sense.foreground.app.replace(/\.exe$/i, "") + (t ? "（" + t + "）" : ""));
  }
  const cMin = minutesAgo(sense.lastClickAt);
  if (cMin !== null && cMin <= 30) bits.push(cMin === 0 ? "刚刚点了你一下" : cMin + " 分钟前点了你一下");
  const dMin = minutesAgo(sense.lastDropAt);
  if (dMin !== null && dMin <= 30 && sense.lastDrop && sense.lastDrop.length) {
    bits.push(dMin === 0 ? "刚往你身上丢了文件" : dMin + " 分钟前往你身上丢了文件");
  }
  if (sense.dnd) bits.push("你处于免打扰状态（不说话不出声）");
  if (!bits.length) return "";
  return "【身体感觉】" + bits.join("；") + "。";
}

function requireMaster(info) {
  if (_ctx && _ctx.isMaster(info && info.userId)) return true;
  return false;
}

function guard(info) {
  if (!enabled()) return "（身体联动被我关掉了，可以说「打开身体联动」）";
  if (!requireMaster(info)) return "（只有主人能指挥我的身体哦）";
  if (!token()) return "（还没拿到身体接口的令牌：body/body-token 不存在，身体可能没启动过）";
  return "";
}

function record(action, detail, ok) {
  try {
    _ctx.recordAction({ action, by: 0, detail: String(detail).slice(0, 120), ok: !!ok });
  } catch (e) {}
}

function toolDef(name, description, props, required) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: props, required: required || [] },
    },
  };
}

module.exports = {
  name: "pet-body",
  version: "1.0.0",
  init(ctx) {
    _ctx = ctx;
    try {
      loadChimeState();
    } catch (e) {}
    // 感官事件流：后台常连，断了自动退避重连；不阻塞插件加载
    try {
      startSse();
    } catch (e) {}
    // 再主动拉一次快照当种子（万一 SSE 连上时状态一直没变化）
    setTimeout(() => {
      call("POST", "/cmd/sense", { _wait: true }, { wait: true, timeoutMs: 4000 })
        .then((r) => {
          if (r.status === 200 && r.data && r.data.ok !== false) {
            handleBodyEvent("sense", r.data);
          }
        })
        .catch(() => {});
    }, 2500);
  },
  contextProvider(payload) {
    try {
      if (!enabled()) return "";
      const p = payload || {};
      // 隐私闸门（v1.71.1）：
      // ① 只在「桌面渠道」注入——QQ（私聊/群聊）一律不给身体感官；
      // ② 只给主人注入——朋友/访客拿不到主人在干嘛的任何信息。
      // 工具通道（pet_sense / pet_look）另有 isMaster 判断，这里是上下文通道的第二道锁。
      if (!p.petMode) return "";
      if (!_ctx || !_ctx.isMaster(p.userId)) return "";
      return senseText();
    } catch (e) {
      return "";
    }
  },
  settings: [
    {
      key: "body.enabled",
      label: "启用身体联动",
      type: "boolean",
      default: true,
      desc: "允许 Momo 指挥桌面上的身体（说话/换动作/移动）",
    },
    {
      key: "body.url",
      label: "身体接口地址",
      type: "string",
      default: DEFAULT_URL,
      desc: "身体本地 HTTP 接口，默认 http://127.0.0.1:4010",
    },
    {
      key: "body.hourly_chime",
      label: "整点报时",
      type: "boolean",
      default: true,
      desc: "每到整点在桌面上报一次时间（只在这个时段内）",
    },
    {
      key: "body.chime_from",
      label: "报时起始小时",
      type: "number",
      default: 8,
      min: 0,
      max: 23,
      desc: "从几点开始报时（默认 8 点）",
    },
    {
      key: "body.chime_to",
      label: "报时结束小时",
      type: "number",
      default: 23,
      min: 0,
      max: 23,
      desc: "到几点停止报时（默认 23 点）",
    },
    {
      key: "body.morning_report",
      label: "早间播报",
      type: "boolean",
      default: true,
      desc: "每天 7~10 点第一次运行时，用语音报天气/节日/叫起床",
    },
  ],
  tools: [
    {
      def: toolDef(
        "pet_walk",
        "让身体在屏幕上走一段（会播走路动画 + 自动转向，走到屏幕边会停住）。主人说「去那边」「往左挪挪」「走到角落去」时调用。",
        {
          dx: { type: "number", description: "走多远：正数向右、负数向左（像素，建议 100~600）" },
        },
        ["dx"]
      ),
      async handler(args, info) {
        const why = guard(info);
        if (why) return why;
        const dx = Number((args && args.dx) || 0);
        if (!dx) return "（往哪边走？给我个 dx，负数是往左）";
        const r = await call("POST", "/cmd/walk", { dx });
        if (r.status === 200 && r.data && r.data.ok) {
          record("body_walk", String(dx), true);
          return "（身体开始" + (dx > 0 ? "往右" : "往左") + "走了）";
        }
        record("body_walk", String(dx), false);
        return offlineHint();
      },
    },
    {
      def: toolDef(
        "pet_say",
        "让桌面上的身体说一句话（浮现气泡 + 播说话动画）。当你在桌宠窗口里想「说出口」、或主人让你「在桌面上说一句」时调用。注意：这只影响桌面上的身体，不会发 QQ 消息。",
        {
          text: { type: "string", description: "要说的话（短，1~2 句）" },
          duration_ms: { type: "number", description: "气泡停留毫秒数，默认 5000" },
        },
        ["text"]
      ),
      async handler(args, info) {
        const why = guard(info);
        if (why) return why;
        const text = String((args && args.text) || "").trim();
        if (!text) return "（要说的话是空的）";
        const r = await call("POST", "/cmd/say", { text, duration_ms: Number(args.duration_ms) || 5000 });
        if (r.status === 200 && r.data && r.data.ok) {
          record("body_say", text, true);
          return "（在桌面上说了：" + text.slice(0, 40) + "）";
        }
        record("body_say", text, false);
        return offlineHint();
      },
    },
    {
      def: toolDef(
        "pet_speak",
        "在桌面上用**真实语音**说一句话（复用 Momo 的克隆音色：先合成再播，气泡会按语音长度自动停留）。当你想「出声说一句」而不只是弹文字气泡时用它。合成要几秒，别连着调很多次；要快速弹字用 pet_say。",
        {
          text: { type: "string", description: "要说的话（短，≤60 字）" },
          duration_ms: { type: "number", description: "气泡停留毫秒（默认按音频长度自动算）" },
        },
        ["text"]
      ),
      async handler(args, info) {
        const why = guard(info);
        if (why) return why;
        const text = String((args && args.text) || "").trim();
        if (!text) return "（要说什么呀）";
        const voice = _ctx.getApi("voice");
        if (!voice || typeof voice.synthesizeToFile !== "function") {
          return "（语音管道不可用：voice 插件没加载，先用 pet_say 弹气泡吧）";
        }
        // 1) 先把话弹成气泡（毫秒级，手感立刻回来）
        await call("POST", "/cmd/say", { text, duration_ms: 6000 });
        // 2) TTS 放后台：GSV 冷启动可能要几十秒，绝不能让它在回复链路里干等（会把整轮拖超时）
        try {
          if (typeof voice.warmVoice === "function") {
            try {
              voice.warmVoice();
            } catch (e) {}
          }
          voice
            .synthesizeToFile(text)
            .then((syn) => {
              if (!syn || !syn.ok) {
                record("body_speak", text + "|synth-fail", false);
                try {
                  _ctx.log("warn", "桌面语音合成失败: " + String((syn && syn.error) || ""));
                } catch (e) {}
                return null;
              }
              return call("POST", "/cmd/speak", {
                path: syn.file,
                text: syn.text || text,
                duration_ms: Number((args && args.duration_ms) || 0),
              }).then((r) => {
                const ok = !!(r.status === 200 && r.data && r.data.ok);
                record("body_speak", text, ok);
                return null;
              });
            })
            .catch(() => {});
        } catch (e) {}
        return "（先在桌面上弹了字，声音马上跟上：" + text.slice(0, 40) + "）";
      },
    },
    {
      def: toolDef(
        "pet_play",
        "让桌面上的身体播一段指定动画（不说活，只做动作）。可以按名字指定（如「优雅女仆舞」「打瞌睡」）或按分类随机。",
        {
          name: { type: "string", description: "动画名（片段名，可模糊匹配中文名）" },
          category: {
            type: "string",
            description: "分类：random（随机小剧场）/ click（点击回应）/ turn / move / drag",
          },
        },
        []
      ),
      async handler(args, info) {
        const why = guard(info);
        if (why) return why;
        const payload = {};
        if (args && args.name) payload.name = String(args.name);
        if (args && args.category) payload.category = String(args.category);
        if (!payload.name && !payload.category) payload.category = "random";
        const r = await call("POST", "/cmd/play", payload);
        if (r.status === 200 && r.data && r.data.ok) {
          record("body_play", payload.name || payload.category, true);
          return "（身体在演：" + String(r.data.anim || "") + "）";
        }
        record("body_play", JSON.stringify(payload), false);
        return offlineHint();
      },
    },
    {
      def: toolDef(
        "pet_sense",
        "查身体的感官当前读数：主人在不在电脑前（键鼠空闲多久）、前台是什么程序/窗口、屏幕锁没锁、最近有没有点你/丢文件给你。当你想「主人现在在干嘛」「他还在吗」时调用——这是你真看得到的东西，别瞎猜。",
        {},
        []
      ),
      async handler(args, info) {
        if (!requireMaster(info)) return "（只有主人能查我的感官哦）";
        const r = await call("POST", "/cmd/sense", { _wait: true }, { wait: true });
        if (r.status !== 200 || !r.data || r.data.ok === false) return offlineHint();
        const d = r.data;
        const fg = d.foreground || {};
        const parts = [];
        parts.push(d.presence === "away" ? "主人可能不在（键鼠 " + Math.round((d.idle_s || 0) / 60) + " 分钟没动）" : "主人在电脑前（键鼠 " + Math.round(d.idle_s || 0) + " 秒前有动作）");
        if (fg.app) parts.push("前台：" + String(fg.app).replace(/\.exe$/i, "") + (fg.title ? "（" + String(fg.title).slice(0, 40) + "）" : ""));
        parts.push(d.locked ? "屏幕锁着" : "屏幕没锁");
        const cMin = minutesAgo(sense.lastClickAt);
        if (cMin !== null && cMin <= 60) parts.push(cMin === 0 ? "刚点过你" : cMin + " 分钟前点过你");
        return "身体的感官：" + parts.join("；") + "。";
      },
    },
    {
      def: toolDef(
        "pet_look",
        "让身体截一张主人现在的屏幕，并（由你看图）说出主人在做什么。当主人问「你看我在干嘛」「看看我屏幕」，或你想知道他在忙什么时调用。注意：要花钱（一次约 0.001~0.002 元）且涉及隐私，别频繁看、别擅自乱看。",
        {
          question: { type: "string", description: "你想从画面上知道什么（可选，比如「他在写代码还是看视频」）" },
        },
        []
      ),
      async handler(args, info) {
        const why = guard(info);
        if (why) return why;
        const now = Date.now();
        if (sense.lastLook && now - (sense.lastLook.ts * 1000) < 20000) {
          return "（刚看过一眼，等几十秒再看吧，省点钱）";
        }
        const r = await call("POST", "/cmd/look", { _wait: true }, { wait: true, timeoutMs: 8000 });
        if (r.status !== 200 || !r.data || !r.data.ok) return offlineHint() + "（截图没成功）";
        const shot = r.data;
        sense.lastLook = { path: shot.path, ts: shot.ts };
        const prompt = String((args && args.question) || "").trim()
          || "这是主人的电脑屏幕截图。用简洁中文说清：1) 主人在做什么（写代码/看视频/聊天/游戏等）；2) 画面上关键的窗口名或文字。不要虚构细节。";
        try {
          const desc = await _ctx.describeImageFile(shot.path, prompt);
          record("body_look", String(desc).slice(0, 100), true);
          return "我看了一眼屏幕：" + String(desc || "（没看清）").slice(0, 300);
        } catch (e) {
          record("body_look", "vision-fail", false);
          return "截图拿到了（" + shot.path + "），但我这边看图的接口出错了：" + String((e && e.message) || e).slice(0, 80);
        }
      },
    },
    {
      def: toolDef(
        "pet_balance",
        "让身体播「生活费余额」对应的动画（按今天已用比例分 6 档：钱袋满溢→分文不剩），并报一句账。主人问「生活费还剩多少」「今天花了多少」时调用。",
        {},
        []
      ),
      async handler(args, info) {
        if (!requireMaster(info)) return "（只有主人能看我的账本哦）";
        const lv = await balanceLevel();
        const text = "今天的生活费已用 " + lv.pct + "%" + (lv.text ? "（" + lv.text + "）" : "");
        try {
          const r1 = await call("POST", "/cmd/play", { name: lv.clip });
          await call("POST", "/cmd/say", { text, duration_ms: 6000 });
          record("body_balance", lv.clip, !!(r1.status === 200));
        } catch (e) {
          return offlineHint();
        }
        return text + "（身体演的是「" + lv.clip + "」）";
      },
    },
    {
      def: toolDef(
        "pet_fortune",
        "在桌面上抽一支签（今日运势），身体会弹气泡说结果。主人说「抽个签」「今天运势怎么样」时调用。",
        {},
        []
      ),
      async handler(args, info) {
        const why = guard(info);
        if (why) return why;
        const f = FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
        const text = "今日运势：" + f.luck + "——" + f.text;
        const r = await call("POST", "/cmd/say", { text, duration_ms: 9000 });
        record("body_fortune", f.luck, !!(r.status === 200 && r.data && r.data.ok));
        return text;
      },
    },
    {
      def: toolDef(
        "pet_dnd",
        "开关身体的免打扰（静音、不自己玩、也不播报报时/提醒）。主人说「先安静一会儿」「免打扰」「可以出声了」时调用。",
        { enable: { type: "boolean", description: "true=开免打扰，false=关" } },
        ["enable"]
      ),
      async handler(args, info) {
        if (!requireMaster(info)) return "（只有主人能改免打扰）";
        const on = !!(args && args.enable);
        const r = await call("POST", "/cmd/dnd", { manual: on, _wait: true }, { wait: true });
        if (r.status === 200 && r.data && r.data.ok) {
          sense.dnd = !!r.data.dnd;
          record("body_dnd", String(on), true);
          return sense.dnd ? "好，我安静待着，不吵你。" : "好，我可以出声啦～";
        }
        record("body_dnd", String(on), false);
        return offlineHint();
      },
    },
    {
      def: toolDef(
        "pet_state",
        "切换身体的状态：idle 待机 / sleep 睡觉 / show 显示 / hide 隐藏。要让它说话请用 pet_say。",
        {
          state: { type: "string", description: "idle | sleep | show | hide", enum: ["idle", "sleep", "show", "hide"] },
        },
        ["state"]
      ),
      async handler(args, info) {
        const why = guard(info);
        if (why) return why;
        const state = String((args && args.state) || "idle").toLowerCase();
        const path = state === "show" || state === "hide" ? "/cmd/" + state : "/cmd/state";
        const payload = state === "show" || state === "hide" ? {} : { state };
        const r = await call("POST", path, payload);
        if (r.status === 200 && r.data && r.data.ok) {
          record("body_state", state, true);
          return "（身体状态：" + state + "）";
        }
        record("body_state", state, false);
        return offlineHint();
      },
    },
    {
      def: toolDef(
        "pet_move",
        "让桌面上的身体在屏幕上移动（相对位移或绝对坐标）。当主人说「往左一点」「挪到中间」时调用。",
        {
          dx: { type: "number", description: "水平位移（正=右）" },
          dy: { type: "number", description: "垂直位移（正=下）" },
          to_x: { type: "number", description: "绝对 x 坐标" },
          to_y: { type: "number", description: "绝对 y 坐标" },
        },
        []
      ),
      async handler(args, info) {
        const why = guard(info);
        if (why) return why;
        const payload = {};
        ["dx", "dy", "to_x", "to_y"].forEach((k) => {
          if (args && args[k] !== undefined && args[k] !== null) payload[k] = Number(args[k]);
        });
        if (!Object.keys(payload).length) return "（要往哪边挪？给我个 dx/dy 或坐标）";
        const r = await call("POST", "/cmd/move", payload);
        if (r.status === 200 && r.data && r.data.ok) {
          record("body_move", JSON.stringify(payload), true);
          return "（挪到 " + r.data.x + "," + r.data.y + "）";
        }
        record("body_move", JSON.stringify(payload), false);
        return offlineHint();
      },
    },
    {
      def: toolDef(
        "pet_body_status",
        "查桌面上的身体现在什么状态（在不在跑、显示着没、正在演哪段动画、位置与大小）。当主人问「身体在不在」「她现在在干嘛」时调用。",
        {},
        []
      ),
      async handler(args, info) {
        if (!requireMaster(info)) return "（只有主人能查我的身体状态哦）";
        const r = await call("GET", "/status");
        if (r.status !== 200 || !r.data || !r.data.ok) {
          record("body_status", "offline", false);
          return offlineHint();
        }
        const d = r.data;
        record("body_status", JSON.stringify({ state: d.state, anim: d.anim }), true);
        return `身体在跑（pid ${d.pid}，端口 ${d.port}）：${d.visible ? "显示中" : "已隐藏"}，状态 ${d.state}，正在演「${d.anim || "无"}」，大小 ${d.scale}，位置 ${d.pos[0]},${d.pos[1]}。`;
      },
    },
    {
      def: toolDef(
        "pet_body_link",
        "打开或关闭「身体联动」总开关。当主人说「先别动我的身体」「打开身体联动」时调用。",
        { enable: { type: "boolean", description: "true=开 false=关" } },
        ["enable"]
      ),
      async handler(args, info) {
        if (!requireMaster(info)) return "（只有主人能改这个开关）";
        const on = !!(args && args.enable);
        try {
          _ctx.setSetting("body.enabled", on);
        } catch (e) {
          return "（设置没写进去，稍后再试）";
        }
        return on ? "好，我又可以指挥身体了～" : "好，身体联动关掉了，我只会安静待在屏幕上。";
      },
    },
  ],
  commands: [
    {
      key: "/身体",
      regex: /^\/身体/,
      async handler(msg) {
        if (!requireMaster(msg)) {
          _ctx.sendPrivate(msg.userId, "只有主人能查我的身体哦～");
          return;
        }
        const r = await call("GET", "/status");
        if (r.status !== 200 || !r.data || !r.data.ok) {
          _ctx.sendPrivate(msg.userId, offlineHint());
          return;
        }
        const d = r.data;
        _ctx.sendPrivate(
          msg.userId,
          `身体：${d.visible ? "显示中" : "已隐藏"} · 状态 ${d.state} · 正在演「${d.anim || "无"}」 · 大小 ${d.scale} · 位置 ${d.pos[0]},${d.pos[1]} · 端口 ${d.port}`
        );
      },
    },
  ],
  /* 情绪 → 动作（v0.5）：把她此刻的心情同步给身体，身体据此决定「自己玩还是安静待着」。
   * 5 分钟一次，纯本地调用不花钱。 */
  hooks: {
    timer(payload) {
      const now = (payload && payload.now) || Date.now();
      if (!enabled()) return;

      // 整点报时（默认 8~23 点，每小时最多一次）
      try {
        const h = hourNow();
        const from = Number(_ctx.getSetting("body.chime_from", 8));
        const to = Number(_ctx.getSetting("body.chime_to", 23));
        if (_ctx.getSetting("body.hourly_chime", true) !== false && h >= from && h <= to && lastChimeHour !== h) {
          lastChimeHour = h;
          saveChimeState({ hour: h });
          announce(buildChimeLine(h), { duration_ms: 5000 }).catch(() => {});
        }
      } catch (e) {}

      // 早间播报（7~10 点，每天一次）：天气 + 节日 + 叫起床
      try {
        const h = hourNow();
        const key = new Date().toDateString();
        if (_ctx.getSetting("body.morning_report", true) !== false && h >= 7 && h <= 10 && lastMorningKey !== key) {
          lastMorningKey = key;
          saveChimeState({ morning: key });
          (async () => {
            const bits = [];
            try {
              const w = _ctx.getApi("weather");
              if (w && typeof w.weatherCtx === "function") {
                const t = await w.weatherCtx();
                if (t) bits.push(String(t).replace(/^【天气】/, "").replace(/。（可以自然地.*?）$/, ""));
              }
            } catch (e) {}
            const fest = FESTIVALS[todayKey()];
            if (fest) bits.push("今天是" + fest + "哦");
            bits.push("该起床啦，记得吃点东西");
            announce(bits.join("；"), { voice: true, duration_ms: 9000 }).catch(() => {});
          })();
        }
      } catch (e) {}

      // 情绪同步（5 分钟一次）
      if (now - lastMoodPush < 300000) return;
      lastMoodPush = now;
      try {
        const mood = Math.round(((_ctx.getMood && _ctx.getMood()) || 0));
        const boredom = Math.round(((_ctx.getBoredom && _ctx.getBoredom()) || 0));
        const emo = (_ctx.getEmotion && _ctx.getEmotion()) || {};
        call("POST", "/cmd/mood", { mood, boredom, emotion: (emo && emo.emotion) || "" }).catch(() => {});
      } catch (e) {}
    },
  },
  api: {
    body: {
      announce,
      balanceLevel,
      senseText,
      status: () => call("GET", "/status"),
    },
  },
  // 供测试用（不参与运行时逻辑）
  __test: { sense, handleBodyEvent, senseText, announce, balanceLevel, buildChimeLine, FESTIVALS, FORTUNES, todayKey, BALANCE_CLIPS },
};
