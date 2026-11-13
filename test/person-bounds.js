/* 分清楚人 P1 静态断言（v1.92.0）：
 * 1. proactive.js 意图文案不再写死「主人」，用 resolveCall 称呼
 * 2. evolReflectionText 按人过滤（from=0 或 from=userId）
 * 3. userPersona 非主人带「主人只有一个人」边界
 * 4. 群聊历史注入带发言人前缀（_histForChat），落盘原文不带前缀
 * 5. resolveCall 回退画像昵称（p.name） */
const fs = require("fs");
const path = require("path");
let fails = 0, total = 0;
function check(name, cond, detail) { total++; if (!cond) { fails++; console.log(`✗ ${name}${detail ? "：" + detail : ""}`); } }

const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const pro = fs.readFileSync(path.join(__dirname, "..", "plugins", "proactive.js"), "utf8");

// 1. proactive 去主人化
check("proactive 意图文案不再写死「给主人」", !pro.includes("给主人发一条早安") && !pro.includes("主动和主人说点什么"), pro.slice(pro.indexOf("_intents"), pro.indexOf("_intents") + 500));
check("proactive 用 _call 称呼", pro.includes("给${_call}发一条早安问候") && pro.includes("主动和${_call}说点什么"));
check("proactive recentQqChat 不再标「主人：」", !pro.includes('role === "user" ? "主人"'), pro.includes("resolveCall") ? "" : "无 resolveCall");

// 2. 反思按人过滤
const refl = extractFunc(src, "evolReflectionText");
check("evolReflectionText 按 from 过滤", refl.includes("from === 0 || from === Number(userId)"), refl.slice(0, 200));

// 3. 主人边界
const up = extractFunc(src, "userPersona");
check("userPersona 非主人带「主人只有一个人」", up.includes("主人只有一个人（QQ 100000001）"));

// 4. 群聊发言人
check("群聊历史注入用 _histForChat（带前缀副本）", src.includes("_histForChat") && src.includes('String(m.name).slice(0, 20) + "说："'));
check("群聊落盘存 name 字段", src.includes("if (_sn) _uMsg.name = _sn;"));

// 5. resolveCall 回退昵称
const rc = extractFunc(src, "resolveCall");
check("resolveCall 回退画像昵称 p.name", rc.includes("p.name && String(p.name) !== String(p.uid)"));

// 6. P2-b 群内收紧（roles.js）
const rolesSrc = fs.readFileSync(path.join(__dirname, "..", "plugins", "roles.js"), "utf8");
check("roles.js 有 GROUP_USER_ALLOW（chat/vision/sticker）", rolesSrc.includes('new Set(["chat", "vision", "sticker"])'));
check("roles.js can() 有 channel==='group' 收紧", rolesSrc.includes('channel === "group" && role === ROLE.USER'));

// 7. P2-a 朋友入口（appellations.js）
const appSrc = fs.readFileSync(path.join(__dirname, "..", "plugins", "appellations.js"), "utf8");
check("appellations.js 有 friend_list 工具", appSrc.includes('name: "friend_list"'));
check("appellations.js 有 /朋友 命令", appSrc.includes('key: "/朋友"'));

function extractFunc(code, fname) {
  const start = code.indexOf(`function ${fname}(`);
  if (start < 0) return "";
  let i = code.indexOf("{", start), depth = 0;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break; }
  }
  return code.slice(start, i + 1);
}

console.log(`person-bounds: ${total - fails}/${total} 通过`);
process.exit(fails ? 1 : 0);
