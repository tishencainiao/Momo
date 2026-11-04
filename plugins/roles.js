/* 插件：角色与权限（管理员 / 用户 / 访客）
 * 阶段 1：只做「聚合视图 + 兼容层」——不改任何现有行为，供新功能统一识人。
 * 设计见 docs/roles-and-permissions.md。
 */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const ROLE = { ADMIN: "admin", USER: "user", VISITOR: "visitor", IGNORED: "ignored" };

/* 能力矩阵：新增能力没登记 = 默认拒绝（admin 也需显式登记，避免新功能漏权限） */
const MATRIX = {
  chat: { admin: true, user: true, visitor: true },
  memory_self: { admin: true, user: true, visitor: false },
  memory_digest: { admin: true, user: false, visitor: false },
  search: { admin: true, user: true, visitor: false },
  vision: { admin: true, user: true, visitor: false },
  voice: { admin: true, user: true, visitor: false },
  sticker: { admin: true, user: true, visitor: false },
  reminder_self: { admin: true, user: true, visitor: false },
  group_proactive: { admin: true, user: false, visitor: false },
  qzone: { admin: true, user: false, visitor: false },
  budget_view: { admin: true, user: false, visitor: false },
  self_evolve: { admin: true, user: false, visitor: false },
  pc_tools: { admin: true, user: false, visitor: false },
  config_write: { admin: true, user: false, visitor: false },
  manage_others: { admin: true, user: false, visitor: false },
};

/* 只作用于「本人」的能力：targetUid 不是自己时，只有 admin 能操作 */
const SELF_SCOPED = new Set(["memory_self", "reminder_self"]);

function setting(key, def) {
  try { const v = _ctx.getSetting(key, def); return v === undefined ? def : v; } catch (e) { return def; }
}
function qqCfg() { try { return (_ctx.config && _ctx.config.qq) || {}; } catch (e) { return {}; } }

function adminIds() {
  const q = qqCfg();
  const roles = q.roles || {};
  const list = Array.isArray(roles.admins) ? roles.admins.map(Number).filter((n) => n > 0) : [];
  const master = Number(q.master_user) || 0;
  if (!list.length && master) return [master];
  if (master && !list.includes(master)) list.push(master);   // 兜底锁：主人永不被锁死
  return list;
}
function userIds() {
  const q = qqCfg();
  const roles = q.roles || {};
  if (Array.isArray(roles.users)) return roles.users.map(Number).filter((n) => n > 0);
  return (Array.isArray(q.allowed_users) ? q.allowed_users : []).map(Number).filter((n) => n > 0);
}
function visitorsEnabled() {
  const q = qqCfg();
  const roles = q.roles || {};
  const cfgOn = roles.visitors && roles.visitors.enabled === true;
  return setting("perm.visitor.enabled", !!cfgOn);
}
function rateCfg() {
  const q = qqCfg();
  const r = (q.roles && q.roles.visitors && q.roles.visitors.rateLimit) || {};
  return {
    windowSec: Number(setting("perm.visitor.window_sec", r.windowSec || 60)) || 60,
    maxPerWindow: Number(setting("perm.visitor.max_per_window", r.maxPerWindow || 6)) || 6,
    dailyCap: Number(setting("perm.visitor.daily_cap", r.dailyCap || 50)) || 50,
    memoryCap: Number(setting("perm.visitor.memory_cap", (q.roles && q.roles.visitors && q.roles.visitors.memoryCap) || 200)) || 200,
  };
}

function resolveRole(uid) {
  const id = Number(uid) || 0;
  if (!id) return ROLE.IGNORED;
  if (adminIds().includes(id)) return ROLE.ADMIN;
  if (userIds().includes(id)) return ROLE.USER;
  return visitorsEnabled() ? ROLE.VISITOR : ROLE.IGNORED;
}

function loadJson(p, def) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return def; } }

function person(uid) {
  const id = Number(uid) || 0;
  const role = resolveRole(id);
  let appellation = null;
  try { appellation = (_ctx.loadAppellations() || {})[id] || null; } catch (e) {}
  const profile = loadJson(path.join(_ctx.DATA_DIR, "user-profile.json"), {})[String(id)] || null;
  let favor = 0;
  try { favor = Number(_ctx.getFavor(id)) || 0; } catch (e) {}
  let memoryCount = 0;
  try {
    let file = "";
    if (role === ROLE.ADMIN) {
      /* 主人记忆与桌宠互通：读桌宠的 sessions/<char>/memory.json */
      const pet = (_ctx.config && _ctx.config.pet) || {};
      const dir = pet.config_path ? path.dirname(pet.config_path) : "";
      if (dir) file = path.join(dir, "sessions", pet.character_id || "shenshen", "memory.json");
    } else {
      file = path.join(_ctx.DATA_DIR, "memory", String(id) + ".json");
    }
    if (file) {
      const arr = JSON.parse(fs.readFileSync(file, "utf8"));
      memoryCount = Array.isArray(arr) ? arr.length : 0;
    }
  } catch (e) {}
  const name = (profile && profile.nickname) || appellation || String(id);
  return {
    uid: id,
    role,
    name,
    appellation,
    profile,
    favor,
    memoryCount,
    isMaster: role === ROLE.ADMIN,
    isFriend: role === ROLE.USER,
    isStranger: role === ROLE.VISITOR || role === ROLE.IGNORED,
  };
}

function can(uid, capability, opts) {
  const role = resolveRole(uid);
  if (role === ROLE.IGNORED) return false;
  const cap = String(capability || "");
  let allow = !!(MATRIX[cap] && MATRIX[cap][role]);
  /* 运行时开关（管理员在 QQ 上可改） */
  if (role === ROLE.USER && cap === "search" && setting("perm.user.search", true) === false) allow = false;
  if (role === ROLE.USER && cap === "group_proactive" && setting("perm.user.group_proactive", false) === true) allow = true;
  if (role === ROLE.VISITOR && cap !== "chat") allow = false;
  if (role === ROLE.VISITOR && cap === "chat" && !visitorsEnabled()) allow = false;
  /* 参数级：本人自助类，动别人需要 admin */
  const target = opts && opts.targetUid != null ? Number(opts.targetUid) : Number(uid);
  if (allow && SELF_SCOPED.has(cap) && target !== Number(uid) && role !== ROLE.ADMIN) allow = false;
  return allow;
}

module.exports = {
  name: "roles",
  version: "1.0.0",
  init(ctx) { _ctx = ctx; },
  settings: [
    { key: "perm.user.search", label: "用户能用联网搜索", type: "boolean", default: true, desc: "关掉后「用户」角色不能联网搜索（省 API）" },
    { key: "perm.user.group_proactive", label: "用户能在群里主动插话", type: "boolean", default: false, desc: "默认关；打开后「用户」相关的群聊可以主动插话" },
    { key: "perm.visitor.enabled", label: "访客能聊天", type: "boolean", default: false, desc: "默认关（=陌生人被忽略）；打开后陌生人可以聊天，受下面的限速约束" },
    { key: "perm.visitor.window_sec", label: "访客限速窗口（秒）", type: "number", default: 60, min: 10, max: 600, desc: "在这个时间窗内最多发几条" },
    { key: "perm.visitor.max_per_window", label: "访客窗口内最多几条", type: "number", default: 6, min: 1, max: 30, desc: "窗口内超过这个数就不回" },
    { key: "perm.visitor.daily_cap", label: "访客每日上限", type: "number", default: 50, min: 1, max: 500, desc: "每天最多回访客几条" },
    { key: "perm.visitor.memory_cap", label: "访客记忆条数上限", type: "number", default: 200, min: 0, max: 2000, desc: "访客的本人记忆最多存多少条，防刷存储" },
  ],
  api: { roles: { resolveRole, can, person, ROLE, MATRIX, rateCfg, visitorsEnabled, adminIds, userIds } },
};
