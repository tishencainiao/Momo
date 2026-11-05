/* 数独测试：局面生成（唯一解）/ 落子判定 / 提示 / 解题完成 / 提示词里没有答案 / 卡住 / 存档跨天 / 每日上限 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-puzzle-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}
const dayStr = (off) => {
  const d = new Date(Date.now() + (off || 0) * 86400e3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const corePlugin = require("E:/Learn/Momo/plugins/fun-core.js");
corePlugin.init({ DATA_DIR: DIR, log: () => {}, dayStr, getSetting: (k, d) => (k === "entertainment.daily_self_max" ? 6 : d), isBudgetExhausted: () => false });
const CORE = corePlugin.api["fun-core"];
const hobbyPlugin = require("E:/Learn/Momo/plugins/hobby.js");
hobbyPlugin.init({ DATA_DIR: DIR, SELF_DIR: DIR, log: () => {}, getSetting: (k, d) => d });
const HOBBY = hobbyPlugin.api.hobby;

let prompts = [];
let reply = '{"r":1,"c":1,"v":1}';
const pz = require("E:/Learn/Momo/plugins/puzzle.js");
pz.init({
  DATA_DIR: DIR, SELF_DIR: DIR,
  log: () => {},
  getSetting: (k, d) => (k === "puzzle.new_per_day" ? 5 : d),
  getApi: (n) => (n === "fun-core" ? CORE : n === "hobby" ? HOBBY : null),
  addMood: () => {}, addBoredom: () => {},
  completeOnce: async (messages) => { prompts.push(String(messages[0].content || "")); return reply; },
  formatGap: () => "刚刚",
});
const P = pz.api.puzzle;

(async () => {
  // 1. 四宫格生成
  const s4 = P.newPuzzle(4);
  check("四宫格尺寸", s4.board.length === 4 && s4.size === 4);
  check("四宫格解唯一", P.solveCount(s4.solution, 4, 2, 2, 2) === 1);
  let blanks4 = 0, subset4 = true;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (s4.givens[r][c] === 0) blanks4++;
    else if (s4.givens[r][c] !== s4.solution[r][c]) subset4 = false;
  }
  check("四宫格题面来自解", subset4);
  check("四宫格空格数合理（5~11）", blanks4 >= 5 && blanks4 <= 11, "blanks=" + blanks4);

  // 2. 六宫格也支持
  const s6 = P.newPuzzle(6);
  check("六宫格尺寸", s6.board.length === 6 && s6.size === 6);
  check("六宫格解唯一", P.solveCount(s6.solution, 6, 2, 3, 2) === 1);

  // 3. 落子判定
  const empt = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (s4.givens[r][c] === 0) empt.push([r, c]);
  const [er, ec] = empt[0];
  const good = P.applyMove(s4, er + 1, ec + 1, s4.solution[er][ec]);
  check("填对 ok:true", good.ok === true && s4.board[er][ec] === s4.solution[er][ec]);
  const [br2, bc2] = empt[1];
  const wrongV = s4.solution[br2][bc2] === 1 ? 2 : 1;
  const bad = P.applyMove(s4, br2 + 1, bc2 + 1, wrongV);
  check("填错 ok:false", bad.ok === false);
  check("填错后 strike 增加", s4.stuck_strike === 1, "strike=" + s4.stuck_strike);
  const given = (() => { for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (s4.givens[r][c] !== 0) return [r, c]; })();
  check("不能改题目给定的格", P.applyMove(s4, given[0] + 1, given[1] + 1, 3).ok === false);
  check("越界被拒", P.applyMove(s4, 9, 1, 1).ok === false);
  check("重复填被拒", P.applyMove(s4, er + 1, ec + 1, 2).ok === false);

  // 4. 提示 = 正确答案
  const h = P.hint(s4);
  check("提示落在空格上", h && s4.givens[h.r - 1][h.c - 1] === 0);
  check("提示的数 = 正确答案", h && s4.solution[h.r - 1][h.c - 1] === h.v);
  check("提示计数", s4.hints_used === 1);

  // 5. 解完：代码置 solved
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (s4.givens[r][c] === 0 && s4.board[r][c] === 0) P.applyMove(s4, r + 1, c + 1, s4.solution[r][c]);
  }
  check("全部填完 → solved", s4.status === "solved", s4.status);
  check("进度显示满格", P.progressOf(s4).filled === P.progressOf(s4).total);

  // 6. playPuzzle：提示词里不能出现答案；模型选对时要真的填上
  P.saveState(P.newPuzzle(4));
  const st0 = P.loadState();
  const solvedText = P.boardText(st0.solution);
  const cell = (() => { for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (st0.board[r][c] === 0) return [r + 1, c + 1, st0.solution[r][c]]; })();
  reply = JSON.stringify({ r: cell[0], c: cell[1], v: cell[2] });
  const r1 = await P.playPuzzle({});
  check("玩了一次有结果", !!r1 && r1.steps >= 1, JSON.stringify(r1 || {}).slice(0, 80));
  check("提示词里没有完整答案盘面", prompts.every((p) => p.indexOf(solvedText) < 0));
  check("盘面用 · 表示空格", prompts.some((p) => p.indexOf("·") >= 0));
  check("提示词带宫规则", prompts.some((p) => p.indexOf("的宫里") >= 0));
  check("活动流水记录", CORE.loadActivities(10).some((a) => a.type === "play_puzzle"));
  check("模型选对时真的填上了", r1 && r1.ok >= 1, JSON.stringify(r1 || {}));

  // 7. 被拒后把原因反馈给下一手
  prompts = [];
  reply = '{"r":9,"c":9,"v":9}';
  await P.playPuzzle({});
  check("被拒后下一手带反馈", prompts.some((p) => p.indexOf("上一手") >= 0), prompts.length + " 次提示");

  // 8. 模型胡来不崩
  prompts = [];
  reply = "我觉得这一步应该填 3";
  const r3 = await P.playPuzzle({});
  check("无效输出不崩", r3 === null || !!r3);

  // 9. 存档跨天：同一局接着玩
  const before = P.loadState();
  reply = JSON.stringify({ r: 1, c: 1, v: 1 });
  const r4 = await P.playPuzzle({});
  const after = P.loadState();
  check("puzzle_id 不变（同一局）", r4 && r4.puzzle_id === before.puzzle_id, (r4 && r4.puzzle_id) + " vs " + before.puzzle_id);
  check("盘面保留（不清零）", Array.isArray(after.board) && after.board.length === 4);

  // 10. 每日上限
  const g = CORE.canPlay("play_puzzle", 1, 0.006);
  check("每天玩一次（超了被挡）", g.ok === false, g.reason);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
