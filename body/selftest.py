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

    print("\n自检结果：%d 过 / %d 失败" % (_ok, _fail))
    return 0 if _fail == 0 else 1
