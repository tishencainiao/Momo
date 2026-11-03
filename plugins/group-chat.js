/* 插件：群聊行为设置 —— 只声明可调参数，具体逻辑在 index.js
 * 这样 Momo 能通过 settings_set 自己调群聊说话方式 */
let _ctx = null;

const AT_REPLY = ["always", "on_at", "never"];
const AT_OTHERS = ["smart", "strict", "ignore"];

function atMode() {
  const v = String(_ctx.getSetting("group.at_reply", "on_at") || "");
  return AT_REPLY.indexOf(v) >= 0 ? v : "on_at";
}
function atOthersMode() {
  const v = String(_ctx.getSetting("group.at_others_mode", "smart") || "");
  return AT_OTHERS.indexOf(v) >= 0 ? v : "smart";
}

module.exports = {
  name: "group-chat",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  settings: [
    {
      key: "group.at_reply",
      label: "群聊回复时要不要@对方",
      type: "string",
      default: "on_at",
      options: AT_REPLY,
      desc: "always=总是@；on_at=只在对方@我时@回去；never=从不@（更像真人）",
    },
    {
      key: "group.at_others_mode",
      label: "对方@了别人时怎么判断",
      type: "string",
      default: "smart",
      options: AT_OTHERS,
      desc: "smart=让模型判断这句在跟谁说话；strict=@了别人就不接话；ignore=不管@了谁",
    },
  ],
  api: { groupChat: { atMode, atOthersMode } },
};
