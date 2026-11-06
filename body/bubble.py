"""说话气泡：挂在身体头顶的一个小浮窗（圆角 + 小尖角 + 自动消失）。

单独做顶层窗口而不是画在身体窗口里——身体窗口只有 256×144，文字放不下也会被裁掉。
"""
from __future__ import annotations

from PySide6.QtCore import QPoint, QRect, QSize, Qt, QTimer
from PySide6.QtGui import QColor, QFont, QFontMetrics, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QWidget

MAX_WIDTH = 300
PAD_X = 12
PAD_Y = 9
TAIL_H = 8


class SpeechBubble(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint
                            | Qt.Tool | Qt.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_ShowWithoutActivating, True)
        self._text = ""
        self._font = QFont()
        self._font.setPointSizeF(10.5)
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.hide)

    # ---- 外部接口 ----
    def show_text(self, text: str, anchor: QWidget, duration_ms: int = 5000) -> None:
        text = str(text or "").strip()
        if not text:
            return
        self._text = text[:300]
        self._resize_to_text()
        self._place_above(anchor)
        self.show()
        self.raise_()
        self.update()
        self._timer.start(max(1200, int(duration_ms)))

    def hideEvent(self, event) -> None:                     # noqa: N802
        if self._timer.isActive():
            self._timer.stop()
        super().hideEvent(event)

    # ---- 布局 ----
    def _resize_to_text(self) -> None:
        metrics = QFontMetrics(self._font)
        rect = metrics.boundingRect(QRect(0, 0, MAX_WIDTH - PAD_X * 2, 1000),
                                    Qt.TextWordWrap, self._text)
        w = min(MAX_WIDTH, rect.width() + PAD_X * 2 + 4)
        h = rect.height() + PAD_Y * 2 + TAIL_H
        self.resize(QSize(max(60, w), max(34, h)))

    def _place_above(self, anchor: QWidget) -> None:
        if anchor is None:
            return
        geo = anchor.frameGeometry()
        screen = anchor.screen().availableGeometry() if anchor.screen() else None
        x = geo.center().x() - self.width() // 2
        y = geo.top() - self.height() + 2
        if screen is not None:
            x = max(screen.left() + 4, min(x, screen.right() - self.width() - 4))
            if y < screen.top() + 4:                        # 顶到屏幕就翻到下面
                y = geo.bottom() - 2
        self.move(QPoint(int(x), int(y)))

    # ---- 绘制 ----
    def paintEvent(self, event) -> None:                    # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        body = QRect(0, 0, self.width() - 1, self.height() - TAIL_H - 1)

        path = QPainterPath()
        path.addRoundedRect(body, 10, 10)
        tail_cx = self.width() // 2
        path.moveTo(tail_cx - 6, body.bottom())
        path.lineTo(tail_cx, body.bottom() + TAIL_H)
        path.lineTo(tail_cx + 6, body.bottom())
        path.closeSubpath()

        painter.setPen(QPen(QColor(60, 60, 70, 160), 1))
        painter.setBrush(QColor(255, 255, 255, 242))
        painter.drawPath(path)

        painter.setPen(QColor(35, 35, 45))
        painter.setFont(self._font)
        painter.drawText(body.adjusted(PAD_X, PAD_Y, -PAD_X, -PAD_Y),
                         int(Qt.TextWordWrap) | int(Qt.AlignLeft) | int(Qt.AlignVCenter),
                         self._text)
        painter.end()
