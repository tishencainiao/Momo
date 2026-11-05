/* 插件：真实生活日志 —— 从真实活动数据汇总「我最近做过什么」，替代虚构日程
 * 数据源（全部是真实发生过的）：current-activity / journal / fun-stuff / mind / qzone-state / replies
 * 原则：只陈述有记录的事实，不编造身体行为（晒太阳/吃饭/走路） */
const fs = require("fs");
const path = require("path");
let _ctx = null;

function readJson(p, def) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return def; } }
function readJsonl(p, n) {
  try {
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

/* 生成「我的真实状态」：只写有记录的事 */
function lifeCtx() {
  const now = Date.now();
  const out = [];
  // 1. 此刻在做什么（真实活动）
  const act = readJson(path.join(_ctx.DATA_DIR, "current-activity.json"), null);
  if (act && act.text) out.push(`此刻：${act.text}（${_ctx.formatGap(now - (act.since || now))}前开始）`);
  // 2. 今天真实的自我叙事（journal）
  const journal = readJson(path.join(_ctx.SELF_DIR, "journal.json"), []);
  const recentJ = (Array.isArray(journal) ? journal : [])
    .filter((e) => now - (e.ts || 0) < 24 * 3600e3)
    .slice(-4)
    .map((e) => String(e.text || e.title || "").slice(0, 30))
    .filter(Boolean);
  if (recentJ.length) out.push("今天想到/记下的：" + recentJ.join("；"));
  // 3. 最近真的搜过什么
  const fun = readJson(path.join(_ctx.DATA_DIR, "fun-stuff.json"), []);
  const topics = (Array.isArray(fun) ? fun : []).slice(-3).map((x) => String(x.topic || "").slice(0, 20)).filter(Boolean);
  if (topics.length) out.push("最近上网搜过：" + topics.join("、"));
  // 4. 最近自己冒出的念头
  const mind = readJson(path.join(_ctx.DATA_DIR, "mind.json"), {});
  const thoughts = (mind && Array.isArray(mind.thoughts) ? mind.thoughts : []).slice(-3).map((t) => String(t).slice(0, 30));
  if (thoughts.length) out.push("最近的念头：" + thoughts.join("；"));
  // 5. 今天发过几条说说
  const qs = readJson(path.join(_ctx.DATA_DIR, "qzone-state.json"), {});
  const posted = Number(((qs && qs.dates) || {})[_ctx.dayStr(0)] || 0);
  if (posted) out.push(`今天发过 ${posted} 条空间说说`);
  // 6. 今天和谁说过多少话（真实回复记录）
  const replies = readJsonl(path.join(_ctx.DATA_DIR, "replies.jsonl"), 300);
  const today = replies.filter((r) => now - (r.ts || 0) < 24 * 3600e3);
  if (today.length) {
    const byUser = {};
    for (const r of today) byUser[r.userId] = (byUser[r.userId] || 0) + 1;
    const desc = Object.entries(byUser).map(([u, n]) => `${_ctx.resolveCall(u)} ${n} 条`).join("、");
    out.push(`今天说过 ${today.length} 句话（${desc}）`);
  }
  // 7. 最近刷到 / 看过的视频（优先用她的感想，其次标题）
  const browse = readJsonl(path.join(_ctx.DATA_DIR, "browse.jsonl"), 30);
  const recentBrowse = browse.filter((x) => now - (x.ts || 0) < 24 * 3600e3).slice(-3)
    .map((x) => String(x.thought || x.title || "").slice(0, 60)).filter(Boolean);
  if (recentBrowse.length) out.push("最近刷到：" + recentBrowse.join("；"));
  // 7.1 最近读过的文章（娱乐：读一篇文章，只认真实读过且带凭据的记录）
  const acts = readJsonl(path.join(_ctx.DATA_DIR, "activities.jsonl"), 200)
    .filter((x) => x && x.type === "read_article" && x.ok && now - (x.ts || 0) < 48 * 3600e3);
  const recentRead = acts.slice(-2).map((x) => `《${String(x.title || "").slice(0, 30)}》（${x.source || "?"}，${x.body_len || 0} 字）`).filter(Boolean);
  if (recentRead.length) out.push("最近认真读过：" + recentRead.join("；"));
  // 7.2 手上那局数独玩到哪了
  const pz = readJson(path.join(_ctx.DATA_DIR, "puzzle.json"), null);
  if (pz && pz.status && pz.status !== "solved" && pz.status !== "abandoned" && Array.isArray(pz.board)) {
    let filled = 0, total = 0;
    for (let r = 0; r < pz.board.length; r++) for (let c = 0; c < pz.board[r].length; c++) {
      if (pz.givens && pz.givens[r] && pz.givens[r][c] === 0) { total++; if (pz.board[r][c] !== 0) filled++; }
    }
    out.push(`那局数独你玩到 ${filled}/${total} 格${pz.status === "stuck" ? "（上一轮卡住了，可以接着试）" : ""}`);
  }
  // 7.3 最近吃过的瓜（只记她的看法，不复述原文）
  const buzz = readJsonl(path.join(_ctx.DATA_DIR, "buzz.jsonl"), 10)
    .filter((x) => x && now - (x.ts || 0) < 48 * 3600e3);
  const recentBuzz = buzz.slice(-2).map((x) => `「${String(x.title || "").slice(0, 24)}」${String(x.view || "").slice(0, 40)}`).filter(Boolean);
  if (recentBuzz.length) out.push("最近刷到的热搜：" + recentBuzz.join("；"));
  // 8. 今天替谁做过什么（统一操作记录，含「谁要求的」）
  const acts8 = readJsonl(path.join(_ctx.DATA_DIR, "actions.jsonl"), 40)
    .filter((x) => now - (x.ts || 0) < 24 * 3600e3 && x.ok !== false);
  if (acts8.length) {
    const desc = acts8.slice(-4).map((a) => {
      const what = ACTION_LABEL[a.action] || a.action;
      const tgt = a.target ? `「${_ctx.resolveCall(a.target)}」` : "";
      const by = a.by ? `${_ctx.resolveCall(a.by)}让的` : "我自己想的";
      return `${what}${tgt}（${by}）`;
    });
    out.push("今天做过：" + desc.join("；"));
  }
  if (!out.length) return "【我的真实状态】刚启动，还没做过什么特别的事（在后台待机）。";
  return "【我的真实状态（据实记录，别编造身体行为）】\n" + out.join("\n");
}

/* 动作名 → 人话 */
const ACTION_LABEL = {
  poke: "拍了拍", send_like: "点赞了", mute_user: "屏蔽了", unmute_user: "解除屏蔽",
  set_other_appellation: "给别人起称呼", set_goal: "定了目标", settings_set: "改了参数",
  set_weather_city: "改了天气城市", memory_forget: "忘了", memory_edit: "更正了记忆",
  emoji_like: "贴了表情回应", forward_msg: "合并转发", set_self_profile: "改了自己资料",
  dsh_notify: "发了DSH通知", qzone_post: "发了空间说说", qzone_feedback: "收到空间评论",
  headpat: "被摸了头", sticker_sent: "发了表情包", qzone_delete: "删了说说",
};

/* 查最近做过什么（含谁要求的） */
function actionLogText(limit) {
  const arr = readJsonl(path.join(_ctx.DATA_DIR, "actions.jsonl"), 200).slice(-(limit || 8)).reverse();
  if (!arr.length) return "（最近还没做过什么需要记录的事）";
  return "【最近做过的事】\n" + arr.map((a) => {
    const t = a.ts ? new Date(a.ts).toLocaleString("zh-CN") : "";
    const what = ACTION_LABEL[a.action] || a.action;
    const tgt = a.target ? `「${_ctx.resolveCall(a.target)}」` : "";
    const by = a.by ? `${_ctx.resolveCall(a.by)}让的` : "我自己想的";
    const ok = a.ok === false ? "（失败）" : "";
    return `${t} ${what}${tgt} —— ${by}${ok}${a.detail ? "：" + a.detail : ""}`;
  }).join("\n");
}

module.exports = {
  name: "life-log",
  version: "1.1.0",
  init(ctx) { _ctx = ctx; },
  api: { lifeLog: { lifeCtx, actionLogText } },
  requires: [],
  tools: [{
    def: {
      type: "function",
      function: {
        name: "action_log",
        description: "查看自己最近做过哪些有副作用的操作（拍一拍/点赞/屏蔽/改设置等），以及每次是「谁要求的」。当有人问「你刚才为什么拍他」「这事谁让你做的」时调用。",
        parameters: { type: "object", properties: { limit: { type: "number", description: "看最近几条，默认 8" } } },
      },
    },
    handler: (args) => actionLogText(Number(args.limit) || 8),
  }],
};
