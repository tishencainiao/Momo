/* 插件：玩一局谜题（play_puzzle）—— 数独，带存档、跨天、代码判定
 * 为什么默认四宫格：实测 flash 解六宫格失败率很高（连错三次直接卡住），娱乐会变成折磨；
 * 四宫格（2×2 宫）她能真做对，才有"赢了的情绪"。settings 里可切回六宫格。
 * 三道锁（防"她说自己玩过了"）：
 *   ① 局面由代码生成，答案 solution 只存盘、永不进模型输入
 *   ② 落子对错只由代码判定（行列宫冲突 + 与唯一解比对），写进 moves
 *   ③ 只有代码把 status 置为 solved 之后，才允许她说"我解出来了"
 * 卡住有出口：连续 3 次填错 → status=stuck（诚实记"卡住了"）；她也可以申请提示（真动作，可明说）。
 * 存档：data/puzzle.json */
const fs = require("fs");
const path = require("path");
let _ctx = null;

const DIMS = { 4: { boxR: 2, boxC: 2 }, 6: { boxR: 2, boxC: 3 } };

const stateFile = () => path.join(_ctx.DATA_DIR, "puzzle.json");
function loadState() { try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")) || null; } catch (e) { return null; } }
function saveState(s) { try { fs.mkdirSync(_ctx.DATA_DIR, { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch (e) {} }

function movesPerDay() { return Number(_ctx.getSetting("puzzle.moves_per_day", 3)) || 3; }
function newPuzzleMaxPerDay() { return Number(_ctx.getSetting("puzzle.new_per_day", 1)) || 1; }
function puzzleSize() { const n = Number(_ctx.getSetting("puzzle.size", 4)) || 4; return DIMS[n] ? n : 4; }
function dimsOf(state) { const n = (state && state.size) || puzzleSize(); return Object.assign({ size: n }, DIMS[n] || DIMS[4]); }

/* ---------- 生成：随机回溯填满 + 挖空并保持唯一解 ---------- */
function emptyGrid(size) { return Array.from({ length: size }, () => new Array(size).fill(0)); }
function clone(g) { return g.map((r) => r.slice()); }

function candidates(g, r, c, size, boxR, boxC) {
  const used = new Set();
  for (let i = 0; i < size; i++) { used.add(g[r][i]); used.add(g[i][c]); }
  const br = Math.floor(r / boxR) * boxR, bc = Math.floor(c / boxC) * boxC;
  for (let i = 0; i < boxR; i++) for (let j = 0; j < boxC; j++) used.add(g[br + i][bc + j]);
  const out = [];
  for (let v = 1; v <= size; v++) if (!used.has(v)) out.push(v);
  return out;
}

function solveCount(g, size, boxR, boxC, limit) {
  const grid = clone(g);
  let count = 0;
  function rec() {
    if (count >= limit) return;
    let br = -1, bc = -1, best = null;
    outer: for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (grid[r][c] !== 0) continue;
      const cand = candidates(grid, r, c, size, boxR, boxC);
      if (!cand.length) return;
      if (!best || cand.length < best.length) { best = cand; br = r; bc = c; }
      if (cand.length === 1) break outer;
    }
    if (br < 0) { count++; return; }
    for (const v of best) {
      grid[br][bc] = v;
      rec();
      grid[br][bc] = 0;
      if (count >= limit) return;
    }
  }
  rec();
  return count;
}

function randomSolution(size, boxR, boxC) {
  const grid = emptyGrid(size);
  function rec() {
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (grid[r][c] !== 0) continue;
      const cand = candidates(grid, r, c, size, boxR, boxC);
      if (!cand.length) return false;
      for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
      for (const v of cand) {
        grid[r][c] = v;
        if (rec()) return true;
        grid[r][c] = 0;
      }
      return false;
    }
    return true;
  }
  rec();
  return grid;
}

/* 挖空：随机移除格子，保证仍有唯一解 */
function digPuzzle(solution, blanks, size, boxR, boxC) {
  const board = clone(solution);
  const cells = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) cells.push([r, c]);
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  let removed = 0;
  for (const [r, c] of cells) {
    if (removed >= blanks) break;
    const keep = board[r][c];
    board[r][c] = 0;
    if (solveCount(board, size, boxR, boxC, 2) !== 1) board[r][c] = keep;
    else removed++;
  }
  return board;
}

function newPuzzle(sizeArg) {
  const size = sizeArg || puzzleSize();
  const d = DIMS[size] || DIMS[4];
  const solution = randomSolution(size, d.boxR, d.boxC);
  const blanks = size === 4 ? (6 + Math.floor(Math.random() * 3)) : (14 + Math.floor(Math.random() * 4));
  const givens = digPuzzle(solution, blanks, size, d.boxR, d.boxC);
  return {
    puzzle_id: `sudoku${size}-` + Date.now().toString(36), size,
    givens, board: clone(givens), solution,
    moves: [], status: "playing", hints_used: 0, stuck_strike: 0,
    created_ts: Date.now(), last_played: 0, day_moves: 0,
  };
}

/* ---------- 判定 ---------- */
function conflicts(board, r, c, v, size, boxR, boxC) {
  for (let i = 0; i < size; i++) {
    if (i !== c && board[r][i] === v) return "这一行已经有 " + v + " 了";
    if (i !== r && board[i][c] === v) return "这一列已经有 " + v + " 了";
  }
  const br = Math.floor(r / boxR) * boxR, bc = Math.floor(c / boxC) * boxC;
  for (let i = 0; i < boxR; i++) for (let j = 0; j < boxC; j++) {
    if ((br + i !== r || bc + j !== c) && board[br + i][bc + j] === v) return "这个宫里已经有 " + v + " 了";
  }
  return "";
}
function isGiven(state, r, c) { return state.givens[r][c] !== 0; }
function progressOf(state) {
  const { size } = dimsOf(state);
  let filled = 0, total = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (state.givens[r][c] === 0) { total++; if (state.board[r][c] !== 0) filled++; }
  return { filled, total, text: `${filled}/${total} 格` };
}

/* 落子：唯一入口，对错只由这里判定 */
function applyMove(state, r, c, v) {
  const { size, boxR, boxC } = dimsOf(state);
  const rr = Number(r) - 1, cc = Number(c) - 1, vv = Number(v);
  if (!(rr >= 0 && rr < size && cc >= 0 && cc < size)) return { ok: false, reason: `格子超出范围（行/列都是 1~${size}）` };
  if (!(vv >= 1 && vv <= size)) return { ok: false, reason: `只能填 1~${size}` };
  if (isGiven(state, rr, cc)) return { ok: false, reason: "这一格是题目给定的，不能改" };
  if (state.board[rr][cc] !== 0) return { ok: false, reason: "这一格已经填过了" };
  const bad = conflicts(state.board, rr, cc, vv, size, boxR, boxC);
  const move = { ts: Date.now(), r: rr, c: cc, v: vv, ok: false };
  if (bad) {
    move.reason = bad;
    state.moves.push(move);
    state.stuck_strike = (state.stuck_strike || 0) + 1;   // 填错就是错：被冲突挡住也算错
    return { ok: false, reason: bad, move };
  }
  if (state.solution[rr][cc] !== vv) {
    move.reason = "这个数不对";
    state.moves.push(move);
    state.stuck_strike = (state.stuck_strike || 0) + 1;
    return { ok: false, reason: "这个数不对", move };
  }
  state.board[rr][cc] = vv;
  move.ok = true;
  state.moves.push(move);
  state.stuck_strike = 0;
  const pr = progressOf(state);
  if (pr.filled === pr.total) state.status = "solved";
  return { ok: true, move };
}

/* 提示：找一个还没填的格，优先"唯一候选"的，返回答案（真的查了攻略，可以明说） */
function hint(state) {
  const { size, boxR, boxC } = dimsOf(state);
  let best = null;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (state.board[r][c] !== 0) continue;
    const cand = candidates(state.board, r, c, size, boxR, boxC);
    if (!best || cand.length < best.cand) best = { r, c, cand: cand.length, v: state.solution[r][c] };
    if (best.cand === 1) break;
  }
  if (!best) return null;
  state.hints_used = (state.hints_used || 0) + 1;
  return { r: best.r + 1, c: best.c + 1, v: best.v, candidates: best.cand };
}

function boardText(board) {
  const size = board.length;
  const half = Math.ceil(size / 2);
  return board.map((row, i) => {
    const cells = row.map((v) => (v === 0 ? "·" : String(v)));
    return `${i + 1}  ${cells.slice(0, half).join(" ")} | ${cells.slice(half).join(" ")}`;
  }).join("\n");
}

function journalAppend(entry) {
  try {
    const p = path.join(_ctx.SELF_DIR, "journal.json");
    let arr = [];
    try { const d = JSON.parse(fs.readFileSync(p, "utf8")); if (Array.isArray(d)) arr = d; } catch (e) {}
    arr.push(Object.assign({ ts: Date.now(), from: "puzzle" }, entry));
    while (arr.length > 200) arr.shift();
    fs.mkdirSync(_ctx.SELF_DIR, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(arr));
  } catch (e) {}
}

/* 候选数表：只按规则（行列宫不重复）推算每个空格"还能填哪些数"，不是答案，只是铅笔标记。
 * 给她这张表她才能真的推理（也符合人玩数独的习惯：先标候选数）。 */
function candidatesText(state, limit) {
  const { size, boxR, boxC } = dimsOf(state);
  const rows = [];
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (state.board[r][c] !== 0) continue;
    const cand = candidates(state.board, r, c, size, boxR, boxC);
    if (!cand.length) continue;
    rows.push(`第${r + 1}行第${c + 1}列 → ${cand.join("/")}`);
    if (rows.length >= (limit || 12)) return rows.join("；");
  }
  return rows.join("；");
}

/* 让模型决定一步：给盘面 + 候选数 + 上一手反馈，永不给答案 */
async function decideStep(state, settings, feedback) {
  const { size, boxR, boxC } = dimsOf(state);
  const prompt = `你在玩一局 ${size}×${size} 数独。规则：每行、每列、每个 ${boxR}行×${boxC}列 的宫里，1~${size} 各出现一次。
当前盘面（· 是空格，行号在左边，已填的数都是对的）：
${boardText(state.board)}

每个空格的候选数（按规则推出来的，不一定唯一）：
${candidatesText(state) || "（没有空格了）"}
${feedback ? "上一手的结果：" + feedback : ""}
请决定下一步填哪一格：优先选候选数只有 1 个的格子；如果都有多个，挑一个你觉得最稳的。只输出 JSON（不要解释、不要代码块）：
{"r":行号1-${size},"c":列号1-${size},"v":数字1-${size}}
如果你实在推不出来，可以输出 {"hint":true} 要一个提示；如果想放弃这局，输出 {"giveUp":true}。`;
  const raw = await _ctx.completeOnce([{ role: "user", content: prompt }], settings, 120, 0.4);
  const m = String(raw || "").match(/\{[\s\S]*?\}/);
  if (!m) return { action: "invalid", raw: String(raw || "").slice(0, 80) };
  let obj = {};
  try { obj = JSON.parse(m[0]); } catch (e) { return { action: "invalid", raw: m[0].slice(0, 80) }; }
  if (obj.giveUp) return { action: "giveUp" };
  if (obj.hint) return { action: "hint" };
  if (obj.r && obj.c && obj.v) return { action: "move", r: obj.r, c: obj.c, v: obj.v };
  return { action: "invalid", raw: m[0].slice(0, 80) };
}

/* 主流程：玩一次（最多 N 个成功落子） */
async function playPuzzle(settings) {
  const core = _ctx.getApi && _ctx.getApi("fun-core");
  if (!core) { _ctx.log("warn", "玩谜题：fun-core 未加载"); return null; }
  const gate = core.canPlay("play_puzzle", newPuzzleMaxPerDay(), 0.006);
  if (!gate.ok) { _ctx.log("info", `玩谜题跳过：${gate.reason}`); return null; }

  let state = loadState();
  let isNew = false;
  if (!state || !Array.isArray(state.board) || (state.status !== "playing" && state.status !== "stuck")) { state = newPuzzle(); isNew = true; }
  if (state.status === "stuck") { state.status = "playing"; state.stuck_strike = 0; }   // 隔天接着来

  const maxOk = movesPerDay();       // 每次最多"成功填对"几格
  const maxTries = maxOk + 5;        // 允许几次无效/被拒的尝试，避免死循环烧钱
  let steps = 0, okCount = 0, badCount = 0, hintUsed = 0, gaveUp = false;
  let feedback = "";
  const log = [];

  while (okCount < maxOk && steps < maxTries && state.status === "playing") {
    const decision = await decideStep(state, settings, feedback);
    steps++;
    if (decision.action === "giveUp") { state.status = "abandoned"; gaveUp = true; log.push("放弃"); break; }
    if (decision.action === "hint") {
      const h = hint(state);
      hintUsed++;
      feedback = h ? `我查了提示：第${h.r}行第${h.c}列应该是 ${h.v}。` : "";
      log.push(h ? `查提示 → 第${h.r}行第${h.c}列是 ${h.v}` : "没有空格可提示了");
      try { _ctx.addBoredom && _ctx.addBoredom(-2); } catch (e) {}
      saveState(state);
      continue;
    }
    if (decision.action !== "move") {
      feedback = '上一步输出格式不对，必须只输出 {"r":行,"c":列,"v":数} 这样的 JSON。';
      log.push("没给出有效落子");
      continue;
    }
    const res = applyMove(state, decision.r, decision.c, decision.v);
    if (res.ok) {
      okCount++;
      feedback = `上一步第${decision.r}行第${decision.c}列填 ${decision.v} 是对的。`;
      log.push(`第${decision.r}行第${decision.c}列填 ${decision.v} ✓`);
      try { _ctx.addMood && _ctx.addMood(1); _ctx.addBoredom && _ctx.addBoredom(-5); } catch (e) {}
    } else {
      badCount++;
      feedback = `上一步第${decision.r}行第${decision.c}列填 ${decision.v} 被拒绝了（${res.reason}），别重复同一手。`;
      log.push(`第${decision.r}行第${decision.c}列填 ${decision.v} ✗（${res.reason}）`);
      try { _ctx.addBoredom && _ctx.addBoredom(3); } catch (e) {}
      if (state.stuck_strike >= 3) { state.status = "stuck"; log.push("连错三次，先放着"); break; }
    }
    saveState(state);
  }

  state.last_played = Date.now();
  state.day_moves = (state.day_moves || 0) + steps;
  saveState(state);

  const prog = progressOf(state);
  if (state.status === "solved") {
    try { _ctx.addMood && _ctx.addMood(5); } catch (e) {}
    journalAppend({ text: `我把那局${state.size}×${state.size}数独解出来了（用了 ${state.hints_used} 次提示）。` });
  } else if (state.status === "stuck") {
    journalAppend({ text: `数独那局我卡住了，填错好几格，先放着，明天再试试。现在进度 ${prog.text}。` });
  } else if (gaveUp) {
    journalAppend({ text: `那局数独我放弃了，没解出来（${prog.text}）。` });
  } else if (okCount || badCount) {
    journalAppend({ text: `玩了会儿数独，填了 ${okCount} 格对的${badCount ? `、错了 ${badCount} 次` : ""}，现在 ${prog.text}。` });
  }

  core.addFunSpent(0.006);
  core.appendActivity({
    type: "play_puzzle", ok: !!(okCount || hintUsed), puzzle_id: state.puzzle_id, size: state.size,
    steps, ok: okCount, bad: badCount, hints: hintUsed, status: state.status, progress: prog.text, is_new: isNew,
  });
  if ((okCount || 0) > 0 || hintUsed > 0) {
    const h = _ctx.getApi("hobby");
    if (h) { try { h.vote("数独", "play", { puzzle_id: state.puzzle_id, progress: prog.text }); } catch (e) {} }
  }

  _ctx.log("info", `玩了数独（${state.size}×${state.size}）：${log.join("；").slice(0, 160)}（进度 ${prog.text}，状态 ${state.status}）`);
  return { puzzle_id: state.puzzle_id, size: state.size, steps, ok: okCount, bad: badCount, hints: hintUsed, status: state.status, progress: prog.text, log, isNew };
}

/* 注入上下文用：她有一局玩到哪了 */
function puzzleCtx() {
  const s = loadState();
  if (!s || s.status === "solved" || s.status === "abandoned") return "";
  const p = progressOf(s);
  const when = s.last_played ? `上次玩是 ${_ctx.formatGap ? _ctx.formatGap(Date.now() - s.last_played) : "之前"}` : "还没开始玩";
  return `【你的数独】有一局 ${s.size}×${s.size} 数独玩到 ${p.text}（${when}，用了 ${s.hints_used || 0} 次提示）${s.status === "stuck" ? "，上一轮卡住了，可以接着试" : ""}。`;
}

module.exports = {
  name: "puzzle",
  displayName: "玩谜题",
  description: "数独，带存档、跨天、代码判定",
  permissions: ["DATA_DIR", "SELF_DIR", "addBoredom", "addMood", "completeOnce", "formatGap", "getApi", "getSetting", "log"],
  version: "1.0.0",
  requires: ["fun-core", "hobby"],
  init(ctx) { _ctx = ctx; },
  settings: [
    { key: "puzzle.size", label: "数独尺寸（4 或 6）", type: "number", default: 4, min: 4, max: 6, desc: "4=四宫格（flash 更容易做对），6=六宫格（更难）" },
    { key: "puzzle.moves_per_day", label: "每次最多填对几格", type: "number", default: 3, min: 1, max: 10, desc: "一天一次，填对这么多格就收工" },
    { key: "puzzle.new_per_day", label: "每天最多玩几次", type: "number", default: 1, min: 1, max: 3, desc: "建议 1 次" },
  ],
  apiSpec: {"puzzle":{"playPuzzle":{"input":"","output":"","sideEffect":""},"puzzleCtx":{"input":"","output":"","sideEffect":""},"loadState":{"input":"","output":"","sideEffect":"只读"},"saveState":{"input":"","output":"","sideEffect":"写盘"},"newPuzzle":{"input":"","output":"","sideEffect":""},"applyMove":{"input":"","output":"","sideEffect":""},"hint":{"input":"","output":"","sideEffect":""},"progressOf":{"input":"","output":"","sideEffect":""},"boardText":{"input":"","output":"","sideEffect":""},"solveCount":{"input":"","output":"","sideEffect":""},"candidates":{"input":"","output":"","sideEffect":""},"dimsOf":{"input":"","output":"","sideEffect":""}}},

  api: { puzzle: { playPuzzle, puzzleCtx, loadState, saveState, newPuzzle, applyMove, hint, progressOf, boardText, solveCount, candidates, dimsOf } },
};
