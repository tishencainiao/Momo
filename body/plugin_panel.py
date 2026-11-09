# -*- coding: utf-8 -*-
"""插件面板（P3）：列出大脑已加载/禁用的插件，双击切换启用/禁用。

通过大脑 3999 端点的 /v1/plugins* 管理（见 index.js startPetApi + plugin-host.js setPluginEnabled）。
只用标准库 urllib.request，不引 requests。
"""
import json
import urllib.request

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QListWidget, QListWidgetItem,
    QPushButton, QLabel, QMessageBox,
)

DEFAULT_BRAIN_URL = "http://127.0.0.1:3999"


def _http(method, url, timeout=5):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


class PluginPanel(QDialog):
    """插件列表 + 启停开关。每次操作后整表刷新。"""

    def __init__(self, parent=None, brain_url=DEFAULT_BRAIN_URL):
        super().__init__(parent)
        self.setWindowTitle("Momo 插件面板")
        self.resize(400, 520)
        self.brain_url = brain_url
        self._plugins = []

        lay = QVBoxLayout(self)
        self.info = QLabel("正在加载插件列表…")
        self.info.setWordWrap(True)
        lay.addWidget(self.info)

        self.listw = QListWidget()
        self.listw.itemDoubleClicked.connect(self._toggle_item)
        lay.addWidget(self.listw)

        row = QHBoxLayout()
        self.btn_refresh = QPushButton("刷新")
        self.btn_refresh.clicked.connect(self.refresh)
        row.addWidget(self.btn_refresh)
        self.btn_close = QPushButton("关闭")
        self.btn_close.clicked.connect(self.accept)
        row.addWidget(self.btn_close)
        lay.addLayout(row)

        self.refresh()

    def refresh(self) -> None:
        try:
            data = _http("GET", self.brain_url + "/v1/plugins")
            self._plugins = data.get("plugins", []) or []
        except Exception as e:  # noqa: BLE001
            self._plugins = []
            self.info.setText("无法连接大脑：%s" % str(e)[:80])
            self.listw.clear()
            return
        enabled = sum(1 for p in self._plugins if p.get("enabled"))
        self.info.setText("共 %d 个插件（启用 %d / 禁用 %d），双击切换" % (len(self._plugins), enabled, len(self._plugins) - enabled))
        self.listw.clear()
        for p in self._plugins:
            state = "✔" if p.get("enabled") else "✖"
            name = p.get("name") or "?"
            disp = p.get("displayName") or ""
            item = QListWidgetItem("%s  %-24s %s" % (state, name, disp))
            item.setData(Qt.UserRole, name)
            if not p.get("enabled"):
                item.setForeground(Qt.gray)
            self.listw.addItem(item)

    def _toggle_item(self, item) -> None:
        name = item.data(Qt.UserRole)
        cur = next((p for p in self._plugins if p.get("name") == name), None)
        if cur is None:
            return
        action = "disable" if cur.get("enabled") else "enable"
        try:
            _http("POST", "%s/v1/plugins/%s/%s" % (self.brain_url, name, action))
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "操作失败", str(e)[:160])
            return
        self.refresh()
