// 身份错误回归库：每条断言对应一次真实事故（HaluEval 式——用出过错的例子防复发）
const fs = require("fs");
const path = require("path");
const R = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const idx = R("index.js");
const ts = R("plugins/time-service.js");
const pro = R("plugins/proactive.js");
const evo = R("plugins/evolution.js");
const rep = R("plugins/report.js");
const vis = R("plugins/vision.js");
const doc = R("scripts/plugin-doctor.js");
let pass = 0, fail = 0;
const T = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log("FAIL " + name + (extra ? " :: " + extra : "")); } };

T("事故 2026-11-08 咖啡/奶茶串味 → report 归属边界", rep.includes("主人告诉你的偏好/习惯") && rep.includes("是「主人的」，不是「你的」"));
T("事故 2026-11-08 咖啡/奶茶串味 → userPersona lessons 头", idx.includes("里面提到的「主人」是主人本人，不是你自己"));
T("事故 2026-11-11 抢功记忆 → DEED_CLAIM_RE 拦「我推荐的」", /\(自己\|我\)\(推荐\|提议\|建议\|安利\)\(了\|的\)/.test(evo) && /自己\|我/.test(evo));
T("事故 2026-11-13 朋友早安写死主人 → proactive 无「给主人发」", !/给主人发一条(早安|晚安)/.test(pro) && pro.includes("_call"));
T("事故 2026-11-13 反思跨人串台 → evolReflectionText 按人过滤", /from === 0 \|\| from === Number\(userId\)/.test(idx));
T("事故 2026-11-13 群聊张冠李戴 → 历史带「XX说：」前缀", idx.includes('+ "说：" + m.content') && idx.includes("_histForChat"));
T("事故 2026-11-09 念头 [object Object] → selfStatus 取 .text", !/\.slice\(-3\)\.join\("；"\)/.test(evo) && (evo.includes("thoughtTexts") || /\.text/.test(evo)));
T("事故 2026-11-09 看图崩溃 → describeImage 用 let", /let desc\s*=/.test(vis));
T("事故 2026-11-09 爱说时间 → 不再指令「提到这个间隔」", !idx.includes("回应时请自然地提到这个间隔") && (idx.includes("时间仅作背景参考") || ts.includes("时间仅作背景参考")));
T("事故 2026-11-15 前提当事实 → proactive 硬规则", pro.includes("对方没确认过结果的事") && pro.includes("禁止用陈述句断言"));
T("事故 2026-11-15 跨时空重复 → proactive-log 持久化去重", idx.includes("proactiveLoggedDup") && idx.includes("appendProactiveLog"));
T("分人守则 §9 → doctor 强制 userScoped 声明", doc.includes("userScoped"));
/* E1~E5 变聪明五件（2026-11-18 方案 M1） */
T("E1 → think 阈值放宽（20 字/8 字问句）", idx.includes("t.length >= 20") && idx.includes("t.length >= 8"));
T("E1 → 连续第 3 轮强制思考", idx.includes("thinkStreak") && idx.includes("_consec >= 3"));
T("E1 → daily_cny 2", (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8")).budget.daily_cny === 2; } catch (e) { return false; } })());
T("E2 → premise 纠正置顶注入", idx.includes("premiseReminders") && idx.includes("【主人纠正过你的话（最高优先，别犯第二次）】") && idx.includes('from === "premise"'));
T("E3 → 跨通道镜头装配", idx.includes("channelLens") && idx.includes("【你们在 QQ 里最近聊的") && idx.includes("【你们在桌宠窗口里最近聊的"));
T("E3 → 桌宠对话落盘 pet 会话", idx.includes('loadSession("pet" + master)'));
T("E5 → 计划保鲜 annotatePlan 豁免", R("plugins/memory-service.js").includes("annotatePlan") && R("plugins/memory-service.js").includes('status !== "已过"'));

console.log(`person-regression: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
