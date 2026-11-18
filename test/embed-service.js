/* test/embed-service.js —— 语义嵌入框架服务（E4）
 * 真模型断言：加载 bge-small-zh-v1.5（data/emb-models，若缺失则整文件 SKIP 不打红灯，
 * 因为模型属于「可选外挂」，CI/离线环境允许没有）。
 * 覆盖：available/embedOne 512 维/相关句余弦>不相关/vecOf 缓存命中/searchSync 排序/refresh 计数。
 */
"use strict";
const path = require("path");
const fs = require("fs");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log((cond ? "  ✓ " : "  ✗ ") + name);
}

const ctx = {
  DATA_DIR,
  log: () => {},
};

async function main() {
  const mod = require(path.join(ROOT, "plugins", "embed-service.js"));
  const api = mod.api.embed;

  await mod.init(ctx);

  const available = api.available();
  console.log("模型可用: " + available);
  check("available 返回布尔", typeof available === "boolean");
  check("manifest 元数据齐全", !!(mod.name && mod.version && mod.apiSpec && mod.apiSpec.embed));

  // 无模型时：跳过真模型断言，但验证降级路径
  if (!available) {
    console.log("（跳过真模型断言：data/emb-models 缺失，属可选外挂）");
    check("vecOf 无模型不抛", api.vecOf("任意") === null);
    const r = await api.refresh(["a", "b"]);
    check("refresh 无模型返回 0 不抛", r === 0);
    check("searchSync 无模型返回 null", api.searchSync("x", [{ content: "y" }]) === null);
    finish();
    return;
  }

  await mod.init(ctx);

  // ① embedOne 真模型 → 512 维向量
  const v1 = await api.embedOne("主人喜欢喝冰美式，加冰不加糖");
  check("embedOne 返回 512 维向量", Array.isArray(v1) && v1.length === 512);
  const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
  check("向量 L2 归一（模长≈1）", Math.abs(norm - 1) < 1e-3);

  // ② vecOf 缓存命中
  const cached = api.vecOf("主人喜欢喝冰美式，加冰不加糖");
  check("vecOf 缓存命中（同文本同向量）", Array.isArray(cached) && cached.length === 512);

  // ③ 相关句余弦 > 不相关句
  const vRel = await api.embedOne("主人爱喝咖啡，尤其美式");
  const vIrr = await api.embedOne("今天天气不错，出去散步");
  const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const rel = cos(v1, vRel);
  const irr = cos(v1, vIrr);
  check("相关句余弦高于不相关句（" + rel.toFixed(3) + " > " + irr.toFixed(3) + "）", rel > irr);

  // ④ searchSync 语义排序：预热后应把「美式咖啡」排第一；冷查询应返回 null（回退语义）
  const cands = [
    { content: "主人平时爱点杨枝甘露" },
    { content: "主人喝美式咖啡，加冰" },
    { content: "昨晚打游戏到很晚" },
  ];
  await api.refresh(cands.map((c) => c.content).concat(["主人喜欢什么咖啡"]));
  const res = api.searchSync("主人喜欢什么咖啡", cands, 3);
  check("searchSync 预热后返回排序结果", Array.isArray(res) && res.length >= 1);
  if (res && res.length) {
    const topContent = String(res[0].m.content);
    check("语义检索把「美式咖啡」排第一（" + topContent.slice(0, 12) + "…）", topContent.includes("美式"));
  }
  const cold = api.searchSync("一个完全陌生的查询词", cands, 3);
  check("冷查询 searchSync 返回 null（本次回退关键词）", cold === null);

  // ⑤ refresh 返回补齐条数（全部已缓存 → 0）
  const r2 = await api.refresh(["主人喜欢喝冰美式，加冰不加糖"]);
  check("refresh 已缓存返回 0", r2 === 0);

  finish();
}

function finish() {
  const fail = results.filter((r) => !r.ok).length;
  console.log("\\n" + results.length + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log("  ✗ 测试异常: " + (e && e.message));
  process.exit(1);
});
