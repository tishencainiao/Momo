/* 防捏造闸门（纯函数，可单测）：输出后审计
 * 问题背景：2026-11-05 Momo 声称"攒了几首轻音乐，我这就放给你听"，并连演两分钟"放啦，这首慢一点的"，
 *           而她并没有任何音频播放能力，全程零工具调用。
 * 规则：最终回复文本里出现"做不到的能力"触发短语，且这句话是**肯定式**（不是"我做不到/两码事"这种否认），
 *       并且本轮没有能兑现它的工具成功执行 → 拦下换成如实说明。
 * 特性：确定性字符串匹配，不调模型、不加延迟、不花钱。
 * 注意：
 *   - 触发短语特意不含单字「放」，因为她常说「先放一边/放过自己」，会被误伤；
 *   - 必须做否定判别：她诚实回答「放歌做不了」「发语音≠放音乐」时不能拦（否则会把真话换成道歉）。 */
const HONEST_FALLBACK = "（说明：这个我做不到，刚才那句不算数。）";

/* 能"兑现"音频类承诺的工具：只要本轮这些工具真的跑成功，就不算编造 */
const CONFIRMING_TOOLS = ["send_voice", "voice_reply"];

/* 否认/澄清词：同一分句里出现这些，说明她在说"做不到"，不是承诺 */
const NEGATION_RE = /(不|没|别|无法|不能|不会|做不到|做不|办不|没有|两码事|区分|不等于|不是|哪会|哪能)/;

/* 音频上下文：只有 contextOnly 的模糊触发词（"放啦""我开始了"）需要它撑腰，避免误伤"把钥匙放好了" */
const AUDIO_CONTEXT_RE = /(歌|音乐|旋律|耳机|音响|音量|播放器|曲子|这首|第一首|第二首|音轨)/;

function clausesOf(text) {
  /* 按标点切成小分句，逐句判断"这句是承诺还是否认" */
  return String(text || "").split(/[。！？；，,、\n…~～]/).filter((s) => s.trim());
}

/**
 * @param {object} opts
 * @param {string} opts.text        最终回复文本
 * @param {string[]} opts.usedTools 本轮执行成功的工具名
 * @param {{phrase:string,id:string,label:string,contextOnly?:boolean}[]} opts.triggers 触发短语表（来自 capability-index 的负清单）
 * @param {boolean} [opts.enabled]  开关（默认 true）
 * @param {boolean} [opts.allowConfirmingTools] 有确认类工具成功时放行（默认 true）
 * @returns {{text:string, blocked:boolean, hit?:object}}
 */
function auditReply(opts) {
  const o = opts || {};
  const text = String(o.text || "");
  if (!text) return { text, blocked: false };
  if (o.enabled === false) return { text, blocked: false };
  const triggers = Array.isArray(o.triggers) ? o.triggers : [];
  if (!triggers.length) return { text, blocked: false };

  const clauses = clausesOf(text);
  let hit = null;
  outer:
  for (const t of triggers) {
    if (!t || !t.phrase) continue;
    for (let i = 0; i < clauses.length; i++) {
      const c = clauses[i];
      if (c.indexOf(t.phrase) < 0) continue;
      if (NEGATION_RE.test(c)) continue;                       // 这一句在否认/澄清，不算编造
      if (t.contextOnly && !AUDIO_CONTEXT_RE.test(c) && !AUDIO_CONTEXT_RE.test(clauses[i + 1] || "")) continue; // 模糊词要有音频上下文
      hit = t;
      break outer;
    }
  }
  if (!hit) return { text, blocked: false };

  const used = new Set(Array.isArray(o.usedTools) ? o.usedTools : []);
  if (o.allowConfirmingTools !== false && CONFIRMING_TOOLS.some((n) => used.has(n))) return { text, blocked: false };
  return { text: HONEST_FALLBACK, blocked: true, hit };
}

module.exports = { auditReply, HONEST_FALLBACK, CONFIRMING_TOOLS, NEGATION_RE, AUDIO_CONTEXT_RE };
