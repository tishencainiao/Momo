/* 娱乐插件测试：网易云封装（搜索/歌词清洗/热评/歌单重试）+ 听歌写乐评
 * （挑歌 / 乐评只引用真实内容 / 品味去重+歌名 / 刚听过的歌不重听 / 预算 / 每日上限） */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-ent-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let playlistFailOnce = new Set();   // 用于验证「歌单接口瞬断要重试」
/* 模拟网易云接口 */
global.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf("search/get") >= 0) {
    return { ok: true, json: async () => ({ result: { songs: [
      { id: 1001, name: "搜到的一首歌", artists: [{ name: "歌手X" }], album: { name: "专辑X" } },
      { id: 1002, name: "搜到的第二首", artists: [{ name: "歌手Y" }], album: { name: "专辑Y" } },
    ] } }) };
  }
  if (u.indexOf("song/lyric") >= 0) {
    if (u.indexOf("id=2001") >= 0) return { ok: true, json: async () => ({ nolyric: true }) };
    return { ok: true, json: async () => ({ lrc: { lyric: "[00:00.000] 作词 : 某某\n[00:01.00]第一句歌词\n[00:02.00]第二句歌词\n" } }) };
  }
  if (u.indexOf("resource/comments") >= 0) {
    return { ok: true, json: async () => ({ hotComments: [
      { content: "评论一：听哭了" }, { content: "评论二：单曲循环" },
    ] }) };
  }
  if (u.indexOf("playlist/detail") >= 0) {
    if (u.indexOf("id=9999") >= 0 && !playlistFailOnce.has("done")) {
      playlistFailOnce.add("done");
      return { ok: false, status: 500, json: async () => ({}) };   // 第一次瞬断
    }
    return { ok: true, json: async () => ({ result: { tracks: [
      { id: 1001, name: "歌一", artists: [{ name: "歌手A" }], album: { name: "专辑A" } },
      { id: 2001, name: "歌二", artists: [{ name: "歌手B" }], album: { name: "专辑B" } },
      { id: 3001, name: "歌三", artists: [{ name: "歌手C" }], album: { name: "专辑C" } },
    ] } }) };
  }
  return { ok: false, status: 500, json: async () => ({}) };
};

/* 音乐插件：需要 _ctx.log */
const musicPlugin = require("E:/Learn/Momo/plugins/music.js");
musicPlugin.init({ log: () => {} });
const M = musicPlugin.api.music;

let reviewCalls = [];
let budgetOut = false;
const entPlugin = require("E:/Learn/Momo/plugins/entertainment.js");
entPlugin.init({
  DATA_DIR: DIR,
  log: () => {},
  isBudgetExhausted: () => budgetOut,
  getSetting: (k, d) => d,
  getApi: (name) => (name === "music" ? M : null),
  completeOnce: async (messages) => {
    const p = String((messages && messages[0] && messages[0].content) || "");
    reviewCalls.push(p);
    if (p.indexOf("挑一首") >= 0) return "2";            // 挑第二首
    return "这首歌很戳我，评论那句听哭了说得真对。";      // 乐评
  },
});
const E = entPlugin.api.entertainment;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

(async () => {
  // 1. 网易云封装：搜索
  const sr = await M.searchSong("测试", 10);
  check("搜索返回 2 首", sr.length === 2);
  check("搜索带歌手+专辑", sr[0].artist === "歌手X" && sr[0].album === "专辑X");

  // 2. 歌词：有词 / 无词 / 清洗
  const lyric = await M.getLyric(1001);
  check("歌词拿到 LRC", lyric.indexOf("第一句歌词") >= 0);
  check("无词返回空", (await M.getLyric(2001)) === "");
  const lines = M.lyricLines(lyric);
  check("剥掉时间轴", lines.length === 2, JSON.stringify(lines));
  check("剥掉作词信息行", lines[0] === "第一句歌词", lines[0]);
  check("空歌词清洗为空", M.lyricLines("").length === 0);

  // 3. 热评
  const cm = await M.getHotComments(1001, 5);
  check("热评 2 条", cm.length === 2 && cm[0] === "评论一：听哭了");

  // 4. 歌单：正常 + 瞬断重试
  const pl = await M.getPlaylist(3778678, 10);
  check("歌单 3 首", pl.length === 3 && pl[0].id === 1001);
  const plRetry = await M.getPlaylist(9999, 10);
  check("歌单瞬断后重试成功", plRetry.length === 3, "len=" + plRetry.length);

  // 5. 听一次歌：挑第二首（无歌词）→ 乐评仍引用真实热评
  const r = await E.musicReview({});
  check("听歌返回结果", !!r);
  check("挑中第二首（歌二，id=2001）", r.id === 2001, "id=" + r.id);
  check("乐评引用真实热评", r.review.indexOf("听哭") >= 0, r.review);
  check("无歌词时不编歌词", r.lyric === "");
  const actPrompt = reviewCalls.filter((p) => p.indexOf("翻了一首歌") >= 0).pop() || "";
  check("乐评提示词不谎称听到声音", actPrompt.indexOf("听不到声音") >= 0);
  check("无歌词时提示词标明没拿到", actPrompt.indexOf("（没拿到歌词）") >= 0);
  // 活动记录
  const acts = E.loadActivities(10);
  check("活动记录 1 条带 songid", acts.length === 1 && acts[0].songid === 2001);
  check("活动带来源 netease", acts[0].source === "netease");
  // 品味
  const t1 = E.loadTaste();
  check("品味记了 1 首", t1.music.length === 1 && t1.music[0].plays === 1);
  check("品味里有歌名", t1.music[0].title === "歌二", JSON.stringify(t1.music[0]));

  // 6. 再听一次：刚听过的（2001）不再挑 → 换一首 → 品味 2 首
  const r2 = await E.musicReview({});
  check("不重复挑刚听过的歌", r2 && r2.id !== 2001, "id=" + (r2 && r2.id));
  const t2 = E.loadTaste();
  check("新歌另立条目", t2.music.length === 2, "music=" + t2.music.length);

  // 7. 品味去重：同一首再投票只累加 plays
  E.voteTaste({ id: 1001, name: "歌一", artist: "歌手A" });
  E.voteTaste({ id: 1001, name: "歌一", artist: "歌手A" });
  const t3 = E.loadTaste();
  const hit = t3.music.find((m) => String(m.id) === "1001");
  check("同曲不新建条目、plays 累加", t3.music.length === 3 && hit && hit.plays === 2, JSON.stringify(hit));

  // 8. 每日上限（默认 2 次）
  check("超过每日上限不再听", (await E.musicReview({})) === null, "今日 " + E.todayCount() + " 次");
  check("再次调用仍被挡", (await E.musicReview({})) === null);

  // 9. 预算耗尽
  budgetOut = true;
  check("预算耗尽时不听", (await E.musicReview({})) === null);
  budgetOut = false;

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
