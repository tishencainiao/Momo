/* 可配置参数测试：查看 / 设置 / 类型转换 / 范围校验 / 枚举校验 / 权限 */
const plugin = require("E:/Learn/Momo/plugins/settings.js");

let store = {};
const CATALOG = [
  { key: "weather.city", label: "天气城市", type: "string", default: "", desc: "留空=按IP" },
  { key: "browse.daily_max", label: "每天刷内容次数", type: "number", default: 3, min: 1, max: 10 },
  { key: "some.flag", label: "某开关", type: "boolean", default: false },
  { key: "some.mode", label: "某模式", type: "string", default: "a", options: ["a", "b"] },
];

plugin.init({
  log: () => {},
  isMaster: (u) => Number(u) === 100000001,
  getSetting: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
  setSetting: (k, v) => { store[k] = v; return true; },
  registry: { settings: () => CATALOG.map((s) => Object.assign({}, s, { value: Object.prototype.hasOwnProperty.call(store, s.key) ? store[s.key] : s.default })) },
});

const S = plugin.api.settingsApi;
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

// 1. 查看
const all = S.settingsView("");
check("列出全部参数", all.indexOf("weather.city") >= 0 && all.indexOf("browse.daily_max") >= 0, all);
check("显示默认值", all.indexOf("= 3") >= 0);
check("显示范围", all.indexOf("1~10") >= 0);
check("显示可选值", all.indexOf("可选：a/b") >= 0);
const kw = S.settingsView("天气");
check("关键词过滤", kw.indexOf("weather.city") >= 0 && kw.indexOf("browse.daily_max") < 0, kw);
const none = S.settingsView("不存在的东西");
check("查不到有提示", none.indexOf("没找到") >= 0);

// 2. 设置字符串
check("设置天气城市", S.settingsSet("weather.city", "大庆").ok === true);
check("值已写入", store["weather.city"] === "大庆");

// 3. 数字类型
check("设置数字", S.settingsSet("browse.daily_max", "5").ok === true);
check("数字转换正确", store["browse.daily_max"] === 5);
const r1 = S.settingsSet("browse.daily_max", "abc");
check("非数字被拒", r1.ok === false && r1.msg.indexOf("要填数字") >= 0, r1.msg);
const r2 = S.settingsSet("browse.daily_max", "0");
check("低于最小值被拒", r2.ok === false && r2.msg.indexOf("最小") >= 0, r2.msg);
const r3 = S.settingsSet("browse.daily_max", "99");
check("高于最大值被拒", r3.ok === false && r3.msg.indexOf("最大") >= 0, r3.msg);

// 4. 布尔类型
check("开 = true", S.settingsSet("some.flag", "开").ok === true && store["some.flag"] === true);
check("关 = false", S.settingsSet("some.flag", "关").ok === true && store["some.flag"] === false);
const r4 = S.settingsSet("some.flag", "也许");
check("非法布尔被拒", r4.ok === false && r4.msg.indexOf("只能填 开/关") >= 0, r4.msg);

// 5. 枚举
check("枚举合法值", S.settingsSet("some.mode", "b").ok === true);
const r5 = S.settingsSet("some.mode", "c");
check("枚举非法值被拒", r5.ok === false && r5.msg.indexOf("只能选") >= 0, r5.msg);

// 6. 未知参数
const r6 = S.settingsSet("no.such.key", "x");
check("未知参数被拒", r6.ok === false && r6.msg.indexOf("没有这个可调参数") >= 0, r6.msg);

// 7. 权限
const viewTool = plugin.tools.find((t) => t.def.function.name === "settings_view");
const setTool = plugin.tools.find((t) => t.def.function.name === "settings_set");
check("熟人不能查看", viewTool.handler({}, { userId: 100000002 }).indexOf("只有主人") >= 0);
check("熟人不能修改", setTool.handler({ key: "weather.city", value: "北京" }, { userId: 100000002 }).indexOf("只有主人") >= 0);
check("主人能修改", setTool.handler({ key: "weather.city", value: "北京" }, { userId: 100000001 }).indexOf("北京") >= 0);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
