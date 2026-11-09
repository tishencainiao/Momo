/* 插件：可配置参数 —— 让 Momo 自己查看/修改各功能暴露出来的可调参数
 * 参数由各插件在 exports.settings 里声明，宿主统一收集（registry.settings()）
 * 存储：data/settings.json（键如 "weather.city"）
 * 权限：仅主人可改（避免被人乱调） */
let _ctx = null;

const TYPE_LABEL = { string: "文本", number: "数字", boolean: "开关" };

function allSettings() {
  try { return _ctx.registry.settings() || []; } catch (e) { return []; }
}

function fmtValue(s) {
  if (s.type === "boolean") return s.value ? "开" : "关";
  return String(s.value == null ? "" : s.value);
}

/* 列出可调参数（可按关键词过滤） */
function settingsView(keyword) {
  const k = String(keyword || "").trim();
  const list = allSettings().filter((s) => {
    if (!k) return true;
    return String(s.key).indexOf(k) >= 0 || String(s.label || "").indexOf(k) >= 0 || String(s.plugin || "").indexOf(k) >= 0;
  });
  if (!list.length) {
    return k ? `（没找到和「${k}」相关的可调参数）` : "（暂时没有可调参数）";
  }
  const lines = list.slice(0, 30).map((s) => {
    const range = (s.type === "number" && (s.min != null || s.max != null)) ? `（范围 ${s.min != null ? s.min : "-∞"}~${s.max != null ? s.max : "+∞"}）` : "";
    const opts = Array.isArray(s.options) && s.options.length ? `（可选：${s.options.join("/")}）` : "";
    return `- ${s.key} = ${fmtValue(s)}${range}${opts}\n  说明：${s.label || ""}${s.desc ? "，" + s.desc : ""}`;
  });
  return "【可调参数】\n" + lines.join("\n") + "\n（用 settings_set 修改，例如 settings_set(key=\"weather.city\", value=\"大庆\")）";
}

/* 修改一个参数：类型转换 + 范围/枚举校验 */
function settingsSet(key, value, by) {
  const k = String(key || "").trim();
  if (!k) return { ok: false, msg: "（没说是哪个参数）" };
  const s = allSettings().find((x) => x.key === k);
  if (!s) return { ok: false, msg: `（没有这个可调参数：${k}，可以先 settings_view 看看）` };
  let v = value;
  if (s.type === "number") {
    v = Number(value);
    if (!Number.isFinite(v)) return { ok: false, msg: `（「${s.label}」要填数字）` };
    if (s.min != null && v < s.min) return { ok: false, msg: `（「${s.label}」最小 ${s.min}）` };
    if (s.max != null && v > s.max) return { ok: false, msg: `（「${s.label}」最大 ${s.max}）` };
  } else if (s.type === "boolean") {
    const t = String(value).toLowerCase();
    if (["1", "true", "开", "yes", "on", "是"].indexOf(t) >= 0) v = true;
    else if (["0", "false", "关", "no", "off", "否"].indexOf(t) >= 0) v = false;
    else return { ok: false, msg: `（「${s.label}」只能填 开/关）` };
  } else {
    v = String(value == null ? "" : value).trim();
    if (s.maxLength && v.length > s.maxLength) v = v.slice(0, s.maxLength);
    if (Array.isArray(s.options) && s.options.length && s.options.indexOf(v) < 0) {
      return { ok: false, msg: `（「${s.label}」只能选：${s.options.join("/")}）` };
    }
  }
  if (!_ctx.setSetting(k, v)) return { ok: false, msg: "（保存失败）" };
  _ctx.log("info", `参数修改: ${k} = ${JSON.stringify(v)}`);
  try { _ctx.recordAction({ action: "settings_set", by: Number(by) || 0, detail: `${k} = ${JSON.stringify(v)}`, ok: true }); } catch (e) {}
  return { ok: true, msg: `好的，「${s.label || k}」改成「${s.type === "boolean" ? (v ? "开" : "关") : v}」了。` };
}

module.exports = {
  name: "settings",
  displayName: "可配置参数",
  description: "让 Momo 自己查看/修改各功能暴露的可调参数",
  permissions: ["isMaster", "log", "recordAction", "registry", "setSetting"],
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  apiSpec: {"settingsApi":{"settingsView":{"input":"","output":"","sideEffect":"写盘"},"settingsSet":{"input":"","output":"","sideEffect":"写盘"},"allSettings":{"input":"","output":"","sideEffect":""}}},

  api: { settingsApi: { settingsView, settingsSet, allSettings } },
  tools: [
    {
      def: {
        type: "function",
        function: {
          name: "settings_view",
          description: "查看有哪些可以调整的参数（各功能暴露出来的设置项，如天气城市）。当主人问「你能调什么」「可以改哪些设置」时调用。",
          parameters: {
            type: "object",
            properties: { keyword: { type: "string", description: "关键词过滤（如「天气」「次数」），留空则列出全部" } },
          },
        },
      },
      handler(args, info) {
        if (!_ctx.isMaster(info.userId)) return "（只有主人能看设置哦）";
        return settingsView(args.keyword);
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "settings_set",
          description: "修改一个可调参数。当主人说「把天气城市改成大庆」「每天刷视频次数改成2」时调用。参数名从 settings_view 拿。",
          parameters: {
            type: "object",
            properties: {
              key: { type: "string", description: "参数名，如 weather.city" },
              value: { type: "string", description: "新值" },
            },
            required: ["key", "value"],
          },
        },
      },
      handler(args, info) {
        if (!_ctx.isMaster(info.userId)) return "（只有主人能改设置哦）";
        const r = settingsSet(args.key, args.value, info.userId);
        return r.msg;
      },
    },
  ],
};
