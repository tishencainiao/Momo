/* embed-service · 框架服务（变聪明 E4）
 * bge-small-zh-v1.5 本地语义嵌入（Xenova ONNX 量化版，模型放 data/emb-models/）。
 * 设计：懒加载（首次 refresh/searchSync 才加载管线 ~1-2s）；向量按内容 sha256 缓存到 data/emb-cache.json（增量，
 * 上限 5000 条，超了丢最旧）。
 * 关键：调用方（memory-service.retrieveMemories）是同步的——所以对外主接口是同步 vecOf/searchSync：
 *   - vecOf(text) 同步取缓存向量（没有则 null）
 *   - searchSync(query,cands,k) 同步融合（查询向量未就绪→返回 null 并后台 warm，调用方回退关键词）
 *   - refresh(texts) 异步补齐缺失向量（保存记忆时 fire-and-forget 调用）
 * 手动 mean pooling + L2 归一（不依赖库的 pooling 行为）。 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let _ctx = null;
let _pipe = null;
let _pipeLoading = null;   // Promise，防并发重复加载
let _cache = null;         // { v:1, items: { hash: { t: lastUsedTs, v: [..] } } }
let _cacheDirty = false;
let _warmBusy = false;
const DIM = 512;
const CACHE_MAX = 5000;

function modelDir() { return path.join(_ctx.DATA_DIR, "emb-models", "bge-small-zh-v1.5"); }
function cacheFile() { return path.join(_ctx.DATA_DIR, "emb-cache.json"); }

function _sha(s) { return crypto.createHash("sha256").update(String(s), "utf8").digest("hex"); }

function _loadCache() {
  if (_cache) return;
  try {
    const d = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
    if (d && d.items) { _cache = { v: 1, items: d.items }; return; }
  } catch (e) {}
  _cache = { v: 1, items: {} };
}
function _saveCache() {
  if (!_cache || !_cacheDirty) return;
  try {
    const entries = Object.entries(_cache.items);
    if (entries.length > CACHE_MAX) {
      entries.sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
      for (const [k] of entries.slice(0, entries.length - CACHE_MAX)) delete _cache.items[k];
    }
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    const tmp = cacheFile() + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(_cache));
    fs.renameSync(tmp, cacheFile());
    _cacheDirty = false;
  } catch (e) { try { _ctx.log("warn", "emb 缓存保存失败: " + String(e && e.message).slice(0, 120)); } catch (e2) {} }
}

function available() {
  try {
    if (!_ctx) return false;
    if (!fs.existsSync(path.join(modelDir(), "config.json"))) return false;
    if (!fs.existsSync(path.join(modelDir(), "onnx", "model.onnx"))) return false;
    require.resolve("@huggingface/transformers");
    return true;
  } catch (e) { return false; }
}

function _getPipe() {
  if (_pipe) return Promise.resolve(_pipe);
  if (!available()) return Promise.reject(new Error("embed 模型或依赖不可用"));
  if (_pipeLoading) return _pipeLoading;
  _pipeLoading = (async () => {
    const { pipeline, env } = require("@huggingface/transformers");
    env.localModelPath = path.join(_ctx.DATA_DIR, "emb-models");
    env.allowRemoteModels = false;
    _pipe = await pipeline("feature-extraction", "bge-small-zh-v1.5");
    return _pipe;
  })().catch((e) => { _pipeLoading = null; throw e; });
  return _pipeLoading;
}

/* token 级输出 [1, seq, DIM] → mean pooling → L2 归一 */
function _poolNorm(seq, data) {
  const v = new Float64Array(DIM);
  for (let i = 0; i < seq; i++) {
    const off = i * DIM;
    for (let j = 0; j < DIM; j++) v[j] += data[off + j];
  }
  for (let j = 0; j < DIM; j++) v[j] /= seq;
  let norm = 0;
  for (let j = 0; j < DIM; j++) norm += v[j] * v[j];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(DIM);
  for (let j = 0; j < DIM; j++) out[j] = v[j] / norm;
  return out;
}

/* 同步取缓存向量（无则 null；命中会刷新 lastUsed） */
function vecOf(text) {
  try {
    const t = String(text || "");
    if (!t) return null;
    _loadCache();
    const h = _sha(t);
    const it = _cache.items[h];
    if (it && Array.isArray(it.v) && it.v.length === DIM) { it.t = Date.now(); _cacheDirty = true; return it.v; }
    return null;
  } catch (e) { return null; }
}

/* 异步补齐缺失向量（fire-and-forget 安全：内部全 try） */
async function refresh(texts) {
  if (!available()) return 0;
  if (_warmBusy) return 0;
  _warmBusy = true;
  try {
    _loadCache();
    const missing = [];
    for (const t of texts || []) {
      const s = String(t || "").trim();
      if (!s) continue;
      if (!vecOf(s)) missing.push(s);
    }
    if (!missing.length) return 0;
    const pipe = await _getPipe();
    const out = await pipe(missing);
    const n = missing.length;
    const per = out.dims[1];
    for (let i = 0; i < n; i++) {
      const v = _poolNorm(per, out.data.slice(i * per * DIM, (i + 1) * per * DIM));
      const h = _sha(missing[i]);
      _loadCache();
      _cache.items[h] = { t: Date.now(), v };
    }
    _cacheDirty = true;
    _saveCache();
    return n;
  } catch (e) {
    try { _ctx.log("warn", "embed refresh 失败: " + String(e && e.message).slice(0, 120)); } catch (e2) {}
    return 0;
  } finally { _warmBusy = false; }
}

function _cos(a, b) {
  let d = 0;
  for (let i = 0; i < DIM; i++) d += a[i] * b[i];
  return d; // 已归一化，点积=余弦
}

/* 同步语义检索：查询向量就绪 → 返回 [{m, score}] 按余弦降序；未就绪/不可用 → null 并后台 warm */
function searchSync(query, candidates, topK) {
  if (!available()) return null;
  const qv = vecOf(query);
  const arr = candidates || [];
  if (!arr.length) return [];
  if (!qv) {
    // 后台 warm 查询 + 候选，本次调用方回退关键词
    const texts = [String(query || "")].concat(arr.map((m) => String((m && m.content) || "")));
    refresh(texts).catch(() => {});
    return null;
  }
  const k = topK || 20;
  const scored = arr.map((m) => {
    const v = vecOf(String((m && m.content) || ""));
    return { m, score: v ? _cos(qv, v) : -1 };
  }).filter((s) => s.score >= 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/* 异步单条（供测试/外部调用） */
async function embedOne(text) {
  const t = String(text || "");
  if (!t) return null;
  await refresh([t]);
  return vecOf(t);
}

module.exports = {
  name: "embed-service",
  displayName: "框架服务 · 语义嵌入",
  description: "bge-small-zh-v1.5 本地语义嵌入与向量缓存（变聪明 E4）。模型/依赖缺失时 searchSync 返回 null，调用方回退关键词检索。",
  version: "1.0.0",
  engines: { kernel: ">=1.99.0" },
  userScoped: false,
  requires: [],
  permissions: ["DATA_DIR", "log"],
  attribution: { source: "BAAI/bge-small-zh-v1.5 (Xenova ONNX 量化)", license: "MIT", note: "模型权重借用 BAAI/bge-small-zh-v1.5；加载经 @huggingface/transformers（npmmirror 安装）" },
  async init(ctx) { _ctx = ctx; },
  api: {
    embed: {
      available,
      vecOf,
      refresh,
      searchSync,
      embedOne,
    },
  },
  apiSpec: {
    embed: {
      available: { input: "", output: "布尔（模型+依赖是否可用）", sideEffect: "只读" },
      vecOf: { input: "文本", output: "512 维归一向量数组或 null（同步，缓存命中）", sideEffect: "只读（刷新 lastUsed）" },
      refresh: { input: "文本数组", output: "补了多少条", sideEffect: "写缓存（增量，异步）" },
      searchSync: { input: "query, candidates[{content}], topK", output: "按余弦降序 [{m, score}]；未就绪返回 null", sideEffect: "写缓存（后台 warm）" },
      embedOne: { input: "文本", output: "512 维向量数组", sideEffect: "写缓存（增量）" },
    },
  },
};
