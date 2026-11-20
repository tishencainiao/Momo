/* 世界书（lore-service）测试：真插件加载 + api.lore 行为 + 注入静态断言 */
const path = require("path");
const fs = require("fs");
const os = require("os");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log("✗ " + name + (extra ? "｜" + extra : "")); }
}

const L = require("../plugins/lore-service.js");

// 临时 DATA_DIR + mock ctx
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lore-"));
fs.writeFileSync(path.join(tmp, "lore.json"), JSON.stringify({ entries: [
  { id: "a", keys: ["火锅", "hotpot"], content: "主人爱吃火锅。", priority: 2, order: 1 },
  { id: "b", keys: ["毕设", "途忆"], content: "主人的毕设是途忆旅游攻略智能体。", priority: 4, order: 2 },
  { id: "c", keys: ["咖啡"], content: "主人爱喝冰美式，偏酸。", priority: 2, order: 3 },
  { id: "d", keys: ["拼图"], content: "主人玩拼图。", priority: 1, order: 4 },
] }));
const writes = [];
const ctx = {
  DATA_DIR: tmp,
  log: () => {},
  writeJsonAtomic: (f, o) => { writes.push(o); return true; },
  isMaster: (u) => u === "100000001",
};
L.init(ctx);

check("entries 读盘", L.api.lore.entries().length === 4);
check("match 子串命中（中文）", L.api.lore.match("我们今晚去吃火锅吧").length === 1);
check("match 英文不区分大小写", L.api.lore.match("HOTPOT").some((e) => e.id === "a"));
check("match 不命中返回空", L.api.lore.match("今天天气不错").length === 0);
check("match 多命中", L.api.lore.match("毕设的火锅局").length === 2);

// loreCtx 优先级：priority 高者在前；命中 2 条时拼注入块
const lc = L.api.lore.loreCtx("聊毕设的事");
check("loreCtx 带块头", lc.includes("【背景（聊到这个想起来的）】"));
check("loreCtx 高优先级在前", lc.indexOf("途忆") < lc.indexOf("火锅") || !lc.includes("火锅"));
check("loreCtx 空命中返回空串", L.api.lore.loreCtx("天气") === "");

// addLore / removeLore / listLore
check("addLore 写盘", L.api.lore.addLore({ keys: "奶茶", content: "主人爱喝奶茶。" }) === true && writes.length === 1);
check("addLore 缺内容拒绝", L.api.lore.addLore({ keys: "x", content: "" }) === false);
check("removeLore", L.api.lore.removeLore("a") === true && L.api.lore.entries().length === 4);
check("removeLore 不存在", L.api.lore.removeLore("zzz") === false);
check("listLore 文本", L.api.lore.listLore().includes("世界书条目"));

// 工具 master-only + 命令
const addTool = L.tools.find((t) => t.def && t.def.function && t.def.function.name === "lore_add");
check("lore_add 非主人拒绝", addTool.handler({ keys: "x", content: "y" }, { userId: "100000002" }).includes("只有主人"));
const loreCmd = L.commands.find((c) => c.key === "/lore");
check("lore 命令非主人拒绝", loreCmd.handler({ user_id: "100000002" }).includes("不能给别人看"));
check("lore 命令主人可看", loreCmd.handler({ user_id: "100000001" }).includes("世界书条目"));

// 注入静态断言：agentChatOnce 区二机会式调用
const idx = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
check("index.js 区二注入 loreCtx", idx.includes('_lore.loreCtx') && idx.includes('apiOf("lore")'));
// doctor FRAMEWORK_NS 收录 lore
const doc = fs.readFileSync(path.join(__dirname, "..", "scripts", "plugin-doctor.js"), "utf8");
check("doctor FRAMEWORK_NS 含 lore", doc.includes('"lore"'));

// 自播种子（放最后：会换 _ctx，别影响前面的主人命令断言）
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "lore2-"));
L.init({ DATA_DIR: tmp2, log: () => {}, writeJsonAtomic: (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); return true; }, isMaster: () => false });
check("无文件时自播 8 条种子", L.api.lore.entries().length === 8);

console.log(`lore-service: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
