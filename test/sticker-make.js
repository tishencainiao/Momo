/* make_sticker 工具测试：存在性 / 权限 / 空描述（不做真实网络请求） */
const plugin = require("E:/Learn/Momo/plugins/stickers.js");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

plugin.init({
  log: () => {},
  isMaster: (u) => Number(u) === 1000,
  DATA_DIR: require("os").tmpdir(),
  onebotSend: async () => {},
  getSetting: (k, d) => d,
});

const tool = (plugin.tools || []).find((t) => t.def.function.name === "make_sticker");
check("暴露 make_sticker 工具", !!tool);
check("描述里说明了用途", tool && tool.def.function.description.indexOf("表情包") >= 0);

(async () => {
  const r1 = await tool.handler({ description: "" }, { userId: 1000 });
  check("空描述 → 失败提示", r1.indexOf("【失败】") === 0, r1);
  check("空描述提示要画什么", r1.indexOf("画什么") >= 0, r1);

  const r2 = await tool.handler({ description: "一只胖鱼" }, { userId: 2000 });
  check("非主人 → 拒绝", r2.indexOf("只有主人") >= 0, r2);

  // 参数 schema
  const props = tool.def.function.parameters.properties;
  check("参数是 description", !!props.description);
  check("description 是必填", (tool.def.function.parameters.required || []).indexOf("description") >= 0);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
