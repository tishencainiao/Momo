"""Momo 小屋主题：纯 QSS 自绘，浅色默认 + 深色可切换（v3.2.0）。"""
from __future__ import annotations

ACCENT = "#FF8FA3"      # 鲑鱼粉（Momo 主色）
ACCENT_DARK = "#E86A8A"
WARM = "#FFC078"        # 暖橙（强调）

LIGHT = """
* { font-family: "Microsoft YaHei UI", "PingFang SC", "Segoe UI", sans-serif; }
QWidget { background: #F7F5F0; color: #3A3440; font-size: 13px; }
QLabel#title { font-size: 19px; font-weight: 700; color: #2E2833; }
QLabel#sub { color: #8B8494; font-size: 12px; }
QLabel#cardTitle { font-size: 12px; font-weight: 600; color: #8B8494; letter-spacing: 1px; }
QLabel#cardValue { font-size: 15px; font-weight: 600; color: #2E2833; }
QLabel#dot { color: #FF8FA3; font-size: 14px; }
QFrame#card {
    background: #FFFFFF; border-radius: 12px;
    border: 1px solid #EEE8E0;
}
QPushButton {
    background: #FFFFFF; border: 1px solid #E4DCD2; border-radius: 8px;
    padding: 7px 12px; color: #3A3440;
}
QPushButton:hover { background: #FFF4F6; border-color: #FF8FA3; }
QPushButton:pressed { background: #FFE4EA; }
QPushButton#primary { background: #FF8FA3; color: white; border: none; font-weight: 600; }
QPushButton#primary:hover { background: #E86A8A; }
QPushButton#primary:pressed { background: #D85A7A; }
QPushButton#refreshing { background: #F3F0EA; color: #B0A8B8; border: 1px solid #E4DCD2; }
QProgressBar {
    border: none; background: #F0EBE2; border-radius: 5px; height: 8px; text-align: center;
}
QProgressBar::chunk { background: qlineargradient(x1:0,y1:0,x2:1,y2:0, stop:0 #FFC078, stop:1 #FF8FA3); border-radius: 5px; }
QToolTip {
    background: #2E2833; color: #FFF; border: none; padding: 8px 10px;
    border-radius: 6px; font-size: 12px;
}
QGroupBox { border: 1px solid #EEE8E0; border-radius: 10px; margin-top: 12px; padding-top: 6px; font-weight: 600; }
QGroupBox::title { subcontrol-origin: margin; left: 12px; padding: 0 4px; color: #6B6474; }
QScrollArea { border: none; }
QLineEdit, QTextEdit, QDoubleSpinBox, QTimeEdit, QSpinBox {
    background: #FFFFFF; border: 1px solid #E4DCD2; border-radius: 8px; padding: 6px 8px;
}
QLineEdit:focus, QTextEdit:focus { border-color: #FF8FA3; }
QCheckBox::indicator { width: 16px; height: 16px; border-radius: 5px; border: 1px solid #C9C0B4; background: #FFF; }
QCheckBox::indicator:checked { background: #FF8FA3; border-color: #FF8FA3; }
"""

DARK = """
* { font-family: "Microsoft YaHei UI", "PingFang SC", "Segoe UI", sans-serif; }
QWidget { background: #1E1B24; color: #E8E3EF; font-size: 13px; }
QLabel#title { font-size: 19px; font-weight: 700; color: #F5F1FA; }
QLabel#sub { color: #9A93A6; font-size: 12px; }
QLabel#cardTitle { font-size: 12px; font-weight: 600; color: #9A93A6; letter-spacing: 1px; }
QLabel#cardValue { font-size: 15px; font-weight: 600; color: #F5F1FA; }
QLabel#dot { color: #FF8FA3; font-size: 14px; }
QFrame#card {
    background: #2A2633; border-radius: 12px;
    border: 1px solid #3A3545;
}
QPushButton {
    background: #2A2633; border: 1px solid #453F52; border-radius: 8px;
    padding: 7px 12px; color: #E8E3EF;
}
QPushButton:hover { background: #3A2F3C; border-color: #FF8FA3; }
QPushButton:pressed { background: #4A3344; }
QPushButton#primary { background: #E86A8A; color: white; border: none; font-weight: 600; }
QPushButton#primary:hover { background: #FF8FA3; }
QPushButton#primary:pressed { background: #D85A7A; }
QPushButton#refreshing { background: #26222E; color: #776F84; border: 1px solid #453F52; }
QProgressBar {
    border: none; background: #3A3545; border-radius: 5px; height: 8px; text-align: center;
}
QProgressBar::chunk { background: qlineargradient(x1:0,y1:0,x2:1,y2:0, stop:0 #FFC078, stop:1 #FF8FA3); border-radius: 5px; }
QToolTip {
    background: #F5F1FA; color: #2E2833; border: none; padding: 8px 10px;
    border-radius: 6px; font-size: 12px;
}
QGroupBox { border: 1px solid #3A3545; border-radius: 10px; margin-top: 12px; padding-top: 6px; font-weight: 600; }
QGroupBox::title { subcontrol-origin: margin; left: 12px; padding: 0 4px; color: #B8B0C4; }
QScrollArea { border: none; }
QLineEdit, QTextEdit, QDoubleSpinBox, QTimeEdit, QSpinBox {
    background: #26222E; border: 1px solid #453F52; border-radius: 8px; padding: 6px 8px; color: #E8E3EF;
}
QLineEdit:focus, QTextEdit:focus { border-color: #FF8FA3; }
QCheckBox::indicator { width: 16px; height: 16px; border-radius: 5px; border: 1px solid #574F66; background: #26222E; }
QCheckBox::indicator:checked { background: #E86A8A; border-color: #E86A8A; }
"""


def sheet(dark: bool) -> str:
    return DARK if dark else LIGHT
