"""Momo 的桌面身体（v0.1）：透明置顶窗 + 帧序列动画 + 拖拽 + 右键菜单。

行为灵感来自 dsh-pet（点击回应 / 拖拽 / 右键点播 / 位置记忆），
窗口与绘制代码为自写实现（署名见 docs/body-attribution.md）。
"""
from __future__ import annotations

import ctypes
import os
import random
import sys

from PySide6.QtCore import QPoint, QRect, Qt, QTimer
from PySide6.QtGui import QAction, QGuiApplication, QPainter
from PySide6.QtWidgets import QMenu, QWidget

import cfg
from anim import Player, scan_clips

_HWND_TOPMOST = -1
_SWP_NOSIZE = 0x0001
_SWP_NOMOVE = 0x0002
_SWP_NOACTIVATE = 0x0010
_SWP_SHOWWINDOW = 0x0040


def _assert_topmost(hwnd: int) -> None:
    """把窗口重新钉回最顶层（不抢焦点、不改位置）。

    某些全屏/置顶程序（浏览器窗口）激活后会盖住置顶窗，桌面宠物需要周期性重申置顶。
    """
    if os.name != "nt":
        return
    try:
        ctypes.windll.user32.SetWindowPos(
            int(hwnd), _HWND_TOPMOST, 0, 0, 0, 0,
            _SWP_NOMOVE | _SWP_NOSIZE | _SWP_NOACTIVATE | _SWP_SHOWWINDOW,
        )
    except Exception:
        pass


class PetWindow(QWidget):
    def __init__(self, config: dict):
        super().__init__()
        self.cfg = config
        self.scale = float(config.get("scale") or 1.0)
        self.clips = scan_clips(config.get("assets_dir") or "",
                                config.get("frameseq_dir") or "frameseq")
        self._drag_origin = None
        self._drag_window_origin = None
        self._drag_moved = False
        self._after_key = None
        self._click_through = bool(config.get("click_through"))
        self._clips_tried = 0

        self.setWindowTitle("Momo")
        flags = Qt.FramelessWindowHint | Qt.Tool
        if config.get("always_on_top", True):
            flags |= Qt.WindowStaysOnTopHint
        self.setWindowFlags(flags)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_ShowWithoutActivating, True)
        self.setAttribute(Qt.WA_TransparentForMouseEvents, self._click_through)

        self.idle_clip = self._pick("idle")
        native = self.idle_clip.native_size() if self.idle_clip else None
        w = int((native.width() if native else 128) * self.scale)
        h = int((native.height() if native else 104) * self.scale)
        self.setFixedSize(max(32, w), max(32, h))

        self.player = Player(self)
        self.player.set_fps_cap(int(self.cfg.get("fps_cap") or 30))
        self.player.frame_changed.connect(self.update)
        self.player.finished.connect(self._on_clip_finished)

        self._restore_geometry()
        self._play_idle()

        # 某些窗口（浏览器/全屏应用）激活后会盖住置顶窗，周期性重申置顶
        self._top_timer = QTimer(self)
        self._top_timer.setInterval(3000)
        self._top_timer.timeout.connect(self._keep_on_top)
        self._top_timer.start()

    def _keep_on_top(self) -> None:
        if self.cfg.get("always_on_top", True):
            _assert_topmost(self.winId())

    def showEvent(self, event) -> None:                            # noqa: N802
        super().showEvent(event)
        self._keep_on_top()

    # ---------- 片段挑选 ----------
    def _cat(self, name: str):
        return list(self.clips.get(name) or [])

    def _pick(self, category: str):
        items = self._cat(category)
        if not items:
            return None
        return random.choice(items)

    def _play_idle(self) -> None:
        if self.idle_clip is None:
            return
        self.player.play(self.idle_clip, loop=True)

    def _play_once(self, clip) -> None:
        if clip is None:
            self._play_idle()
            return
        self._after_key = "idle"
        self.player.play(clip, loop=False)

    def _on_clip_finished(self, key: str) -> None:
        # 一次性动画播完回待机
        self._after_key = None
        self._play_idle()

    # ---------- 位置 ----------
    def _restore_geometry(self) -> None:
        state = cfg.load_state()
        x = state.get("x")
        y = state.get("y")
        if isinstance(x, int) and isinstance(y, int) and self._on_screen(x, y):
            self.move(x, y)
            return
        screen = QGuiApplication.primaryScreen()
        area = screen.availableGeometry() if screen else QRect(0, 0, 1280, 720)
        mx = int(self.cfg.get("margin_x") or 40)
        my = int(self.cfg.get("margin_y") or 120)
        self.move(area.right() - self.width() - mx, area.bottom() - self.height() - my)

    def _on_screen(self, x: int, y: int) -> bool:
        for screen in QGuiApplication.screens():
            if screen.availableGeometry().adjusted(-40, -40, 40, 40).contains(QPoint(x, y)):
                return True
        return False

    def _save_geometry(self) -> None:
        state = cfg.load_state()
        state.update({"x": self.x(), "y": self.y(), "scale": self.scale})
        cfg.save_state(state)

    # ---------- 绘制 ----------
    def paintEvent(self, event) -> None:                          # noqa: N802 (Qt 命名)
        pm = self.player.current_pixmap()
        if pm is None:
            return
        painter = QPainter(self)
        painter.setRenderHint(QPainter.SmoothPixmapTransform, True)
        painter.setRenderHint(QPainter.Antialiasing, True)
        painter.drawPixmap(self.rect(), pm)
        painter.end()

    # ---------- 鼠标 ----------
    def mousePressEvent(self, event) -> None:                      # noqa: N802
        if event.button() == Qt.LeftButton:
            self._drag_origin = event.globalPosition().toPoint()
            self._drag_window_origin = self.pos()
            self._drag_moved = False
            event.accept()

    def mouseMoveEvent(self, event) -> None:                       # noqa: N802
        if self._drag_origin is None:
            return
        delta = event.globalPosition().toPoint() - self._drag_origin
        if abs(delta.x()) + abs(delta.y()) > 3:
            self._drag_moved = True
        self.move(self._drag_window_origin + delta)
        event.accept()

    def mouseReleaseEvent(self, event) -> None:                    # noqa: N802
        if event.button() != Qt.LeftButton or self._drag_origin is None:
            return
        self._drag_origin = None
        if self._drag_moved:
            self._save_geometry()
        elif self.cfg.get("click_response", True):
            self._play_once(self._pick("click"))
        event.accept()

    def mouseDoubleClickEvent(self, event) -> None:                 # noqa: N802
        if event.button() == Qt.LeftButton:
            self._play_once(self._pick("random"))

    # ---------- 右键菜单 ----------
    def contextMenuEvent(self, event) -> None:                     # noqa: N802
        menu = QMenu(self)
        actions_menu = menu.addMenu("点播动作")
        for cat in ("random", "click", "turn", "move", "drag"):
            items = self._cat(cat)
            if not items:
                continue
            sub = actions_menu.addMenu(cat)
            for clip in items[:40]:
                act = QAction(clip.key, self)
                act.triggered.connect(lambda _checked=False, c=clip: self._play_once(c))
                sub.addAction(act)
        menu.addSeparator()
        for label, value in (("小 (1.2x)", 1.2), ("中 (1.6x)", 1.6), ("大 (2.2x)", 2.2)):
            act = QAction(label, self)
            act.triggered.connect(lambda _checked=False, v=value: self._set_scale(v))
            menu.addAction(act)
        toggle = QAction("鼠标穿透（整窗）", self, checkable=True)
        toggle.setChecked(self._click_through)
        toggle.triggered.connect(self._toggle_click_through)
        menu.addAction(toggle)
        recenter = QAction("回到右下角", self)
        recenter.triggered.connect(self._recenter)
        menu.addAction(recenter)
        menu.addSeparator()
        quit_act = QAction("退出身体", self)
        quit_act.triggered.connect(self._quit)
        menu.addAction(quit_act)
        menu.exec(event.globalPos())

    def _set_scale(self, value: float) -> None:
        self.scale = float(value)
        native = self.idle_clip.native_size() if self.idle_clip else None
        self.setFixedSize(int((native.width() if native else 128) * self.scale),
                          int((native.height() if native else 104) * self.scale))
        self._save_geometry()
        self.update()

    def _toggle_click_through(self, checked: bool) -> None:
        self._click_through = bool(checked)
        self.setAttribute(Qt.WA_TransparentForMouseEvents, self._click_through)
        self.update()

    def _recenter(self) -> None:
        screen = QGuiApplication.primaryScreen()
        area = screen.availableGeometry() if screen else QRect(0, 0, 1280, 720)
        self.move(area.right() - self.width() - 40, area.bottom() - self.height() - 120)
        self._save_geometry()

    def _quit(self) -> None:
        self._save_geometry()
        QGuiApplication.instance().quit()

    def closeEvent(self, event) -> None:                           # noqa: N802
        self._save_geometry()
        super().closeEvent(event)
