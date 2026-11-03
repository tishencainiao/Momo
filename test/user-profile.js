/* 用户画像插件测试：提炼合并 / 注入文本 / 权限 / 重置 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-profile-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let settings = { "profile.auto_extract": true, "profile.every_n": 15 };
let llmOut = '{"nickname":"阿远","interests":["打游戏","吃火锅"],"personality":["细心"],"mood":"有点累","preferences":["熬夜"]}';
let sessionMsgs = [];
for (let i = 0; i < 12; i++) sessionMsgs.push({ role: i % 2 ? "assistant" : "user", content: "测试消息 " + i });

const plugin = require("E:/Learn/Momo/plugins/user-profile.js");
plugin.init({
  DATA_DIR: DIR,
  log: () => {},
  loadSession: () => sessionMsgs,
  settings: () => ({}),
  getSetting: (k, d) => (k in settings ? settings[k] : d),
  completeOnce: async () => llmOut,
  isMaster: (u) => Number(u) === 1000,
  resolveTargetId: (n) => (String(n) === "阿远" ? 2000 : null),
});
const P = plugin.api.userProfile;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

(async () => {
  // 1. 没有画像时
  check("空画像返回空串", P.profileCtx(2000) === "");
  check("空画像的文本提示", P.profileText(2000).indexOf("还没记下") >= 0);

  // 2. 提炼
  const p = await P.extract(2000);
  check("提炼成功", !!p, JSON.stringify(p));
  check("记下了名字", p && p.nickname === "阿远");
  check("记下了兴趣", p && Array.isArray(p.interests) && p.interests.indexOf("吃火锅") >= 0);
  check("记下了性格", p && p.personality.indexOf("细心") >= 0);
  check("记下了状态", p && p.mood === "有点累");

  // 3. 注入文本
  const ctx = P.profileCtx(2000);
  check("注入文本有标题", ctx.indexOf("【你对这个人的了解") >= 0, ctx.slice(0, 40));
  check("注入文本含称呼", ctx.indexOf("阿远") >= 0);
  check("注入文本含兴趣", ctx.indexOf("打游戏") >= 0);

  // 4. 合并（第二次提炼只给新兴趣，旧的保留）
  llmOut = '{"interests":["爬山"],"mood":"挺开心的"}';
  const p2 = await P.extract(2000);
  check("合并保留旧兴趣", p2.interests.indexOf("吃火锅") >= 0 && p2.interests.indexOf("爬山") >= 0, JSON.stringify(p2.interests));
  check("合并更新状态", p2.mood === "挺开心的");
  check("合并保留名字", p2.nickname === "阿远");

  // 5. 数量上限
  llmOut = '{"interests":["a","b","c","d","e","f","g"]}';
  const p3 = await P.extract(2000);
  check("兴趣最多 5 个", p3.interests.length <= 5, String(p3.interests.length));

  // 6. 不编造（空对象不覆盖已有）
  llmOut = '{}';
  const p4 = await P.extract(2000);
  check("空结果不覆盖", p4.nickname === "阿远");

  // 7. 关掉自动提炼
  settings["profile.auto_extract"] = false;
  const off = await P.extract(2000);
  check("关闭后不提炼", off === null);
  settings["profile.auto_extract"] = true;

  // 8. 权限
  const tool = (plugin.tools || []).find((t) => t.def.function.name === "profile_view");
  check("暴露 profile_view", !!tool);
  const own = tool.handler({}, { userId: 2000 });
  check("本人能看自己的", own.indexOf("阿远") >= 0, own.slice(0, 40));
  const other = tool.handler({ target: "阿远" }, { userId: 2000 });
  check("非主人看别人被拒", other.indexOf("只能看关于你自己") >= 0, other);
  const asMaster = tool.handler({ target: "阿远" }, { userId: 1000 });
  check("主人能查别人", asMaster.indexOf("只能看关于你自己") < 0);

  // 9. 重置
  P.resetProfile(2000);
  check("重置后为空", P.profileCtx(2000) === "");

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
