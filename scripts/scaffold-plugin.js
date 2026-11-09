#!/usr/bin/env node
/* 插件脚手架：生成带完整清单（Manifest）的插件模板
 * 用法：node scripts/scaffold-plugin.js <name> [显示名]
 *   name 必须「领域-用途」kebab-case（如 my-tool、memory-digest）
 * 生成 plugins/<name>.js，带 name/displayName/description/version/engines.kernel/
 *   requires/permissions/attribution(注释示例)/api/apiSpec/init/tools/commands/hooks
 * 已存在则拒绝覆盖；生成后跑 node scripts/plugin-doctor.js 应绿。
 */
const fs = require("fs");
const path = require("path");

function readKernelVersion() {
  try {
    const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const m = src.match(/const BASE_VERSION\s*=\s*["']([^"']+)["']/);
    return m ? m[1] : "0.0.0";
  } catch (e) { return "0.0.0"; }
}

function main() {
  const name = String(process.argv[2] || "").trim();
  const display = String(process.argv[3] || "").trim();

  if (!name) {
    console.error("用法：node scripts/scaffold-plugin.js <领域-用途> [显示名]");
    console.error("示例：node scripts/scaffold-plugin.js my-tool 我的工具");
    process.exit(1);
  }
  // 领域-用途 kebab-case：小写字母开头，至少一段连字符
  if (!/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)+$/.test(name)) {
    console.error(`名字不合法：「${name}」必须是「领域-用途」kebab-case（至少一段 -，全小写），如 my-tool / memory-digest`);
    process.exit(1);
  }

  const target = path.join(__dirname, "..", "plugins", name + ".js");
  if (fs.existsSync(target)) {
    console.error(`已存在：${target}，拒绝覆盖。`);
    process.exit(1);
  }

  const kernel = readKernelVersion();
  const displayName = display || name.split("-").map(s => s[0].toUpperCase() + s.slice(1)).join(" ");
  const ns = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); // my-tool → myTool（api 命名空间惯例）

  const tpl = `/* 插件：${displayName} —— 一句话用途（改这里） */
let _ctx = null;
const fs = require("fs");
const path = require("path");

module.exports = {
  name: "${name}",
  displayName: "${displayName}",
  description: "做什么、什么时候用（改这里，给面板/大脑看）",
  version: "1.0.0",
  engines: { kernel: ">=${kernel}" },
  requires: [],                    // 依赖的 api 命名空间，如 ["search","body"]
  permissions: ["DATA_DIR", "getSetting", "log"],   // 用到的 _ctx.xxx（体检会核对）
  /* 借鉴了开源才写 attribution（保留原许可证），原创删掉这 4 行 */
  // attribution: {
  //   source: "https://github.com/xxx/yyy",
  //   license: "MIT",
  //   note: "借用了 <函数> 的 <思路/实现>，改为零依赖+适配 ctx",
  // },
  init(ctx) { _ctx = ctx; },
  /* 有 api 就写 apiSpec（命名空间/函数名一一对应），不导出别人就不写 */
  // api: { ${ns}: { doThing } },
  // apiSpec: { ${ns}: { doThing: { input: "无", output: "结果", sideEffect: "只读" } } },
  tools: [
    // { def: { type: "function", function: { name: "${name.replace(/-/g, "_")}_x", description: "何时调用", parameters: { type: "object", properties: {} } } }, handler(args, info) { return "结果"; } },
  ],
  commands: [
    // { key: "/${name}", regex: /^\\/${name}/, handler(msg) { _ctx.sendPrivate(msg.userId, "回复"); } },
  ],
  hooks: {
    // startup() {},
    // timer({ now }) { /* 每秒触发，记得节流 */ },
    // private_message(msg) {},
    // reply(record) {},
  },
};
`;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, tpl);
  console.log(`已生成 ${path.relative(process.cwd(), target)}`);
  console.log(`  displayName: ${displayName}`);
  console.log(`  engines.kernel: >=${kernel}（当前内核）`);
  console.log(`下一步：填业务逻辑 → node scripts/plugin-doctor.js 应绿 → node check.js 应过`);
}

main();
