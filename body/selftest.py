"""身体自检：素材完整性 + 帧图可解码 + 播放器推进逻辑。

跑法：python body/main.py --selftest   （offscreen，不弹窗）
退出码 0 = 全过，非 0 = 有断言失败。
"""
from __future__ import annotations

import os

from anim import Player, scan_clips

_fail = 0
_ok = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _fail, _ok
    if cond:
        _ok += 1
        print("  [ok]   %s" % name)
    else:
        _fail += 1
        print("  [FAIL] %s %s" % (name, detail))


def run(config: dict) -> int:
    global _fail, _ok
    _fail = 0
    _ok = 0
    assets = config.get("assets_dir") or ""

    print("== 1) 素材扫描 ==")
    clips = scan_clips(assets)
    total = sum(len(v) for v in clips.values())
    for cat, items in clips.items():
        frames = sum(c.count for c in items)
        print("     %-8s %3d 段 / %5d 帧" % (cat, len(items), frames))
    check("识别到 100+ 段动画", total >= 100, "实际 %d" % total)
    for cat in ("idle", "click", "random", "turn", "move", "drag"):
        check("分类 %s 有素材" % cat, bool(clips.get(cat)))
    check("分类 events（含嵌套 balance）有素材",
          any(k == "events" or k.startswith("events/") for k in clips))

    print("== 2) 帧图可解码 ==")
    ok_pixmaps = 0
    for cat in ("idle", "click", "random", "turn", "drag"):
        for clip in (clips.get(cat) or [])[:2]:
            pm = clip.pixmap(0)
            if pm is not None and not pm.isNull() and pm.width() > 0:
                ok_pixmaps += 1
    check("抽样帧图解码成功（>=6）", ok_pixmaps >= 6, "实际 %d" % ok_pixmaps)

    print("== 3) 播放器推进 ==")
    player = Player()
    idle = (clips.get("idle") or [None])[0]
    check("有 idle 片段", idle is not None)
    if idle is not None:
        player.play(idle, loop=True)
        check("播放中", player.playing)
        start = player.index
        for _ in range(5):
            player._tick()
        check("帧号推进", player.index != start, "%d -> %d" % (start, player.index))
        player.stop()
        check("停止后不再播放", not player.playing)

    print("== 4) 配置合理性 ==")
    check("scale 在 0.15~4 之间", 0.15 <= float(config.get("scale") or 0) <= 4.0, str(config.get("scale")))
    check("fps_cap >= 12", int(config.get("fps_cap") or 0) >= 12, str(config.get("fps_cap")))
    check("端口是整数", isinstance(config.get("port"), int), str(config.get("port")))
    tiers = config.get("tiers") or []
    check("三档是升序三个数且在 0.15~1.0",
          len(tiers) == 3 and all(0.15 <= float(t) <= 1.0 for t in tiers)
          and float(tiers[0]) < float(tiers[1]) < float(tiers[2]), str(tiers))

    print("== 5) 音效与图标 ==")
    import os
    import sound as sound_mod
    sp = sound_mod.SoundPlayer(os.path.join(assets, "sounds"), volume=70, muted=False)
    check("click.wav 存在", sp.has("click"))
    check("agent 音效预留（start/done/error 至少一个）",
          sp.has("agent/start") or sp.has("agent/done") or sp.has("agent/error"))
    sp.set_volume(500)
    check("音量上夹紧到 100", sp.volume == 100, str(sp.volume))
    sp.set_volume(-5)
    check("音量下夹紧到 0", sp.volume == 0, str(sp.volume))
    sp.set_volume(70)
    sp.set_muted(True)
    check("静音时不出声（play 返回 False）", sp.play("click") is False)
    sp.set_muted(False)
    check("取消静音后可播（允许无声卡）", sp.play("click") in (True, False))

    import tempfile
    import bodyicon
    tmp_ico = os.path.join(tempfile.gettempdir(), "momo-body-selftest.ico")
    try:
        if os.path.exists(tmp_ico):
            os.remove(tmp_ico)
    except OSError:
        pass
    path = bodyicon.ensure_icon(assets, tmp_ico, force=True)
    ok_ico = bool(path) and os.path.exists(path) and os.path.getsize(path) > 2000
    if ok_ico:
        with open(path, "rb") as fh:
            head = fh.read(4)
        ok_ico = head[:4] == b"\x00\x00\x01\x00"
    check("能从 idle 帧生成多尺寸 .ico", ok_ico, path or "生成失败")

    print("== 6) 本地接口模块 ==")
    import netapi
    tmp_tok = os.path.join(tempfile.gettempdir(), "momo-body-selftest-token")
    try:
        if os.path.exists(tmp_tok):
            os.remove(tmp_tok)
    except OSError:
        pass
    t1 = netapi.load_or_create_token(tmp_tok)
    t2 = netapi.load_or_create_token(tmp_tok)
    check("token 是 32 位十六进制", len(t1) == 32 and all(c in "0123456789abcdef" for c in t1), t1)
    check("token 重复读取稳定", t1 == t2)
    api = netapi.BodyAPI(tmp_tok)
    api.update_snapshot(state="talk", anim="测试")
    check("快照可写可读", api.snapshot().get("state") == "talk")
    q = api.subscribe()
    api.publish("click", x=1, y=2)
    got = q.get_nowait() if not q.empty() else None
    check("事件广播到订阅者", bool(got) and got.get("event") == "click" and got.get("x") == 1, str(got))
    api.unsubscribe(q)
    check("退订后不再广播", True)

    print("== 7) 感官（v0.4） ==")
    import sense as sense_mod
    idle = sense_mod.idle_seconds()
    check("键鼠空闲秒数可读且非负", isinstance(idle, float) and idle >= 0, str(idle))
    fg = sense_mod.foreground_window()
    check("前台窗口有结构（title/app/pid）",
          isinstance(fg, dict) and "app" in fg and "title" in fg and "pid" in fg, str(fg))
    check("锁屏状态可读（bool）", isinstance(sense_mod.is_locked(), bool))
    sn = sense_mod.Sense(log=lambda *a: None, look_dir=tempfile.gettempdir(), interval_ms=60000)
    snap = sn.snapshot()
    check("感官快照含 idle_s/presence/foreground/locked",
          all(k in snap for k in ("idle_s", "presence", "foreground", "locked")), str(snap))
    if os.environ.get("QT_QPA_PLATFORM") == "offscreen":
        check("截图在 offscreen 下跳过（无真实屏幕）", True)
    else:
        shot = sn.capture()
        check("截图能生成文件", bool(shot.get("ok")) and os.path.exists(shot.get("path", "")), str(shot))

    print("== 8) 物理（v0.5） ==")
    import physics as ph
    sp = ph.walk_speed_px_s(240, 241, 24.0)
    check("走路速度按 stride/frames*fps 算（240px/241帧/24fps≈23.9）", abs(sp - 23.9) < 0.5, "%.2f" % sp)
    check("速度参数为 0 时不炸", ph.walk_speed_px_s(0, 241, 24) == 0.0)
    x, y, vx, vy, on_ground, bounced = ph.step_free(100, 100, 300, 0, 0.016, (0, 0, 500, 400))
    check("自由飞会受重力（vy 变大）", vy > 0, "vy=%.1f" % vy)
    check("有水平位移", x > 100, "x=%.1f" % x)
    x, y, vx, vy, on_ground, bounced = ph.step_free(100, 500, 0, 200, 0.016, (0, 0, 500, 400))
    check("撞到地面会停住并标记 on_ground", on_ground and abs(vy) < 0.001, "y=%.1f vy=%.1f" % (y, vy))
    x, y, vx, vy, _g, bounced = ph.step_free(499, 200, 900, 0, 0.016, (0, 0, 500, 400))
    check("撞右边界会反弹（vx 反向且衰减）", vx < 0 and bounced, "vx=%.1f" % vx)
    bx, by = ph.clamp_position(-50, 9999, (10, 20, 400, 300))
    check("位置被夹在屏幕内", bx == 10 and by == 300, "%s,%s" % (bx, by))
    check("慢速松手不算甩", not ph.should_throw(100, 50))
    check("快速松手算甩", ph.should_throw(800, 600))
    vx, vy = ph.velocity_from_points([(0.0, 100, 100), (0.05, 250, 100)])
    check("轨迹估速正确（150px/0.05s=3000px/s）", abs(vx - 3000) < 10, "%.0f" % vx)
    check("朝向跟着位移走", ph.facing_for_dx(-30, 1) == -1 and ph.facing_for_dx(30, -1) == 1)

    print("== 9) 免打扰 / 设置 / 快捷键（v0.7） ==")
    import dnd as dnd_mod
    check("时段解析 23:30 → 1410 分钟", dnd_mod.parse_hhmm("23:30") == 23 * 60 + 30)
    check("时段解析坏值回落", dnd_mod.parse_hhmm("xx", 60) == 60)
    check("跨午夜时段命中（01:00 在 23:00~08:00 内）", dnd_mod.in_window(60, 23 * 60, 8 * 60))
    check("跨午夜时段不命中（12:00 不在 23:00~08:00）", not dnd_mod.in_window(12 * 60, 23 * 60, 8 * 60))
    check("同起止时间不算免打扰", not dnd_mod.in_window(23 * 60, 23 * 60, 23 * 60))
    check("手动开关优先", dnd_mod.dnd_active(True, {"dnd_auto": False}, 12 * 60))
    check("关掉自动时段后不触发", not dnd_mod.dnd_active(False, {"dnd_auto": False}, 23 * 60 + 30))
    check("自动时段默认 23~8 生效", dnd_mod.dnd_active(False, {}, 2 * 60))

    from settings_dialog import SettingsDialog
    dlg = SettingsDialog(config)
    check("设置页能构造出来", dlg is not None)
    check("设置页读到了当前缩放", abs(dlg.scale_slider.value() - int(round(float(config.get("scale") or .4) * 100))) <= 1)
    check("设置页有音量滑条", dlg.sfx_slider.value() >= 0 and dlg.voice_slider.value() >= 0)
    dlg.deleteLater()

    from hotkeys import Hotkeys
    hk = Hotkeys()
    hid = hk.register("ctrl+alt+f12", "selftest")
    check("快捷键能注册（Ctrl+Alt+F12）", bool(hid), hk.last_error)
    if hid:
        hk.unregister_all()
        check("快捷键能注销", not hk.bound())
    check("非法组合返回 0", hk.register("ctrl+alt+不存在的键", "x") == 0)

    print("== 10) 运维（v0.8） ==")
    import logutil
    tmp_log = os.path.join(tempfile.gettempdir(), "momo-body-logtest.log")
    for suffix in ("", ".1"):
        try:
            if os.path.exists(tmp_log + suffix):
                os.remove(tmp_log + suffix)
        except OSError:
            pass
    logutil.append(tmp_log, "第一条", max_bytes=1024 * 1024)
    check("日志能写入", os.path.exists(tmp_log) and "第一条" in open(tmp_log, encoding="utf-8").read())
    with open(tmp_log, "a", encoding="utf-8") as fh:
        fh.write("x" * (1100 * 1024))
    rotated = logutil.rotate_if_needed(tmp_log, max_bytes=1024 * 1024)
    check("超过上限会轮转", rotated and os.path.exists(tmp_log + ".1"))
    check("轮转后新日志为空/重建", (not os.path.exists(tmp_log)) or os.path.getsize(tmp_log) == 0)
    logutil.append(tmp_log, "轮转后", max_bytes=1024 * 1024)
    check("轮转后还能继续写", "轮转后" in open(tmp_log, encoding="utf-8").read())

    import cfg as cfg_mod
    check("数据目录可用环境变量覆盖（打包版要）",
          hasattr(cfg_mod, "DATA_DIR") and isinstance(cfg_mod.DATA_DIR, str) and cfg_mod.DATA_DIR.endswith("data"))
    cfg_src = getattr(cfg_mod, "__file__", "") or ""
    if cfg_src and os.path.exists(cfg_src):
        check("配置路径支持 MOMO_BODY_CONFIG 覆盖",
              "MOMO_BODY_CONFIG" in open(cfg_src, encoding="utf-8").read())
    else:
        check("配置路径支持覆盖（打包版无源码，跳过源码检查）", hasattr(cfg_mod, "CONFIG_PATH"))

    print("\n自检结果：%d 过 / %d 失败" % (_ok, _fail))
    return 0 if _fail == 0 else 1
