#!/usr/bin/env node
/* 身体联动插件测试（plugins/pet-body.js）
 * 覆盖：元数据 / 权限 / 开关 / 成功路径（含请求头与请求体）/ 离线降级 / 状态查询 / 开关命令
 * 不依赖真实身体：起一个本地 stub HTTP 服务冒充 body 接口。
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const os = require("os");
process.env.MOMO_BODY_EVENTS = path.join(os.tmpdir(), "momo-body-events-test.jsonl");
const plugin = require(path.join(ROOT, "plugins", "pet-body.js"));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- ctx 桩 ----
const store = new Map();
const actions = [];
let fakeVoice = null;
const ctx = {
  getSetting: (k, d) => (store.has(k) ? store.get(k) : d),
  setSetting: (k, v) => store.set(k, v),
  isMaster: (u) => String(u) === "100000001",
  log: () => {},
  recordAction: (e) => actions.push(e),
  sendPrivate: (u, t) => { ctx._lastPrivate = { u, t }; },
  getApi: (n) => (n === "voice" ? fakeVoice : null),
  describeImageFile: async (p, prompt) => {
    ctx._lastDescribe = { p, prompt };
    if (ctx._describeThrows) throw new Error("视觉接口炸了");
    return "主人在写代码（VS Code），窗口标题是 index.js";
  },
};
plugin.init(ctx);

const MASTER = { userId: "100000001" };
const FRIEND = { userId: "100000002" };
const tool = (n) => plugin.tools.find((t) => t.def.function.name === n);

(async () => {
  console.log("\n[1] 插件元数据");
  check("插件名是 pet-body", plugin.name === "pet-body");
  const names = plugin.tools.map((t) => t.def.function.name);
  ["pet_say", "pet_play", "pet_state", "pet_move", "pet_body_status", "pet_body_link"].forEach((n) => {
    check("有工具 " + n, names.includes(n));
  });
  check("有 /身体 命令", plugin.commands.some((c) => c.key === "/身体"));
  check("暴露两个设置项", Array.isArray(plugin.settings) && plugin.settings.length === 2);

  console.log("\n[2] 权限与开关");
  let r = await tool("pet_say").handler({ text: "不该被朋友触发" }, FRIEND);
  check("朋友调 pet_say 被拒", /只有主人/.test(r), r);
  r = await tool("pet_body_status").handler({}, FRIEND);
  check("朋友查状态也被拒", /只有主人/.test(r), r);
  store.set("body.enabled", false);
  r = await tool("pet_say").handler({ text: "x" }, MASTER);
  check("开关关掉后直接拦下", /关掉/.test(r), r);
  store.set("body.enabled", true);

  console.log("\n[3] 身体离线时降级");
  plugin.init({ ...ctx, getSetting: (k, d) => (k === "body.url" ? "http://127.0.0.1:1" : ctx.getSetting(k, d)) });
  r = await tool("pet_say").handler({ text: "在线吗" }, MASTER);
  check("连不上时给可操作提示", /身体好像没在跑/.test(r), r);
  check("离线失败也记了 action", actions.some((a) => a.action === "body_say" && a.ok === false));

  // ---- stub 身体服务 ----
  const seen = [];
  let mode = "ok";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(obj));
      };
      if (mode === "fail") return send(500, { ok: false, error: "boom" });
      if (req.url.startsWith("/status")) {
        return send(200, { ok: true, protocol: "1", pid: 1234, port: 4010, state: "talk",
          anim: "深度思考碎碎念", visible: true, scale: 0.4, pos: [100, 200] });
      }
      if (req.url.startsWith("/cmd/sense")) {
        return send(200, { ok: true, idle_s: 12.5, presence: "active", locked: false,
          foreground: { title: "index.js — Momo", pid: 4321, app: "Code.exe" }, last_look: null });
      }
      if (req.url.startsWith("/cmd/look")) {
        return send(200, { ok: true, path: "E:/Learn/Momo/data/body-shots/fake.jpg", ts: Date.now() / 1000, width: 1280, height: 720 });
      }
      return send(200, { ok: true, queued: true, anim: "哈欠连天", x: 120, y: 220 });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  plugin.init({ ...ctx, getSetting: (k, d) => (k === "body.url" ? "http://127.0.0.1:" + port : ctx.getSetting(k, d)) });

  const token = (() => { try { return fs.readFileSync(path.join(ROOT, "body", "body-token"), "utf8").trim(); } catch (e) { return ""; } })();

  console.log("\n[4] 正常路径（stub 身体）");
  r = await tool("pet_say").handler({ text: "主人～我在桌面上说话", duration_ms: 6000 }, MASTER);
  check("pet_say 成功返回带她说的话", /在桌面上说了/.test(r) && r.includes("主人～我在桌面上说话"), r);
  const lastSay = seen.filter((s) => s.url === "/cmd/say").pop();
  check("请求打到 /cmd/say", !!lastSay);
  check("带 Bearer token", !!lastSay && lastSay.auth === "Bearer " + token, lastSay && lastSay.auth);
  check("请求体是 UTF-8 JSON 且含原文", !!lastSay && JSON.parse(lastSay.body).text === "主人～我在桌面上说话");

  r = await tool("pet_play").handler({ name: "优雅女仆舞" }, MASTER);
  check("pet_play 按名字点播", /身体在演/.test(r), r);
  r = await tool("pet_play").handler({}, MASTER);
  check("pet_play 缺参数默认 random", /身体在演/.test(r), r);
  r = await tool("pet_state").handler({ state: "hide" }, MASTER);
  check("pet_state hide 打到 /cmd/hide", /身体状态：hide/.test(r) && seen.some((s) => s.url === "/cmd/hide"), r);
  r = await tool("pet_move").handler({ dx: 20 }, MASTER);
  check("pet_move 返回新坐标", /挪到 120,220/.test(r), r);
  r = await tool("pet_move").handler({}, MASTER);
  check("pet_move 缺参数时提示", /往哪边挪/.test(r), r);

  console.log("\n[5] 状态查询");
  r = await tool("pet_body_status").handler({}, MASTER);
  check("状态里带 pid/端口/动画", r.includes("1234") && r.includes("4010") && r.includes("深度思考碎碎念"), r);

  console.log("\n[6] 开关工具 + /身体 命令");
  r = await tool("pet_body_link").handler({ enable: false }, MASTER);
  check("关闭开关有回执", /关掉/.test(r), r);
  check("开关真的写进设置", ctx.getSetting("body.enabled") === false);
  await tool("pet_body_link").handler({ enable: true }, MASTER);
  ctx._lastPrivate = null;
  await plugin.commands[0].handler({ userId: "100000001" });
  check("/身体 命令回状态", !!ctx._lastPrivate && /身体：显示中/.test(ctx._lastPrivate.t), JSON.stringify(ctx._lastPrivate));

  console.log("\n[7] 身体报错时降级");
  mode = "fail";
  r = await tool("pet_say").handler({ text: "报错测试" }, MASTER);
  check("身体 500 时返回离线提示而不是崩", /身体好像没在跑/.test(r), r);

  console.log("\n[8] 桌面语音（pet_speak：先气泡、后台合成再播）");
  mode = "ok";
  let synthCalls = 0;
  fakeVoice = {
    warmVoice: () => {},
    synthesizeToFile: async (text) => {
      synthCalls++;
      await sleep(60);
      return { ok: true, file: "/tmp/momo-fake.mp3", text };
    },
  };
  seen.length = 0;
  r = await tool("pet_speak").handler({ text: "晚安，早点睡" }, MASTER);
  check("pet_speak 立即回执（不干等合成）", /弹了字/.test(r), r);
  check("先发了气泡 /cmd/say", seen.some((s) => s.url === "/cmd/say"));
  check("此时还没发 /cmd/speak（合成在后台）", !seen.some((s) => s.url === "/cmd/speak"));
  await sleep(400);
  check("合成完成后补发 /cmd/speak", seen.some((s) => s.url === "/cmd/speak"));
  check("合成被调用了一次", synthCalls === 1, String(synthCalls));
  const speakReq = seen.filter((s) => s.url === "/cmd/speak").pop();
  check("/cmd/speak 带音频路径与原文",
    !!speakReq && JSON.parse(speakReq.body).path === "/tmp/momo-fake.mp3"
    && JSON.parse(speakReq.body).text === "晚安，早点睡");

  seen.length = 0;
  fakeVoice = null;
  r = await tool("pet_speak").handler({ text: "没有语音管道" }, MASTER);
  check("voice 插件不在时给明确提示", /语音管道不可用/.test(r), r);
  check("此时不该发 /cmd/speak", !seen.some((s) => s.url === "/cmd/speak"));

  fakeVoice = { synthesizeToFile: async () => ({ ok: false, error: "gsv 挂了" }), warmVoice: () => {} };
  seen.length = 0;
  r = await tool("pet_speak").handler({ text: "合成会失败" }, MASTER);
  check("合成失败也先弹气泡（不静默）", /弹了字/.test(r));
  await sleep(300);
  check("合成失败时不发 /cmd/speak", !seen.some((s) => s.url === "/cmd/speak"));
  check("合成失败记了失败 action", actions.some((a) => a.action === "body_speak" && a.ok === false));

  console.log("\n[9] 感官回流（pet_sense / pet_look / contextProvider）");
  r = await tool("pet_sense").handler({}, MASTER);
  check("pet_sense 说清在不在 + 前台程序", /主人在电脑前|主人可能不在/.test(r) && /Code/.test(r), r);

  r = await tool("pet_sense").handler({}, FRIEND);
  check("朋友查感官被拒", /只有主人/.test(r), r);

  r = await tool("pet_look").handler({ question: "他在干嘛" }, MASTER);
  check("pet_look 返回看图描述", /主人在写代码/.test(r), r);
  check("pet_look 把截图路径交给视觉接口", !!ctx._lastDescribe && /fake\.jpg$/.test(ctx._lastDescribe.p), JSON.stringify(ctx._lastDescribe));
  check("pet_look 把问题透传给视觉接口", !!ctx._lastDescribe && ctx._lastDescribe.prompt === "他在干嘛");

  // 20 秒内重复看会被劝退（省钱）
  r = await tool("pet_look").handler({}, MASTER);
  check("短时间重复看图会被拦", /刚看过一眼/.test(r), r);

  ctx._describeThrows = true;
  require(path.join(__dirname, "..", "plugins", "pet-body.js")).__test.sense.lastLook = null;
  r = await tool("pet_look").handler({}, MASTER);
  check("视觉接口出错时把路径给出来而不是崩", /看图的接口出错了/.test(r) && /fake\.jpg/.test(r), r);
  ctx._describeThrows = false;

  const t = plugin.__test;
  t.sense.updatedAt = 0;
  check("没有感官数据时 contextProvider 返回空", plugin.contextProvider({}) === "");
  t.handleBodyEvent("presence", { presence: "away", idle_s: 600 });
  t.handleBodyEvent("foreground", { title: "index.js — Momo", pid: 1, app: "Code.exe" });
  t.handleBodyEvent("click", { x: 1, y: 2, sound: true });
  const ctxText = plugin.contextProvider({});
  check("contextProvider 注入【身体感觉】", /【身体感觉】/.test(ctxText), ctxText);
  check("里面有「主人可能离开了」", /离开|没动/.test(ctxText), ctxText);
  check("里面有前台程序", /Code/.test(ctxText), ctxText);
  check("刚点过也会写进去", /点了你一下/.test(ctxText), ctxText);

  const eventsFile = process.env.MOMO_BODY_EVENTS;
  const evLines = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").trim().split("\n") : [];
  check("感官事件落盘到 data/body-events.jsonl", evLines.length >= 3, String(evLines.length));
  check("落盘的事件带 event 字段", evLines.slice(-3).every((l) => JSON.parse(l).event), evLines.slice(-1)[0]);

  server.close();
  await sleep(50);
  console.log("\n结果：" + pass + " 过 / " + fail + " 失败");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
