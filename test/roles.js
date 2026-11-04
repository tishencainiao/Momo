/* test/roles.js —— 角色与权限（v1.47.4 起） */
const assert = require("assert");
const path = require("path");
const ROLES = require(path.join(__dirname, "..", "plugins", "roles.js"));

function makeCtx(opts) {
  const o = opts || {};
  return {
    config: { qq: { master_user: 100000001, allowed_users: [100000002] } },
    getSetting: (k, d) => (Object.prototype.hasOwnProperty.call(o.settings || {}, k) ? o.settings[k] : d),
    loadAppellations: () => ({ 100000002: "小明" }),
    getFavor: (u) => (Number(u) === 100000002 ? 42 : 0),
    DATA_DIR: path.join(__dirname, "..", "data"),
    log: () => {},
  };
}

let n = 0;
function check(name, fn) { fn(); n++; console.log("✓ " + name); }

check("主人=admin", () => { ROLES.init(makeCtx()); assert.strictEqual(ROLES.api.roles.resolveRole(100000001), "admin"); });
check("朋友=user", () => { assert.strictEqual(ROLES.api.roles.resolveRole(100000002), "user"); });
check("陌生人默认忽略", () => { assert.strictEqual(ROLES.api.roles.resolveRole(199999999), "ignored"); });
check("访客开关打开后=visitor", () => {
  ROLES.init(makeCtx({ settings: { "perm.visitor.enabled": true } }));
  assert.strictEqual(ROLES.api.roles.resolveRole(199999999), "visitor");
});
check("主人全能力", () => { assert.strictEqual(ROLES.api.roles.can(100000001, "config_write"), true); });
check("用户不能改配置", () => { assert.strictEqual(ROLES.api.roles.can(100000002, "config_write"), false); });
check("用户可用搜索", () => { assert.strictEqual(ROLES.api.roles.can(100000002, "search"), true); });
check("搜索开关关掉后用户不能搜", () => {
  ROLES.init(makeCtx({ settings: { "perm.user.search": false } }));
  assert.strictEqual(ROLES.api.roles.can(100000002, "search"), false);
});
check("用户默认不能群主动", () => { ROLES.init(makeCtx()); assert.strictEqual(ROLES.api.roles.can(100000002, "group_proactive"), false); });
check("打开群主动开关后用户可用", () => {
  ROLES.init(makeCtx({ settings: { "perm.user.group_proactive": true } }));
  assert.strictEqual(ROLES.api.roles.can(100000002, "group_proactive"), true);
});
check("访客只能聊天", () => {
  ROLES.init(makeCtx({ settings: { "perm.visitor.enabled": true } }));
  assert.strictEqual(ROLES.api.roles.can(199999999, "chat"), true);
  assert.strictEqual(ROLES.api.roles.can(199999999, "search"), false);
});
check("参数级：用户不能碰别人记忆", () => {
  ROLES.init(makeCtx());
  assert.strictEqual(ROLES.api.roles.can(100000002, "memory_self", { targetUid: 100000001 }), false);
  assert.strictEqual(ROLES.api.roles.can(100000002, "memory_self", { targetUid: 100000002 }), true);
});
check("person 字段", () => {
  ROLES.init(makeCtx());
  const p = ROLES.api.roles.person(100000002);
  assert.strictEqual(p.role, "user");
  assert.strictEqual(p.appellation, "小明");
  assert.strictEqual(p.favor, 42);
  assert.strictEqual(p.isFriend, true);
});
check("访客限速：窗口内超限拒绝", () => {
  ROLES.init(makeCtx({ settings: { "perm.visitor.enabled": true, "perm.visitor.max_per_window": 2 } }));
  const R = ROLES.api.roles;
  R.resetRate();
  assert.strictEqual(R.rateOk(199999999), true);
  assert.strictEqual(R.rateOk(199999999), true);
  assert.strictEqual(R.rateOk(199999999), false);
});
check("访客限速：每日上限", () => {
  ROLES.init(makeCtx({ settings: { "perm.visitor.enabled": true, "perm.visitor.max_per_window": 100, "perm.visitor.daily_cap": 2 } }));
  const R = ROLES.api.roles;
  R.resetRate();
  assert.strictEqual(R.rateOk(199999998), true);
  assert.strictEqual(R.rateOk(199999998), true);
  assert.strictEqual(R.rateOk(199999998), false);
});
console.log(`\n✓ 全部 ${n} 个断言通过`);
