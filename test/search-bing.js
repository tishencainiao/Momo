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

/* 2. 字典退化兜底（离线静态断言 + 纯函数行为测试） */
const src = S;
check("bingSearch 用 isDictDominated 判定", src.includes("isDictDominated(results)"));
check("字典特征含（汉语文字）", src.includes('"（汉语文字）"'));
check("字典特征含 姓（中华姓氏）", src.includes('"姓（中华姓氏）"'));
check("判定=过半命中", src.includes("hit * 2 >= results.length"));
check("bingSearch 最长段重试", src.includes("b.length > a.length"));
check("bingSearch 重试后替换结果", src.includes("results = r2"));
check("api 含 bingSearch", Object.keys(search.api.search).includes("bingSearch"));
check("api 含 isDictDominated", Object.keys(search.api.search).includes("isDictDominated"));
check("apiSpec 含 bingSearch", src.includes('"bingSearch"'));
check("bochaSearch 已移除", !src.includes("bochaSearch"));

/* 2b. isDictDominated 行为（复刻真实退化页与正常页；摘要很长会吃掉拼接窗口，标题窗口必须独立判断） */
const D = search.api.search.isDictDominated;
check("「王」字字典退化页判定为 dominated（含混入的王姓/王者荣耀）", D([
  { title: "王 （汉语文字）_百度百科", snippet: "王（拼音：wáng、wàng）是汉语通用规范一级汉字（常用字） [1]，此字始见于商代甲骨文" },
  { title: "王 wáng、wàng、yù - 汉典", snippet: "王 wáng ㄨㄤˊ 古代一国君主的称号，现代有些国家仍用这种称号。 例如 ～国。～法。公子～孙。～朝" },
  { title: "王 （wáng、wàng）- 王 的意思与解释 | 汉语国学", snippet: "王字的甲骨文为斧钺之形，斧钺为礼器，象征王者之权威。 本义：天子、君主。 2. 殷周时代对帝王的称呼。 溥天之下，莫非王土。" },
  { title: "王 姓（中华姓氏之一）_百度百科", snippet: "2022年1月24日 王姓第1大省是山东，约占全国王姓总人口的14.7%，占山东总人口的12.7%。 在全国的分布主要集中于山东、河北。" },
  { title: "王者荣耀官方网站-腾讯游戏", snippet: "2026年9月25日 《王者荣耀》是腾讯天美工作室推出的英雄竞技手游，不是一个人的王者，而是团队的荣耀！" },
]) === true);
check("正常结果不误判（含长摘要）", D([
  { title: "抖音 王洋律师 是不是剧本？ - 知乎", snippet: "王洋律师是一位讲离奇案件的短视频博主，常年在抖音更新，粉丝很多，案子讲得有意思，评论区都在问是不是剧本。" },
  { title: "王洋律师 -快懂百科", snippet: "简介" },
  { title: "王洋律师 的抖音 - 抖音", snippet: "" },
]) === false);
check("空结果不算退化", D([]) === false);
check("单条正常结果不算退化", D([{ title: "王洋律师", snippet: "短视频博主" }]) === false);

/* 3. apiSpec 契约一致：api 与 apiSpec 函数名一一对应 */
const names = Object.keys(search.api.search).sort();
const spec = JSON.parse(src.match(/apiSpec:\s*(\{[\s\S]*?\}),\s*\n\s*api:/)[1].replace(/"sideEffect":"[^"]*"/g, '"sideEffect":"x"'));
const specNames = Object.keys(spec.search).sort();
check("api 与 apiSpec 函数名一致", JSON.stringify(names) === JSON.stringify(specNames));

console.log(`search-bing: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
