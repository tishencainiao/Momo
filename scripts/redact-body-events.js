#!/usr/bin/env node
/* 清理 data/body-events.jsonl 里的隐私字段（历史遗留的窗口标题、完整文件路径）
 *
 * 用法：
 *   node scripts/redact-body-events.js            # 只看会改什么（dry-run，默认）
 *   node scripts/redact-body-events.js --apply    # 真的改（先备份到 data/archive/）
 *
 * 幂等：已经干净的条目不会被动。
 * 口径与 plugins/pet-body.js 的 appendEvent 一致：
 *   - foreground.title 抹掉（只留 app / pid）
 *   - files[] 只留文件名
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// 测试可用 MOMO_BODY_EVENTS 指向临时文件
const FILE = process.env.MOMO_BODY_EVENTS || path.join(ROOT, "data", "body-events.jsonl");
const ARCHIVE_DIR = path.join(ROOT, "data", "archive");

function sanitize(obj) {
  const out = Object.assign({}, obj);
  let changed = false;
  // 老格式：foreground 事件把 title 放在顶层
  if ("title" in out) {
    delete out.title;
    changed = true;
  }
  // 新格式：sense 快照里嵌一层 foreground
  if (out.foreground && typeof out.foreground === "object" && "title" in out.foreground) {
    out.foreground = { app: out.foreground.app || "", pid: out.foreground.pid || 0 };
    changed = true;
  }
  if (Array.isArray(out.files)) {
    const names = out.files.map((p) => String(p).split(/[\\/]/).pop()).slice(0, 10);
    if (JSON.stringify(names) !== JSON.stringify(out.files)) {
      out.files = names;
      changed = true;
    }
  }
  return { out, changed };
}

function main() {
  const apply = process.argv.includes("--apply");
  if (!fs.existsSync(FILE)) {
    console.log("没有 " + FILE + "，无需处理");
    return;
  }
  const raw = fs.readFileSync(FILE, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  let changedCount = 0;
  const outLines = lines.map((line) => {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      return line;                         // 坏行原样保留
    }
    const { out, changed } = sanitize(obj);
    if (changed) changedCount++;
    return JSON.stringify(out);
  });

  const stillTitles = outLines.filter((l) => l.includes('"title"')).length;
  console.log("总条数:", lines.length, "| 需要脱敏:", changedCount, "| 处理后仍含 title:", stillTitles);

  if (!changedCount) {
    console.log("已经是干净的，不需要改");
    return;
  }
  if (!apply) {
    console.log("（dry-run）加 --apply 才会真的写入");
    return;
  }

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backup = path.join(ARCHIVE_DIR, "body-events-" + stamp + ".jsonl");
  fs.copyFileSync(FILE, backup);
  console.log("已备份:", backup);

  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, outLines.join("\n") + "\n", "utf8");
  fs.renameSync(tmp, FILE);
  console.log("已重写:", FILE, "（" + outLines.length + " 条）");
}

main();
