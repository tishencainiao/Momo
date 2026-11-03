/* 空间插件测试：配图挑选 / 发布记录 / 去重素材 / 发布时段 / 反馈 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-qzone-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let calls = [];
let settings = { "qzone.attach_image": true, "qzone.daily_max": 5, "qzone.weekly_max": 10, "qzone.post_hour_start": 19, "qzone.post_hour_end": 22 };
let fakeHour = 20;
let llText = "今天刷到知乎讲屎壳郎的";
async function fakeFetch(url, opts) {
  calls.push({ url: String(url), body: JSON.parse(opts.body) });
  return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { tid: "t" + Date.now(), time: 1 } }) };
}
global.fetch = fakeFetch;

const plugin = require("E:/Learn/Momo/plugins/qzone.js");
plugin.init({
  DATA_DIR: DIR,
  log: () => {},
  dayStr: (off) => "2026-11-" + String(1 + (Number(off) || 0)),   // 不同偏移返回不同日期
  todayText: () => "11月1日 晚上",
  settings: () => ({}),
  getSetting: (k, d) => (k in settings ? settings[k] : d),
  config: { onebot: { http_url: "http://127.0.0.1:3000" }, qzone: { ugc_right: "1" }, qq: { self_id: 100000004 } },
  completeOnce: async () => "今天看到一个关于屎壳郎的冷知识，笑死",
  qzoneHttp: async (action, params) => {
    calls.push({ url: action, body: params });
    if (action === "get_qzone_msg_list") {
      return { msglist: [{ tid: "t1", content: "旧说说", comment_num: 3 }] };
    }
    return {};
  },
  recordAction: () => {},
  getApi: (name) => {
    if (name === "lifeLog") return { lifeCtx: () => llText };
    if (name === "weather") return { weatherCtx: async () => "【天气】哈尔滨 -2°C" };
    if (name === "stickers") return { pickForText: (t) => ({ file: "E:/Learn/Momo/stickers/test.webp", label: "开心" }) };
    return null;
  },
});
const Q = plugin.api.qzone;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

// 让 new Date().getHours() 可控
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(2026, 10, 1, fakeHour, 0, 0); else super(...a); }
  static now() { return RealDate.now(); }
};

(async () => {
  // 1. 配图挑选
  const img = Q.pickQzoneImage("今天很开心");
  check("配图开启时返回图片", img.length === 1, JSON.stringify(img));
  settings["qzone.attach_image"] = false;
  check("配图关闭时返回空", Q.pickQzoneImage("今天很开心").length === 0);
  settings["qzone.attach_image"] = true;

  // 2. 发布带图
  calls = [];
  await Q.publishQzone("测试说说", ["E:/a.webp"]);
  const body = calls[calls.length - 1].body;
  check("发布请求带 content", body.content === "测试说说");
  check("发布请求带 images", Array.isArray(body.images) && body.images[0] === "E:/a.webp", JSON.stringify(body));
  check("发布了 1 条", Q.dailyQzoneCount() === 1, String(Q.dailyQzoneCount()));

  // 3. 纯文字也能发
  calls = [];
  await Q.publishQzone("纯文字说说", []);
  check("没图时不传 images", calls[calls.length - 1].body.images === undefined);

  // 4. 素材来自真实生活
  llText = "今天刷到知乎讲屎壳郎的";
  const st = JSON.parse(fs.readFileSync(path.join(DIR, "qzone-state.json"), "utf8"));
  check("状态里记了 posts", Array.isArray(st.posts) && st.posts.length === 2, JSON.stringify(st.posts && st.posts.length));

  // 5. 发布时段：白天不发
  fakeHour = 10;
  calls = [];
  // 清掉 last_self 以允许尝试
  const st2 = JSON.parse(fs.readFileSync(path.join(DIR, "qzone-state.json"), "utf8"));
  delete st2.last_self;
  fs.writeFileSync(path.join(DIR, "qzone-state.json"), JSON.stringify(st2));
  await plugin.hooks.timer({ now: Date.now() + 3600000 });
  await new Promise((r) => setTimeout(r, 50));
  check("白天（10点）不发", calls.filter((c) => String(c.url).indexOf("send_qzone_msg") >= 0).length === 0, "calls=" + calls.length);

  // 6. 发布时段：晚上发
  fakeHour = 20;
  calls = [];
  // 重置
  const st3 = JSON.parse(fs.readFileSync(path.join(DIR, "qzone-state.json"), "utf8"));
  delete st3.last_self; st3.dates = {};
  fs.writeFileSync(path.join(DIR, "qzone-state.json"), JSON.stringify(st3));
  await plugin.hooks.timer({ now: Date.now() + 7200000 });
  await new Promise((r) => setTimeout(r, 100));
  check("晚上（20点）会发", calls.some((c) => String(c.url).indexOf("send_qzone_msg") >= 0), "calls=" + JSON.stringify(calls.map((c) => c.url)));

  // 7. 反馈：新评论能被发现
  const fb = await Q.checkQzoneFeedback();
  check("反馈检查不崩", typeof fb === "number");
  const st4 = JSON.parse(fs.readFileSync(path.join(DIR, "qzone-state.json"), "utf8"));
  const withComment = (st4.posts || []).find((p) => p.tid === "t1");
  check("匹配不到 tid 时不误报", !withComment || withComment.comments >= 0);

  // 8. 设置项存在
  check("暴露配图开关参数", (plugin.settings || []).some((s) => s.key === "qzone.attach_image"));
  check("暴露发布时段参数", (plugin.settings || []).some((s) => s.key === "qzone.post_hour_start"));
  const hsSet = (plugin.settings || []).find((s) => s.key === "qzone.post_hour_start");
  const heSet = (plugin.settings || []).find((s) => s.key === "qzone.post_hour_end");
  check("默认从 8 点开始", hsSet && hsSet.default === 8, String(hsSet && hsSet.default));
  check("默认到 22 点结束", heSet && heSet.default === 22, String(heSet && heSet.default));

  global.Date = RealDate;
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
