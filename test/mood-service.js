/* 框架服务 mood-service 测试（骨骼方案 S3） */
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}
const DIR = path.join(os.tmpdir(), "momo-mood-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

const mod = require("../plugins/mood-service.js");
const notes = [];
mod.init({
  DATA_DIR: DIR,
  log: () => {},
  loadActions: (n) => [{ action: "view_space", ts: Date.now() }],
  formatGap: (ms) => "刚才",
});
const m = mod.api.mood;

check("manifest system:true", mod.system === true);
check("manifest userScoped:false", mod.userScoped === false);
check("api 命名空间完整", ["loadMood","getMood","setMood","addMood","decayMood","getEmotion","setEmotion","emotionVal","applyEmotionInertia","moodLabel","moodPrompt","setActivity","activityCtx","actionLabel"].every((k) => typeof m[k] === "function"));

/* 心情 */
m.setMood(50);
check("setMood/getMood 往返", m.getMood() === 50);
m.setMood(999);
check("心情上限钳制 100", m.getMood() === 100);
m.setMood(-999);
check("心情下限钳制 -100", m.getMood() === -100);
m.addMood(30);
check("addMood 累加", m.getMood() === -70);
check("mood.json 已落盘", fs.existsSync(path.join(DIR, "mood.json")));

/* 情绪 */
check("初始情绪平静", m.getEmotion().name === "平静");
m.setEmotion("开心", 0.8);
check("setEmotion 生效", m.getEmotion().name === "开心" && Math.abs(m.getEmotion().intensity - 0.8) < 1e-9);
m.setEmotion("不存在的情绪", 0.5);
check("未知情绪名回退平静", m.getEmotion().name === "平静");
check("emotionVal 映射", m.emotionVal("开心") === 1 && m.emotionVal("难过") === -1 && m.emotionVal("不存在的") === 0);
check("emotion.json 已落盘", fs.existsSync(path.join(DIR, "emotion.json")));

/* 惯性 */
const inert = m.applyEmotionInertia({ name: "开心", intensity: 0.9 }, "难过", 0.9);
check("大跨度情绪走惯性过渡", inert.name !== "难过" && inert.intensity < 0.9);
const same = m.applyEmotionInertia({ name: "开心", intensity: 0.5 }, "开心", 0.9);
check("同情绪平滑叠加", same.name === "开心" && same.intensity > 0.5 && same.intensity <= 1);

/* moodPrompt */
m.setEmotion("平静", 0.05);
check("强度<0.15 时 moodPrompt 空串", m.moodPrompt() === "");
m.setEmotion("开心", 0.7);
check("moodPrompt 带情绪名", m.moodPrompt().includes("开心") && m.moodPrompt().includes("强度 70"));
check("moodLabel 跟随情绪", m.moodLabel() === "开心");

/* 活动 */
m.setActivity("在写报告");
let act = m.activityCtx();
check("activityCtx 反映 setActivity", act.includes("在写报告"));
check("setActivity 截断 30 字", m.loadActivityState().text.length <= 30);
/* 兜底：重置为发呆后，用 mock loadActions 补真实动作 */
m.setActivity("发呆");
const ctx2 = m.activityCtx();
check("发呆时兜底真实动作（看空间）", ctx2.includes("空间动态"));
check("actionLabel 未知返回空串", m.actionLabel("不存在") === "");

/* 衰减：刚更新过 → 不变 */
m.setMood(80);
m.decayMood();
check("1 分钟内 decayMood 不变", m.getMood() === 80);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
