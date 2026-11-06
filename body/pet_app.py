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
import dnd as dnd_mod
import physics
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

        # 感官（v0.4）：键鼠空闲 / 前台窗口 / 锁屏；截图由大脑按需触发
        from sense import Sense

        self.sense = Sense(
            log=self._log,
            look_dir=os.path.join(cfg.DATA_DIR, "body-shots"),
            away_after_s=float(self.cfg.get("away_after_s") or 180),
            interval_ms=int(self.cfg.get("sense_interval_ms") or 5000),
            parent=self,
        )
        self.sense.changed.connect(self._on_sense)
        self.setAcceptDrops(True)

        # ---------- 物理 / 移动 / 情绪（v0.5） ----------
        self._motion = self._load_motion_data()
        self._facing = 1                       # 1=朝右，-1=朝左
        self._mode = "idle"                    # idle | walk | throw
        self._vx = 0.0
        self._vy = 0.0
        self._walk_target = None
        self._drag_points = []
        self._phys_timer = QTimer(self)
        self._phys_timer.setInterval(16)
        self._phys_timer.timeout.connect(self._step_physics)
        self.mood = {"mood": 0, "boredom": 0, "emotion": ""}
        self.dnd_manual = bool(self.cfg.get("dnd_manual"))
        self._idle_timer = QTimer(self)
        self._idle_timer.setInterval(25000)
        self._idle_timer.timeout.connect(self._maybe_self_play)
        self._idle_timer.start()

        self._restore_geometry()
        self._play_idle()

        # 全局快捷键（v0.7）：Ctrl+Alt+M/S/D
        try:
            from hotkeys import Hotkeys

            self.hotkeys = Hotkeys(self)
            self._hotkey_map = {}
            self._hotkey_labels = {}
            plan = {
                "toggle": ["ctrl+alt+m", "ctrl+shift+m", "ctrl+alt+f9"],
                "settings": ["ctrl+alt+s", "ctrl+shift+s", "ctrl+alt+f10"],
                "dnd": ["ctrl+alt+d", "ctrl+shift+d", "ctrl+alt+f11"],
            }
            for action, combos in plan.items():
                for combo in combos:
                    hid = self.hotkeys.register(combo, action)
                    if hid:
                        self._hotkey_map[hid] = action
                        self._hotkey_labels[action] = combo
                        break
                else:
                    self._log("快捷键全部被占用，放弃：%s（%s）" % (action, self.hotkeys.last_error))
            if self._hotkey_labels:
                self._log("快捷键就绪：" + "，".join("%s=%s" % (k, v) for k, v in self._hotkey_labels.items()))
            self.hotkeys.hotkey.connect(self._on_hotkey)
        except Exception as exc:
            self.hotkeys = None
            self._log("快捷键初始化失败：%s" % exc)

        # 某些窗口（浏览器/全屏应用）激活后会盖住置顶窗，周期性重申置顶
        self._top_timer = QTimer(self)
        self._top_timer.setInterval(3000)
        self._top_timer.timeout.connect(self._keep_on_top)
        self._top_timer.start()

    def _on_sense(self, event: str, data: dict) -> None:
        try:
            self._publish(event, **data)
            if event == "presence":
                self._snap(presence=data.get("presence"), idle_s=data.get("idle_s"))
            elif event == "lock":
                self._snap(locked=data.get("locked"))
            elif event == "foreground":
                self._snap(foreground=data)
            elif event == "drop":
                self._snap(last_drop=data.get("files"))
        except Exception:
            pass

    # ---------- 拖文件进来（投喂） ----------
    def dragEnterEvent(self, event) -> None:                       # noqa: N802
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event) -> None:                            # noqa: N802
        files = []
        for url in event.mimeData().urls():
            p = url.toLocalFile()
            if p:
                files.append(p)
        if not files:
            return
        event.acceptProposedAction()
        self._publish("drop", files=files)
        name = os.path.basename(files[0])
        self.say("收到啦：%s" % (name if len(files) == 1 else "%d 个文件" % len(files)), 4000)

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
        if self.in_dnd():                        # 免打扰：只弹字，不出声
            self._publish("voice", path="", ok=False, dnd=True)
            return
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

        if cmd == "sense":
            snap = self.sense.snapshot()
            snap["ok"] = True
            return snap

        if cmd == "mood":
            m = self.set_mood(payload.get("mood"), payload.get("boredom"), payload.get("emotion"))
            return {"ok": True, "mood": m}

        if cmd == "walk":
            dx = int(payload.get("dx") or 0)
            if not dx:
                return {"ok": False, "error": "需要 dx（正=右，负=左）"}
            self.start_walk(dx)
            return {"ok": True, "target_x": self._walk_target}

        if cmd == "throw":
            self.throw(float(payload.get("vx") or 0), float(payload.get("vy") or 0))
            return {"ok": True}

        if cmd == "dnd":
            active = self.set_dnd(payload.get("manual"))
            return {"ok": True, "dnd": active, "manual": self.dnd_manual}

        if cmd == "look":
            r = self.sense.capture()
            if r.get("ok"):
                self._publish("look", path=r["path"], ts=r["ts"])
                self._snap(last_look=r)
            return r

        return {"ok": False, "error": "unknown command: %s" % cmd}

    # ---------- 免打扰 / 设置 / 快捷键（v0.7） ----------
    def in_dnd(self) -> bool:
        import datetime

        now = datetime.datetime.now()
        minutes = now.hour * 60 + now.minute
        return dnd_mod.dnd_active(self.dnd_manual, self.cfg, minutes)

    def set_dnd(self, manual=None) -> bool:
        if manual is not None:
            self.dnd_manual = bool(manual)
            self.cfg["dnd_manual"] = self.dnd_manual
            cfg.save_config(self.cfg)
        active = self.in_dnd()
        if active and getattr(self, "_voice_out", None) is not None:
            self._voice_out.stop()
        self._publish("dnd", active=active, manual=self.dnd_manual)
        self._snap(dnd=active)
        return active

    def open_settings(self) -> None:
        from settings_dialog import SettingsDialog

        dlg = SettingsDialog(self.cfg, self)
        dlg.applied.connect(self.apply_settings)
        dlg.exec()

    def apply_settings(self, new_cfg: dict) -> None:
        """把设置页的改动落到运行时（大小/音量/开关/免打扰）并落盘。"""
        self.cfg.update(new_cfg or {})
        cfg.save_config(self.cfg)
        if "scale" in (new_cfg or {}):
            self._set_scale(float(new_cfg["scale"]))
        if self.sound is not None:
            if new_cfg.get("sound_enabled") is False:
                self.sound.set_muted(True)
            else:
                self.sound.set_muted(bool(new_cfg.get("mute")))
                self.sound.set_volume(int(new_cfg.get("volume", 70)))
        if self._voice_out is not None:
            self._voice_out.set_volume(int(new_cfg.get("voice_volume", 85)))
        self._click_through = bool(new_cfg.get("click_through"))
        self.setAttribute(Qt.WA_TransparentForMouseEvents, self._click_through)
        self.dnd_manual = bool(new_cfg.get("dnd_manual"))
        self.set_dnd(self.dnd_manual)
        self._publish("settings", changed=sorted(new_cfg.keys())[:20])
        self._log("设置已应用：大小 %.2f，音效 %d，语音 %d，免打扰 %s"
                  % (self.scale, int(new_cfg.get("volume", 70)),
                     int(new_cfg.get("voice_volume", 85)), "开" if self.in_dnd() else "关"))

    def _on_hotkey(self, hid: int) -> None:
        action = (getattr(self, "_hotkey_map", None) or {}).get(int(hid))
        if action == "toggle":
            if self.isVisible():
                self.hide()
            else:
                self.show()
                self._keep_on_top()
        elif action == "settings":
            self.open_settings()
        elif action == "dnd":
            active = self.set_dnd(not self.dnd_manual)
            self._log("快捷键切换免打扰：%s" % ("开" if active else "关"))

    # ---------- 物理 / 移动 / 情绪（v0.5） ----------
    def _load_motion_data(self) -> dict:
        """读 move_strides.json（每个移动动画一圈位移）与 text_clips.json（不能镜像的片段）。"""
        import json

        assets = self.cfg.get("assets_dir") or ""
        data = {"speeds": {}, "no_mirror": set()}
        try:
            with open(os.path.join(assets, "move_strides.json"), "r", encoding="utf-8") as fh:
                strides = json.load(fh) or {}
            for name, info in strides.items():
                if not isinstance(info, dict):
                    continue
                stride = float(info.get("stride") or 0)
                clip = self.find_clip(name)
                if clip is None or stride <= 0:
                    continue
                data["speeds"][clip.key] = physics.walk_speed_px_s(stride, clip.count, clip.fps)
        except Exception as exc:
            self._log("读取 move_strides 失败：%s" % exc)
        try:
            with open(os.path.join(assets, "text_clips.json"), "r", encoding="utf-8") as fh:
                tc = json.load(fh) or {}
            for name in tc.get("no_mirror") or []:
                data["no_mirror"].add(str(name))
        except Exception:
            pass
        return data

    def _move_clip(self):
        """挑一段可用的移动动画（优先有速度标定的）。"""
        clips = self._cat("move")
        if not clips:
            return None, 0.0
        for clip in clips:
            sp = self._motion["speeds"].get(clip.key)
            if sp:
                return clip, sp
        return clips[0], 40.0

    def _bounds(self):
        screen = self.screen() or QGuiApplication.primaryScreen()
        area = screen.availableGeometry() if screen else QRect(0, 0, 1280, 720)
        return physics.screen_bounds(area, self.width(), self.height())

    def start_walk(self, dx: float) -> None:
        """朝某个方向走一段（dx 像素，负数向左）。"""
        clip, speed = self._move_clip()
        if clip is None or abs(dx) < 4:
            return
        left, top, right, bottom = self._bounds()
        target = physics.clamp(self.x() + dx, left, right)
        if abs(target - self.x()) < 2:
            return
        self._walk_target = target
        self._facing = 1 if dx > 0 else -1
        self._mode = "walk"
        self._play_once(clip)
        self._publish("walk", dx=dx, speed=round(speed, 1))
        if not self._phys_timer.isActive():
            self._phys_timer.start()

    def throw(self, vx: float, vy: float) -> None:
        """被甩出去：抛物线 + 边缘反弹 + 落地摩擦。"""
        self._mode = "throw"
        self._vx = float(vx)
        self._vy = float(vy)
        self._walk_target = None
        self._facing = physics.facing_for_dx(vx, self._facing)
        self._publish("throw", vx=round(vx), vy=round(vy))
        if not self._phys_timer.isActive():
            self._phys_timer.start()

    def _step_physics(self) -> None:
        dt = 0.016
        if self._mode == "walk":
            clip, speed = self._move_clip()
            left, top, right, bottom = self._bounds()
            step = speed * dt * (1 if self._facing >= 0 else -1)
            nx = self.x() + step
            if (self._facing >= 0 and nx >= self._walk_target) or (self._facing < 0 and nx <= self._walk_target):
                nx = self._walk_target
                self._walk_target = None
                self._mode = "idle"
                self._phys_timer.stop()
                self._save_geometry()
                self._play_idle()
            else:
                self.move(int(physics.clamp(nx, left, right)), self.y())
            self._snap(pos=[self.x(), self.y()], facing=self._facing)
            return

        if self._mode == "throw":
            bounds = self._bounds()
            nx, ny, vx, vy, on_ground, bounced = physics.step_free(
                float(self.x()), float(self.y()), self._vx, self._vy, dt, bounds)
            self.move(int(nx), int(ny))
            self._vx, self._vy = vx, vy
            if bounced:
                self._publish("bounce", x=int(nx), y=int(ny))
            if on_ground and abs(vx) < physics.STOP_SPEED and abs(vy) < 1:
                self._mode = "idle"
                self._phys_timer.stop()
                self._save_geometry()
                self._kick_squash(1.2)
                self._play_idle()
                self._publish("land", x=int(nx), y=int(ny))
            self._snap(pos=[self.x(), self.y()])
            return

        self._phys_timer.stop()

    # ---------- 情绪 → 动作 ----------
    def set_mood(self, mood: int = None, boredom: int = None, emotion: str = None) -> dict:
        if mood is not None:
            self.mood["mood"] = max(-100, min(100, int(mood)))
        if boredom is not None:
            self.mood["boredom"] = max(0, min(100, int(boredom)))
        if emotion is not None:
            self.mood["emotion"] = str(emotion)[:12]
        self._publish("mood", **self.mood)
        self._snap(mood=self.mood)
        return dict(self.mood)

    def _pick_click_clip(self):
        """按当前情绪挑「点击回应」：开心更活泼，生气更傲娇。"""
        items = self._cat("click")
        if not items:
            return None
        emo = self.mood.get("emotion") or ""
        want = []
        if emo in ("开心", "满足", "期待", "撒娇"):
            want = ["开心", "元气"]
        elif emo in ("生气", "傲娇", "委屈", "吃醋"):
            want = ["傲娇", "生气", "害羞"]
        for key in want:
            for clip in items:
                if key in clip.key:
                    return clip
        return random.choice(items)

    def _maybe_self_play(self) -> None:
        """她自己找点事做：无聊度高就更活跃，心情差就更安静。"""
        if self._mode != "idle" or not self.isVisible():
            return
        if self.in_dnd():                        # 免打扰：不自己找事做
            return
        if self.bubble is not None and self.bubble.isVisible():
            return
        boredom = int(self.mood.get("boredom") or 0)
        mood = int(self.mood.get("mood") or 0)
        chance = 0.30                     # v0.9：整体 ×2（更活泼）
        if boredom >= 60:
            chance = 1.0
        elif boredom >= 30:
            chance = 0.6
        if mood <= -30:
            chance *= 0.4
        if random.random() > chance:
            return
        if mood <= -40:                                  # 心情差 → 蔫着
            clip = self.find_clip("小憩") or self.find_clip("哈欠") or self.find_clip("发呆")
        elif boredom >= 60:                              # 无聊 → 自己玩
            clip = self._pick("random")
        else:
            clip = self.find_clip("东张西望") or self._pick("random")
        if clip is not None:
            self._play_once(clip)
            self._publish("self_play", anim=clip.key, boredom=boredom)

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
        # 朝向：朝左就水平镜像（但含文字的片段不镜像，否则字会反着）
        clip = self.player.clip
        if self._facing < 0 and clip is not None and clip.key not in self._motion.get("no_mirror", ()):
            painter.translate(self.width(), 0)
            painter.scale(-1, 1)
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
            self._drag_points = [(time.perf_counter(), self._drag_origin.x(), self._drag_origin.y())]
            if self._mode == "walk":          # 被人抓住时先停下
                self._mode = "idle"
                self._walk_target = None
                self._phys_timer.stop()
            self._kick_squash(1.0)         # 按下去的瞬间就压一下，手感立刻回来
            event.accept()

    def mouseMoveEvent(self, event) -> None:                       # noqa: N802
        if self._drag_origin is None:
            return
        pos = event.globalPosition().toPoint()
        delta = pos - self._drag_origin
        if abs(delta.x()) + abs(delta.y()) > 3:
            self._drag_moved = True
        self._drag_points.append((time.perf_counter(), pos.x(), pos.y()))
        if len(self._drag_points) > 6:
            self._drag_points.pop(0)
        self.move(self._drag_window_origin + delta)
        event.accept()

    def mouseReleaseEvent(self, event) -> None:                    # noqa: N802
        if event.button() != Qt.LeftButton or self._drag_origin is None:
            return
        self._drag_origin = None
        if self._drag_moved:
            # 松手速度够快 → 甩出去（抛物线 + 反弹）；否则只是放下
            vx, vy = physics.velocity_from_points(self._drag_points)
            self._drag_points = []
            if physics.should_throw(vx, vy):
                self.throw(vx * 0.75, vy * 0.75)
            else:
                self._save_geometry()
                self._kick_squash(0.65)
                self._publish("drag_end", x=self.x(), y=self.y())
                self._snap()
        elif self.cfg.get("click_response", True):
            self._play_once(self._pick_click_clip())
            quiet = self.in_dnd() or self.cfg.get("sound_enabled") is False
            played = (self.sound.play("click") if (self.sound is not None and not quiet) else False)
            detail = ""
            if self.sound is not None and hasattr(self.sound, "debug_state"):
                detail = " / " + self.sound.debug_state("click")
            self._log("身体被点了一下（音效%s）%s%s"
                      % ("响" if played else "静音/无设备", detail,
                         "（免打扰）" if quiet else ""))
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
        settings_act = QAction("设置…", self)
        settings_act.triggered.connect(self.open_settings)
        menu.addAction(settings_act)
        dnd_act = QAction("免打扰", self, checkable=True)
        dnd_act.setChecked(self.in_dnd())
        dnd_act.triggered.connect(lambda checked=False: self.set_dnd(not self.dnd_manual))
        menu.addAction(dnd_act)
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
