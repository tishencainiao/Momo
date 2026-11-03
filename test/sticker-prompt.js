/* 表情包提示词回归测试：确保不再注入全量清单、且给出可用情绪 */
const p = require("E:/Learn/Momo/plugins/stickers.js");
const prompt = p.api.stickers.stickerPrompt();
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name); }
}
check("提示词非空", prompt.length > 0);
check("长度 < 400 字符（不再注入全量清单）", prompt.length < 400);
check("不含旧标记格式说明", prompt.indexOf("[[贴图") < 0);
check("包含 send_sticker 工具指引", prompt.indexOf("send_sticker") >= 0);
check("包含情绪分布", /\((\d+)\)/.test(prompt));
console.log("\n--- 实际内容 ---\n" + prompt);
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
