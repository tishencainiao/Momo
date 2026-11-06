"""音效播放：只用标准库 winsound，可调音量（内存里缩放 PCM 样本）。

为什么不用 QSoundEffect / QMediaPlayer：它们在 PySide6-Addons 里，本项目只装了
Essentials；为一个点击音效多下 150MB 不值得。

限制（如实标注）：
- 只支持 16bit PCM 的 WAV（click.wav / agent/*.wav 都是）；mp3 播不了，预留不实现。
- 音量靠「把 16bit 样本乘系数再夹紧」，不是系统音量，音质在低音量时略糙，够用。
"""
from __future__ import annotations

import os
import queue
import struct
import threading
import winsound

_DEFAULT_VOLUME = 70


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
    buf = bytearray(raw)
    n = size // 2
    if n <= 0:
        return raw
    samples = struct.unpack_from("<%dh" % n, raw, off)
    scaled = [int(s * vol) for s in samples]
    struct.pack_into("<%dh" % n, buf, off, *scaled)
    return bytes(buf)


class SoundPlayer:
    """按名字播 body/assets/sounds/<name>.wav，带音量与静音。

    实现要点：winsound 不允许「内存 + 异步」同时用（会抛 RuntimeError），
    所以内存播放改在**后台线程里同步播**——不卡界面，还能保留音量缩放。
    """

    def __init__(self, sounds_dir: str, volume: int = _DEFAULT_VOLUME, muted: bool = False):
        self.dir = sounds_dir
        self.volume = max(0, min(100, int(volume if volume is not None else _DEFAULT_VOLUME)))
        self.muted = bool(muted)
        self._cache = {}          # (name, volume) -> bytes（同时持有引用，保证播放期间不被回收）
        self.last_error = ""
        self._queue = queue.Queue(maxsize=4)
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()

    # ---- 设置 ----
    def set_volume(self, volume: int) -> None:
        self.volume = max(0, min(100, int(volume)))

    def set_muted(self, muted: bool) -> None:
        self.muted = bool(muted)

    # ---- 查询 ----
    def has(self, name: str) -> bool:
        return os.path.exists(self.path_of(name))

    def path_of(self, name: str) -> str:
        return os.path.join(self.dir, name.replace("\\", "/") + ".wav")

    # ---- 播放 ----
    def play(self, name: str) -> bool:
        """入队播放（立即返回）。静音/音量为 0 时不播，返回 False。"""
        if self.muted or self.volume <= 0:
            return False
        if not self._load(name):
            return False
        try:
            self._queue.put_nowait(name)
            return True
        except queue.Full:
            return True          # 队列满了说明前面还有音在放，直接忽略这一次

    def _load(self, name: str):
        key = (name, self.volume)
        data = self._cache.get(key)
        if data is not None:
            return data
        path = self.path_of(name)
        try:
            with open(path, "rb") as fh:
                raw = fh.read()
        except OSError as exc:
            self.last_error = "读不到音效 %s: %s" % (path, exc)
            return None
        data = _scale_pcm16(raw, self.volume / 100.0) if self.volume < 100 else raw
        self._cache[key] = data
        return data

    def _worker(self) -> None:
        while True:
            name = self._queue.get()
            try:
                data = self._cache.get((name, self.volume))
                if data is None:
                    continue
                winsound.PlaySound(data, winsound.SND_MEMORY | winsound.SND_NODEFAULT)
            except Exception as exc:              # 没有声卡/被占用：静默失败，别影响身体
                self.last_error = str(exc)
            finally:
                self._queue.task_done()

    def wait_idle(self, timeout: float = 3.0) -> bool:
        """等队列播完（自检用）。"""
        done = threading.Event()

        def _watch():
            self._queue.join()
            done.set()

        threading.Thread(target=_watch, daemon=True).start()
        return done.wait(timeout)
