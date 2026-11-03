/* 互动插件测试：名片点赞（每日上限）/ 拍一拍（私聊 vs 群聊）/ 被拍回应（防刷）/ 只回应拍她自己的 */
let calls = [];
let failNext = false;
async function fakeSend(action, params) {
  calls.push({ action, params });
  if (failNext) { failNext = false; throw new Error("模拟失败"); }
  if (action === "get_profile_like") return { status: "ok", data: { favoriteInfo: { today_count: 3, total_count: 4200 } } };
  return { status: "ok", data: {} };
}
let sent = [];
const plugin = require("E:/Learn/Momo/plugins/interact.js");
plugin.init({
  log: () => {},
  onebotSend: fakeSend,
  sendPrivate: async (uid, t) => { sent.push({ uid, text: t }); },
  resolveCall: (u) => (Number(u) === 100000001 ? "主人" : "朋友"),
  isMaster: (u) => Number(u) === 100000001,
  resolveTargetId: (name) => (String(name) === "老王" ? 3550140293 : null),
});
const I = plugin.api.interact;
const ME = 100000001, FRIEND = 3550140293;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

(async () => {
  // 1. 名片点赞（此时今日计数为 0）
  const r0 = await I.sendLike(ME, 99);
  check("超过 10 次被夹到 10", r0.ok === true && calls[calls.length - 1].params.times === 10, JSON.stringify(calls[calls.length - 1].params));
  check("传了 user_id", calls[calls.length - 1].params.user_id === ME);

  const r1 = await I.sendLike(ME, 1);
  check("超过每日上限被拒", r1.ok === false && r1.msg.indexOf("最多") >= 0, r1.msg);

  const r2 = await I.sendLike(FRIEND, 1);
  check("换个人也是同一个每日额度", r2.ok === false, r2.msg);

  const r5 = await I.sendLike(0, 1);
  check("没目标被拒", r5.ok === false);

  // 2. 查点赞数据
  const st = await I.likeStatus(ME);
  check("拿到今日获赞", st.today === 3);
  check("拿到累计获赞", st.total === 4200);

  // 3. 拍一拍：私聊
  const p1 = await I.poke(FRIEND, 0);
  check("私聊拍成功", p1.ok === true, p1.msg);
  const pc = calls[calls.length - 1];
  check("私聊用 friend_poke", pc.action === "friend_poke");
  check("私聊不带 group_id", pc.params.group_id === undefined);

  // 冷却：立刻再拍同一个人
  const p2 = await I.poke(FRIEND, 0);
  check("同一人 30 秒内不能重复拍", p2.ok === false && p2.msg.indexOf("刚拍过") >= 0, p2.msg);

  // 4. 拍一拍：群聊
  const p3 = await I.poke(ME, 100000003);
  check("群聊拍成功", p3.ok === true, p3.msg);
  const qc = calls[calls.length - 1];
  check("群聊用 group_poke", qc.action === "group_poke");
  check("群聊带 group_id", qc.params.group_id === 100000003);
  check("群聊带 user_id", qc.params.user_id === ME);

  // 5. 被拍：只回应拍她自己的（私聊回话走 sendPrivate，所以看 sent）
  calls = [];
  sent = [];
  await I.onPoke({ target_id: 100000004, self_id: 100000004, user_id: FRIEND, group_id: 0 });
  const isReply = sent.length > 0;
  const isPokeBack = calls.some((c) => c.action === "friend_poke" || c.action === "group_poke");
  check("私聊被拍 → 回话或拍回去", isReply || isPokeBack, "sent=" + sent.length + " calls=" + calls.length);
  if (isReply) check("回话内容非空", String(sent[0].text || "").length > 0);

  // 6. 防刷：60 秒内再拍同一人不回应
  calls = [];
  sent = [];
  await I.onPoke({ target_id: 100000004, self_id: 100000004, user_id: FRIEND, group_id: 0 });
  check("1 分钟内再拍不重复回应", calls.length === 0 && sent.length === 0, "calls=" + calls.length + " sent=" + sent.length);

  // 7. 拍别人（不是她）不回应
  calls = [];
  await I.onPoke({ target_id: 999, self_id: 100000004, user_id: FRIEND, group_id: 0 });
  check("戳的是别人 → 不回应", calls.length === 0);

  // 8. 群聊被拍
  calls = [];
  await I.onPoke({ target_id: 100000004, self_id: 100000004, user_id: ME, group_id: 100000003 });
  check("群里被拍会回应", calls.length > 0, "calls=" + calls.length);
  const gCall = calls.find((c) => c.action === "send_msg");
  if (gCall) check("群回应带 group_id", gCall.params.group_id === 100000003);
  else check("群回应带 group_id（走拍回去）", calls.some((c) => c.action === "group_poke"));

  // 9. 参数级权限：对别人做必须主人
  const pokeTool = plugin.tools.find((t) => t.def.function.name === "poke");
  const likeTool = plugin.tools.find((t) => t.def.function.name === "send_like");
  const t1 = await pokeTool.handler({}, { userId: FRIEND, groupId: 0 });
  check("熟人拍自己 → 允许", t1.indexOf("只有主人") < 0, t1);
  const t2 = await pokeTool.handler({ target: String(ME) }, { userId: FRIEND, groupId: 0 });
  check("熟人拍别人 → 拒绝", t2.indexOf("只有主人") >= 0, t2);
  const t3 = await pokeTool.handler({ target: String(FRIEND) }, { userId: ME, groupId: 0 });
  check("主人拍别人 → 允许", t3.indexOf("只有主人") < 0, t3);
  const t4 = await likeTool.handler({ target: String(ME), times: 1 }, { userId: FRIEND });
  check("熟人点赞别人 → 拒绝", t4.indexOf("只有主人") >= 0, t4);

  // 9.5 用名字指定对象
  const n1 = await pokeTool.handler({ target: "老王" }, { userId: ME, groupId: 0 });
  check("主人用名字拍人 → 能解析", n1.indexOf("还不认识") < 0 && n1.indexOf("只有主人") < 0, n1);
  const n2 = await pokeTool.handler({ target: "查无此人" }, { userId: ME, groupId: 0 });
  check("名字解析不到 → 友好提示", n2.indexOf("还不认识") >= 0, n2);
  const n3 = await pokeTool.handler({}, { userId: ME, groupId: 0 });
  check("留空 = 拍当前对话的人", n3.indexOf("只有主人") < 0, n3);

  // 10. 失败兜底
  failNext = true;
  const bad = await I.sendLike(123, 1);
  check("点赞失败不崩", bad.ok === false, bad.msg);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
