/* 兴趣档案测试：证据升级（3 次跨 2 天）/ 衰减降级 / 只注入前 2 个 / 收藏夹必须能在原文里找到 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-hobby-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

let settings = {};
const plugin = require("E:/Learn/Momo/plugins/hobby.js");
plugin.init({
  DATA_DIR: DIR,
  SELF_DIR: DIR,
  log: () => {},
  getSetting: (k, d) => (settings[k] != null ? settings[k] : d),
});
const H = plugin.api.hobby;

/* 允许测试注入"旧日期"，用来模拟跨天 */
function backdate(item, daysAgo) {
  const d = H.load();
  const all = d.pending.concat(d.interests);
  const x = all.find((i) => i.key === item.key);
  if (!x) return;
  x.last_seen = Date.now() - daysAgo * 86400e3;
  if (Array.isArray(x.days)) x.days = x.days.map((day) => {
    const t = new Date(day + "T00:00:00").getTime() - daysAgo * 86400e3;
    const dd = new Date(t);
    return `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, "0")}-${String(dd.getDate()).padStart(2, "0")}`;
  });
  H.save(d);
}

(async () => {
  check("初始无爱好", H.hobbyText() === "");

  // 1 次证据 → 只是 pending，不进上下文
  H.vote("AI", "read", { source: "爱范儿", title: "t1" });
  let d = H.load();
  check("一次只算 pending", d.pending.length === 1 && d.interests.length === 0);
  check("pending 不注入上下文", H.hobbyText() === "");

  // 第 2 次证据（同一天）→ 仍不升（跨天不够）
  H.vote("AI", "read", { source: "简书", title: "t2" });
  d = H.load();
  check("同一天 2 次还不升", d.interests.length === 0 && d.pending[0].count === 2);

  // 把日期往回拨一天，再第 3 次 → 升 hobby
  backdate({ key: "AI" }, 1);
  H.vote("AI", "read", { source: "中新网", title: "t3" });
  d = H.load();
  check("3 次 + 跨 2 天 → 升为爱好", d.interests.length === 1 && d.interests[0].level === "hobby", JSON.stringify(d.interests));
  check("证据都留着", d.interests[0].evidence.length === 3);
  const ctx = H.hobbyText(2);
  check("爱好注入上下文", ctx.indexOf("AI") >= 0, ctx);

  // 只注入前 2 个
  H.vote("科技", "read", {});
  check("第二个主题还在 pending（1 次）", H.load().pending.some((x) => x.key === "科技"));

  // 衰减：30 天没新证据 → 信心下降
  backdate({ key: "AI" }, 31);
  const before = H.load().interests[0].confidence;
  H.decay();
  const after = H.load().interests[0].confidence;
  check("30 天后信心下降", after < before, `${before} → ${after}`);

  // 60 天 → 降回 pending
  backdate({ key: "AI" }, 61);
  H.decay();
  d = H.load();
  check("60 天降回 pending", d.interests.length === 0 && d.pending.some((x) => x.key === "AI"));

  // 收藏夹：引文必须在原文里
  const body = "苹果今天推送了 iOS 27.2，里面藏着一个限制动作数据的开关。";
  check("能收藏真实原文", !!H.collect("里面藏着一个限制动作数据的开关", "https://x.test/1", body, "read"));
  check("编造的引文被丢弃", H.collect("苹果明年要发布新手机", "https://x.test/1", body, "read") === null);
  check("重复收藏去重", H.collect("里面藏着一个限制动作数据的开关", "https://x.test/1", body, "read") === null);
  const col = H.loadCollection();
  check("收藏带来源网址", col.length === 1 && col[0].url === "https://x.test/1");

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
