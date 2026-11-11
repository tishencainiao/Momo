#!/usr/bin/env node
// doc-check.js —— Momo 文档对账（版本头 / 数字口径 / 行号引用）
// 用法：node scripts/doc-check.js [--base-version vX.Y.Z]
// 退出码：0 无偏差；1 有偏差（release.ps1 阶段 6 调用，偏差只警告不阻塞发布）
// 规则来源：docs/development.md「十二、文档纪律章程」

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
let baseOverride = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base-version' && args[i + 1]) {
    baseOverride = args[i + 1].replace(/^v/i, '');
    i++;
  }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

const problems = [];
function fail(msg) { problems.push(msg); console.log('✗ ' + msg); }
function ok(msg) { console.log('✓ ' + msg); }

// 1) 版本权威：BASE_VERSION（可用 --base-version 覆盖，便于测试）
let baseVersion = baseOverride;
if (!baseVersion) {
  const idx = readText(path.join(root, 'index.js'));
  const m = idx && idx.match(/BASE_VERSION\s*=\s*"([^"]+)"/);
  if (!m) { console.log('✗ 读不到 index.js 的 BASE_VERSION'); process.exit(1); }
  baseVersion = m[1];
}

// 2) 计数：插件/测试文件；运行日志里的工具/命令数（若 bridge.log 有「插件平台就绪」行）
const pluginCount = fs.readdirSync(path.join(root, 'plugins')).filter(f => f.endsWith('.js')).length;
const testCount = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.js')).length;
let runtime = null;
const bridgeLog = readText(path.join(root, 'bridge.log'));
if (bridgeLog) {
  const lines = bridgeLog.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/插件平台就绪：(\d+)\s*个插件（工具\s*(\d+)\s*个\s*\/\s*命令\s*(\d+)\s*个）/);
    if (m) { runtime = { plugins: +m[1], tools: +m[2], cmds: +m[3] }; break; }
  }
}
console.log('[doc-check] base_version=' + baseVersion + ' plugins=' + pluginCount + ' tests=' + testCount +
  (runtime ? (' runtime_plugins=' + runtime.plugins + ' tools=' + runtime.tools + ' cmds=' + runtime.cmds) : '（bridge.log 无「插件平台就绪」行，工具/命令数检查跳过）'));
if (runtime && runtime.plugins !== pluginCount) {
  fail('运行日志插件数 ' + runtime.plugins + ' ≠ 磁盘插件文件数 ' + pluginCount);
}

// 3) 版本头检查：带「适用版本」头的文档必须与 BASE_VERSION 一致
const headerDocs = [
  { file: 'docs/architecture.md', re: /版本：v?([\d.]+)/ },
  { file: 'docs/prompt-map.md', re: /# Momo 的提示词地图（v([\d.]+)）/ },
  { file: 'docs/report-center.md', re: /版本：v?([\d.]+)/ }
];
for (const h of headerDocs) {
  const t = readText(path.join(root, h.file));
  if (!t) { fail(h.file + ' 不存在'); continue; }
  const m = t.match(h.re);
  if (!m) { fail(h.file + ' 缺少版本头标记'); continue; }
  if (m[1] !== baseVersion) fail(h.file + ' 版本头 v' + m[1] + ' ≠ BASE_VERSION v' + baseVersion);
  else ok('版本头 ' + h.file + ' = v' + m[1]);
}

// 4) 数字口径：文档里写死的插件/工具/命令/测试数必须与实测一致
const numDocs = ['README.md', 'docs/architecture.md', 'docs/development.md', 'docs/prompt-map.md'];
const numberChecks = [
  { re: /(\d+)\s*个(?:功能)?插件/g, want: pluginCount, label: '插件数' },
  { re: /插件\s*(\d+)\s*个/g, want: pluginCount, label: '插件数' },
  { re: /插件清单\s*[（(]\s*(\d+)\s*个\s*[）)]/g, want: pluginCount, label: '插件清单数' },
  { re: /(\d+)\s*个工具/g, want: runtime ? runtime.tools : null, label: '工具数' },
  { re: /(\d+)\s*个命令/g, want: runtime ? runtime.cmds : null, label: '命令数' },
  { re: /(\d+)\s*个测试文件/g, want: testCount, label: '测试数' }
];
for (const doc of numDocs) {
  const t = readText(path.join(root, doc));
  if (!t) continue;
  for (const c of numberChecks) {
    if (c.want === null) continue;
    c.re.lastIndex = 0;
    let m;
    while ((m = c.re.exec(t)) !== null) {
      const n = +m[1];
      if (n !== c.want) fail(doc + ' ' + c.label + '写 ' + n + '，实际 ' + c.want);
    }
  }
}

// 5) 行号引用：docs/*.md（不含子目录）里禁止 index.js 行号 / 「第 N 行」/ `L123` 写法
const docFiles = fs.readdirSync(path.join(root, 'docs')).filter(f => f.endsWith('.md'));
const lineRefRes = [/index\.js\s*[:：]\s*\d+/, /index\.js[^\n]{0,12}第\s*\d+\s*行/, /`L\d{3,}`/];
for (const f of docFiles) {
  const t = readText(path.join(root, 'docs', f));
  if (!t) continue;
  for (const re of lineRefRes) {
    const hit = t.match(re);
    if (hit) fail('docs/' + f + ' 含行号引用：' + hit[0]);
  }
}

// 6) 索引完整性：docs/index.md 必须覆盖所有 docs/*.md（顶层），漏登记=红（拦提交）
const indexText = readText(path.join(root, 'docs', 'index.md'));
if (!indexText) {
  fail('docs/index.md 不存在（文档地图）');
} else {
  const indexExcludes = ['remote-backup-gitee.md']; // 私有笔记，不进公开索引
  const topMd = fs.readdirSync(path.join(root, 'docs')).filter(f => f.endsWith('.md') && f !== 'index.md' && !indexExcludes.includes(f));
  let missing = 0;
  for (const f of topMd) {
    if (!indexText.includes(f)) { fail('docs/index.md 未收录 ' + f + '（新增文档必须登记进文档地图）'); missing++; }
  }
  if (missing === 0) ok('索引完整性：docs/index.md 覆盖 ' + topMd.length + ' 份顶层文档');
}

console.log('');
if (problems.length === 0) {
  console.log('[doc-check] 通过：无偏差');
  process.exit(0);
}
console.log('[doc-check] 发现 ' + problems.length + ' 处偏差（见上）');
process.exit(1);
