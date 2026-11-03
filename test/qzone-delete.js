#!/usr/bin/env node
/* QQ 空间删除测试（v1.46.1）：1 小时权限 / 需要点头 / 确认删除 / 本地状态清理 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-qzdel-"));

const calls = [];
const actions = [];
const plugin = require(path.join(ROOT, "plugins/qzone.js"));
plugin.init({
  DATA_DIR: tmp,
  log: () => {},
  dayStr: () => "2026-11-02",
  getSetting: (k, d) => (k === "qzone.delete_self_window_min" ? 60 : d),
  recordAction: (e) => actions.push(e),
  sendPrivate: () => {},
  qzoneHttp: async (action, params) => { calls.push({ action, params }); return action === "get_qzone_msg_list" ? { msglist: [{ tid: "remote1", content: "接口里的说说", time: Math.floor(Date.now() / 1000), comment_num: 0 }] } : null; },
});
const Q = plugin.api.qzone;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

const now = Date.now();
const state = {
  dates: { "2026-11-02": 2 },
  posts: [
    { tid: "old001", ts: now - 3 * 3600e3, content: "三小时前发的", comments: 0 },
    { tid: "new002", ts: now - 5 * 60000, content: "五分钟前发的", comments: 0 },
  ],
};
fs.writeFileSync(path.join(tmp, "qzone-state.json"), JSON.stringify(state));

function readState() { return JSON.parse(fs.readFileSync(path.join(tmp, "qzone-state.json"), "utf8")); }
function readPending() { try { return JSON.parse(fs.readFileSync(path.join(tmp, "qzone-pending.json"), "utf8")); } catch (e) { return {}; } }

(async () => {
  // 1. 列表：新的在前
  const list = await Q.recentPosts(5);
  check("本地列表新的在前", list[0].tid === "new002" && list[1].tid === "old001", JSON.stringify(list.map((x) => x.tid)));
  check("列表文案带序号", (await Q.postsListText(5)).includes("1."));

  // 2. 1 小时内：直接删
  let r = await Q.tryDeleteOwn("new002", 100000001, {});
  check("1 小时内可以直接删", r.ok === true, r.msg);
  check("调用了 delete_qzone_msg", calls.some((c) => c.action === "delete_qzone_msg" && c.params.tid === "new002"), JSON.stringify(calls));
  check("本地记录已移除", !readState().posts.some((p) => p.tid === "new002"));
  check("当天配额回退一条", readState().dates["2026-11-02"] === 1, String(readState().dates["2026-11-02"]));
  check("动作日志带 by", actions.some((a) => a.action === "qzone_delete" && a.by === 100000001));

  // 3. 超过 1 小时：要点头，不能直接删
  const before = calls.filter((c) => c.action === "delete_qzone_msg").length;
  r = await Q.tryDeleteOwn("old001", 100000001, {});
  check("超时要主人点头", r.ok === false && r.needConfirm === true, JSON.stringify(r));
  check("超时不能真的删", calls.filter((c) => c.action === "delete_qzone_msg").length === before);
  check("超时会挂起待确认", readPending().tid === "old001", JSON.stringify(readPending()));
  check("提示里给了确认方式", String(r.msg).includes("确认"), r.msg);

  // 4. 确认后删除
  r = await Q.confirmDeletePending(100000001);
  check("确认后删除成功", r.ok === true, r.msg);
  check("删除后本地清空", readState().posts.length === 0);
  check("待确认记录已清除", !readPending().tid);

  // 5. 再确认一次应失败（没有待确认）
  r = await Q.confirmDeletePending(100000001);
  check("没有挂起时确认会失败", r.ok === false, r.msg);

  // 6. 删别人的（不在本地记录里）应拒绝
  r = await Q.tryDeleteOwn("someone_else_tid", 100000001, { confirmed: true });
  check("不删不在自己记录里的说说", r.ok === false, r.msg);

  // 7. 本地不够时回落接口
  const remote = await Q.recentPosts(5);
  check("本地空了会拉接口", remote.length > 0 && remote[0].tid === "remote1", JSON.stringify(remote.map((x) => x.tid)));

  // 7b. 只有接口记录、本地没存过 tid 的历史说说，也要能删
  const r2 = await Q.tryDeleteOwn("remote1", 100000001, {});
  check("接口来的说说也能删", r2.ok === true, r2.msg);

  // 8. 源码级：命令与工具都接上了
  const src = fs.readFileSync(path.join(ROOT, "plugins/qzone.js"), "utf8");
  check("注册了 /删说说 命令", src.includes('key: "/删说说"'));
  check("注册了 qzone_delete 工具", src.includes('name: "qzone_delete"'));
  check("走 delete_qzone_msg 动作", src.includes('"delete_qzone_msg"'));
  check("权限窗口可配置", src.includes("qzone.delete_self_window_min"));
  check("删除会记动作日志", src.includes('action: "qzone_delete"'));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
