/* self-archive.js —— 原始记忆归档：被上限挤掉/被清理的原文不物理消失
 * 写入 data/archive/<kind>-YYYY-MM.jsonl（每行一条 JSON，按月份滚动）
 * 只追加、不参与注入，需要时可检索；不引入任何依赖。
 */
const fs = require("fs");
const path = require("path");

function archiveDir(dataDir) { return path.join(dataDir, "archive"); }

function appendArchive(dataDir, kind, items) {
  if (!Array.isArray(items) || !items.length) return 0;
  try {
    const dir = archiveDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const month = new Date().toISOString().slice(0, 7);
    const file = path.join(dir, `${String(kind || "misc")}-${month}.jsonl`);
    const now = Date.now();
    const lines = items.map((it) => JSON.stringify(
      typeof it === "string" ? { text: it, archived_at: now } : Object.assign({ archived_at: now }, it)
    )).join("\n") + "\n";
    fs.appendFileSync(file, lines);
    return items.length;
  } catch (e) { return 0; }
}

/* 读最近 N 条归档（按文件倒序扫描，不做全量索引） */
function readArchive(dataDir, kind, limit) {
  const n = Math.max(1, Number(limit) || 20);
  try {
    const dir = archiveDir(dataDir);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(String(kind || "misc") + "-")).sort().reverse();
    const out = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        try { out.push(JSON.parse(lines[i])); } catch (e) {}
      }
      if (out.length >= n) break;
    }
    return out;
  } catch (e) { return []; }
}

module.exports = { appendArchive, readArchive, archiveDir };
