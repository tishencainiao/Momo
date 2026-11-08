#!/usr/bin/env node
/*
 * 一次性迁移脚本：把「主人长期记忆」从旧桌宠 memory.json 迁到 data/memory/<master>.json
 * 背景：旧桌宠（dsh-pet-standalone-webm-chat）已废弃，主人记忆此前与其互通（读写旧桌宠文件）。
 * 迁移后内核 loadMemories/saveMemories 不再特判主人，统一读写 data/memory/<uid>.json。
 *
 * 用法：node scripts/migrate-master-memory.js
 * 安全：先备份源文件到 data/archive/；目标已存在则按 fingerprint 去重合并，不覆盖。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const MASTER_ID = Number(cfg.qq && cfg.qq.master_user);

if (!MASTER_ID) {
  console.error("config.json 缺少 qq.master_user，无法确定主人 QQ 号");
  process.exit(1);
}

function petMemoryPath() {
  const dir = (cfg.pet && cfg.pet.config_path)
    ? path.dirname(cfg.pet.config_path)
    : path.join(process.env.APPDATA || "", "dsh-pet-standalone-webm-chat");
  const charId = (cfg.pet && cfg.pet.character_id) || "shenshen";
  return path.join(dir, "sessions", charId, "memory.json");
}

const src = petMemoryPath();
const dst = path.join(ROOT, "data", "memory", String(MASTER_ID) + ".json");

if (!fs.existsSync(src)) {
  console.error("源文件不存在（可能旧桌宠已卸载或路径变了）：" + src);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(src, "utf8"));
const entries = (raw && Array.isArray(raw.entries)) ? raw.entries : [];

// 备份源文件（可回滚）
const backupDir = path.join(ROOT, "data", "archive");
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, "old-pet-memory-" + Date.now() + ".json");
fs.copyFileSync(src, backup);

function fingerprint(s) {
  return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, "");
}

// 转换 entries -> items（与 plugins/memory.js mergeMemories 的长期记忆 item 结构对齐）
const migrated = entries.filter((e) => e && e.text).map((e) => {
  let createdSec = Math.floor(Date.now() / 1000);
  const ts = e.created_at || e.updated_at;
  if (ts) {
    const t = typeof ts === "number" ? ts : new Date(ts).getTime();
    if (Number.isFinite(t)) createdSec = Math.floor(t / 1000);
  }
  return {
    content: String(e.text).slice(0, 500),
    source: e.source || "auto",
    layer: e.layer || "fact",
    keywords: Array.isArray(e.keywords) ? e.keywords : [],
    created: createdSec,
    hits: e.hits || 0,
    importance: Math.max(1, e.hits || 1),
    from: MASTER_ID,
  };
});

// 目标已存在则合并去重，否则新建
let items = migrated;
if (fs.existsSync(dst)) {
  const old = JSON.parse(fs.readFileSync(dst, "utf8"));
  const existing = Array.isArray(old.items) ? old.items : [];
  const seen = new Set(existing.map((i) => fingerprint(i && i.content)).filter(Boolean));
  const merged = existing.slice();
  let added = 0;
  for (const m of migrated) {
    const f = fingerprint(m.content);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    merged.push(m);
    added++;
  }
  items = merged;
  console.log(`目标已存在（${existing.length} 条），去重合并新增 ${added} 条`);
}

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, JSON.stringify({ updated: Date.now(), items }), "utf8");

console.log("迁移完成：");
console.log("  源：" + src);
console.log("  源条目数：" + entries.length);
console.log("  目标：" + dst);
console.log("  目标条目数：" + items.length);
console.log("  备份：" + backup);
