"""音效播放：优先用 Qt 的 QSoundEffect（常驻混音器，低延迟），没有 QtMultimedia 时退回 winsound。

背景（2026-11-06 实测）：这台机器上 `winsound.PlaySound` 播一段 160ms 的点击音要阻塞
约 970ms —— 大头在「每次重新打开音频设备 + 系统音频栈（FxSound / 虚拟声卡）」。
QSoundEffect 在 Qt 内部维护常驻音频输出，只需要开一次设备，所以延迟明显更低，
还自带音量（0~1）与多路混音。

限制（如实标注）：
- QSoundEffect 只吃未压缩 WAV；mp3（duck 音效）仍需 QMediaPlayer，本期不接。
- 两条后端都保留：QtMultimedia 缺失时自动降级到 winsound，功能不中断（只是延迟高）。
"""
from __future__ import annotations

import os
import queue
import struct
import threading

_DEFAULT_VOLUME = 70

try:                                              # QtMultimedia 在 PySide6-Addons 里
    from PySide6.QtCore import QUrl
    from PySide6.QtMultimedia import QSoundEffect

    _HAS_QT = True
except Exception:                                 # 只装了 Essentials 的机器
    _HAS_QT = False


# ---------------------------------------------------------------- winsound 兜底

def _parse_wav(raw: bytes):
    """返回 (data_offset, data_size, bits, channels) 或 None。"""
    if len(raw) < 44 or raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        return None
    pos = 12
    bits = 16
    channels = 1
    data_off = data_size = None
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        size = struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        body = pos + 8
        if cid == b"fmt " and body + 16 <= len(raw):
            _fmt, channels, _rate, _br, _ba, bits = struct.unpack("<HHIIHH", raw[body:body + 16])
        elif cid == b"data":
            data_off = body
            data_size = min(size, len(raw) - body)
            break
        pos = body + size + (size & 1)
    if data_off is None:
        return None
    return data_off, data_size, bits, channels


def _scale_pcm16(raw: bytes, vol: float) -> bytes:
    """把 16bit PCM 样本乘 vol (0~1)，越界夹紧；其它格式原样返回。"""
    info = _parse_wav(raw)
    if info is None:
        return raw
    off, size, bits, _ch = info
    if bits != 16 or vol >= 0.999:
        return raw
    n = size // 2
    if n <= 0:
        return raw
    samples = struct.unpack_from("<%dh" % n, raw, off)
    scaled = [int(s * vol) for s in samples]
    buf = bytearray(raw)
    struct.pack_into("<%dh" % n, buf, off, *scaled)
    return bytes(buf)


class _WinsoundBackend:
    """老后端：内存缩放音量 + 后台线程同步播（延迟高，仅作降级）。"""

    def __init__(self, sounds_dir: str, get_volume, is_muted):
        self.dir = sounds_dir
        self._get_volume = get_volume
        self._is_muted = is_muted
        self.last_error = ""
        self._cache = {}
        self._queue = queue.Queue(maxsize=4)
        threading.Thread(target=self._worker, daemon=True).start()

    def path_of(self, name: str) -> str:
        return os.path.join(self.dir, name.replace("\\", "/") + ".wav")

    def _load(self, name: str):
        vol = self._get_volume()
        key = (name, vol)
        data = self._cache.get(key)
        if data is not None:
            return data
        try:
            with open(self.path_of(name), "rb") as fh:
                raw = fh.read()
        except OSError as exc:
            self.last_error = "读不到音效 %s: %s" % (self.path_of(name), exc)
            return None
        data = _scale_pcm16(raw, vol / 100.0) if vol < 100 else raw
        self._cache[key] = data
        return data

    def play(self, name: str) -> bool:
        if self._is_muted() or self._get_volume() <= 0:
            return False
        if self._load(name) is None:
            return False
        try:
            self._queue.put_nowait(name)
            return True
        except queue.Full:
            return True

    def _worker(self) -> None:
        import winsound
        while True:
            name = self._queue.get()
            try:
                data = self._cache.get((name, self._get_volume()))
                if data is not None:
                    winsound.PlaySound(data, winsound.SND_MEMORY | winsound.SND_NODEFAULT)
            except Exception as exc:
                self.last_error = str(exc)
            finally:
                self._queue.task_done()

    def wait_idle(self, timeout: float = 3.0) -> bool:
        done = threading.Event()

        def _watch():
            self._queue.join()
            done.set()

        threading.Thread(target=_watch, daemon=True).start()
        return done.wait(timeout)


# ---------------------------------------------------------------- 主入口

class SoundPlayer:
    """按名字播 body/assets/sounds/<name>.wav，带音量与静音。

    优先 QSoundEffect（常驻混音器）；QtMultimedia 不可用时降级 winsound。
    """

    def __init__(self, sounds_dir: str, volume: int = _DEFAULT_VOLUME, muted: bool = False):
        self.dir = sounds_dir
        self.volume = max(0, min(100, int(volume if volume is not None else _DEFAULT_VOLUME)))
        self.muted = bool(muted)
        self.last_error = ""
        self.backend = "qt" if _HAS_QT else "winsound"
        self._effects = {}                 # name -> QSoundEffect（必须持有引用，否则会被回收）
        self._fallback = None
        if not _HAS_QT:
            self._fallback = _WinsoundBackend(sounds_dir, lambda: self.volume, lambda: self.muted)

    # ---- 设置 ----
    def set_volume(self, volume: int) -> None:
        self.volume = max(0, min(100, int(volume)))
        self._apply_volume()

    def set_muted(self, muted: bool) -> None:
        self.muted = bool(muted)
        self._apply_volume()

    def _effective_volume(self) -> float:
        return 0.0 if self.muted else max(0.0, min(1.0, self.volume / 100.0))

    def _apply_volume(self) -> None:
        vol = self._effective_volume()
        for eff in self._effects.values():
            try:
                eff.setVolume(vol)
            except Exception:
                pass

    # ---- 查询 ----
    def path_of(self, name: str) -> str:
        return os.path.join(self.dir, name.replace("\\", "/") + ".wav")

    def has(self, name: str) -> bool:
        return os.path.exists(self.path_of(name))

    # ---- 播放 ----
    def _effect(self, name: str):
        eff = self._effects.get(name)
        if eff is not None:
            return eff
        if not self.has(name):
            self.last_error = "音效不存在：%s" % self.path_of(name)
            return None
        try:
            eff = QSoundEffect()
            eff.setSource(QUrl.fromLocalFile(self.path_of(name)))
            eff.setVolume(self._effective_volume())
            eff.setLoopCount(1)
        except Exception as exc:
            self.last_error = str(exc)
            return None
        self._effects[name] = eff
        return eff

    def preload(self, names=("click", "agent/start", "agent/done", "agent/error"),
                timeout_ms: int = 2000) -> int:
        """预加载常用音效（把音频设备提前打开），返回就绪数量。

        注意：QSoundEffect 是异步加载的，靠事件循环推进状态——这里必须 pump
        `processEvents()`，否则永远停在 Loading。
        """
        if not _HAS_QT:
            return 0
        import time
        from PySide6.QtCore import QCoreApplication

        deadline = time.time() + timeout_ms / 1000.0
        pending = []
        for name in names:
            eff = self._effect(name)
            if eff is not None:
                pending.append(eff)
        while pending and time.time() < deadline:
            QCoreApplication.processEvents()
            for eff in list(pending):
                try:
                    st = eff.status()
                except Exception:
                    pending.remove(eff)
                    continue
                if st == QSoundEffect.Status.Ready:
                    pending.remove(eff)
                elif st == QSoundEffect.Status.Error:
                    self.last_error = "音效加载失败：%s" % eff.source().toString()
                    pending.remove(eff)
            if pending:
                time.sleep(0.01)
        QCoreApplication.processEvents()
        return sum(1 for e in self._effects.values()
                   if e.status() == QSoundEffect.Status.Ready)

    def play(self, name: str) -> bool:
        if self.muted or self.volume <= 0:
            return False
        if not _HAS_QT:
            return self._fallback.play(name)
        eff = self._effect(name)
        if eff is None:
            return False
        try:
            eff.play()                 # 常驻混音器：立刻出声，不阻塞界面
            return True
        except Exception as exc:
            self.last_error = str(exc)
            return False

    def wait_idle(self, timeout: float = 3.0) -> bool:
        if not _HAS_QT:
            return self._fallback.wait_idle(timeout)
        import time
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not any(getattr(e, "isPlaying", lambda: False)() for e in self._effects.values()):
                return True
            time.sleep(0.02)
        return False
