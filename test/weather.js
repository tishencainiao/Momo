/* 天气插件测试：接口解析 / 缓存 / 设置城市 / 权限 / 工具文本 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-weather-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let lastUrl = "";
global.fetch = async (url) => {
  lastUrl = String(url);
  return {
    ok: true,
    json: async () => ({
      nearest_area: [{ areaName: [{ value: "龙凤" }] }],
      current_condition: [{ temp_C: "-3", weatherDesc: [{ value: "Light snow" }], FeelsLikeC: "-8", humidity: "62" }],
      weather: [{ mintempC: "-7", maxtempC: "-1" }],
    }),
  };
};

const plugin = require("E:/Learn/Momo/plugins/weather.js");
plugin.init({
  DATA_DIR: DIR,
  log: () => {},
  isMaster: (u) => Number(u) === 100000001,
});
const W = plugin.api.weather;
const ME = 100000001, FRIEND = 100000002;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

(async () => {
  // 1. 未设置城市 → 按 IP
  check("初始没有设置城市", W.loadCity() === "");
  const w1 = await W.fetchWeather();
  check("未设置时按 IP 查询", lastUrl.indexOf("/?format=j1") >= 0, lastUrl);
  check("城市回退到接口定位名", w1.city === "龙凤", w1.city);
  check("温度解析正确", w1.tempC === "-3");

  // 2. 设置城市（主人）
  const setTool = plugin.tools.find((t) => t.def.function.name === "set_weather_city");
  const r1 = setTool.handler({ city: "大庆" }, { userId: ME });
  check("主人能设置城市", r1.indexOf("大庆") >= 0, r1);
  check("城市已持久化", W.loadCity() === "大庆");

  // 3. 设置后按城市查
  const w2 = await W.fetchWeather();
  check("按城市查询（URL 含城市名）", decodeURIComponent(lastUrl).indexOf("大庆") >= 0, lastUrl);
  check("显示设置的城市名", w2.city === "大庆", w2.city);

  // 4. 权限：熟人不能设置
  const r2 = setTool.handler({ city: "北京" }, { userId: FRIEND });
  check("熟人不能设置城市", r2.indexOf("只有主人") >= 0, r2);
  check("城市未被改动", W.loadCity() === "大庆");

  // 5. 上下文与工具文本
  const ctx = await W.weatherCtx();
  check("上下文用设置的城市", ctx.indexOf("大庆") >= 0, ctx);
  check("上下文含今日范围", ctx.indexOf("-7~-1") >= 0);
  const txt = await W.weatherText();
  check("工具文本用设置的城市", txt.indexOf("大庆") >= 0, txt);

  // 6. 缓存：同城市再查不请求网络
  let calls = 0;
  const oldFetch = global.fetch;
  global.fetch = async (u) => { calls++; return oldFetch(u); };
  await W.fetchWeather();
  check("同城市 30 分钟内走缓存", calls === 0, "calls=" + calls);

  // 7. 换城市清缓存
  setTool.handler({ city: "哈尔滨" }, { userId: ME });
  await W.fetchWeather();
  check("换城市后重新请求", calls === 1, "calls=" + calls);
  check("新城市生效", W.loadCity() === "哈尔滨");

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
