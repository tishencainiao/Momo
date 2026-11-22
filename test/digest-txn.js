/* WP4 行为测试：digest.py 事务化（假模型 + 真实 CLI，零网络，不碰真实 data/ 目录）
 * 场景：A 成功 B 失败部分提交 / 修复后重跑 SKIP / 提交崩溃不覆盖旧文件 / 空与坏结构拒绝提交 / 静态断言 / 真实目录零污染 */
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PY = "python";
const ROOT = path.join(__dirname, "..");
const DIGEST = path.join(ROOT, "digest.py");

const failures = [];
let checks = 0;
function check(name, fn) { checks += 1; try { fn(); console.log("ok " + checks + " - " + name); } catch (e) { failures.push(name + " :: " + (e && e.message)); console.log("FAIL " + checks + " - " + name + " :: " + (e && e.message)); } }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || "eq") + " got=" + JSON.stringify(a) + " want=" + JSON.stringify(b)); }
function ok(v, msg) { if (!v) throw new Error(msg || "expected truthy"); }

function wj(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj), "utf8"); }
function rj(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function freshEnv() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "momodig-"));
  const data = path.join(t, "data"), self = path.join(t, "self"), out = path.join(t, "out");
  fs.mkdirSync(path.join(data, "memory"), { recursive: true });
  fs.mkdirSync(self, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  return { t, data, self, out, manifest: path.join(out, "manifest.json"), bucket: (n) => path.join(out, n + ".json") };
}
function seed(env, content43) {
  wj(path.join(env.data, "memory", "100000001.json"), { updated: Date.now(), items: [
    { content: "我喜欢喝美式咖啡", channel: "private", groupId: 0 },
    { content: "下周三有组会", channel: "private", groupId: 0 },
    { content: "最近在学 agent", channel: "private", groupId: 0 },
  ] });
  wj(path.join(env.data, "memory", "43.json"), { updated: Date.now(), items: [
    { content: content43, channel: "private", groupId: 0 },
  ] });
}
function run(env, extra) {
  return spawnSync(PY, [DIGEST, "--data-dir", env.data, "--self-dir", env.self, "--out-dir", env.out, "--min", "1", ...extra], { cwd: ROOT, encoding: "utf8" });
}
function resOf(r) {
  const m = (r.stdout || "").match(/RESULT (\{[\s\S]*\})\s*$/);
  ok(m, "stdout 有 RESULT：" + r.stdout);
  return JSON.parse(m[1]);
}

check("A 成功 B 失败：partial 提交、失败 scope 旧文件保留", () => {
  const env = freshEnv(); seed(env, "__FAKE_FAIL__");
  wj(env.bucket("43"), { schema: 2, updated: "old", topics: [{ theme: "旧", insight: "旧认识", evidence: ["S_000000000000"] }] });
  const r = run(env, ["--fake-model", "good"]);
  eq(r.status, 2, "exit 2（部分成功）");
  const res = resOf(r);
  eq(res.all, false, "RESULT.all=false");
  eq(res.partial, true, "RESULT.partial=true");
  ok(res.ok.indexOf("100000001") >= 0, "主人桶在 ok 列表");
  ok(res.failed.indexOf("43") >= 0, "43 在 failed 列表");
  const dm = rj(env.bucket("100000001"));
  eq(dm.schema, 2, "schema=2");
  eq(dm.topics.length, 3, "主人 3 条 topic 全提交");
  eq(rj(env.bucket("43")).updated, "old", "失败 scope 旧文件未被覆盖");
  const mf = rj(env.manifest);
  eq(mf.scopes["43"].status, "failed", "manifest 43=failed");
  eq(mf.scopes["43"].fail_streak, 1, "fail_streak=1");
  eq(mf.scopes["100000001"].status, "ok", "manifest 主人=ok");
});

check("修复后重跑：成功 scope SKIP，失败 scope 重消化", () => {
  const env = freshEnv(); seed(env, "__FAKE_FAIL__");
  const r1 = run(env, ["--fake-model", "good"]);
  eq(r1.status, 2, "第一次部分失败");
  wj(path.join(env.data, "memory", "43.json"), { updated: Date.now(), items: [
    { content: "修好了，今天学完 agent", channel: "private", groupId: 0 },
  ] });
  const r2 = run(env, ["--fake-model", "good"]);
  eq(r2.status, 0, "第二次 exit 0");
  ok(r2.stdout.indexOf("SKIP 100000001") >= 0, "来源未变 scope 被 SKIP");
  const res = resOf(r2);
  eq(res.all, true, "第二次 all=true");
  ok(res.skipped.indexOf("100000001") >= 0, "skipped 列表含主人桶");
  const mf = rj(env.manifest);
  eq(mf.scopes["43"].status, "ok", "43 恢复 ok");
  ok(rj(env.bucket("43")).topics.length === 1, "43 新 digest 提交");
});

check("提交阶段崩溃：旧文件保留可读、manifest 记 failed", () => {
  const env = freshEnv(); seed(env, "普通记忆");
  const r1 = run(env, ["--fake-model", "good"]);
  eq(r1.status, 0, "先全成功");
  const before = fs.readFileSync(env.bucket("100000001"), "utf8");
  wj(path.join(env.data, "memory", "100000001.json"), { updated: Date.now(), items: [
    { content: "改过的记忆甲", channel: "private", groupId: 0 },
    { content: "改过的记忆乙", channel: "private", groupId: 0 },
  ] });
  wj(path.join(env.data, "memory", "43.json"), { updated: Date.now(), items: [
    { content: "改过的记忆丙", channel: "private", groupId: 0 },
  ] });
  const r2 = run(env, ["--fake-model", "good", "--txn-fail-replace"]);
  eq(r2.status, 2, "提交崩溃 exit 2");
  const res = resOf(r2);
  eq(res.partial, true, "partial=true");
  ok(rj(env.bucket("100000001")), "崩溃后旧 digest 仍可读");
  eq(fs.readFileSync(env.bucket("100000001"), "utf8"), before, "旧文件字节不变");
  const mf = rj(env.manifest);
  ok(res.failed.length === 1, "恰一个 scope 失败");
  eq(mf.scopes[res.failed[0]].status, "failed", "崩溃 scope manifest=failed");
  ok(fs.existsSync(env.bucket(res.failed[0]) + ".tmp"), "崩溃残留 .tmp（旧文件未被替换）");
});

check("空结果/坏结构：拒绝提交，不覆盖旧文件", () => {
  const env = freshEnv(); seed(env, "普通记忆");
  eq(run(env, ["--fake-model", "good"]).status, 0, "先成功一次");
  const beforeM = fs.readFileSync(env.bucket("100000001"), "utf8");
  wj(path.join(env.data, "memory", "100000001.json"), { updated: Date.now(), items: [
    { content: "又改了一次", channel: "private", groupId: 0 },
  ] });
  const r1 = run(env, ["--fake-model", "empty"]);
  eq(r1.status, 1, "empty 全失败 exit 1");
  eq(fs.readFileSync(env.bucket("100000001"), "utf8"), beforeM, "empty 不覆盖旧文件");
  wj(path.join(env.data, "memory", "100000001.json"), { updated: Date.now(), items: [
    { content: "再改一次", channel: "private", groupId: 0 },
  ] });
  const r2 = run(env, ["--fake-model", "badjson"]);
  eq(r2.status, 1, "badjson 全失败 exit 1");
  eq(fs.readFileSync(env.bucket("100000001"), "utf8"), beforeM, "badjson 不覆盖旧文件");
  ok(r1.stdout.indexOf("RESULT") >= 0 && r2.stdout.indexOf("RESULT") >= 0, "两次都有 RESULT");
});

check("静态断言：tick 部分失败不推进 dailyDue", () => {
  const src = fs.readFileSync(path.join(ROOT, "plugins", "memory-digest.js"), "utf8");
  ok(src.indexOf("if (!r.all)") >= 0, "tick 有 r.all 守卫");
  ok(src.indexOf("今天不标记完成") >= 0, "部分失败文案");
  ok(src.indexOf("RESULT") >= 0 && src.indexOf("digestStatus") >= 0, "runDigest 解析 RESULT + digestStatus 存在");
});

check("真实 data/ 目录零污染（文件清单+哈希不变）", () => {
  const env = freshEnv(); seed(env, "普通记忆");
  const real = path.join(ROOT, "data");
  const snap = () => {
    const out = {};
    for (const sub of ["memory", "memory-digest"]) {
      const d = path.join(real, sub);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).sort()) {
        const p = path.join(d, f);
        if (fs.statSync(p).isFile()) out[sub + "/" + f] = fs.readFileSync(p, "utf8");
      }
    }
    return JSON.stringify(out);
  };
  const before = snap();
  run(env, ["--fake-model", "good"]);
  eq(snap(), before, "真实 data/ 未变");
});

check("B20 失败保留 last_success（成功游标不丢）", () => {
  const env = freshEnv(); seed(env, "43 第一次正常内容");
  const r1 = run(env, ["--fake-model", "good"]);
  eq(r1.status, 0, "首次全成功");
  const ts1 = rj(env.manifest).scopes["43"].last_success;
  ok(typeof ts1 === "number" && ts1 > 0, "首次 last_success 已记录");
  wj(path.join(env.data, "memory", "43.json"), { updated: Date.now(), items: [{ content: "__FAKE_FAIL__", channel: "private", groupId: 0 }] });
  const r2 = run(env, ["--fake-model", "good"]);
  ok(r2.status !== 0, "第二次失败（exit " + r2.status + "，SKIP 桶不算成功）");
  const rec = rj(env.manifest).scopes["43"];
  eq(rec.status, "failed", "43 status=failed");
  eq(rec.last_success, ts1, "last_success 保留首次成功时间（不丢成功游标）");
  eq(rec.fail_streak, 1, "fail_streak=1");
});

console.log("== digest-txn: " + checks + " checks, " + failures.length + " failed ==");
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
