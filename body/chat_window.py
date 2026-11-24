"""桌宠文字聊天（v3.2.0）：支持连发多条，Momo 停顿 2.5 秒后一次理解并回复。

复用 Momo 本机大脑，不直接保存 API Key 或另建人格。
"""
from __future__ import annotations

import threading
import uuid

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtWidgets import QDialog, QHBoxLayout, QLabel, QLineEdit, QPushButton, QTextBrowser, QVBoxLayout

from brain_api import BrainAPI

FLUSH_MS = 2500  # 停顿这么久没再发，就把攒下的消息一次发给 Momo


class _ChatReply(QObject):
    done = Signal(str, str, str)             # event_id, reply, error


class ChatWindow(QDialog):
    def __init__(self, parent=None, api: BrainAPI = None):
        super().__init__(parent)
        self.setWindowTitle("和 Momo 聊天")
        self.resize(520, 560)
        self.api = api or BrainAPI()
        self.history = []
        self._busy = False
        self._pending_event = ""
        self._pending_msgs = []              # 等待聚合发送的连发消息
        self._plain_lines = []               # 供 history 重建的纯文本记录
        self._flush_timer = QTimer(self)
        self._flush_timer.setSingleShot(True)
        self._flush_timer.setInterval(FLUSH_MS)
        self._flush_timer.timeout.connect(self._flush)
        root = QVBoxLayout(self)
        tip = QLabel("可以像 QQ 一样连发好几条～ Momo 会等你停 2.5 秒再一起看、一起回。")
        tip.setWordWrap(True)
        root.addWidget(tip)
        self.transcript = QTextBrowser()
        self.transcript.setReadOnly(True)
        self.transcript.setOpenExternalLinks(False)
        root.addWidget(self.transcript, 1)
        row = QHBoxLayout()
        self.input = QLineEdit()
        self.input.setPlaceholderText("随便聊聊，或者说「我们一起编故事」…")
        self.send_btn = QPushButton("发送")
        row.addWidget(self.input, 1)
        row.addWidget(self.send_btn)
        root.addLayout(row)
        self.status = QLabel("")
        self.status.setWordWrap(True)
        root.addWidget(self.status)
        self.send_btn.clicked.connect(self.send)
        self.input.returnPressed.connect(self.send)

    def _append(self, who: str, text: str) -> None:
        self._plain_lines.append("%s：%s" % (who, text))
        import html as _html
        esc = _html.escape(text).replace("\n", "<br>")
        if who == "你":
            bubble = ('<div style="text-align:right;margin:3px 2px;">'
                      '<span style="background:#9DBEFF;color:#14304E;border-radius:12px;padding:6px 12px;">%s</span></div>') % esc
        elif who == "Momo":
            bubble = ('<div style="text-align:left;margin:3px 2px;">'
                      '<span style="background:#FFD6E0;color:#5A2434;border-radius:12px;padding:6px 12px;">%s</span></div>') % esc
        else:
            bubble = ('<div style="text-align:center;margin:3px 2px;color:#9A93A6;font-size:11px;">%s</div>') % esc
        self.transcript.append(bubble)

    def send(self) -> None:
        text = self.input.text().strip()
        if not text:
            return
        self.input.clear()
        self._append("你", text)
        self._pending_msgs.append(text)
        self._flush_timer.start()
        if not self._busy:
            self.status.setText(f"已收到 {len(self._pending_msgs)} 条，Momo 等你发完…")

    def _flush(self) -> None:
        """把攒下的消息聚合为一次请求（busy 时由 _finished 再触发）。"""
        if self._busy or not self._pending_msgs:
            return
        msgs = self._pending_msgs
        self._pending_msgs = []
        if len(msgs) == 1:
            payload = msgs[0]
        else:
            numbered = "\n".join(f"{i + 1}. {m}" for i, m in enumerate(msgs))
            payload = f"（对方连发了 {len(msgs)} 条）\n{numbered}"
        self._busy = True
        self.input.setDisabled(True)
        self.send_btn.setDisabled(True)
        self.status.setText("Momo 正在想…")
        self._pending_event = uuid.uuid4().hex
        signal = _ChatReply(self)
        signal.done.connect(self._finished)

        def work():
            try:
                reply = self.api.chat(payload, self.history, self._pending_event)
                signal.done.emit(self._pending_event, reply, "")
            except Exception as exc:
                signal.done.emit(self._pending_event, "", str(exc))

        threading.Thread(target=work, daemon=True).start()

    def _finished(self, event_id: str, reply: str, error: str) -> None:
        if event_id != self._pending_event:
            return
        self._busy = False
        self.input.setDisabled(False)
        self.send_btn.setDisabled(False)
        self.input.setFocus()
        if error:
            self.status.setText(error + "（这条没有记入对话，可以直接重发）")
            self._append("系统", "这次没连好，请重发一句。")
            if self._pending_msgs:
                self._flush()
            return
        if not reply:
            reply = "嗯，我在。"
        self._append("Momo", reply)
        # 从纯文本记录还原最近 user/assistant，失败回合不会混入历史。
        reconstructed = []
        for line in self._plain_lines:
            if line.startswith("你："):
                reconstructed.append({"role": "user", "content": line[2:]})
            elif line.startswith("Momo："):
                reconstructed.append({"role": "assistant", "content": line[5:]})
        self.history = reconstructed[-20:]
        self.status.setText("")
        if self._pending_msgs:
            self.status.setText(f"还有 {len(self._pending_msgs)} 条等 Momo 看…")
            self._flush()
