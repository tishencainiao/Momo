/* 插件：天气 —— 让她知道自己"所在城市"的天气，能自然关心主人
 * 数据源：wttr.in（免费、无需 key）
 * 城市：优先用 data/weather-city.json 里设置的城市，没设置才按 IP 自动定位
 * 缓存 30 分钟，避免频繁请求 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const WTTR_BASE = "https://wttr.in/";
const CACHE_MS = 30 * 60000;
let cache = null, cacheTs = 0, cacheCity = "";

const cityFile = () => path.join(_ctx.DATA_DIR, "weather-city.json");
function loadCity() {
  // 优先读统一参数表；兼容旧文件
  if (_ctx.getSetting) {
    const s = String(_ctx.getSetting("weather.city", "") || "").trim();
    if (s) return s;
  }
  try {
    const d = JSON.parse(fs.readFileSync(cityFile(), "utf8"));
    return String(d.city || "").trim();
  } catch (e) { return ""; }
}
function saveCity(city, userId) {
  const c = String(city || "").trim().slice(0, 20);
  try {
    if (_ctx.setSetting) _ctx.setSetting("weather.city", c);
    // 同时写旧文件，保持向后兼容
    fs.mkdirSync(_ctx.DATA_DIR, { recursive: true });
    fs.writeFileSync(cityFile(), JSON.stringify({ city: c, setBy: Number(userId) || 0, ts: Date.now() }));
    cache = null; cacheTs = 0; cacheCity = "";   // 换城市 → 清缓存
    try { _ctx.recordAction({ action: "set_weather_city", by: Number(userId) || 0, detail: c, ok: true }); } catch (e2) {}
    return true;
  } catch (e) { return false; }
}

async function fetchWeather() {
  const city = loadCity();
  if (cache && cacheTs && Date.now() - cacheTs < CACHE_MS && cacheCity === city) return cache;
  const url = WTTR_BASE + (city ? encodeURIComponent(city) : "") + "?format=j1";
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "curl/8.0" },   // wttr.in 对 curl UA 返回 JSON 最稳
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const cur = (j.current_condition && j.current_condition[0]) || {};
    const today = (j.weather && j.weather[0]) || {};
    const area = (j.nearest_area && j.nearest_area[0]) || {};
    const w = {
      // 优先用设置的城市名；没设置才用接口返回的定位名
      city: city || String((area.areaName && area.areaName[0] && area.areaName[0].value) || ""),
      areaName: String((area.areaName && area.areaName[0] && area.areaName[0].value) || ""),
      tempC: String(cur.temp_C || ""),
      desc: String((cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || ""),
      feelsC: String(cur.FeelsLikeC || ""),
      humidity: String(cur.humidity || ""),
      minC: String(today.mintempC || ""),
      maxC: String(today.maxtempC || ""),
    };
    cache = w; cacheTs = Date.now(); cacheCity = city;
    return w;
  } catch (e) {
    _ctx.log("warn", "天气获取失败: " + String(e.message).slice(0, 100));
    return cache || null;
  }
}

/* 给上下文用的一句话 */
async function weatherCtx() {
  const w = await fetchWeather();
  if (!w || !w.tempC) return "";
  const range = (w.minC && w.maxC) ? `，今天 ${w.minC}~${w.maxC}°C` : "";
  return `【天气】${w.city || "本地"}现在 ${w.tempC}°C、${w.desc || ""}，体感 ${w.feelsC}°C${range}。（可以自然地关心主人穿衣/带伞，但别每句都提）`;
}

/* 给工具用的文字 */
async function weatherText() {
  const w = await fetchWeather();
  if (!w || !w.tempC) return "（暂时没拿到天气数据）";
  return `${w.city || "本地"}：${w.tempC}°C，${w.desc}，体感 ${w.feelsC}°C，湿度 ${w.humidity}%，今天 ${w.minC}~${w.maxC}°C`;
}

module.exports = {
  name: "weather",
  displayName: "天气",
  description: "城市天气 + 自然关心主人",
  permissions: ["DATA_DIR", "getSetting", "isMaster", "log", "recordAction", "setSetting"],
  version: "1.1.0",
  init(ctx) { _ctx = ctx; },
  /* 可调参数：宿主会收集并在 settings_view 里列出，Momo 能自己改 */
  settings: [
    { key: "weather.city", label: "天气城市", type: "string", default: "", desc: "留空=按IP自动定位；填城市名如「大庆」" },
  ],
  apiSpec: {"weather":{"fetchWeather":{"input":"","output":"","sideEffect":"只读"},"weatherCtx":{"input":"","output":"","sideEffect":""},"weatherText":{"input":"","output":"","sideEffect":""},"loadCity":{"input":"","output":"","sideEffect":"只读"},"saveCity":{"input":"","output":"","sideEffect":"写盘"}}},

  api: { weather: { fetchWeather, weatherCtx, weatherText, loadCity, saveCity } },
  tools: [
    {
      def: {
        type: "function",
        function: {
          name: "weather_view",
          description: "查看本地天气（温度/天气/体感/湿度/今日范围）。当对方问「今天天气怎么样」「冷不冷」「要不要带伞」时调用。",
          parameters: { type: "object", properties: {} },
        },
      },
      handler: async () => weatherText(),
    },
    {
      def: {
        type: "function",
        function: {
          name: "set_weather_city",
          description: "设置天气查询的城市。当主人说自己所在城市时调用，例如「我在大庆」「我回哈尔滨了」「人在北京」。只影响天气查询，不改其他东西。",
          parameters: {
            type: "object",
            properties: { city: { type: "string", description: "城市名，如「大庆」「哈尔滨」「北京」" } },
            required: ["city"],
          },
        },
      },
      handler(args, info) {
        if (!_ctx.isMaster(info.userId)) return "（只有主人能改天气城市哦）";
        const city = String(args.city || "").trim();
        if (!city) return "（没说要设哪个城市）";
        if (!saveCity(city, info.userId)) return "（保存失败）";
        return `记下了，以后天气按「${city}」查。`;
      },
    },
  ],
};
