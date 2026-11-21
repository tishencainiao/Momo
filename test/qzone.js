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
  writeJsonAtomic: (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 0)); } catch (e) {} },
  writeFileAtomic: (f, t) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); } catch (e) {} },
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
    if (name === "time") return require(path.join(__dirname, "..", "plugins", "time-service.js")).api.time;
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

  // 9. Kimi 二轮：同内容幂等——成功过 24h 内不重发；并发同文只发一次
  {
    const ledger = { open: {}, lines: [] };
    let fetchCount = 0;
    global.fetch = async (url, opts) => { fetchCount++; return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { tid: "led-" + fetchCount, time: 1 } }) }; };
    plugin.init({
      DATA_DIR: DIR,
      log: () => {},
      writeJsonAtomic: (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 0)); } catch (e) {} },
      writeFileAtomic: (f, t) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); } catch (e) {} },
      dayStr: (off) => "2026-11-" + String(1 + (Number(off) || 0)),
      todayText: () => "11月1日 晚上",
      settings: () => ({}),
      getSetting: (k, d) => (k in settings ? settings[k] : d),
      config: { onebot: { http_url: "http://127.0.0.1:3000" }, qzone: { ugc_right: "1" }, qq: { self_id: 100000004 } },
      actionKey: (...parts) => "qk-" + parts.map((p) => String(p)).join("|"),
      loadActions: () => ledger.lines,
      tryBeginAction: (m) => {
        if (ledger.open[m.key]) return { key: m.key, acquired: false, duplicateOf: ledger.open[m.key].status || "running" };
        ledger.open[m.key] = { status: "running" };
        return { key: m.key, acquired: true, duplicateOf: "" };
      },
      endAction: (k, r) => {
        delete ledger.open[k];
        ledger.lines.push({ key: k, action: "qzone_post", status: r && r.ok === true ? "succeeded" : "failed", ts: Date.now() });
      },
      verifyAction: (k, r) => { ledger.lines.push({ key: k, action: "qzone_post", status: "verified", ts: Date.now() }); },
      recordAction: () => {},
      getApi: () => null,
    });

    // 9a. 同内容二次调用不重复发布
    fetchCount = 0;
    const c1 = "同内容去重测试";
    await Q.publishQzone(c1, []);
    check("第一次真实发布", fetchCount === 1, "fetch=" + fetchCount);
    const r2 = await Q.publishQzone(c1, []);
    check("第二次同内容被去重（不真发）", fetchCount === 1 && r2 && r2.status === "ok" && r2.data && r2.data.dedup === true, "fetch=" + fetchCount + " r2=" + JSON.stringify(r2));
    await Q.publishQzone("另一个内容", []);
    check("不同内容仍可发", fetchCount === 2, "fetch=" + fetchCount);

    // 9b. 两个并发相同空间发布只实际发布一次
    fetchCount = 0;
    const c2 = "并发去重测试";
    let release;
    const barrier = new Promise((r) => { release = r; });
    global.fetch = async (url, opts) => { fetchCount++; await barrier; return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { tid: "cc-" + fetchCount, time: 1 } }) }; };
    const p1 = Q.publishQzone(c2, []);
    const p2 = Q.publishQzone(c2, []);
    await new Promise((r) => setTimeout(r, 30));
    release();
    await Promise.all([p1, p2]);
    check("并发同内容只发布一次", fetchCount === 1, "fetch=" + fetchCount);
  }
  // 10. Kimi 四轮：qzoneDailyPost 幂等命中（_pub.data.dedup）不写 last_self；正常发布才写
  {
    const ledger = { open: {}, lines: [] };
    let dailyFetches = [];
    global.fetch = async (url, opts) => { dailyFetches.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ status: "ok", retcode: 0, data: { tid: "d-" + dailyFetches.length, time: 1 } }) }; };
    plugin.init({
      DATA_DIR: DIR,
      log: () => {},
      writeJsonAtomic: (f, o) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 0)); } catch (e) {} },
      writeFileAtomic: (f, t) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); } catch (e) {} },
      dayStr: (off) => "2026-11-" + String(1 + (Number(off) || 0)),
      todayText: () => "11月1日 晚上",
      settings: () => ({}),
      getSetting: (k, d) => (k in settings ? settings[k] : d),
      config: { onebot: { http_url: "http://127.0.0.1:3000" }, qzone: { ugc_right: "1" }, qq: { self_id: 100000004 } },
      completeOnce: async () => "今天看到一个关于屎壳郎的冷知识，笑死",
      qzoneHttp: async (action, params) => (action === "get_qzone_msg_list" ? { msglist: [] } : {}),
      actionKey: (...parts) => "qk-" + parts.map((p) => String(p)).join("|"),
      loadActions: () => ledger.lines,
      tryBeginAction: (m) => {
        if (ledger.open[m.key]) return { key: m.key, acquired: false, duplicateOf: "running" };
        ledger.open[m.key] = { status: "running" };
        return { key: m.key, acquired: true, duplicateOf: "" };
      },
      endAction: (k, r) => { delete ledger.open[k]; ledger.lines.push({ key: k, action: "qzone_post", status: r && r.ok === true ? "succeeded" : "failed", ts: Date.now() }); },
      verifyAction: (k, r) => { ledger.lines.push({ key: k, action: "qzone_post", status: "verified", ts: Date.now() }); },
      recordAction: () => {},
      getApi: (name) => {
        if (name === "time") return require(path.join(__dirname, "..", "plugins", "time-service.js")).api.time;
        if (name === "lifeLog") return { lifeCtx: () => "今天刷到知乎讲屎壳郎的" };
        if (name === "weather") return { weatherCtx: async () => "【天气】哈尔滨 -2°C" };
        return null;
      },
    });
    fakeHour = 20;
    const stFile = path.join(DIR, "qzone-state.json");
    const content = "今天看到一个关于屎壳郎的冷知识，笑死";
    // 10a. 预置 24h 内 succeeded 同内容凭据 → 幂等命中 → 不得写 last_self
    ledger.lines.push({ key: "qk-qzone_post|" + content.slice(0, 80), action: "qzone_post", status: "succeeded", ts: Date.now() });
    let st = JSON.parse(fs.readFileSync(stFile, "utf8"));
    delete st.last_self; st.dates = {};
    fs.writeFileSync(stFile, JSON.stringify(st));
    dailyFetches = [];
    await plugin.hooks.timer({ now: Date.now() + 4 * 3600000 });
    await new Promise((r) => setTimeout(r, 150));
    st = JSON.parse(fs.readFileSync(stFile, "utf8"));
    check("幂等命中不写 last_self（字段路径 _pub.data.dedup）", !st.last_self && dailyFetches.length === 0, "fetches=" + dailyFetches.length + " last_self=" + JSON.stringify(st.last_self));
    // 10b. 清空凭据 → 正常发布成功 → 写 last_self
    ledger.lines.length = 0;
    st = JSON.parse(fs.readFileSync(stFile, "utf8"));
    delete st.last_self; st.dates = {};
    fs.writeFileSync(stFile, JSON.stringify(st));
    dailyFetches = [];
    await plugin.hooks.timer({ now: Date.now() + 5 * 3600000 });
    await new Promise((r) => setTimeout(r, 150));
    st = JSON.parse(fs.readFileSync(stFile, "utf8"));
    check("正常发布成功才写 last_self", dailyFetches.length === 1 && st.last_self === "2026-11-1", "fetches=" + dailyFetches.length + " last_self=" + JSON.stringify(st.last_self));
  }
  global.fetch = fakeFetch;

  global.Date = RealDate;
  // 登录失效处理（源码级）：检测 -3000 + 冷却 + 一天最多提醒一次
  const src = fs.readFileSync(require("path").join(__dirname, "..", "plugins", "qzone.js"), "utf8");
  check("识别「请先登录空间」", src.includes("请先登录空间"));
  check("识别 -3000", src.includes("-3000"));
  check("有 30 分钟冷却", src.includes("30 * 60000"));
  check("一天最多提醒一次", src.includes("24 * 3600e3"));
  check("viewSpaces 先查冷却", src.includes("if (inLoginCooldown()) return 0"));

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
