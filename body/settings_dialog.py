"""设置页：大小、音量、行为开关、免打扰（含自动时段）。

只改「身体这一侧的配置」；报时/播报这类大脑侧设置这里只做说明。
保存时写回 body/config.json（与托盘、右键菜单共用同一份）。
"""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal, QTime
from PySide6.QtWidgets import (
    QCheckBox, QDialog, QDialogButtonBox, QFormLayout, QGroupBox, QHBoxLayout,
    QLabel, QSlider, QTimeEdit, QVBoxLayout,
)


class SettingsDialog(QDialog):
    applied = Signal(dict)

    def __init__(self, config: dict, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Momo 身体设置")
        self.setMinimumWidth(380)
        self.cfg = dict(config or {})

        root = QVBoxLayout(self)

        # ---- 外观 ----
        box_look = QGroupBox("大小与音量")
        form = QFormLayout(box_look)
        self.scale_slider = QSlider(Qt.Horizontal)
        self.scale_slider.setRange(15, 100)
        self.scale_slider.setValue(int(round(float(self.cfg.get("scale") or 0.4) * 100)))
        self.scale_label = QLabel()
        row = QHBoxLayout()
        row.addWidget(self.scale_slider, 1)
        row.addWidget(self.scale_label)
        form.addRow("大小", row)
        self.scale_slider.valueChanged.connect(self._refresh_labels)

        self.sfx_slider = self._volume_row(form, "点击音效音量", "volume", 70)
        self.voice_slider = self._volume_row(form, "语音音量", "voice_volume", 85)
        root.addWidget(box_look)

        # ---- 行为 ----
        box_behave = QGroupBox("行为")
        bv = QVBoxLayout(box_behave)
        self.chk_sound = QCheckBox("启用音效")
        self.chk_sound.setChecked(self.cfg.get("sound_enabled", True) is not False)
        self.chk_click = QCheckBox("点击有回应（动画 + 音效）")
        self.chk_click.setChecked(self.cfg.get("click_response", True) is not False)
        self.chk_squash = QCheckBox("点击 Q 弹挤压")
        self.chk_squash.setChecked(self.cfg.get("squash_enabled", True) is not False)
        self.chk_through = QCheckBox("整窗鼠标穿透")
        self.chk_through.setChecked(bool(self.cfg.get("click_through")))
        for w in (self.chk_sound, self.chk_click, self.chk_squash, self.chk_through):
            bv.addWidget(w)
        root.addWidget(box_behave)

        # ---- 免打扰 ----
        box_dnd = QGroupBox("免打扰")
        df = QFormLayout(box_dnd)
        self.chk_dnd = QCheckBox("现在开始免打扰（静音、不自己玩、不播报）")
        self.chk_dnd.setChecked(bool(self.cfg.get("dnd_manual")))
        df.addRow(self.chk_dnd)
        self.chk_dnd_auto = QCheckBox("自动时段")
        self.chk_dnd_auto.setChecked(self.cfg.get("dnd_auto", True) is not False)
        df.addRow(self.chk_dnd_auto)
        row2 = QHBoxLayout()
        self.dnd_from = QTimeEdit()
        self.dnd_from.setDisplayFormat("HH:mm")
        self.dnd_from.setTime(self._qtime(self.cfg.get("dnd_from") or "23:00"))
        self.dnd_to = QTimeEdit()
        self.dnd_to.setDisplayFormat("HH:mm")
        self.dnd_to.setTime(self._qtime(self.cfg.get("dnd_to") or "08:00"))
        row2.addWidget(self.dnd_from)
        row2.addWidget(QLabel("到"))
        row2.addWidget(self.dnd_to)
        df.addRow("时段", row2)
        root.addWidget(box_dnd)

        tip = QLabel("报时 / 早间播报 / 抽签这些是大脑侧设置，在 QQ 里说「改设置」或改配置文件调。\n"
                     "快捷键：Ctrl+Alt+M 显隐 · Ctrl+Alt+S 设置 · Ctrl+Alt+D 免打扰")
        tip.setWordWrap(True)
        tip.setStyleSheet("color:#666; font-size:11px;")
        root.addWidget(tip)

        buttons = QDialogButtonBox(QDialogButtonBox.Save | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self._save)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)

        self._refresh_labels()

    # ---------- 小工具 ----------
    def _volume_row(self, form: QFormLayout, label: str, key: str, default: int) -> QSlider:
        s = QSlider(Qt.Horizontal)
        s.setRange(0, 100)
        s.setValue(int(self.cfg.get(key, default) or default))
        form.addRow(label, s)
        return s

    @staticmethod
    def _qtime(text: str) -> QTime:
        try:
            hh, mm = str(text).split(":")
            return QTime(int(hh), int(mm))
        except Exception:
            return QTime(0, 0)

    def _refresh_labels(self) -> None:
        self.scale_label.setText("%.2f" % (self.scale_slider.value() / 100.0))

    # ---------- 保存 ----------
    def _save(self) -> None:
        out = dict(self.cfg)
        out.update({
            "scale": round(self.scale_slider.value() / 100.0, 2),
            "volume": int(self.sfx_slider.value()),
            "voice_volume": int(self.voice_slider.value()),
            "sound_enabled": bool(self.chk_sound.isChecked()),
            "click_response": bool(self.chk_click.isChecked()),
            "squash_enabled": bool(self.chk_squash.isChecked()),
            "click_through": bool(self.chk_through.isChecked()),
            "dnd_manual": bool(self.chk_dnd.isChecked()),
            "dnd_auto": bool(self.chk_dnd_auto.isChecked()),
            "dnd_from": self.dnd_from.time().toString("HH:mm"),
            "dnd_to": self.dnd_to.time().toString("HH:mm"),
        })
        self.applied.emit(out)
        self.accept()
