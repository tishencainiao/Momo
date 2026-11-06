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

const TOKEN_FILE = () => path.join(__dirname, "..", "body", "body-token");
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
  try {
    return fs.readFileSync(TOKEN_FILE(), "utf8").trim();
  } catch (e) {
    return "";
  }
}

function enabled() {
  try {
    return _ctx.getSetting("body.enabled", true) !== false;
  } catch (e) {
    return true;
  }
}

async function call(method, pathname, body) {
  const url = baseUrl() + pathname;
  const headers = { Authorization: "Bearer " + token() };
  if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
  ],
  tools: [
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
};
