const STATUS_RULES = [
  { kind: "sleep", re: /(?:我|已经)?(?:要|去|先)?睡(?:了|觉|啦)|晚安|困了|睡觉去|去睡|先睡了|要睡了/, hours: 6, label: "正在睡觉" },
  { kind: "nap", re: /午休|眯一会|眯一会儿|打个盹|小憩|躺一会/, hours: 2, label: "正在午休" },
  { kind: "work", re: /去上班|上班了|上班去|去工作|工作了|加班|在公司|要工作|开会/, hours: 2, label: "正在工作" },
  { kind: "study", re: /去学习|学习去|看书|写作业|复习|上课|去自习|刷题/, hours: 1.5, label: "正在学习" },
  { kind: "away", re: /出门|出去一下|出去一趟|在外面|在路上|出门了/, hours: 2, label: "出门了" },
];
const STATUS_CLEAR_RE = /我(?:醒|回来|起)了|起床了|我醒了|不睡了|下班了|回来了|我回来啦|醒了|醒啦|早啊|早上好/;

function classify(s) {
  if (STATUS_CLEAR_RE.test(s)) return "CLEAR";
  for (const r of STATUS_RULES) if (r.re.test(s)) return r.kind + "/" + r.hours + "h";
  return "none";
}
const cases = [
  ["我先睡了", "sleep/6h"],
  ["晚安", "sleep/6h"],
  ["我去午休了", "nap/2h"],
  ["眯一会儿", "nap/2h"],
  ["去上班了", "work/2h"],
  ["我下班了", "CLEAR"],
  ["去学习了", "study/1.5h"],
  ["我醒了", "CLEAR"],
  ["出门一下", "away/2h"],
  ["摸摸头，待会再见", "none"],
  ["1. OK，暂时先这样\n2. 我先睡了", "sleep/6h"],
  ["今天天气不错", "none"],
];
let pass = 0, fail = 0;
for (const [input, expect] of cases) {
  const got = classify(input);
  const ok = got === expect;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "✓" : "✗"} "${input.replace(/\n/g, "\\n")}" → ${got}${ok ? "" : "（期望 " + expect + "）"}`);
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
