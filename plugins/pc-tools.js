/* 插件：电脑工具（截图/找文件/开软件/系统信息，仅主人） */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, spawn } = require("child_process");

let _ctx = null;
const pendingSend = new Map();  // userId -> { path, name, ts }

function isConfirmText(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t || t.length > 10) return false;
  return /发|好|行|可以|要|是|确认|嗯|对|yes|ok|send/.test(t) && !/不|别|算了|取消|没|no/.test(t);
}
function isCancelText(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t || t.length > 10) return false;
  return /不发|算了|取消|不用|不要|别|不了|no|cancel/.test(t);
}
function extractFileQuery(text) {
  const t = String(text || "");
  let m = t.match(/(?:帮我)?(?:找|查)(?:一下|下)?(?:我)?(?:在|从)?(?:桌面|文档|下载|电脑)?(?:上|里|的)?(.{1,20}?)(?:这个|那个|文件|文档)(?:吗|呢|吧|啊|呀)?[？?！!。.]*$/);
  if (m && m[1] && m[1].trim().length >= 2) return m[1].trim().replace(/[的有没有和与]/g, "");
  m = t.match(/(.{1,20}?)(?:文件|文档)(?:在|找|有)/);
  if (m && m[1] && m[1].trim().length >= 2) return m[1].trim().replace(/[的有没有和与]/g, "");
  return null;
}
async function detectTask(text, settings) {
  const prompt = `你是电脑操作判断助手。判断用户这条消息是否想让 Momo 在电脑上执行操作。可用操作（tool）与参数：
- open_app 打开软件 args={"name":"软件名"}
- close_app 关闭软件 args={"name":"进程名或软件名"}
- system_info 查系统信息 args={"query":"CPU/内存/磁盘/时间等"}
- find_files 查找文件 args={"name":"文件名关键词","dir":"可选，如 桌面/文档/下载"}
- send_file 发送文件 args={"path":"完整路径（必须来自 find_files 的结果，不要编造）"}
规则：只有用户明确要求操作电脑时才输出操作；普通聊天/问答/闲聊输出 {"tool":null}。只输出 JSON，不要解释。

用户消息：${String(text).slice(0, 500)}`;
  const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 300, 0);
  try {
    const s = String(raw).trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    return (obj && obj.tool) ? obj : null;
  } catch (e) { return null; }
}
function findLnk(dir, key) {
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return null; }
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) { const r = findLnk(full, key); if (r) return r; }
      else if (f.toLowerCase().endsWith(".lnk") && f.toLowerCase().includes(key)) return full;
    } catch (e) {}
  }
  return null;
}
function openApp(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return { ok: false, msg: "未指定要打开的应用" };
  const dirs = [
    path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
  ];
  for (const d of dirs) {
    const found = findLnk(d, key);
    if (found) { try { spawn("cmd", ["/c", "start", "", found], { detached: true, windowsHide: true }).unref(); } catch (e) {} return { ok: true, msg: `已打开「${name}」` }; }
  }
  try { spawn("cmd", ["/c", "start", "", name], { detached: true, windowsHide: true }).unref(); return { ok: true, msg: `已尝试打开「${name}」` }; }
  catch (e) { return { ok: false, msg: `打开失败: ${e.message}` }; }
}
function closeApp(name) {
  const key = String(name || "").trim().replace(/[\*?\[\]"'`$;&|]/g, "");
  if (!key) return { ok: false, msg: "未指定要关闭的应用" };
  const ps = `Get-Process | Where-Object { $_.ProcessName -like '*${key}*' -or $_.MainWindowTitle -like '*${key}*' } | Select-Object -ExpandProperty Id`;
  try {
    const out = String(spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 20000 }).stdout || "").trim();
    const ids = out.split(/\s+/).filter(Boolean);
    if (!ids.length) return { ok: false, msg: `没找到名为「${key}」的进程` };
    for (const id of ids) { try { spawnSync("taskkill", ["/PID", id, "/F"], { windowsHide: true }); } catch (e) {} }
    return { ok: true, msg: `已关闭 ${ids.length} 个进程（${key}）` };
  } catch (e) { return { ok: false, msg: `关闭失败: ${e.message}` }; }
}
function systemInfo(query) {
  const total = os.totalmem(), free = os.freemem();
  const memUsed = ((total - free) / 1073741824).toFixed(1);
  const memTotal = (total / 1073741824).toFixed(1);
  const cpus = os.cpus();
  const up = os.uptime();
  let disk = "";
  try {
    disk = String(spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { \"$($_.DeviceID) 总 $([math]::Round($_.Size/1GB,1))GB 剩 $([math]::Round($_.FreeSpace/1GB,1))GB\" }"], { encoding: "utf8", timeout: 20000 }).stdout || "").trim();
  } catch (e) {}
  const info = [
    `主机：${os.hostname()}`,
    `系统：${os.platform()} ${os.release()}`,
    `CPU：${cpus.length} 核${cpus[0] ? " " + cpus[0].model : ""}`,
    `内存：已用 ${memUsed}GB / 共 ${memTotal}GB`,
    `磁盘：${disk || "未知"}`,
    `运行时长：${Math.floor(up / 3600)} 小时 ${Math.floor((up % 3600) / 60)} 分钟`,
  ];
  return { ok: true, msg: info.join("\n") };
}
function findFiles(name, dir) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return { ok: false, msg: "未指定要查找的文件名/关键词" };
  const home = os.homedir();
  const dirMap = { "桌面": "Desktop", "文档": "Documents", "下载": "Downloads", "图片": "Pictures", "音乐": "Music", "视频": "Videos" };
  let root = home;
  if (dir) {
    const d = String(dir).trim();
    const mapped = dirMap[d] || Object.keys(dirMap).find((k) => d.includes(k));
    if (mapped) root = path.join(home, mapped);
    else if (d.includes(":")) root = d;
  }
  const results = [];
  const exclude = /node_modules|\\\.git|\\AppData|\\\.dsh|Program Files|\\Windows|\\\.cache/i;
  function walk(d, depth) {
    if (depth > 6 || results.length >= 20) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (results.length >= 20) return;
      const full = path.join(d, e.name);
      if (exclude.test(full)) continue;
      try {
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.name.toLowerCase().includes(key)) { const st = fs.statSync(full); results.push({ path: full, size: st.size }); }
      } catch (e2) {}
    }
  }
  walk(root, 0);
  if (!results.length) return { ok: true, msg: `在 ${root} 里没找到名称含「${name}」的文件` };
  const lines = results.map((r, i) => `${i + 1}. ${r.path}（${(r.size / 1024).toFixed(1)}KB）`).join("\n");
  return { ok: true, msg: `找到 ${results.length} 个：\n${lines}` };
}
function sendFileTool(userId, args) {
  const filePath = String((args && args.path) || "").trim();
  if (!filePath) return { ok: false, msg: "未指定要发送的文件路径" };
  const lower = filePath.toLowerCase();
  if (/\.(key|pem|pfx|p12|kdbx|wallet|dat|env)$/.test(lower) || /(password|secret|credential|private)/.test(lower)) {
    return { ok: false, msg: "这个文件涉及敏感信息，不能发送" };
  }
  if (!fs.existsSync(filePath)) return { ok: false, msg: `文件不存在：${filePath}` };
  const st = fs.statSync(filePath);
  if (st.isDirectory()) return { ok: false, msg: `这是文件夹，不是文件：${filePath}` };
  pendingSend.set(userId, { path: filePath, name: path.basename(filePath), ts: Date.now() });
  return { ok: true, pending: true, msg: `已找到文件「${filePath}」，等待主人确认发送` };
}
async function actuallySendFile(userId, filePath) {
  const http = (_ctx.config.onebot && _ctx.config.onebot.http_url) || "http://127.0.0.1:3000";
  const r = await fetch(http + "/upload_private_file", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: Number(userId), file: "file:///" + filePath.replace(/\\/g, "/"), name: path.basename(filePath) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== "ok") throw new Error(j.wording || j.status || ("HTTP " + r.status));
  return j;
}
function executeTool(tool, args, userId) {
  if (tool === "open_app") return openApp(args && args.name);
  if (tool === "close_app") return closeApp(args && args.name);
  if (tool === "system_info") return systemInfo(args && args.query);
  if (tool === "find_files") return findFiles(args && args.name, args && args.dir);
  if (tool === "send_file") return sendFileTool(userId, args);
  return { ok: false, msg: "未知操作: " + tool };
}
async function runTasks(text, settings, userId) {
  const results = [];
  let ctx = text;
  for (let i = 0; i < 3; i++) {
    let call = null;
    try { call = await detectTask(ctx, settings); } catch (e) { call = null; }
    if (!call || !call.tool) break;
    let r;
    try { r = executeTool(call.tool, call.args || {}, userId); } catch (e) { r = { ok: false, msg: "操作出错: " + e.message.slice(0, 120) }; }
    results.push({ tool: call.tool, msg: r.msg, ok: r.ok, pending: r.pending });
    if (r.pending) break;
    if (!r.ok) break;
    ctx = text + "\n\n【上一步操作结果】" + String(r.msg || "").slice(0, 600);
  }
  return results;
}
async function captureScreen() {
  const tmp = path.join(_ctx.DATA_DIR, "screen-" + Date.now() + ".png");
  const ps = `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save('${tmp.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose();`;
  try {
    spawnSync("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { timeout: 30000, windowsHide: true });
    return fs.existsSync(tmp) ? tmp : null;
  } catch (e) { return null; }
}

function pcToolDef(name, description, params) {
  return { type: "function", function: { name, description, parameters: params } };
}
function pcToolHandler(toolName) {
  return async function (args, info) {
    if (!_ctx.isMaster(info.userId)) { _ctx.log("warn", "电脑工具被非主人调用: " + toolName); return "（只有主人能让我操作电脑哦）"; }
    try {
      const r = await Promise.resolve(executeTool(toolName, args, info.userId));
      return r ? (r.ok !== undefined ? (r.ok ? r.msg : `失败：${r.msg}`) : String(r).slice(0, 600)) : "（操作无结果）";
    } catch (e) { return "电脑操作失败: " + String(e.message).slice(0, 100); }
  };
}

module.exports = {
  name: "pc-tools",
  displayName: "电脑工具",
  description: "截图/找文件/开软件/系统信息（仅主人）",
  permissions: ["DATA_DIR", "completeOnce", "config", "isMaster", "log", "onebotSend", "sendPrivate"],
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  apiSpec: {"pcTools":{"extractFileQuery":{"input":"","output":"","sideEffect":""},"findFiles":{"input":"","output":"","sideEffect":"只读"},"runTasks":{"input":"","output":"","sideEffect":""}}},

  api: { pcTools: { extractFileQuery, findFiles, runTasks } },
  tools: [
    {
      def: pcToolDef("take_screenshot", "截取主人电脑当前屏幕并发送给主人。当主人说截图、看看屏幕、看下我屏幕时调用。", { type: "object", properties: {} }),
      handler: async (args, info) => {
        if (!_ctx.isMaster(info.userId)) return "（只有主人能让我截图哦）";
        const fp = await captureScreen();
        if (fp) {
          await _ctx.onebotSend("send_msg", { message_type: "private", user_id: Number(info.userId), message: [{ type: "image", data: { file: "file:///" + fp.replace(/\\/g, "/") } }] }).catch(() => {});
          return "已截取主人电脑当前屏幕并发送给主人";
        }
        return "（截图失败）";
      },
    },
    { def: pcToolDef("find_files", "在主人电脑上查找文件。当主人让找文件、找某个东西时调用。", { type: "object", properties: { name: { type: "string", description: "文件名关键词" }, dir: { type: "string", description: "可选：桌面/文档/下载" } }, required: ["name"] }), handler: pcToolHandler("find_files") },
    { def: pcToolDef("open_app", "打开主人电脑上的软件。当主人让打开软件时调用。", { type: "object", properties: { name: { type: "string", description: "软件名" } }, required: ["name"] }), handler: pcToolHandler("open_app") },
    { def: pcToolDef("system_info", "查询主人电脑的系统信息（CPU/内存/磁盘/运行时长等）。", { type: "object", properties: { query: { type: "string", description: "查询内容：CPU/内存/磁盘/全部" } }, required: ["query"] }), handler: pcToolHandler("system_info") },
  ],
  hooks: {
    private_message(ctx, { userId, raw }) {
      if (!ctx.isMaster(userId)) return false;
      const p = pendingSend.get(userId);
      if (!p) return false;
      const t = String(raw || "").trim();
      if (isConfirmText(t)) {
        pendingSend.delete(userId);
        actuallySendFile(userId, p.path)
          .then(() => ctx.sendPrivate(userId, `已发送「${p.name}」给你啦～`))
          .catch((e) => ctx.sendPrivate(userId, "文件发送失败：" + e.message.slice(0, 120)));
        return true;
      }
      if (isCancelText(t)) { pendingSend.delete(userId); ctx.sendPrivate(userId, "好的，不发了～"); return true; }
      return false;
    },
  },
};
