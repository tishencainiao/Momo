"""感官：键鼠空闲 / 前台窗口 / 锁屏 / 截图。

定位：身体只负责**采集**，判断留给大脑——
- 「主人在不在电脑前」由 idle 秒数推出来，但要不要打扰、要不要记下来，是大脑的事；
- 截图只在被要求时抓（大脑调 /cmd/look），不持续截屏偷看。

Windows 实现全部走 ctypes，不引第三方库。
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import os
import time

from PySide6.QtCore import QObject, QTimer, Signal

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wt.UINT), ("dwTime", wt.DWORD)]


def idle_seconds() -> float:
    """距上一次键鼠输入的秒数。"""
    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not user32.GetLastInputInfo(ctypes.byref(info)):
        return 0.0
    now = kernel32.GetTickCount()
    delta = (now - info.dwTime) & 0xFFFFFFFF       # 32 位回绕
    return max(0.0, delta / 1000.0)


def foreground_window() -> dict:
    """返回 {title, pid, app}。"""
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return {"title": "", "pid": 0, "app": ""}
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(max(8, length + 1))
    user32.GetWindowTextW(hwnd, buf, len(buf))
    pid = wt.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    app = ""
    try:
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if h:
            size = wt.DWORD(1024)
            path_buf = ctypes.create_unicode_buffer(1024)
            if kernel32.QueryFullProcessImageNameW(h, 0, path_buf, ctypes.byref(size)):
                app = os.path.basename(path_buf.value)
            kernel32.CloseHandle(h)
    except Exception:
        pass
    return {"title": buf.value[:120], "pid": int(pid.value), "app": app}


def is_locked() -> bool:
    """锁屏/安全桌面判定：打不开输入桌面就认为锁了。"""
    try:
        DESKTOP_SWITCHDESKTOP = 0x0100
        h = user32.OpenInputDesktop(0, False, DESKTOP_SWITCHDESKTOP)
        if not h:
            return True
        user32.CloseDesktop(h)
        return False
    except Exception:
        return False


class Sense(QObject):
    """定时采样 + 变化时发事件；另提供截图。"""

    changed = Signal(str, dict)          # (事件名, 数据)

    def __init__(self, log=print, look_dir: str = "", away_after_s: float = 180.0,
                 interval_ms: int = 5000, parent=None):
        super().__init__(parent)
        self.log = log
        self.look_dir = look_dir
        self.away_after_s = float(away_after_s)
        self.idle_s = 0.0
        self.presence = "active"          # active / away
        self.foreground = {"title": "", "pid": 0, "app": ""}
        self.locked = False
        self.last_look = None             # {path, ts}
        self._timer = QTimer(self)
        self._timer.setInterval(max(1000, int(interval_ms)))
        self._timer.timeout.connect(self.sample)
        self._timer.start()
        self.sample()
        # 启动先广播一次完整快照，别让大脑等到「状态变化」才知道主人在不在
        self.changed.emit("sense", self.snapshot())

    # ---------- 采样 ----------
    def sample(self) -> None:
        self.idle_s = idle_seconds()
        presence = "away" if self.idle_s >= self.away_after_s else "active"
        if presence != self.presence:
            self.presence = presence
            self.changed.emit("presence", {"presence": presence, "idle_s": round(self.idle_s, 1)})
        fg = foreground_window()
        if fg["app"] != self.foreground.get("app") or fg["title"] != self.foreground.get("title"):
            self.foreground = fg
            self.changed.emit("foreground", dict(fg))
        locked = is_locked()
        if locked != self.locked:
            self.locked = locked
            self.changed.emit("lock", {"locked": locked})

    # ---------- 快照 ----------
    def snapshot(self) -> dict:
        return {
            "idle_s": round(self.idle_s, 1),
            "presence": self.presence,
            "foreground": dict(self.foreground),
            "locked": self.locked,
            "last_look": self.last_look,
        }

    # ---------- 截图 ----------
    def capture(self, max_width: int = 1280, quality: int = 78) -> dict:
        """抓一张全屏（缩放保存为 jpg），返回 {path, width, height, ts}。"""
        from PySide6.QtGui import QGuiApplication

        screen = QGuiApplication.primaryScreen()
        if screen is None:
            return {"ok": False, "error": "没有屏幕"}
        pm = screen.grabWindow(0)
        if pm.isNull():
            return {"ok": False, "error": "截图失败"}
        if pm.width() > max_width:
            pm = pm.scaledToWidth(max_width)
        out_dir = self.look_dir or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "body-look-%d.jpg" % int(time.time() * 1000))
        ok = pm.save(path, "JPG", quality)
        if not ok:
            return {"ok": False, "error": "保存失败"}
        self.last_look = {"path": path, "ts": round(time.time(), 3),
                          "width": pm.width(), "height": pm.height()}
        try:                                   # 只留最近 20 张，别把 data/ 塞满
            files = sorted((f for f in os.listdir(out_dir) if f.startswith("body-look-")),
                           reverse=True)
            for f in files[20:]:
                try:
                    os.remove(os.path.join(out_dir, f))
                except OSError:
                    pass
        except OSError:
            pass
        return {"ok": True, **self.last_look}
