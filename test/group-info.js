/* 群信息插件测试：解析 / 缓存 / 角色 / 荣誉 / 贴表情 / 合并转发 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const DIR = path.join(os.tmpdir(), "momo-ginfo-test-" + Date.now());
fs.mkdirSync(DIR, { recursive: true });

let calls = [];
let failNext = false;
async function fakeSend(action, params) {
  calls.push({ action, params });
  if (failNext) { failNext = false; throw new Error("模拟失败"); }
  if (action === "get_group_info") return { status: "ok", data: { group_id: 100000003, group_name: "爱笑（导）男孩", member_count: 11, max_member_count: 200 } };
  if (action === "get_group_member_list") return { status: "ok", data: [
    { user_id: 100000001, nickname: "测试用户", card: "测试用户A", role: "owner" },
    { user_id: 3550140293, nickname: "洛雪", card: "洛雪笙月", role: "admin" },
    { user_id: 999, nickname: "路人", card: "", role: "member" },
  ] };
  if (action === "get_group_honor_info") return { status: "ok", data: { current_talkative: { user_id: 3550140293, nickname: "洛雪笙月", description: "今日发言最多" } } };
  if (action === "get_stranger_info") return { status: "ok", data: { user_id: 3550140293, nickname: "洛雪笙月", sex: "female", age: 20 } };
  if (action === "set_msg_emoji_like") return { status: "ok", data: {} };
  if (action === "send_group_forward_msg") return { status: "ok", data: {} };
  if (action === "get_group_files_by_folder") return { status: "ok", data: { files: [
    { file_name: "项目报告.pdf", file_size: 102400 },
    { file_name: "截图.png", file_size: 2048 },
  ] } };
  if (action === "get_msg") {
    if (String(params.message_id) === "bad") throw new Error("not found");
    return { status: "ok", data: {
      message_id: 12345,
      sender: { user_id: 111, nickname: "小明", card: "小明同学" },
      time: 1793600000,
      message: [{ type: "text", data: { text: "你好呀" } }, { type: "at", data: { qq: "222" } }],
    } };
  }
  if (action === "set_qq_profile") return { status: "ok", data: {} };
  return { status: "ok", data: {} };
}

const plugin = require("E:/Learn/Momo/plugins/group-info.js");
plugin.init({ DATA_DIR: DIR, log: () => {}, onebotSend: fakeSend, isMaster: (u) => Number(u) === 100000001, config: { qq: { self_id: 100000004 } } });
const G = plugin.api.groupInfo;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("✓ " + name); }
  else { fail++; console.log("✗ " + name + (extra ? "  → " + extra : "")); }
}

(async () => {
  // 1. 群信息
  const info = await G.fetchGroupInfo(100000003);
  check("拿到群名", info && info.name === "爱笑（导）男孩", JSON.stringify(info));
  check("拿到人数", info.memberCount === 11);
  const n1 = calls.length;
  await G.fetchGroupInfo(100000003);
  check("30 分钟内走缓存", calls.length === n1, "calls=" + calls.length);

  // 2. 成员
  const ms = await G.fetchMembers(100000003);
  check("拿到 3 个成员", ms.length === 3);
  check("解析群主角色", ms[0].role === "owner");
  check("解析管理员角色", ms[1].role === "admin");
  check("空群名片回退昵称", ms[2].card === "" && ms[2].nickname === "路人");
  check("成员带 userId", ms[0].userId === 100000001);

  // 3. 荣誉
  const h = await G.fetchHonor(100000003);
  check("拿到荣誉", h.length >= 1, JSON.stringify(h));
  check("荣誉含龙王", h.join("").indexOf("龙王") >= 0, h.join("|"));

  // 4. 陌生人
  const u = await G.fetchStranger(3550140293);
  check("拿到陌生人信息", u && u.nickname === "洛雪笙月");
  check("带性别年龄", u.sex === "female" && u.age === 20);

  // 5. 上下文
  const ctx = await G.groupInfoCtx(100000003);
  check("上下文含群名", ctx.indexOf("爱笑（导）男孩") >= 0, ctx);
  check("上下文含人数", ctx.indexOf("11 人") >= 0, ctx);
  check("上下文含荣誉", ctx.indexOf("荣誉") >= 0, ctx);

  // 6. 贴表情
  const r1 = await G.emojiLike("msg123", "赞");
  check("贴表情成功", r1.ok === true, r1.msg);
  const last = calls[calls.length - 1];
  check("传的是 message_id", last.params.message_id === "msg123");
  check("赞映射成 128077", last.params.emoji_id === "128077", JSON.stringify(last.params));
  const r2 = await G.emojiLike("msg1", "999999");
  check("数字 id 原样传", calls[calls.length - 1].params.emoji_id === "999999");
  const r3 = await G.emojiLike("", "赞");
  check("没有 message_id 被拒", r3.ok === false);

  // 7. 合并转发
  const r4 = await G.forwardToGroup(100000003, "第一段\n第二段\n第三段");
  check("合并转发成功", r4.ok === true, r4.msg);
  const fw = calls[calls.length - 1];
  check("节点数 = 3", fw.params.messages.length === 3);
  check("节点类型是 node", fw.params.messages[0].type === "node");
  check("节点内容正确", fw.params.messages[0].data.content[0].data.text === "第一段");
  const r5 = await G.forwardToGroup(100000003, "   ");
  check("空内容被拒", r5.ok === false);

  // 8. 群文件
  const fr = await G.fetchGroupFiles(100000003);
  check("拿到群文件", fr.ok && fr.files.length === 2, JSON.stringify(fr));
  check("文件名正确", fr.files[0].name === "项目报告.pdf");
  check("大小解析正确", fr.files[0].size === 102400);
  const fk = await G.fetchGroupFiles(100000003, "截图");
  check("关键词过滤", fk.files.length === 1 && fk.files[0].name === "截图.png", JSON.stringify(fk.files));
  const fz = await G.fetchGroupFiles(100000003, "不存在");
  check("过滤无结果返回空", fz.ok && fz.files.length === 0);

  // 9. 按 id 查消息
  const m1 = await G.fetchMsg("12345");
  check("查到消息", m1 && m1.messageId === "12345", JSON.stringify(m1));
  check("消息发送者正确", m1.nickname === "小明同学");
  check("消息内容拼接", m1.text === "你好呀[@]", m1.text);
  const m2 = await G.fetchMsg("bad");
  check("查不到时返回 null", m2 === null);

  // 10. 改自己资料
  const r6 = await G.setSelfProfile("大肥鱼", "今天也在摸鱼");
  check("改资料成功", r6.ok === true, r6.msg);
  const prof = calls[calls.length - 1];
  check("传了 nickname", prof.params.nickname === "大肥鱼");
  check("传了 personal_note", prof.params.personal_note === "今天也在摸鱼");
  const r7 = await G.setSelfProfile("", "");
  check("什么都没改被拒", r7.ok === false);

  // 11. 工具权限：改资料仅主人
  const profTool = plugin.tools.find((t) => t.def.function.name === "set_self_profile");
  check("熟人不能改资料", (await profTool.handler({ nickname: "x" }, { userId: 100000002 })).indexOf("只有主人") >= 0);
  check("主人能改资料", (await profTool.handler({ nickname: "小鱼" }, { userId: 100000001 })).indexOf("改好了") >= 0);

  // 12. 失败兜底
  failNext = true;
  const bad = await G.fetchGroupInfo(123, true);
  check("接口失败不崩（回退缓存或 null）", bad === null || typeof bad === "object");

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
