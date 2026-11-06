"""帧序列动画（frameseq）加载与播放。

素材与目录组织方式借鉴 PC2005-cloud/dsh-pet（MIT）的 frameseq 结构：
每个片段一个目录，内含 f_0001.webp 逐帧图 + meta.json（fps / frames）。
本文件代码为自写实现，未复制上游源码（署名见 docs/body-attribution.md）。
"""
from __future__ import annotations

import json
import os

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtGui import QPixmap


class Clip:
    """一段动画。"""

    def __init__(self, clip_dir: str):
        self.dir = clip_dir
        self.key = os.path.basename(clip_dir).split(".")[0]      # 目录名形如「待机呼吸休闲.d41f157159e8」
        self.category = os.path.basename(os.path.dirname(clip_dir))
        self.fps = 24.0
        self.count = 0
        meta_path = os.path.join(clip_dir, "meta.json")
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as fh:
                    meta = json.load(fh) or {}
                self.fps = float(meta.get("fps") or 24.0)
                self.count = int(meta.get("frames") or 0)
            except Exception:
                pass
        if self.count <= 0:
            self.count = len([n for n in os.listdir(clip_dir) if n.lower().endswith(".webp")])
        self._paths = [os.path.join(clip_dir, "f_%04d.webp" % i) for i in range(1, self.count + 1)]
        self._cache = {}

    def pixmap(self, idx: int) -> QPixmap:
        idx = max(0, min(int(idx), self.count - 1))
        pm = self._cache.get(idx)
        if pm is None:
            pm = QPixmap(self._paths[idx])
            if pm.isNull():
                pm = QPixmap(1, 1)
                pm.fill(0)
            self._cache[idx] = pm
        return pm

    def native_size(self):
        return self.pixmap(0).size()

    def drop_cache(self) -> None:
        self._cache.clear()

    def __repr__(self) -> str:
        return "<Clip %s/%s %d帧@%gfps>" % (self.category, self.key, self.count, self.fps)


def scan_clips(assets_dir: str, subdir: str = "frameseq") -> dict:
    """扫描 assets/<subdir>/**/，返回 {分类: [Clip, ...]}（保持目录名排序）。

    subdir 默认 frameseq（旧桌宠已解码的低清帧）；生成高清帧后可用 frameseq-hi。
    分类支持一层嵌套（如 events/balance），标签写成 "events/balance"。
    """
    out = {}
    root = os.path.join(assets_dir, subdir or "frameseq")
    if not os.path.isdir(root):
        return out

    def _is_clip_dir(path: str) -> bool:
        return os.path.exists(os.path.join(path, "meta.json"))

    def _collect(cat_dir: str, label: str) -> None:
        try:
            entries = sorted(os.listdir(cat_dir))
        except OSError:
            return
        clips, subdirs = [], []
        for name in entries:
            path = os.path.join(cat_dir, name)
            if not os.path.isdir(path):
                continue
            if _is_clip_dir(path):
                try:
                    clips.append(Clip(path))
                except Exception:
                    continue
            else:
                subdirs.append(path)
        if clips:
            out[label] = clips
        for path in subdirs:                       # 只下探一层，防止误扫深目录
            if label.count("/") >= 1:
                continue
            _collect(path, label + "/" + os.path.basename(path))

    for cat in sorted(os.listdir(root)):
        cat_dir = os.path.join(root, cat)
        if os.path.isdir(cat_dir):
            _collect(cat_dir, cat)
    return out


class Player(QObject):
    """按片段 fps 推进帧号。loop=True 循环；否则播完发 finished。"""

    finished = Signal(str)          # 片段 key
    frame_changed = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)
        self.clip = None
        self.index = 0
        self.loop = True
        self._fps_cap = 30

    def set_fps_cap(self, cap) -> None:
        self._fps_cap = max(1, int(cap or 30))

    @property
    def playing(self) -> bool:
        return self._timer.isActive()

    def play(self, clip, loop: bool = True) -> None:
        self._timer.stop()
        self.clip = clip
        self.index = 0
        self.loop = loop
        if clip is None or clip.count <= 0:
            return
        fps = min(clip.fps, float(self._fps_cap))
        interval = max(1, int(round(1000.0 / fps)))
        self._timer.start(interval)
        self.frame_changed.emit()

    def stop(self) -> None:
        if self._timer.isActive():
            self._timer.stop()
        self.clip = None
        self.index = 0

    def _tick(self) -> None:
        if self.clip is None:
            self._timer.stop()
            return
        nxt = self.index + 1
        if nxt >= self.clip.count:
            if self.loop:
                nxt = 0
            else:
                self._timer.stop()
                self.index = self.clip.count - 1
                self.finished.emit(self.clip.key)
                return
        self.index = nxt
        self.frame_changed.emit()

    def current_pixmap(self):
        if self.clip is None:
            return None
        return self.clip.pixmap(self.index)
