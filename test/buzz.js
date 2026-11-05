/* 吃瓜测试：热搜解析 / 只写看法 / 流水不存榜单原文 / 抓不到不编 / 每日上限 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-buzz-test-" + Date.now());
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

const BOARD = {
  success: true,
  data: { cards: [{ component: "tabTextList", content: [{ content: [
    { isTop: true, word: "相约四叶草 共享中国机遇", url: "https://m.baidu.com/s?word=A" },
    { isTop: false, index: 1, word: "2027年假期安排出炉 春节连休9天", url: "https://m.baidu.com/s?word=B" },
    { isTop: false, index: 2, word: "某明星离婚传闻", url: "https://m.baidu.com/s?word=C" },
  ] }] }] },
};

let failBoard = false;
global.fetch = async () => {
  if (failBoard) return { ok: false, status: 503, json: async () => ({}) };
  return { ok: true, json: async () => BOARD };
};

const corePlugin = require("E:/Learn/Momo/plugins/fun-core.js");
corePlugin.init({ DATA_DIR: DIR, log: () => {}, dayStr, getSetting: (k, d) => (k === "entertainment.daily_self_max" ? 2 : d), isBudgetExhausted: () => false });
const CORE = corePlugin.api["fun-core"];
const hobbyPlugin = require("E:/Learn/Momo/plugins/hobby.js");
hobbyPlugin.init({ DATA_DIR: DIR, SELF_DIR: DIR, log: () => {}, getSetting: (k, d) => d });
const HOBBY = hobbyPlugin.api.hobby;

let prompts = [];
const bz = require("E:/Learn/Momo/plugins/buzz.js");
bz.init({
  DATA_DIR: DIR, log: () => {},
  getSetting: (k, d) => d,
  getApi: (n) => (n === "fun-core" ? CORE : n === "hobby" ? HOBBY : null),
  addBoredom: () => {}, addMood: () => {},
  completeOnce: async (messages) => {
    const p = String(messages[0].content || "");
    prompts.push(p);
    if (p.indexOf("挑一条") >= 0) return "2";                    // 挑第二条
    return JSON.stringify({ view: "又是放假的事，我看了眼日历，感觉离放假还早得很。", topic: "假期" });
  },
});
const B = bz.api.buzz;

(async () => {
  // 1. 榜单解析
  const list = await B.fetchBoard();
  check("解析出 3 条热搜", list.length === 3, "len=" + list.length);
  check("榜位从 1 开始", list[0].rank === 1 && list[1].rank === 2);
  check("标题取到", list[1].word.indexOf("2027年假期") >= 0);

  // 2. 挑一条（模型挑第 2 条）
  const picked = await B.pickTopic(list, {});
  check("按模型选择挑了第 2 条", picked.rank === 2, picked.word);

  // 3. 写看法：提示词明确"只看标题、不许编细节"
  const v = await B.writeView(picked, {});
  check("看法生成", v.view.length > 5 && v.topic === "假期", JSON.stringify(v));
  check("提示词有'只看了标题'约束", prompts.some((p) => p.indexOf("只看了标题") >= 0));
  check("提示词禁止编造细节", prompts.some((p) => p.indexOf("不许编造事件细节") >= 0));

  // 4. 完整流程
  const rec = await B.readBuzz({});
  check("吃瓜成功", !!rec && rec.rank === 2);
  check("记录只存她的看法", !!rec.view && !rec.content && !rec.desc, JSON.stringify(rec).slice(0, 80));
  const acts = CORE.loadActivities(10);
  check("活动流水 ok:true", acts.length === 1 && acts[0].ok === true && acts[0].type === "read_buzz");
  check("流水不存整张榜单", JSON.stringify(acts[0]).length < 600, "len=" + JSON.stringify(acts[0]).length);
  check("兴趣档案投票", HOBBY.load().pending.some((x) => x.key === "假期"));

  // 5. 每日上限（该类 1 次）
  const r2 = await B.readBuzz({});
  check("当天第二次被挡", r2 === null);

  // 6. 抓不到时不编
  fs.rmSync(path.join(DIR, "activities.jsonl"), { force: true });
  failBoard = true;
  const r3 = await B.readBuzz({});
  check("抓不到返回 null", r3 === null);
  const acts2 = CORE.loadActivities(10);
  check("失败记 ok:false", acts2.length === 1 && acts2[0].ok === false, JSON.stringify(acts2));

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
