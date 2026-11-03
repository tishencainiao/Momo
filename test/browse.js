/* 刷视频插件测试：多源汇总 / 热评 / 自主选择 / 感想 / 强情绪记忆 / 预算门禁 / 每日上限 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-browse-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

global.fetch = async (url) => {
  const u = String(url);
  if (u.indexOf("popular") >= 0) {
    return { ok: true, json: async () => ({ code: 0, data: { list: [
      { title: "视频A", desc: "描述A", owner: { name: "UP1" }, short_link_v2: "https://b23.tv/a", aid: 111 },
      { title: "视频B", desc: "描述B", owner: { name: "UP2" }, short_link_v2: "https://b23.tv/b", aid: 222 },
    ] } }) };
  }
  if (u.indexOf("x/v2/reply") >= 0) {
    return { ok: true, json: async () => ({ code: 0, data: { replies: [
      { content: { message: "评论一" } }, { content: { message: "评论二" } },
    ] } }) };
  }
  if (u.indexOf("zhihu") >= 0) {
    return { ok: true, json: async () => ({ stories: [
      { title: "知乎文章一", hint: "摘要一", url: "https://zhihu.com/1" },
      { title: "知乎文章二", hint: "摘要二", url: "https://zhihu.com/2" },
    ] }) };
  }
  if (u.indexOf("music.163") >= 0) {
    return { ok: true, json: async () => ({ result: { tracks: [
      { name: "歌一", artists: [{ name: "歌手A" }] },
      { name: "歌二", artists: [{ name: "歌手B" }] },
    ] } }) };
  }
  return { ok: false, status: 500, json: async () => ({}) };
};

const thoughts = ["太燃了吧，看得我停不下来！", "这是个普通的技术讲解视频。"];
let thoughtIdx = 0;
let budgetOut = false;
let identityWrites = [];

const plugin = require("E:/Learn/Momo/plugins/browse.js");
plugin.init({
  DATA_DIR: DIR,
  log: () => {},
  isBudgetExhausted: () => budgetOut,
  completeOnce: async (messages) => {
    const p = String((messages && messages[0] && messages[0].content) || "");
    if (p.indexOf("挑一条") >= 0) return "2";
    return thoughts[Math.min(thoughtIdx++, thoughts.length - 1)];
  },
  getApi: (name) => (name === "evolution" ? { addIdentityItem: (t) => { identityWrites.push(t); return true; } } : null),
});
const B = plugin.api.browse;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

(async () => {
  // 1. 多源汇总
  const all = await B.gather();
  const sources = Array.from(new Set(all.map((x) => x.source)));
  check("汇总含 B站", sources.indexOf("B站") >= 0, sources.join(","));
  check("汇总含 知乎", sources.indexOf("知乎") >= 0, sources.join(","));
  check("汇总含 音乐", sources.indexOf("音乐") >= 0, sources.join(","));
  check("总数 = 2+2+2", all.length === 6, "共 " + all.length);
  check("知乎带来源字段", all.find((x) => x.source === "知乎").title === "知乎文章一");
  check("音乐带歌手", all.find((x) => x.source === "音乐").desc === "歌手A");

  // 2. 单源抓取
  const hot = await B.fetchHot(2);
  check("B站单源可用", hot.length === 2 && hot[1].aid === 222);
  const zh = await B.fetchZhihu(2);
  check("知乎单源可用", zh.length === 2);
  const mu = await B.fetchMusic(2);
  check("音乐单源可用", mu.length === 2);

  // 3. 刷一次：挑第 2 条（B站视频B），强情绪 → 写记忆
  const p1 = await B.browse({});
  check("刷到了", !!p1);
  check("挑中第 2 条（B站视频B）", p1.title === "视频B", p1.title);
  check("带来源", p1.source === "B站", p1.source);
  check("带评论", p1.comments.length === 2);
  check("强情绪 → 写成长记忆", p1.memorized === true);
  check("identity 收到 1 条", identityWrites.length === 1);
  const h1 = B.loadHistory(10)[0];
  check("记录含来源", h1.source === "B站");
  check("记录含感想", h1.thought.indexOf("太燃") >= 0);

  // 4. 平淡感想 → 不写
  const p2 = await B.browse({});
  check("平淡感想不写记忆", p2.memorized === false);

  // 5. 预算耗尽
  budgetOut = true;
  check("预算耗尽时不刷", (await B.browse({})) === null);
  budgetOut = false;

  // 6. 每日上限
  await B.browse({});
  check("第 4 次被挡住", (await B.browse({})) === null, "当前 " + B.todayCount() + " 次");

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
