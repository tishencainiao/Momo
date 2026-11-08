/* caps.js —— 工具/命令的能力登记表（阶段 3）
 * 规则：这里登记的是「用户可以用的」能力；没登记的默认只给管理员（拒绝优先于放行）。
 * 能力名与 plugins/roles.js 的 MATRIX 一致。
 */
const TOOL_CAPS = {
  /* 只影响自己的自助能力 */
  memory_view: "memory_self",
  memory_edit: "memory_self",
  memory_forget: "memory_self",
  profile_view: "memory_self",
  set_appellation: "memory_self",
  set_weather_city: "memory_self",
  goals_view: "memory_self",
  set_goal: "memory_self",
  birthday_view: "reminder_self",
  set_birthday: "reminder_self",
  add_todo: "reminder_self",
  complete_todo: "reminder_self",
  list_todo: "reminder_self",
  remove_todo: "reminder_self",
  set_reminder: "reminder_self",
  like_status: "memory_self",
  poke: "memory_self",
  send_like: "memory_self",
  /* 只读 / 只发给自己 */
  web_search: "search",
  send_sticker: "sticker",
  make_sticker: "sticker",
  send_voice: "voice",
  weather_view: "memory_self",
  /* 其余全部默认 admin（不登记） */
};

const CMD_CAPS = {
  "/叫我": "memory_self",
  "/称呼": "memory_self",
  "/生日": "reminder_self",
  "/目标": "memory_self",
  "/记忆": "memory_self",
  "/提醒": "reminder_self",
  "/待办": "reminder_self",
  "/表情包": "sticker",
  "/做表情包": "sticker",
};

function toolCap(name) { return TOOL_CAPS[String(name || "")] || null; }
function cmdCap(key) { return CMD_CAPS[String(key || "")] || null; }

module.exports = { TOOL_CAPS, CMD_CAPS, toolCap, cmdCap };
