/* 插件：网易云音乐（纯数据封装，零副作用）
 * 只做「取数据」，不写盘、不调 LLM、不发消息、不改状态。
 * 接口（本机实测 200，无需登录，Referer 固定 music.163.com 即可）：
 *   - 搜索歌曲  GET https://music.163.com/api/search/get/web?s=<关键词>&type=1&limit=10
 *   - 歌词      GET https://music.163.com/api/song/lyric?id=<id>&lv=-1&kv=-1&tv=-1
 *   - 热评      GET https://music.163.com/api/v1/resource/comments/R_SO_4_<id>?limit=20&offset=0
 *   - 歌单      GET https://music.163.com/api/playlist/detail?id=<id>（3778678=热歌榜）
 * 供 entertainment 插件（听歌写乐评）调用。 */
let _ctx = null;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function getJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Referer: "https://music.163.com/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

/* 搜索歌曲 → [{id,name,artist,album}]，失败返回 [] */
async function searchSong(keyword, limit) {
  try {
    const q = encodeURIComponent(String(keyword || "").trim());
    if (!q) return [];
    const j = await getJson(`https://music.163.com/api/search/get/web?s=${q}&type=1&limit=${limit || 10}`);
    const songs = (j && j.result && Array.isArray(j.result.songs)) ? j.result.songs : [];
    return songs.map((s) => ({
      id: Number(s.id) || 0,
      name: String(s.name || "").slice(0, 60),
      artist: (Array.isArray(s.artists) ? s.artists.map((a) => a.name).join("/") : "").slice(0, 80),
      album: String((s.album && s.album.name) || "").slice(0, 60),
    })).filter((s) => s.id);
  } catch (e) { _ctx.log("warn", "网易云搜索失败: " + String(e.message).slice(0, 100)); return []; }
}

/* 歌词清洗：剥掉 [mm:ss.xxx] 时间轴 + 作词/作曲/制作人这类制作信息行，只留真正能唱的句子
 * 坑：网易云歌词每一行都带时间轴，若直接按「行首是不是 [」过滤会把整首歌词滤空（v1.61 修） */
const LYRIC_META_RE = /^(作词|作曲|编曲|制作人|制作|和声|混音|母带|录音|监制|吉他|贝斯|鼓|键盘|弦乐|合声|出品|发行|统筹|企划|封面|原唱|翻唱|词|曲|OP|SP|Produced|Written|Composed|Arranged|Mixed|Mastered)\s*[:：]/i;
function lyricLines(lrc) {
  const out = [];
  for (const raw of String(lrc || "").split("\n")) {
    const line = raw.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, "").trim();
    if (!line || line.length < 2) continue;
    if (LYRIC_META_RE.test(line)) continue;
    out.push(line);
  }
  return out;
}

/* 歌词（LRC 原文，保留时间轴，让乐评有真实素材）→ 字符串；无词/失败返回 "" */
async function getLyric(id) {
  try {
    if (!id) return "";
    const j = await getJson(`https://music.163.com/api/song/lyric?id=${id}&lv=-1&kv=-1&tv=-1`);
    if (!j) return "";
    if (j.nolyric || j.uncollected) return "";
    const lrc = (j.lrc && j.lrc.lyric) || (j.klyric && j.klyric.lyric) || "";
    return String(lrc).slice(0, 2000);
  } catch (e) { _ctx.log("warn", "网易云歌词失败: " + String(e.message).slice(0, 100)); return ""; }
}

/* 热评 → 字符串数组（点赞高的在前）；无评/失败返回 [] */
async function getHotComments(id, limit) {
  try {
    if (!id) return [];
    const j = await getJson(`https://music.163.com/api/v1/resource/comments/R_SO_4_${id}?limit=20&offset=0`);
    const list = (j && (j.hotComments || (j.data && j.data.hotComments))) || [];
    return list.slice(0, limit || 5).map((c) => String((c && c.content) || "").slice(0, 120)).filter(Boolean);
  } catch (e) { _ctx.log("warn", "网易云热评失败: " + String(e.message).slice(0, 100)); return []; }
}

/* 歌单/排行榜 → [{id,name,artist,album}]；失败返回 []
 * 实测这个接口偶发 fetch failed（瞬断），所以重试一次再放弃（v1.61 修） */
async function getPlaylist(id, limit) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const j = await getJson(`https://music.163.com/api/playlist/detail?id=${id || 3778678}`);
      const tracks = (j && j.result && Array.isArray(j.result.tracks)) ? j.result.tracks : [];
      return tracks.slice(0, limit || 20).map((t) => ({
        id: Number(t.id) || 0,
        name: String(t.name || "").slice(0, 60),
        artist: (Array.isArray(t.artists) ? t.artists.map((a) => a.name).join("/") : "").slice(0, 80),
        album: String((t.album && t.album.name) || "").slice(0, 60),
      })).filter((t) => t.id);
    } catch (e) {
      if (attempt === 2) { _ctx.log("warn", "网易云歌单失败: " + String(e.message).slice(0, 100)); return []; }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  return [];
}

module.exports = {
  name: "music",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  api: { music: { searchSong, getLyric, getHotComments, getPlaylist, lyricLines } },
};
