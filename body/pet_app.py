"""Momo 的桌面身体（v0.1）：透明置顶窗 + 帧序列动画 + 拖拽 + 右键菜单。

行为灵感来自 dsh-pet（点击回应 / 拖拽 / 右键点播 / 位置记忆），
窗口与绘制代码为自写实现（署名见 docs/body-attribution.md）。
"""
from __future__ import annotations

import ctypes
import math
import os
import random
import sys
import time

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

# Q 弹挤压参数：横向最多鼓 16%、纵向最多压 20%（视觉上像被戳了一下的软体）
SQ_SQUASH_X = 0.16
SQ_SQUASH_Y = 0.20


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
    def __init__(self, config: dict, sound=None, api=None):
        super().__init__()
        self.cfg = config
        self.sound = sound
        self.api = api                      # BodyAPI（v0.2 起可用）；None 表示纯本地跑
        self.bubble = None
        self._voice_out = None
        self.hide_on_close = False          # 有托盘时：关窗=隐藏，不是退出
        self._quitting = False
        self._log = config.get("_log") or (lambda _m: None)
        self._last_moved_at = 0.0
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

        # 点击 Q 弹：状态 + 60fps 驱动定时器
        self._squash_start = None
        self._squash_strength = 1.0
        self._squash_duration_ms = int(self.cfg.get("squash_duration_ms") or 320)
        self._squash_timer = QTimer(self)
        self._squash_timer.setInterval(16)
        self._squash_timer.timeout.connect(self._tick_squash)

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
        self._snap(visible=True)
        self._publish("visibility", visible=True)

    def hideEvent(self, event) -> None:                            # noqa: N802
        super().hideEvent(event)
        if getattr(self, "_voice_out", None) is not None:
            self._voice_out.stop()
        self._snap(visible=False)
        self._publish("visibility", visible=False)

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
        self._publish("anim", name=self.idle_clip.key, category="idle")
        self._snap(state="idle", anim=self.idle_clip.key)

    def _play_once(self, clip) -> None:
        if clip is None:
            self._play_idle()
            return
        self._after_key = "idle"
        self.player.play(clip, loop=False)
        self._publish("anim", name=clip.key, category=clip.category)
        self._snap(anim=clip.key)

    # ---------- 对外接口（供 HTTP 指令调用，均在本体线程执行） ----------
    def _publish(self, event: str, **data) -> None:
        if self.api is not None:
            try:
                self.api.publish(event, **data)
            except Exception:
                pass

    def _snap(self, **data) -> None:
        if self.api is not None:
            try:
                data.setdefault("visible", self.isVisible())
                data.setdefault("scale", round(self.scale, 3))
                data.setdefault("pos", [self.x(), self.y()])
                self.api.update_snapshot(**data)
            except Exception:
                pass

    def find_clip(self, needle: str):
        """按名字片段找片段（跨分类），找不到返回 None。"""
        needle = str(needle or "").strip()
        if not needle:
            return None
        for items in self.clips.values():
            for clip in items:
                if clip.key == needle:
                    return clip
        for items in self.clips.values():
            for clip in items:
                if needle in clip.key:
                    return clip
        return None

    def say(self, text: str, duration_ms: int = 5000) -> None:
        from bubble import SpeechBubble

        if self.bubble is None:
            self.bubble = SpeechBubble()
        self.bubble.show_text(text, self, duration_ms)
        # 说话时配一段「碎碎念/说话」类动画，没有就随机来一段
        clip = self.find_clip("碎碎念") or self.find_clip("是啊，吃什么") or self._pick("random")
        if clip is not None:
            self._after_key = "idle"
            self.player.play(clip, loop=False)
            self._publish("anim", name=clip.key, category=clip.category)
        self._snap(state="talk", anim=(clip.key if clip else ""), last_say=str(text)[:80])
        self._publish("say", text=str(text)[:200])

    # ---------- 语音（复用大脑合成好的音频文件） ----------
    def _voice(self):
        if getattr(self, "_voice_out", None) is None:
            from voiceout import VoiceOut

            self._voice_out = VoiceOut(self)
            self._voice_out.set_volume(int(self.cfg.get("voice_volume") or self.cfg.get("volume") or 85))
            self._voice_out.finished.connect(lambda p: self._publish("voice_end", path=str(p)))
        return self._voice_out

    def speak(self, path: str, text: str = "", duration_ms: int = 0) -> None:
        """播一段语音 + 头顶气泡（气泡时长按音频长度自动对齐）。"""
        voice = self._voice()
        duration = int(duration_ms or 0)
        if not duration:
            duration = voice.duration_ms() + 900 if voice.duration_ms() else 6000
        if text:
            self.say(text, duration)
        ok = voice.play(path, delete_after=True)
        if not ok:
            self._log("语音播放失败：%s" % getattr(voice, "last_error", ""))
        self._publish("voice", path=str(path), ok=bool(ok))
        self._snap(state="talk", last_voice_ok=bool(ok))

    def handle_command(self, cmd: str, payload: dict) -> dict:
        """执行一条来自 HTTP 的指令；返回执行结果（GUI 线程内调用）。"""
        payload = payload or {}
        if cmd == "say":
            text = str(payload.get("text") or "").strip()
            if not text:
                return {"ok": False, "error": "empty text"}
            self.say(text, int(payload.get("duration_ms") or 5000))
            return {"ok": True, "said": text[:80]}

        if cmd == "speak":
            path = str(payload.get("path") or "").strip()
            if not path:
                return {"ok": False, "error": "empty path"}
            self.speak(path, str(payload.get("text") or ""), int(payload.get("duration_ms") or 0))
            return {"ok": True, "spoke": str(payload.get("text") or "")[:80]}

        if cmd == "play":
            clip = None
            if payload.get("name"):
                clip = self.find_clip(payload["name"])
            if clip is None and payload.get("category"):
                clip = self._pick(str(payload["category"]))
            if clip is None:
                clip = self._pick("random")
            if clip is None:
                return {"ok": False, "error": "no clip"}
            self._play_once(clip)
            return {"ok": True, "anim": clip.key, "category": clip.category}

        if cmd == "state":
            state = str(payload.get("state") or "idle").lower()
            if state in ("idle", ""):
                self._play_idle()
            elif state == "talk":
                self.say(payload.get("text") or "嗯？", int(payload.get("duration_ms") or 4000))
            elif state in ("sleep", "sleeping"):
                clip = self.find_clip("小憩") or self.find_clip("沉眠") or self.idle_clip
                if clip is not None:
                    self.player.play(clip, loop=True)
                    self._snap(state="sleep", anim=clip.key)
                    self._publish("state", state="sleep")
            else:
                return {"ok": False, "error": "unknown state"}
            self._snap(state=("talk" if state == "talk" else state))
            return {"ok": True, "state": state}

        if cmd == "move":
            dx = int(payload.get("dx") or 0)
            dy = int(payload.get("dy") or 0)
            if "to_x" in payload or "to_y" in payload:
                nx = int(payload.get("to_x", self.x()))
                ny = int(payload.get("to_y", self.y()))
                self.move(nx, ny)
            else:
                self.move(self.x() + dx, self.y() + dy)
            self._save_geometry()
            self._snap()
            self._publish("moved", x=self.x(), y=self.y())
            return {"ok": True, "x": self.x(), "y": self.y()}

        if cmd in ("show", "hide"):
            if cmd == "show":
                self.show()
                self._keep_on_top()
            else:
                self.hide()
            self._snap(visible=self.isVisible())
            self._publish("visibility", visible=self.isVisible())
            return {"ok": True, "visible": self.isVisible()}

        if cmd == "scale":
            self._set_scale(float(payload.get("scale") or self.scale))
            return {"ok": True, "scale": self.scale}

        return {"ok": False, "error": "unknown command: %s" % cmd}

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
        sq = self._squash_amount()
        if abs(sq) > 0.001:
            # Q 弹：以「脚底中点」为锚点做挤压（横向鼓、纵向压），松开后回弹过冲
            painter.translate(self.width() / 2.0, float(self.height()))
            painter.scale(1.0 + SQ_SQUASH_X * sq, 1.0 - SQ_SQUASH_Y * sq)
            painter.translate(-self.width() / 2.0, -float(self.height()))
        painter.drawPixmap(self.rect(), pm)
        painter.end()

    # ---------- Q 弹挤压 ----------
    def _squash_amount(self) -> float:
        """返回当前挤压量：>0 压扁，<0 拉长（回弹过冲）。"""
        if self._squash_start is None:
            return 0.0
        elapsed = (time.perf_counter() - self._squash_start) * 1000.0
        total = float(self._squash_duration_ms)
        if elapsed >= total:
            self._squash_start = None
            return 0.0
        t = elapsed / total
        press = 0.25                     # 前 25% 时间压下去
        if t < press:
            u = t / press
            return self._squash_strength * (1.0 - (1.0 - u) ** 3)   # ease-out：快速压到位
        u = (t - press) / (1.0 - press)
        bounce = (1.0 - u) * math.cos(u * math.pi * 1.6)            # 回弹 + 轻微过冲（负值=拉长）
        return self._squash_strength * max(-0.35, bounce)

    def _kick_squash(self, strength: float = 1.0) -> None:
        if not self.cfg.get("squash_enabled", True):
            return
        self._squash_strength = max(0.2, min(1.5, float(strength)))
        self._squash_start = time.perf_counter()
        if not self._squash_timer.isActive():
            self._squash_timer.start()

    def _tick_squash(self) -> None:
        self._squash_amount()                    # 到时间会自己把 _squash_start 清空
        if self._squash_start is None:
            self._squash_timer.stop()
        self.update()

    # ---------- 鼠标 ----------
    def mousePressEvent(self, event) -> None:                      # noqa: N802
        if event.button() == Qt.LeftButton:
            self._drag_origin = event.globalPosition().toPoint()
            self._drag_window_origin = self.pos()
            self._drag_moved = False
            self._kick_squash(1.0)         # 按下去的瞬间就压一下，手感立刻回来
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
            self._kick_squash(0.65)      # 拖动落地也弹一下
            self._publish("drag_end", x=self.x(), y=self.y())
            self._snap()
        elif self.cfg.get("click_response", True):
            self._play_once(self._pick("click"))
            played = self.sound.play("click") if self.sound is not None else False
            detail = ""
            if self.sound is not None and hasattr(self.sound, "debug_state"):
                detail = " / " + self.sound.debug_state("click")
            self._log("身体被点了一下（音效%s）%s" % ("响" if played else "静音/无设备", detail))
            self._publish("click", x=self.x(), y=self.y(), sound=bool(played))
        event.accept()

    def mouseDoubleClickEvent(self, event) -> None:                 # noqa: N802
        if event.button() == Qt.LeftButton:
            self._play_once(self._pick("random"))
            if self.sound is not None:
                self.sound.play("click")

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

        # 三档：按「屏幕上的角色大小」定，不再按画布算
        size_menu = menu.addMenu("大小（当前 %.2f）" % self.scale)
        for label, value in self._tiers():
            act = QAction("%s（%.2f）" % (label, value), self, checkable=True)
            act.setChecked(abs(self.scale - value) < 1e-6)
            act.triggered.connect(lambda _checked=False, v=value: self._set_scale(v))
            size_menu.addAction(act)
        size_menu.addSeparator()
        for label, delta in (("放大一档（+0.05）", +0.05), ("缩小一档（−0.05）", -0.05)):
            act = QAction(label, self)
            act.triggered.connect(lambda _checked=False, d=delta: self._nudge_scale(d))
            size_menu.addAction(act)

        toggle = QAction("鼠标穿透（整窗）", self, checkable=True)
        toggle.setChecked(self._click_through)
        toggle.triggered.connect(self._toggle_click_through)
        menu.addAction(toggle)
        recenter = QAction("回到右下角", self)
        recenter.triggered.connect(self._recenter)
        menu.addAction(recenter)
        menu.addSeparator()
        hide_act = QAction("隐藏身体（托盘可叫回）", self)
        hide_act.triggered.connect(self.hide)
        menu.addAction(hide_act)
        quit_act = QAction("退出身体", self)
        quit_act.triggered.connect(self._quit)
        menu.addAction(quit_act)
        menu.exec(event.globalPos())

    def _tiers(self):
        tiers = self.cfg.get("tiers") or [0.30, 0.40, 0.50]
        try:
            vals = sorted(float(x) for x in tiers)[:3]
        except Exception:
            vals = [0.30, 0.40, 0.50]
        labels = ["小", "中", "大"]
        return list(zip(labels[:len(vals)], vals))

    def _nudge_scale(self, delta: float) -> None:
        self._set_scale(max(0.15, min(1.0, round(self.scale + delta, 2))))

    def _set_scale(self, value: float) -> None:
        self.scale = max(0.15, min(1.0, float(value)))
        native = self.idle_clip.native_size() if self.idle_clip else None
        self.setFixedSize(int((native.width() if native else 640) * self.scale),
                          int((native.height() if native else 360) * self.scale))
        self._save_geometry()
        self._snap(scale=round(self.scale, 3))
        self._publish("scale", scale=round(self.scale, 3))
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
        self._quitting = True
        self._save_geometry()
        QGuiApplication.instance().quit()

    def closeEvent(self, event) -> None:                           # noqa: N802
        self._save_geometry()
        if self.hide_on_close and not self._quitting:
            # 有托盘时：关窗只是藏起来，别让她「凭空消失」
            event.ignore()
            self.hide()
            return
        super().closeEvent(event)
