"""桌面语音播放：用 QMediaPlayer 播音频文件（wav/mp3），复用 Momo 的克隆音色。

为什么不用 QSoundEffect：它只吃未压缩 WAV；Momo 的 tts.py 产出的是 mp3。
QMediaPlayer 还能拿到时长，气泡停留时间就能按语音长短自动对齐。
"""
from __future__ import annotations

import os
import time

from PySide6.QtCore import QObject, QUrl, Signal
from PySide6.QtMultimedia import QAudioOutput, QMediaDevices, QMediaPlayer


class VoiceOut(QObject):
    """播一段语音；播完（或被打断）时把临时文件删掉。"""

    started = Signal(str)          # 文件路径
    finished = Signal(str)         # 文件路径

    def __init__(self, parent=None):
        super().__init__(parent)
        self._player = QMediaPlayer(self)
        self._audio = QAudioOutput(self)
        self._player.setAudioOutput(self._audio)
        self._path = ""
        self._delete_after = False
        self._volume = 0.85
        self._player.mediaStatusChanged.connect(self._on_status)
        self.last_error = ""

    # ---------- 对外 ----------
    def set_volume(self, volume_0_100: int) -> None:
        self._volume = max(0.0, min(1.0, float(volume_0_100) / 100.0))
        try:
            self._audio.setVolume(self._volume)
        except Exception:
            pass

    def play(self, path: str, delete_after: bool = True) -> bool:
        path = str(path or "")
        if not path or not os.path.exists(path):
            self.last_error = "音频文件不存在：%s" % path
            return False
        try:
            # 上一段如果还没播完：先停、释放文件句柄、再删，避免临时文件越堆越多
            prev, prev_delete = self._path, self._delete_after
            try:
                self._player.stop()
                self._player.setSource(QUrl())
            except Exception:
                pass
            if prev and prev_delete:
                self._remove(prev)

            # 每次播放前重绑当前默认输出：换过耳机/虚拟声卡程序退出后不会「静默失效」
            self._audio.setDevice(QMediaDevices.defaultAudioOutput())
            self._audio.setVolume(self._volume)
            self._path = path
            self._delete_after = bool(delete_after)
            self._player.setSource(QUrl.fromLocalFile(path))
            self._player.play()
            self.started.emit(path)
            return True
        except Exception as exc:
            self.last_error = str(exc)
            return False

    def stop(self) -> None:
        try:
            self._player.stop()
        except Exception:
            pass
        self._cleanup()

    def is_playing(self) -> bool:
        try:
            return self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState
        except Exception:
            return False

    def duration_ms(self) -> int:
        try:
            return int(self._player.duration())
        except Exception:
            return 0

    # ---------- 内部 ----------
    def _on_status(self, status) -> None:
        if status in (QMediaPlayer.MediaStatus.EndOfMedia,
                      QMediaPlayer.MediaStatus.InvalidMedia,
                      QMediaPlayer.MediaStatus.NoMedia):
            if status == QMediaPlayer.MediaStatus.InvalidMedia:
                self.last_error = "无法播放：%s" % self._path
            path = self._path
            self._cleanup()
            self.finished.emit(path)

    def _cleanup(self) -> None:
        path, flag = self._path, self._delete_after
        self._path = ""
        self._delete_after = False
        try:                                  # 先解除占用再删，否则 Windows 上会删不掉
            self._player.setSource(QUrl())
        except Exception:
            pass
        if flag and path:
            self._remove(path)

    def _remove(self, path: str) -> bool:
        if not path:
            return False
        for _ in range(3):
            try:
                if os.path.exists(path):
                    os.remove(path)
                return True
            except Exception:
                time.sleep(0.05)
        return False
