/* 插件：吃瓜（read_buzz）—— 读百度实时热搜，只看标题，写一句自己的看法
 * 红线：
 *   - 只读标题（+ 榜位），**不复述、不转述细节**（她本来也没点进去看）
 *   - 生成的"看法"只允许是主观感受/态度，禁止传播未经核实的细节
 *   - 抓不到就记 ok:false，不编"今天热搜第一是……"
 * 落点：data/buzz.jsonl、兴趣档案；不主动发消息（分享由上层 nudge 队列管）
 * 数据源：百度热搜榜（2026-11-05 本机实测 200 可用） */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BOARD_URL = "https://top.baidu.com/api/board?platform=wise&tab=realtime";
const buzzFile = () => path.join(_ctx.DATA_DIR, "buzz.jsonl");

function loadBuzz(n) {
  try {
    return fs.readFileSync(buzzFile(), "utf8").split("\n").filter(Boolean)
      .slice(-(n || 50)).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
function appendBuzz(rec) {
  try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.appendFileSync(buzzFile(), JSON.stringify(rec) + "\n"); } catch (e) {}
}

/* 拉热搜榜 → [{rank, word, url, hot}]；失败返回 [] */
async function fetchBoard() {
  try {
    const r = await fetch(BOARD_URL, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const cards = j && j.data && j.data.cards;
    if (!Array.isArray(cards) || !cards.length) return [];
    const list = cards[0] && cards[0].content && cards[0].content[0] && cards[0].content[0].content;
    if (!Array.isArray(list)) return [];
    return list.map((x, i) => ({
      rank: i + 1,
      word: String((x && x.word) || "").slice(0, 60),
      url: String((x && x.url) || "").slice(0, 300),
      hot: String((x && x.hotTag) || ""),
      top: !!(x && x.isTop),
    })).filter((x) => x.word);
  } catch (e) {
    _ctx.log("warn", "热搜榜抓取失败: " + String(e.message).slice(0, 100));
    return [];
  }
}

/* 让她从热搜里挑一条"她关心的"（只给标题，不给正文，符合"她只看了标题"的事实） */
async function pickTopic(list, settings) {
  const hobby = _ctx.getApi && _ctx.getApi("hobby");
  let hobbyLine = "";
  try { const t = hobby && hobby.hobbyText && hobby.hobbyText(2); if (t) hobbyLine = "（这是她最近的爱好，挑的时候可以参考：）" + t; } catch (e) {}
  const lines = list.slice(0, 10).map((x) => `${x.rank}. ${x.word}`).join("\n");
  const prompt = `你是 Momo（大肥鱼桌宠），正在刷今天的实时热搜榜。你只看到了标题，没点进去看内容。${hobbyLine}
${lines}

挑一条你此刻最想聊两句的（凭感觉，别挑最沉重的社会悲剧），只输出序号数字。`;
  try {
    const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 10, 0.8);
    const n = parseInt(String(raw || "").replace(/[^\d]/g, ""), 10);
    if (n >= 1 && n <= Math.min(10, list.length)) return list[n - 1];
  } catch (e) {}
  return list[0];
}

/* 写看法：只允许主观感受，禁止转述细节 */
async function writeView(item, settings) {
  const prompt = `你是 Momo（大肥鱼桌宠）。你刚刷到一条热搜标题：
「${item.word}」（榜位第 ${item.rank}）

规则（很重要）：你**只看了标题**，没看内容，所以不许编造事件细节、不许转述别人说的话、不许传播未经证实的说法。只写你自己的主观感受或态度。
请用 JSON 输出（不要解释、不要代码块）：
{"view":"60 字以内的看法，口语、像真人","topic":"这条热搜的话题词，2~6 个字"}`;
  const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 200, 0.8);
  const m = String(raw || "").match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      return { view: String(o.view || "").slice(0, 90), topic: String(o.topic || "").slice(0, 20) };
    } catch (e) {}
  }
  return { view: String(raw || "").trim().slice(0, 90), topic: "" };
}

/* 主流程 */
async function readBuzz(settings) {
  const core = _ctx.getApi && _ctx.getApi("fun-core");
  if (!core) { _ctx.log("warn", "吃瓜：fun-core 未加载"); return null; }
  const gate = core.canPlay("read_buzz", 1, 0.004);
  if (!gate.ok) { _ctx.log("info", `吃瓜跳过：${gate.reason}`); return null; }

  const list = await fetchBoard();
  if (!list.length) {
    core.appendActivity({ type: "read_buzz", ok: false, reason: "热搜榜没抓到" });
    return null;
  }
  const item = await pickTopic(list, settings);
  const v = await writeView(item, settings);
  const rec = { ts: Date.now(), board: "百度热搜", rank: item.rank, title: item.word, url: item.url, view: v.view, topic: v.topic };

  core.addFunSpent(0.004);
  core.appendActivity({ type: "read_buzz", ok: true, rank: item.rank, title: item.word, view: v.view, topic: v.topic });
  appendBuzz(rec);
  if (v.topic) { const h = _ctx.getApi("hobby"); if (h) { try { h.vote(v.topic, "buzz", { title: item.word }); } catch (e) {} } }
  try { _ctx.addBoredom && _ctx.addBoredom(-4); } catch (e) {}

  _ctx.log("info", `吃瓜：热搜第${item.rank}「${item.word}」→ ${v.view.slice(0, 40)}`);
  return rec;
}

module.exports = {
  name: "buzz",
  version: "1.0.0",
  requires: ["fun-core", "hobby"],
  init(ctx) { _ctx = ctx; },
  api: { buzz: { readBuzz, fetchBoard, pickTopic, writeView, loadBuzz } },
};

