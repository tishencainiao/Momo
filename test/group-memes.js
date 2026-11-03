/* 群梗插件测试：学习 / 去重 / 自动识别 / 按群隔离 / 列表 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-memes-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

const plugin = require("E:/Learn/Momo/plugins/group-memes.js");
plugin.init({ DATA_DIR: DIR, log: () => {} });
const M = plugin.api.groupMemes;

const G1 = 100000003, G2 = 999999;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

// 1. 基础学习
check("学一个梗", M.learn(G1, "老八", "游戏里垫底", 3550140293).ok === true);
check("注入里出现", M.ctx(G1).indexOf("老八") >= 0, M.ctx(G1));
check("注入里带解释", M.ctx(G1).indexOf("游戏里垫底") >= 0);
check("标注只在本群用", M.ctx(G1).indexOf("别拿到别处") >= 0);

// 2. 去重 + 计数
const r2 = M.learn(G1, "老八", "", 1);
check("同梗不重复添加", r2.updated === true);
check("计入出现次数", M.list(G1).indexOf("出现 2 次") >= 0, M.list(G1));

// 3. 按群隔离
check("另一个群看不到", M.ctx(G2) === "", M.ctx(G2));
check("另一个群列表为空", M.list(G2).indexOf("还没学到") >= 0);
M.learn(G2, "打工人", "上班族", 1);
check("两个群的梗互不影响", M.ctx(G1).indexOf("打工人") < 0 && M.ctx(G2).indexOf("老八") < 0);

// 4. 自动识别
const d1 = M.detectAndLearn(G1, "老八的意思是垫底", 1);
check("识别「X的意思是Y」", d1 && d1.ok === true, JSON.stringify(d1));
const d2 = M.detectAndLearn(G1, "泰裤辣，就是太酷了的意思", 1);
check("识别「X，就是Y」", d2 && d2.ok === true, JSON.stringify(d2));
const d3 = M.detectAndLearn(G1, "今天天气不错", 1);
check("普通聊天不误学", d3 === null, JSON.stringify(d3));
const d4 = M.detectAndLearn(G1, "哈哈哈", 1);
check("短语气词不误学", d4 === null);

// 5. 学了自动识别的内容
check("自动识别的梗已入库", M.ctx(G1).indexOf("泰裤辣") >= 0, M.ctx(G1));

// 6. 列表格式
const list = M.list(G1);
check("列表带序号", /^1\. /.test(list), list);
check("列表带出现次数", list.indexOf("出现") >= 0);

// 7. 工具权限：非群聊上下文
const viewTool = plugin.tools.find((t) => t.def.function.name === "group_meme_view");
const learnTool = plugin.tools.find((t) => t.def.function.name === "group_meme_learn");
check("私聊里查群梗被拒", viewTool.handler({}, { userId: 1 }).indexOf("只有群聊") >= 0);
check("私聊里学群梗被拒", learnTool.handler({ meme: "x" }, { userId: 1 }).indexOf("只有群聊") >= 0);
check("群聊里能学", learnTool.handler({ meme: "绝了", meaning: "太厉害" }, { userId: 1, groupId: G1 }).indexOf("绝了") >= 0);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
