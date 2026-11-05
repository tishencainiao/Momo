/* 插件：娱乐系统 v1（MVP：听歌写乐评）
 * music_review：从榜单挑一首 → 拉歌词 + 热评 → flash 写 2~4 句乐评 → 记 activities.jsonl + 投 taste 一票
 * 产出：data/activities.jsonl（带 songid 可追溯）、data/taste.json（品味雏形：去重 + plays 累加）
 * 成本：挑 1 次 flash + 写乐评 1 次 flash ≈ ¥0.003；网易云接口免费。预算耗尽不玩。
 * 红线：歌词/热评拿不到就如实写「无」，不许编；乐评只引用接口真给的内容。 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const DAY_MAX_DEFAULT = 2;
const PLAYLIST_ID_DEFAULT = 3778678;   // 网易云热歌榜

function numSetting(key, def) {
  try { const v = Number(_ctx.getSetting ? _ctx.getSetting(key, def) : def); return Number.isFinite(v) && v > 0 ? v : def; }
  catch (e) { return def; }
}
function dayMax() { return numSetting("entertainment.music_review_max", DAY_MAX_DEFAULT); }
function playlistId() { return numSetting("entertainment.playlist_id", PLAYLIST_ID_DEFAULT); }
/* 同一天里刚听过的歌不重复听（默认 6 小时内），避免连着三次都是同一首 */
function repeatGapMs() { return numSetting("entertainment.repeat_gap_hours", 6) * 3600e3; }

const actFile = () => path.join(_ctx.DATA_DIR, "activities.jsonl");
const tasteFile = () => path.join(_ctx.DATA_DIR, "taste.json");

function loadActivities(n) {
  try {
    return fs.readFileSync(actFile(), "utf8").split("\n").filter(Boolean)
      .slice(-(n || 100)).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
function recordActivity(item) {
  try {
    fs.mkdirSync(_ctx.DATA_DIR, { recursive: true });
    fs.appendFileSync(actFile(), JSON.stringify(Object.assign({ ts: Date.now() }, item)) + "\n");
  } catch (e) {}
}
function todayCount() {
  const now = Date.now();
  return loadActivities(100).filter((x) => x.type === "music_review" && now - (x.ts || 0) < 24 * 3600e3).length;
}
function loadTaste() {
  try { const d = JSON.parse(fs.readFileSync(tasteFile(), "utf8")); if (d && typeof d === "object") return d; } catch (e) {}
  return { music: [] };
}
function saveTaste(t) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(tasteFile(), JSON.stringify(t)); } catch (e) {} }

/* 投品味一票（雏形）：按 songid 去重，重复听只累加 plays，不新建条目 */
function voteTaste(song) {
  const t = loadTaste();
  t.music = Array.isArray(t.music) ? t.music : [];
  const title = String(song.title || song.name || "").slice(0, 60);   // 歌单里字段叫 name（v1.61 修：之前丢了歌名）
  const hit = t.music.find((m) => String(m.id) === String(song.id));
  if (hit) {
    hit.plays = (hit.plays || 0) + 1;
    hit.last_ts = Date.now();
    if (!hit.title && title) hit.title = title;
  } else t.music.push({ id: String(song.id), title, artist: song.artist || "", rating: 0.5, plays: 1, first_ts: Date.now(), last_ts: Date.now() });
  saveTaste(t);
}
/* 刚听过的歌（repeatGap 内）排除掉，池子空了才允许重复 */
function freshPool(list) {
  const gap = repeatGapMs();
  const now = Date.now();
  const recent = new Set((loadTaste().music || [])
    .filter((m) => now - (Number(m.last_ts) || 0) < gap)
    .map((m) => String(m.id)));
  const fresh = list.filter((x) => !recent.has(String(x.id)));
  return fresh.length ? fresh : list;
}
/* 歌词节选：跳过开头（多制作信息），取中间 8 句左右，让乐评有真材实料可引 */
function lyricExcerpt(lines, max) {
  if (!lines || !lines.length) return "";
  const start = lines.length > 14 ? Math.floor(lines.length / 3) : 0;
  return lines.slice(start, start + 8).join(" / ").slice(0, max || 200);
}

async function pickSong(list, settings) {
  const lines = list.map((x, i) => `${i + 1}. ${x.name}（${x.artist}）`).join("\n");
  const prompt = `你是 Momo（大肥鱼桌宠）。下面是你现在能听到的歌：\n${lines}\n挑一首你此刻最想听的（凭感觉），只输出序号数字，不要解释。`;
  const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 10, 0.8);
  const n = parseInt(String(raw || "").replace(/[^\d]/g, ""), 10);
  return (n >= 1 && n <= list.length) ? list[n - 1] : list[0];
}

async function writeReview(song, lyricLines, comments, settings) {
  const lyr = lyricExcerpt(lyricLines, 200);
  const cm = comments.length ? comments.slice(0, 3).map((c, i) => `${i + 1}. ${c}`).join("\n") : "";
  const prompt = `你是 Momo（大肥鱼桌宠）。你刚刚翻了一首歌的歌词和高赞评论（下面是接口真实返回的内容；你听不到声音，别假装听到了旋律）：
歌名：${song.name}
歌手：${song.artist}${song.album ? "\n专辑：" + song.album : ""}
歌词（节选）：${lyr || "（没拿到歌词）"}
热评：\n${cm || "（没拿到热评）"}

请写 2~4 句乐评（60~150 字）：歌词大概什么感觉 + 你的真实感受。只写上面真给的歌词和热评里的东西，不许补充歌手经历、别人对他的评价、八卦或你记忆里的歌词（那不是这次拿到的）；引用歌词原文时才加引号。没拿到歌词就不要提具体歌词句子，别凭歌名编。口语化、像真人，不要括号动作，不要引号包整段，不要解释。`;
  const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 200, 0.8);
  return String(raw || "").trim().replace(/^["'「『]|["'」』]$/g, "").slice(0, 200);
}

/* 听一次歌：挑歌 → 歌词+热评 → 乐评 → 记活动 + 投品味一票 */
async function musicReview(settings) {
  if (_ctx.isBudgetExhausted()) { _ctx.log("info", "听歌写乐评跳过：生活费已用完"); return null; }
  if (todayCount() >= dayMax()) { _ctx.log("info", "听歌写乐评跳过：今天已经听够了"); return null; }
  const music = _ctx.getApi && _ctx.getApi("music");
  if (!music || !music.getPlaylist) { _ctx.log("warn", "听歌写乐评：music 插件未加载"); return null; }
  const all = await music.getPlaylist(playlistId(), 8);
  if (!all.length) return null;
  const pool = freshPool(all);                  // 刚听过的先不听，避免连着三次同一首
  let picked = pool[0];
  try { picked = await pickSong(pool, settings); } catch (e) { /* 挑失败用第一首 */ }
  const rawLyric = await music.getLyric(picked.id);
  const lines = (music.lyricLines ? music.lyricLines(rawLyric) : []) || [];
  const comments = await music.getHotComments(picked.id, 5);
  const review = await writeReview(picked, lines, comments, settings);
  voteTaste(picked);
  recordActivity({ type: "music_review", source: "netease", songid: picked.id, title: picked.name, artist: picked.artist, album: picked.album, review, lyric_excerpt: lyricExcerpt(lines, 200), comments });
  _ctx.log("info", `听歌写乐评: ${picked.name}（${picked.artist}）${review ? " → " + review.slice(0, 40) : ""}`);
  return Object.assign({}, picked, { review, lyric: rawLyric, lyric_lines: lines, comments });
}

module.exports = {
  name: "entertainment",
  version: "1.0.0",
  requires: ["music"],
  init(ctx) { _ctx = ctx; },
  /* 可调参数：宿主收集，Momo 可自己改 */
  settings: [
    { key: "entertainment.music_review_max", label: "每天听歌写乐评次数", type: "number", default: 2, min: 1, max: 5, desc: "超过就不听了" },
    { key: "entertainment.playlist_id", label: "听歌来源歌单 id", type: "number", default: 3778678, min: 1, max: 999999999, desc: "网易云歌单 id，默认热歌榜" },
    { key: "entertainment.repeat_gap_hours", label: "刚听过的歌多久内不重听", type: "number", default: 6, min: 1, max: 72, desc: "单位小时" },
  ],
  api: { entertainment: { musicReview, loadActivities, todayCount, loadTaste, voteTaste } },
};
