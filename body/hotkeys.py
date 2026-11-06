"""全局快捷键：用 Win32 RegisterHotKey 注册，Qt 原生事件过滤器接 WM_HOTKEY。

默认绑定（都带 Ctrl+Alt，避免和常见软件冲突）：
- Ctrl+Alt+M：显示/隐藏身体
- Ctrl+Alt+S：打开设置
- Ctrl+Alt+D：免打扰开关

注册失败（被别的软件占了）不会崩，只在日志里说一声。
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt

from PySide6.QtCore import QAbstractNativeEventFilter, QObject, Signal

user32 = ctypes.windll.user32

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_NOREPEAT = 0x4000
WM_HOTKEY = 0x0312

VK = {
    "M": 0x4D,
    "S": 0x53,
    "D": 0x44,
}
for _i in range(1, 25):          # F1..F24 = 0x70..0x87
    VK["F%d" % _i] = 0x6F + _i


class HotkeyFilter(QAbstractNativeEventFilter):
    def __init__(self, on_hotkey):
        super().__init__()
        self._on_hotkey = on_hotkey

    def nativeEventFilter(self, event_type, message):          # noqa: N802
        try:
            if event_type == b"windows_generic_MSG" or event_type == b"windows_dispatcher_MSG":
                msg = ctypes.cast(int(message), ctypes.POINTER(wt.MSG))
                if msg and msg.contents.message == WM_HOTKEY:
                    self._on_hotkey(int(msg.contents.wParam))
        except Exception:
            pass
        return False, 0


class Hotkeys(QObject):
    """注册/注销全局快捷键，命中时发 hotkey(id) 信号。"""

    hotkey = Signal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._filter = HotkeyFilter(self._dispatch)
        self._registered = {}
        self._seq = 0
        self.last_error = ""
        from PySide6.QtWidgets import QApplication

        app = QApplication.instance()
        if app is not None:
            app.installNativeEventFilter(self._filter)

    def _dispatch(self, hid: int) -> None:
        self.hotkey.emit(int(hid))

    def register(self, combo: str, name: str = "") -> int:
        """combo 形如 'ctrl+alt+m'；成功返回 id，失败返回 0。"""
        parts = [p.strip().lower() for p in str(combo or "").split("+") if p.strip()]
        if not parts:
            return 0
        mods = MOD_NOREPEAT
        key = None
        for p in parts:
            if p in ("ctrl", "control"):
                mods |= MOD_CONTROL
            elif p == "alt":
                mods |= MOD_ALT
            elif p == "shift":
                mods |= MOD_SHIFT
            else:
                key = VK.get(p.upper())
        if key is None:
            self.last_error = "不认识的按键：%s" % combo
            return 0
        self._seq += 1
        hid = 1000 + self._seq
        ok = user32.RegisterHotKey(None, hid, mods, key)
        if not ok:
            self.last_error = "快捷键被占用：%s" % combo
            return 0
        self._registered[hid] = (combo, name)
        return hid

    def unregister_all(self) -> None:
        for hid in list(self._registered.keys()):
            try:
                user32.UnregisterHotKey(None, hid)
            except Exception:
                pass
        self._registered.clear()

    def bound(self) -> dict:
        return dict(self._registered)
