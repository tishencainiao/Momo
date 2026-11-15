// R2 上下文四区 + 分级预算（静态断言）
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
let pass = 0, fail = 0;
const T = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log("FAIL " + name + (extra ? " :: " + extra : "")); } };

T("四档分级表 _tierLv 定义", /const _tierLv = \{ full: 3, low: 2, flash: 1, minimal: 0 \}/.test(src));
T("总长度预算 _dbudget（6000/4000/2400/1200）", /const _dbudget = \{ full: 6000, low: 4000, flash: 2400, minimal: 1200 \}/.test(src));
T("_dput 带预算截断", /if \(_dynLen \+ s\.length > _dbudget\) return;/.test(src));
T("区一必读·时间不设档", /const _td = timeDirective\(\);[\s\S]{0,80}if \(_td\) _dput\("now", _td\);/.test(src));
T("区一必读·活动/运行状态/生活费无档位门", /_dput\("now", activityCtx\(\)\);/.test(src) && /_dput\("now", `【你的运行状态】/.test(src) && /_dput\("now", `【生活费】/.test(src));
T("区二记忆有档位门 _tierLv>=1", /if \(_tierLv >= 1\) \{[\s\S]{0,200}if \(memories && memories\.length\)/.test(src));
T("区二用户画像/心情在档位内", /_dput\("mem", _up\);/.test(src) && /_dput\("mem", _esp\);/.test(src));
T("好感在区二且档位内", /_dput\("mem", favorPrompt\(userId\)\);/.test(src));
T("区三任务档位门", /if \(_tierLv >= 1\) \{[\s\S]{0,120}_dput\("todo", `【你之前想过要做/.test(src));
T("区四装饰 full 档(>=3)含 sticker/pulse/headpat/身体感觉", /if \(_tierLv >= 3\) \{/.test(src) && /_dput\("extra", sp\);/.test(src) && /_dput\("extra", _pulse\);/.test(src) && /_dput\("extra", _hp\);/.test(src) && /_dput\("extra", _sr\);/.test(src) && /contextProvider/.test(src));
T("metaCtx 需 low 档以上(>=2)", /if \(_tierLv >= 2\) \{[\s\S]{0,120}metaCtx/.test(src));
T("内心戏仍只随 _think", /if \(_think\) \{[\s\S]{0,120}【回答前】内心/.test(src) && /【回答前自查】/.test(src));
T("四区排版头【此刻/你记得的/要做的事/顺带的】", /【此刻】/.test(src) && /【你记得的】/.test(src) && /【要做的事】/.test(src) && /【顺带的】/.test(src));
T("区序 now→mem→todo→extra", /for \(const z of \["now", "mem", "todo", "extra"\]\)/.test(src));
const _tierCount = (src.match(/const _tier = budgetTier\(\);/g) || []).length;
T("_tier 只算一次且移到动态块上方", _tierCount === 1 && src.indexOf("/* R2：_tier 已在动态块上方计算") >= 0);
T("旧的平铺 _dyn.push 顺序全被 _dput 替代", /const _dyn = \[\];[\s\S]{0,50}const sp = stickerPrompt/.test(src) === false);

console.log(`context-tiers: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
