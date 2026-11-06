"""Momo 身体 v0.1.1 启动入口。

用法（在 Momo 根目录）：
    python body/main.py                 # 正常启动（有控制台，便于看日志）
    pythonw body/main.py                # 无控制台（日常用 scripts/run-body.vbs 或快捷方式）
    python body/main.py --selftest      # 只做自检，不开窗口

行为：
- 单实例（QSharedMemory）；已在跑就提示并退出，避免快捷键/自启重复拉起。
- 有系统托盘时：关窗=隐藏（托盘点一下就回来），只有「退出身体」才真退出。
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import traceback

BODY_DIR = os.path.dirname(os.path.abspath(__file__))
if BODY_DIR not in sys.path:
    sys.path.insert(0, BODY_DIR)


def log(msg: str) -> None:
    """写 data/body.log；没有控制台（pythonw）时也不会抛错。"""
    import time
    line = "[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        import cfg
        os.makedirs(cfg.DATA_DIR, exist_ok=True)
        with open(cfg.LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass
    try:
        print(line)
    except Exception:
        pass


def _restart_self() -> None:
    """拉起一个新的身体进程（当前进程随后退出）。"""
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    exe = sys.executable
    if exe.lower().endswith("python.exe"):
        cand = exe[:-len("python.exe")] + "pythonw.exe"
        if os.path.exists(cand):
            exe = cand
    subprocess.Popen([exe, os.path.join(BODY_DIR, "main.py")],
                     cwd=os.path.dirname(BODY_DIR),
                     creationflags=flags,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     close_fds=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Momo 桌面身体")
    parser.add_argument("--selftest", action="store_true", help="只跑自检，不开窗口")
    parser.add_argument("--scale", type=float, default=None, help="覆盖配置里的缩放")
    args = parser.parse_args(argv)

    import cfg
    config = cfg.load()
    config["_log"] = log          # 让窗口内部事件（点击/缩放）也能写日志
    if args.scale:
        config["scale"] = args.scale

    assets = config.get("assets_dir") or ""
    if not os.path.isdir(os.path.join(assets, "frameseq")):
        log("素材目录缺失：%s（先跑 scripts/convert-assets.ps1）" % assets)
        print("素材目录缺失：%s\n请先执行：powershell -File scripts/convert-assets.ps1" % assets)
        return 2

    if args.selftest:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

    from PySide6.QtCore import QSharedMemory
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication, QSystemTrayIcon

    app = QApplication.instance() or QApplication(sys.argv[:1])
    app.setApplicationName("MomoBody")
    app.setQuitOnLastWindowClosed(False)

    # 单实例：已经有一只身体在跑就不再开第二只
    guard = QSharedMemory("MomoBody-single-instance-v1")
    if not args.selftest:
        if not guard.create(64):
            if guard.attach():
                log("已有身体实例在运行，本次启动退出")
                return 3
            guard.create(64)

    if args.selftest:
        import selftest as selftest_mod
        code = selftest_mod.run(config)
        guard.detach()
        return code

    import bodyicon
    import sound as sound_mod
    from pet_app import PetWindow
    from tray import BodyTray

    icon_path = ""
    try:
        icon_path = bodyicon.ensure_icon(assets)
    except Exception as exc:
        log("生成托盘图标失败：%s" % exc)
    if icon_path and os.path.exists(icon_path):
        app.setWindowIcon(QIcon(icon_path))

    player = None
    if config.get("sound_enabled", True):
        player = sound_mod.SoundPlayer(
            os.path.join(assets, "sounds"),
            volume=int(config.get("volume") or 70),
            muted=bool(config.get("mute")),
        )

    try:
        win = PetWindow(config, sound=player)
        tray = None
        if QSystemTrayIcon.isSystemTrayAvailable():
            tray = BodyTray(win, player, icon_path)
            win.hide_on_close = True

            def _toggle():
                if win.isVisible():
                    win.hide()
                else:
                    win.show()
                    win._keep_on_top()

            def _quit_body():
                win._quitting = True
                win._save_geometry()
                app.quit()

            def _restart_body():
                win._save_geometry()
                _restart_self()
                win._quitting = True
                app.quit()

            def _persist(key, value):
                config[key] = value
                cfg.save_config(config)

            tray.body_toggle.connect(_toggle)
            tray.body_restart.connect(_restart_body)
            tray.body_quit.connect(_quit_body)
            if player is not None:
                tray.volume_changed.connect(lambda v: _persist("volume", int(v)))
                tray.muted_changed.connect(lambda m: _persist("mute", bool(m)))
        else:
            log("系统托盘不可用：关窗即退出")

        win.show()
        log("身体已启动：片段 %d 类，缩放 %.2f，托盘 %s，音效 %s" % (
            len(win.clips), win.scale,
            "开" if tray is not None else "关",
            ("开(音量%d)" % player.volume) if player is not None else "关",
        ))
        code = app.exec()
        guard.detach()
        return code
    except Exception:
        log("启动失败：\n" + traceback.format_exc())
        raise


if __name__ == "__main__":
    sys.exit(main())
