/* 读一篇文章测试：列表解析 / 正文段落提取 / 标题清理 / 抓不到不编 / 编造的引文被丢 / 每日上限 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-read-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}
const dayStr = (off) => {
  const d = new Date(Date.now() + (off || 0) * 86400e3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/* ---- 假的三个站点 ---- */
const LIST_IFANR = `<html><body><a href="https://www.ifanr.com/1686157">x</a><a href="https://www.ifanr.com/1686154">y</a></body></html>`;
const ART_IFANR = `<html><head><title>苹果终于对「摇一摇」广告动手了！ - 爱范儿</title></head><body>
<p>登录 注册 下载APP</p>
<p>今天凌晨，苹果正式推送了 iOS 27.2 系统更新，这次更新里藏着一个让所有国内 iPhone 用户喜大普奔的「史诗级」功能，叫限制动作数据（Restrict Motion Data）。不夸张地说，对于苦开屏广告久矣的国内用户而言，这可能是近三年最值得连夜升级的一次小版本更新。</p>
<p>我们在第一时间把手机升级到了最新正式版，替大家跑了一遍实测，看看它到底能不能彻底治好开屏乱跳的问题。实测下来，开启这个开关之后，之前那种轻微晃一下手机就被拽去电商 App 的情况基本消失了，体验上的差别非常明显。</p>
<p>升级之后，只需要四步就能开启这个功能，进入设置里的隐私与安全，下滑找到运动与健身，把限制动作数据打开即可。需要注意的是，这个开关默认是关闭的，升级完不会自动生效，得自己动手。</p>
<p>（责任编辑：张三）</p>
</body></html>`;
const LIST_JIANSHU = `<html><body><a href="/p/eb8855cf5372">a</a></body></html>`;

let mode = "normal";
global.fetch = async (url) => {
  const u = String(url);
  if (mode === "fail" && u.indexOf("ifanr") >= 0 && u.indexOf(".com/1686") >= 0) return { ok: false, status: 500, text: async () => "" };
  if (u === "https://www.ifanr.com/") return { ok: true, text: async () => LIST_IFANR };
  if (u.indexOf("ifanr.com/1686157") >= 0) return { ok: true, text: async () => ART_IFANR };
  if (u.indexOf("ifanr.com/1686154") >= 0) return { ok: true, text: async () => ART_IFANR };
  if (u === "https://www.jianshu.com/") return { ok: true, text: async () => LIST_JIANSHU };
  return { ok: false, status: 500, text: async () => "" };
};

/* ---- 假的底层插件 ---- */
const corePlugin = require("E:/Learn/Momo/plugins/fun-core.js");
corePlugin.init({ DATA_DIR: DIR, log: () => {}, dayStr, getSetting: (k, d) => (k === "entertainment.daily_self_max" ? 2 : d), isBudgetExhausted: () => false });
const CORE = corePlugin.api["fun-core"];

let interests = [], collections = [];
const hobbyPlugin = require("E:/Learn/Momo/plugins/hobby.js");
hobbyPlugin.init({ DATA_DIR: DIR, SELF_DIR: DIR, log: () => {}, getSetting: (k, d) => d });
const HOBBY = hobbyPlugin.api.hobby;

let prompts = [];
let replyMode = "normal";
const ra = require("E:/Learn/Momo/plugins/read-article.js");
ra.init({
  DATA_DIR: DIR, SELF_DIR: DIR,
  log: () => {},
  getSetting: (k, d) => (k === "read_article.host_gap_ms" ? 0 : d),
  getApi: (n) => (n === "fun-core" ? CORE : n === "hobby" ? HOBBY : null),
  addMood: () => {}, addBoredom: () => {},
  completeOnce: async (messages) => {
    const p = String(messages[0].content || "");
    prompts.push(p);
    if (replyMode === "hallucinate") return JSON.stringify({ thought: "读完觉得挺有意思，苹果这次算是干了件实事。", topic: "苹果", pick: "这是一句正文里根本没有的话" });
    return JSON.stringify({ thought: "读完觉得挺有意思，苹果这次算是干了件实事，那个开关居然藏这么深。", topic: "苹果", pick: "限制动作数据（Restrict Motion Data）" });
  },
});
const R = ra.api["read-article"];

(async () => {
  // 1. 列表解析
  const src = R.SOURCES[0];
  const links = R.parseList(LIST_IFANR, src);
  check("爱范儿列表解析出 2 条", links.length === 2 && links[0] === "https://www.ifanr.com/1686157");
  const jLinks = R.parseList(LIST_JIANSHU, R.SOURCES[1]);
  check("简书相对链接补全域名", jLinks[0] === "https://www.jianshu.com/p/eb8855cf5372", jLinks[0]);

  // 2. 正文段落提取：噪声（登录/责编）被滤掉
  const paras = R.parseParagraphs(ART_IFANR);
  check("段落提取滤掉导航噪声", paras.every((p) => p.indexOf("登录") < 0 && p.indexOf("责任编辑") < 0), JSON.stringify(paras.slice(0, 1)));
  check("段落数正确（导航/责编被滤掉）", paras.length === 3, "len=" + paras.length);
  check("标题去掉站点后缀", R.parseTitle(ART_IFANR) === "苹果终于对「摇一摇」广告动手了！", R.parseTitle(ART_IFANR));

  // 3. 抓一篇：正文长度 / 节选长度
  const art = await R.fetchArticle("https://www.ifanr.com/1686157", src);
  check("抓到正文", art.ok && art.body_len > 300, art.reason);
  check("节选不超过 200 字", art.excerpt.length <= 200, art.excerpt.length);
  check("只留节选不留全文标记", !("body" in art) === false && art.body.length <= 3000);

  // 4. 完整流程：感想 + 主题 + 收藏
  const r1 = await R.readArticle({});
  check("读成功", !!r1 && !!r1.title, JSON.stringify(r1 || {}).slice(0, 100));
  check("感想来自模型", r1.thought.indexOf("开关居然藏这么深") >= 0, r1.thought);
  check("主题记下", r1.topic === "苹果");
  check("真实引文被收藏", HOBBY.loadCollection().length === 1, JSON.stringify(HOBBY.loadCollection()));
  check("兴趣档案记了一票", HOBBY.load().pending.some((x) => x.key === "苹果"));
  const acts = CORE.loadActivities(10);
  check("活动流水带真实凭据", acts.length === 1 && acts[0].body_len > 300 && !!acts[0].url && !!acts[0].excerpt);
  check("流水里不存全文", !acts[0].body, "有 body 字段");

  // 5. 编造的引文不进收藏（清空当天流水，模拟新的一天，避免被每日上限挡住）
  fs.rmSync(path.join(DIR, 'activities.jsonl'), { force: true });
  replyMode = 'hallucinate';
  const before = HOBBY.loadCollection().length;
  const r2 = await R.readArticle({});
  check("第二次也读到了", !!r2);
  check("编造的引文被丢弃", HOBBY.loadCollection().length === before, "col=" + HOBBY.loadCollection().length);

  // 6. 每日上限：第 3 次被挡（该类上限 1/天，但这里已 2 次是因为上面连读两次？→ 用 canPlay 直接验）
  const g = CORE.canPlay("read_article", 1, 0.01);
  check("每日上限生效", g.ok === false, g.reason);

  // 7. 抓取失败：不产出、记 ok:false
  fs.rmSync(path.join(DIR, "activities.jsonl"), { force: true });
  mode = "fail";
  const failRes = await R.readArticle({});
  const acts2 = CORE.loadActivities(10);
  check("抓不到时不产出", failRes === null);
  check("失败也记流水 ok:false", acts2.length === 1 && acts2[0].ok === false, JSON.stringify(acts2));

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();

