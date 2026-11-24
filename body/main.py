"""Momo 身体 v0.8 启动入口。

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
    """写 data/body.log（超过 2MB 自动轮转）；没有控制台（pythonw/exe）时也不会抛错。"""
    try:
        import cfg
        import logutil

        logutil.append(cfg.LOG_PATH, msg)
    except Exception:
        try:
            print(msg)
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
        try:
            code = selftest_mod.run(config)
        except Exception:
            import traceback
            traceback.print_exc()
            code = 1                         # windowed exe 未捕获异常也可能返回 0，必须显式失败
        guard.detach()
        return code

    import bodyicon
    import netapi
    import queue as queue_mod
    import sound as sound_mod
    from PySide6.QtCore import QTimer
    from pet_app import PetWindow
    from tray import BodyTray

    # 本地接口（HTTP 指令 + SSE 事件）：大脑通过它指挥身体
    api = None
    if config.get("api_enabled", True):
        # token 放数据目录（源码跑/打包跑共用一份，brain 侧也读这里）
        token_path = os.environ.get("MOMO_BODY_TOKEN") or os.path.join(cfg.DATA_DIR, "body-token")
        api = netapi.BodyAPI(token_path, log=log)
        ok, info = api.start(port=int(config.get("port") or 4010))
        if ok:
            log("本地接口已就绪：http://127.0.0.1:%d（token 在 %s）" % (info, token_path))
        else:
            log("本地接口启动失败：%s（身体照常显示，只是大脑连不上）" % info)
            api = None

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
        ready = player.preload()          # 提前打开音频设备，第一次点击就不卡
        log("音效后端=%s，预加载就绪 %d 个，输出设备=%s"
            % (player.backend, ready, getattr(player, "device_name", "") or "默认"))

    try:
        win = PetWindow(config, sound=player, api=api)

        # 指令队列：HTTP 线程只入队，这里在 GUI 线程执行
        if api is not None:
            drain = QTimer(win)
            drain.setInterval(80)

            def _drain():
                for _ in range(8):
                    try:
                        item = api.commands.get_nowait()
                    except queue_mod.Empty:
                        break
                    try:
                        res = win.handle_command(item.get("cmd"), item.get("payload") or {})
                    except Exception as exc:
                        res = {"ok": False, "error": str(exc)}
                    if item.get("event") is not None:
                        item["result"] = res
                        item["event"].set()
                    # 日志脱敏：感官结果里的窗口标题属于私事，落盘只留程序名
                    log_res = res
                    if item.get("cmd") == "sense" and isinstance(res, dict) and isinstance(res.get("foreground"), dict):
                        log_res = dict(res)
                        fg = dict(res["foreground"])
                        fg.pop("title", None)
                        log_res["foreground"] = fg
                    log("指令 %s -> %s" % (item.get("cmd"), log_res))

            drain.timeout.connect(_drain)
            drain.start()
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

        # v3.1 应用外壳：主窗口与聊天窗按需创建，身体右键/托盘共用同一入口。
        from app_window import MainWindow
        from chat_window import ChatWindow
        from brain_api import BrainAPI
        brain_api = BrainAPI(config.get("brain_url") or "http://127.0.0.1:3999")
        main_win = None
        chat_win = None

        def _open_chat():
            nonlocal chat_win
            if chat_win is None:
                chat_win = ChatWindow(api=brain_api)
            chat_win.show()
            chat_win.raise_()
            chat_win.activateWindow()

        def _quit_all():
            from PySide6.QtWidgets import QMessageBox
            box = QMessageBox()
            box.setWindowTitle("完全退出 Momo")
            box.setText("这会停止大脑、守护和桌面身体。\n只想收起界面的话，请直接关闭窗口。")
            box.setStandardButtons(QMessageBox.Yes | QMessageBox.No)
            box.setDefaultButton(QMessageBox.No)
            if box.exec() != QMessageBox.Yes:
                return
            if tray is not None:
                import tray as tray_mod
                tray_mod.kill_pids(tray_mod.find_supervisor_pids())
                tray_mod.kill_pids(tray_mod.find_brain_pids())
            win._quitting = True
            win._save_geometry()
            app.quit()

        def _open_main():
            nonlocal main_win
            if main_win is None:
                actions = {
                    "chat": _open_chat,
                    "toggle_body": (lambda: _toggle() if tray is not None else (win.hide() if win.isVisible() else win.show())),
                    "settings": win.open_settings,
                    "start": (lambda: tray._start_supervisor() if tray is not None else None),
                    "restart": (lambda: tray._restart_brain() if tray is not None else None),
                    "stop": (lambda: tray._stop_brain() if tray is not None else None),
                    "logs": (lambda: tray._open_log() if tray is not None else None),
                    "quit": _quit_all,
                }
                main_win = MainWindow(
                    actions=actions,
                    api=brain_api,
                    get_body_state=lambda: {
                        "visible": win.isVisible(),
                        "dnd_manual": bool(getattr(win, "dnd_manual", False)),
                        "dnd_auto_active": (win.in_dnd() and not bool(getattr(win, "dnd_manual", False))),
                        "weather_city": str(config.get("weather_city") or "北京"),
                    },
                )
            main_win.show()
            main_win.raise_()
            main_win.activateWindow()

        config["_open_chat"] = _open_chat
        config["_open_main"] = _open_main
        if tray is not None:
            tray.main_open.connect(_open_main)
            tray.chat_open.connect(_open_chat)
            if config.get("manage_brain_on_launch", True) and not __import__("tray").find_brain_pids():
                tray._start_supervisor()

        win.show()
        QTimer.singleShot(0, _open_main)
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
