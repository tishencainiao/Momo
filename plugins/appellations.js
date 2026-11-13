/* 插件：称呼（工具 set_appellation + 命令 /叫我 /称呼 /朋友） */
let _ctx = null;
function rec(e) { try { if (_ctx.recordAction) _ctx.recordAction(e); } catch (err) {} }

/* P2-a：朋友清单（主人专属）——称呼/好感度/画像摘要，多朋友也可运维 */
function friendListText() {
  try {
    const roles = _ctx.getApi("roles");
    if (!roles || !roles.userIds || !roles.adminIds) return "（暂时查不到朋友清单）";
    const admins = new Set((roles.adminIds() || []).map(Number));
    const ids = (roles.userIds() || []).map(Number).filter((n) => n > 0 && !admins.has(n));
    if (!ids.length) return "（你还没有添加朋友，只有你自己）";
    const up = _ctx.getApi("userProfile");
    const lines = ids.map((id, i) => {
      const call = String(_ctx.resolveCall(id) || "朋友").slice(0, 20);
      let favor = "";
      try { const f = _ctx.getFavor(id); favor = f === undefined ? "" : `，好感 ${Math.round(f)}`; } catch (e) {}
      let brief = "";
      try { if (up && up.profileText) { const t = String(up.profileText(id) || "").replace(/\n+/g, " ").trim(); brief = t && t !== "（还没记下什么关于他的稳定信息）" ? `\n   画像：${t.slice(0, 60)}${t.length > 60 ? "…" : ""}` : ""; } } catch (e) {}
      return `${i + 1}. ${call}（QQ ${id}${favor}）${brief}`;
    });
    return `你的朋友共 ${ids.length} 个：\n${lines.join("\n")}`;
  } catch (e) { return "（朋友清单查询失败）"; }
}

module.exports = {
  name: "appellations",
  displayName: "称呼",
  description: "给自己和别人起称呼（/叫我、/称呼 命令）",
  permissions: ["isMaster", "loadAppellations", "log", "recordAction", "resolveCall", "resolveTargetId", "saveAppellations", "sendPrivate", "getApi", "getFavor"],
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  tools: [{
    def: {
      type: "function",
      function: {
        name: "set_appellation",
        description: "设置对方希望被称呼的名字。当对方说「叫我XX」时调用。",
        parameters: { type: "object", properties: { content: { type: "string", description: "对方原话（含想被叫的名字）" } }, required: ["content"] },
      },
    },
    handler(args, info) {
      const am = String(args.content || "").match(/(?:叫我|喊我|称我|叫我为)\s*([^\s，。！？!?]{1,20})/);
      if (am) {
        const nm = am[1].trim().replace(/(了|吧|哦|呀|哈)$/, "").trim();
        if (nm.includes("主人")) return "（「主人」是专属称呼，不能这么叫）";
        const apps = _ctx.loadAppellations(); apps[info.userId] = nm.slice(0, 20); _ctx.saveAppellations(apps);
        _ctx.log("info", `设置称呼 user=${info.userId}: ${nm}`);
        return `已设置称呼：「${nm}」`;
      }
      return "（没听懂想被叫什么）";
    },
  }, {
    def: {
      type: "function",
      function: {
        name: "set_other_appellation",
        description: "给某个群友/用户设置称呼（主人专属）。当主人说「把XX叫YY」「给123456起名叫小明」「这个QQ号是XXX」「100000002 叫老王」时调用。设好后就能用这个名字指代他（比如「拍拍老王」）。",
        parameters: { type: "object", properties: { target: { type: "string", description: "QQ号或对方现在的名字" }, name: { type: "string", description: "要设置的称呼" } }, required: ["target", "name"] },
      },
    },
    handler(args, info) {
      if (!_ctx.isMaster(info.userId)) return "（只有主人能给别人定称呼哦）";
      const nm = String(args.name || "").trim().slice(0, 20);
      if (!nm) return "（称呼为空）";
      if (nm.includes("主人")) return "（「主人」只能是你自己哦）";
      const tgt = _ctx.resolveTargetId(String(args.target || "").trim());
      if (!tgt) return `（没找到「${args.target}」，请给 QQ 号）`;
      const apps = _ctx.loadAppellations(); apps[tgt] = nm; _ctx.saveAppellations(apps);
      _ctx.log("info", `设置他人称呼 target=${tgt}: ${nm}`);
      rec({ action: "set_other_appellation", by: info.userId, target: tgt, detail: nm, ok: true });
      return `已把 ${tgt} 的称呼设为「${nm}」`;
    },
  }, {
    def: {
      type: "function",
      function: {
        name: "friend_list",
        description: "查看主人的朋友清单（称呼、好感度、画像摘要）。主人问「我有几个朋友」「朋友都有谁」「小🐟的画像」时调用。只有主人能看。",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    handler(args, info) {
      if (!_ctx.isMaster(info.userId)) return "（只有主人能看朋友清单）";
      return friendListText();
    },
  }],
  commands: [
    {
      key: "/叫我",
      regex: /^\/叫我\s*/,
      handler(msg) {
        const arg = msg.text.replace(/^\/(叫我|callme)\s*/i, "").trim();
        if (!arg) { _ctx.sendPrivate(msg.userId, "用法：/叫我 <称呼>，例如 /叫我 小明"); return; }
        if (arg.includes("主人")) { _ctx.sendPrivate(msg.userId, "「主人」这个称呼是专属的哦，不能这么叫～换个别的吧。"); return; }
        const apps = _ctx.loadAppellations(); apps[msg.userId] = arg.slice(0, 20); _ctx.saveAppellations(apps);
        _ctx.log("info", `设置称呼 user=${msg.userId}: ${arg}`);
        _ctx.sendPrivate(msg.userId, `好呀，以后我就叫你「${arg}」啦～`);
      },
    },
    {
      key: "/称呼",
      regex: /^\/称呼/,
      handler(msg) {
        if (msg.text === "/称呼" || msg.text === "/call") {
          _ctx.sendPrivate(msg.userId, `我现在称呼你为「${_ctx.resolveCall(msg.userId)}」${_ctx.isMaster(msg.userId) ? "（主人专属）" : ""}。`);
          return;
        }
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "只有主人能给别的人定称呼哦～"); return; }
        const arg = msg.text.replace(/^\/(称呼|call)\s*/i, "").trim();
        const mm = arg.match(/^(\d{5,12})\s+(.+)$/);
        if (!mm) { _ctx.sendPrivate(msg.userId, "用法：/称呼 <QQ号> <称呼>，例如 /称呼 100000002 小明"); return; }
        const tgt = mm[1], nm = mm[2].slice(0, 20);
        if (nm.includes("主人")) { _ctx.sendPrivate(msg.userId, "「主人」只能是你自己哦，别人不能叫这个称呼。"); return; }
        const apps = _ctx.loadAppellations(); apps[tgt] = nm; _ctx.saveAppellations(apps);
        _ctx.log("info", `设置称呼 target=${tgt}: ${nm}`);
        _ctx.sendPrivate(msg.userId, `已把 ${tgt} 的称呼设为「${nm}」。`);
      },
    },
    {
      key: "/朋友",
      regex: /^\/朋友/,
      handler(msg) {
        if (!_ctx.isMaster(msg.userId)) { _ctx.sendPrivate(msg.userId, "这个只有主人能看哦～"); return; }
        _ctx.sendPrivate(msg.userId, friendListText());
        rec({ action: "friend_list", by: msg.userId, ok: true });
      },
    },
  ],
};
