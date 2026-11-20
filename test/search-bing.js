/* 测试：必应国内版搜索解析（parseBingHtml 离线 fixture + 字典退化兜底逻辑） */
const path = require("path");
const fs = require("fs");
const vm = require("vm");

const S = fs.readFileSync(path.join(__dirname, "..", "plugins", "search.js"), "utf8");
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL: " + name); } }

/* 1. 行为测试：parseBingHtml 用离线 fixture（不联网） */
const FIX = `
<li class="b_algo" data-h="ID=SERP,5310.1">
  <h2><a target="_blank" href="https://www.zhihu.com/question/1">王洋律师<b>是谁</b>？</a></h2>
  <p>王洋律师是一位讲离奇案件的<b>短视频博主</b>，常年在抖音更新。</p>
</li>
<li class="b_algo" data-h="ID=SERP,5310.2">
  <h2><a target="_blank" href="https://www.zhihu.com/question/1">重复链接不该出现</a></h2>
  <p>这条 URL 与第一条相同，应被去重。</p>
</li>
<li class="b_algo" data-h="ID=SERP,5310.3">
  <h2><a target="_blank" href="https://www.douyin.com/user/x">王洋律师的抖音主页</a></h2>
  <p>粉丝很多，案子讲得有意思。</p>
</li>`;

const ctx = { cleanText: (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() };
const search = require("../plugins/search.js");
search.init(ctx);
const parsed = search.api.search.parseBingHtml(FIX, 5);
check("parseBingHtml 提取 2 条（重复 URL 去重）", parsed.length === 2);
check("第一条标题去标签", parsed[0].title === "王洋律师是谁？");
check("第一条链接正确", parsed[0].url === "https://www.zhihu.com/question/1");
check("第一条摘要去标签", parsed[0].snippet === "王洋律师是一位讲离奇案件的短视频博主，常年在抖音更新。");
check("第二条是抖音", parsed[1].url.startsWith("https://www.douyin.com/"));
const limited = search.api.search.parseBingHtml(FIX, 1);
check("limit=1 只取一条", limited.length === 1);

/* 2. 字典退化兜底（离线静态断言）：检测「拼音」+ 最长段重试 */
const src = S;
check("bingSearch 检测字典词条（拼音）", src.includes('includes("拼音")'));
check("bingSearch 最长段重试", src.includes("b.length > a.length"));
check("bingSearch 重试后替换结果", src.includes("results = r2"));
check("api 含 bingSearch", Object.keys(search.api.search).includes("bingSearch"));
check("apiSpec 含 bingSearch", src.includes('"bingSearch"'));
check("bochaSearch 已移除", !src.includes("bochaSearch"));

/* 3. apiSpec 契约一致：api 与 apiSpec 函数名一一对应 */
const names = Object.keys(search.api.search).sort();
const spec = JSON.parse(src.match(/apiSpec:\s*(\{[\s\S]*?\}),\s*\n\s*api:/)[1].replace(/"sideEffect":"[^"]*"/g, '"sideEffect":"x"'));
const specNames = Object.keys(spec.search).sort();
check("api 与 apiSpec 函数名一致", JSON.stringify(names) === JSON.stringify(specNames));

console.log(`search-bing: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
