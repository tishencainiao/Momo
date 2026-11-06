"""Momo 身体 v0.1 启动入口。

用法（在 Momo 根目录）：
    python body/main.py                 # 正常启动（有控制台，便于看日志）
    pythonw body/main.py                # 无控制台（日常用 scripts/run-body.vbs）
    python body/main.py --selftest      # 只做自检，不开窗口
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import traceback

BODY_DIR = os.path.dirname(os.path.abspath(__file__))
if BODY_DIR not in sys.path:
    sys.path.insert(0, BODY_DIR)


def log(msg: str) -> None:
    """写 data/body.log；没有控制台（pythonw）时也不会抛错。"""
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


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Momo 桌面身体")
    parser.add_argument("--selftest", action="store_true", help="只跑自检，不开窗口")
    parser.add_argument("--scale", type=float, default=None, help="覆盖配置里的缩放")
    args = parser.parse_args(argv)

    import cfg
    config = cfg.load()
    if args.scale:
        config["scale"] = args.scale

    assets = config.get("assets_dir") or ""
    if not os.path.isdir(os.path.join(assets, "frameseq")):
        log("素材目录缺失：%s（先跑 scripts/convert-assets.ps1）" % assets)
        print("素材目录缺失：%s\n请先执行：powershell -File scripts/convert-assets.ps1" % assets)
        return 2

    if args.selftest:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

    from PySide6.QtWidgets import QApplication
    import selftest as selftest_mod
    from pet_app import PetWindow

    app = QApplication.instance() or QApplication(sys.argv[:1])
    app.setApplicationName("MomoBody")
    app.setQuitOnLastWindowClosed(True)

    if args.selftest:
        return selftest_mod.run(config)

    try:
        win = PetWindow(config)
        win.show()
        log("身体已启动：片段 %d 类，缩放 %.2f" % (len(win.clips), win.scale))
        return app.exec()
    except Exception:
        log("启动失败：\n" + traceback.format_exc())
        raise


if __name__ == "__main__":
    sys.exit(main())
