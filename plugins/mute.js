/* 插件：屏蔽（工具 mute_user / unmute_user，主人专属，数据层在内核） */
let _ctx = null;
function rec(e) { try { if (_ctx.recordAction) _ctx.recordAction(e); } catch (err) {} }

module.exports = {
  name: "mute",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  tools: [
    {
      def: {
        type: "function",
        function: {
          name: "mute_user",
          description: "屏蔽某个用户（主人专属）。当主人说「别跟XX说话了」「屏蔽XX」时调用。",
          parameters: { type: "object", properties: { content: { type: "string", description: "主人原话（含要屏蔽的人）" } }, required: ["content"] },
        },
      },
      handler(args, info) {
        if (!_ctx.isMaster(info.userId)) return "（只有主人能屏蔽/解除屏蔽别人哦）";
        const s = String(args.content || "");
        const mm = s.match(/(?:别跟|不要理|别理|屏蔽|拉黑)\s*([^\s，。！？!?]{1,20})/);
        if (mm) {
          const nm = mm[1].trim().replace(/(说话了|说话|了|这个人|他|她|它)$/, "").trim();
          const tgt = _ctx.resolveTargetId(nm);
          if (tgt) { _ctx.addMute(tgt, nm); _ctx.log("info", `屏蔽用户: ${tgt} (${nm})`); rec({ action: "mute_user", by: info.userId, target: tgt, detail: nm, ok: true }); return `已屏蔽「${nm}」`; }
          return `（没找到「${nm}」，请给 QQ 号或先 /称呼 起名）`;
        }
        return "（没听懂要屏蔽谁）";
      },
    },
    {
      def: {
        type: "function",
        function: {
          name: "unmute_user",
          description: "解除屏蔽（主人专属）。当主人说「解除屏蔽XX」时调用。",
          parameters: { type: "object", properties: { content: { type: "string", description: "主人原话（含要解除的人）" } }, required: ["content"] },
        },
      },
      handler(args, info) {
        if (!_ctx.isMaster(info.userId)) return "（只有主人能屏蔽/解除屏蔽别人哦）";
        const s = String(args.content || "");
        const mm = s.match(/(?:解除屏蔽|取消屏蔽|可以理|恢复理)\s*([^\s，。！？!?]{1,20})/);
        if (mm) {
          const nm = mm[1].trim().replace(/(了|这个人|他|她|它)$/, "").trim();
          const tgt = _ctx.resolveTargetId(nm);
          if (tgt) { _ctx.removeMute(tgt); _ctx.log("info", `解除屏蔽: ${tgt} (${nm})`); rec({ action: "unmute_user", by: info.userId, target: tgt, detail: nm, ok: true }); return `已解除屏蔽「${nm}」`; }
          return `（没找到「${nm}」，请给 QQ 号或先 /称呼 起名）`;
        }
        return "（没听懂要解除谁）";
      },
    },
  ],
};
