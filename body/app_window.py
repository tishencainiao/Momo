"""Momo 桌面主界面（v3.2.0 美化版）：状态卡片、聊天、进程控制、统一生活费与自主活动开关。

浅色默认 + 深色可切换（主题入口 theme.sheet），窗口重显/定时自动刷新。
"""
from __future__ import annotations

import json
import threading
import urllib.parse

from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QDoubleSpinBox, QFrame, QHBoxLayout, QLabel, QMainWindow, QProgressBar,
    QPushButton, QVBoxLayout, QWidget,
)

from brain_api import BrainAPI
import theme


class _Result(QObject):
    done = Signal(str, dict, str)


def _card(parent=None) -> QFrame:
    f = QFrame(parent)
    f.setObjectName("card")
    return f


def _card_title(text: str) -> QLabel:
    lab = QLabel(text.upper())
    lab.setObjectName("cardTitle")
    return lab


def _card_value(text: str) -> QLabel:
    lab = QLabel(text)
    lab.setObjectName("cardValue")
    lab.setWordWrap(True)
    return lab


def _fmt_uptime(sec: float) -> str:
    sec = max(0, int(sec))
    d, rem = divmod(sec, 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    if d:
        return f"{d} 天 {h} 小时"
    if h:
        return f"{h} 小时 {m} 分"
    return f"{m} 分 {s} 秒"


KIND_NAMES = {
    "search": "搜索", "view_space": "看空间", "browse": "浏览网页",
    "read_article": "读文章", "play_puzzle": "解谜", "read_buzz": "看动态",
    "qzone": "发空间", "unknown": "其他",
}


class MainWindow(QMainWindow):
    def __init__(self, actions=None, api: BrainAPI = None, get_body_state=None):
        super().__init__()
        self.actions = actions or {}
        self.api = api or BrainAPI()
        self.get_body_state = get_body_state or (lambda: {})
        self._closing_to_tray = True
        self._busy = set()
        self._dark = False
        self.setWindowTitle("Momo 的小屋")
        self.resize(540, 600)

        self.setStyleSheet(theme.sheet(self._dark))

        root = QVBoxLayout()
        root.setContentsMargins(16, 14, 16, 14)
        root.setSpacing(10)
        central = QWidget(self)
        central.setLayout(root)
        self.setCentralWidget(central)

        # ---- 标题行 ----
        head = QHBoxLayout()
        self.title = QLabel("Momo 的小屋")
        self.title.setObjectName("title")
        head.addWidget(self.title)
        head.addStretch(1)
        self.dot = QLabel("●")
        self.dot.setObjectName("dot")
        head.addWidget(self.dot)
        self.brain_state = QLabel("检查中…")
        self.brain_state.setObjectName("sub")
        head.addWidget(self.brain_state)
        self.theme_btn = QPushButton("🌙 深色")
        self.theme_btn.clicked.connect(self._toggle_theme)
        head.addWidget(self.theme_btn)
        root.addLayout(head)

        # ---- 状态卡片：2×2 网格 ----
        grid1 = QHBoxLayout()
        grid2 = QHBoxLayout()

        # 大脑卡片
        c1 = _card()
        v1 = QVBoxLayout(c1)
        v1.setContentsMargins(12, 10, 12, 10)
        v1.addWidget(_card_title("大脑"))
        self.brain_pid = _card_value("PID — · 运行 — · 阶段 —")
        v1.addWidget(self.brain_pid)
        self.brain_health = QLabel("健康：无异常")
        self.brain_health.setObjectName("sub")
        self.brain_health.setWordWrap(True)
        v1.addWidget(self.brain_health)
        grid1.addWidget(c1, 1)

        # 身体卡片
        c2 = _card()
        v2 = QVBoxLayout(c2)
        v2.setContentsMargins(12, 10, 12, 10)
        v2.addWidget(_card_title("身体"))
        self.body_state = _card_value("显示中 · 免打扰未开")
        v2.addWidget(self.body_state)
        self.body_tip = QLabel("窗口标题、截图与前台感知受免打扰门禁")
        self.body_tip.setObjectName("sub")
        self.body_tip.setWordWrap(True)
        v2.addWidget(self.body_tip)
        grid1.addWidget(c2, 1)
        root.addLayout(grid1)

        # 生活费卡片
        c3 = _card()
        v3 = QVBoxLayout(c3)
        v3.setContentsMargins(12, 10, 12, 10)
        h3 = QHBoxLayout()
        h3.addWidget(_card_title("生活费"))
        h3.addStretch(1)
        self.refresh_btn = QPushButton("↻ 刷新")
        self.refresh_btn.clicked.connect(self.refresh)
        h3.addWidget(self.refresh_btn)
        v3.addLayout(h3)
        self.budget_label = _card_value("今日已用 — 元 · 剩余 — 元")
        v3.addWidget(self.budget_label)
        self.budget_bar = QProgressBar()
        self.budget_bar.setRange(0, 1000)
        v3.addWidget(self.budget_bar)
        self.budget_tier = QLabel("档位 —")
        self.budget_tier.setObjectName("sub")
        v3.addWidget(self.budget_tier)
        h3b = QHBoxLayout()
        self.budget_spin = QDoubleSpinBox()
        self.budget_spin.setRange(0.01, 50.0)
        self.budget_spin.setDecimals(2)
        self.budget_spin.setSingleStep(0.5)
        self.budget_spin.setSuffix(" 元/天")
        self.budget_spin.setToolTip("每日生活费额度（所有入口与 23 点报告共用这一份）")
        h3b.addWidget(self.budget_spin, 1)
        self.set_budget_btn = QPushButton("保存额度")
        self.set_budget_btn.clicked.connect(self.save_budget)
        h3b.addWidget(self.set_budget_btn)
        v3.addLayout(h3b)
        grid2.addWidget(c3, 1)

        # 自主活动卡片
        c4 = _card()
        v4 = QVBoxLayout(c4)
        v4.setContentsMargins(12, 10, 12, 10)
        h4 = QHBoxLayout()
        h4.addWidget(_card_title("自主活动"))
        h4.addStretch(1)
        self.autonomy_value = QLabel("进行中")
        self.autonomy_value.setObjectName("sub")
        h4.addWidget(self.autonomy_value)
        v4.addLayout(h4)
        self.pause_btn = QPushButton("暂停自主活动")
        self.pause_btn.setObjectName("primary")
        self.pause_btn.setCheckable(True)
        self.pause_btn.toggled.connect(self.set_autonomy)
        v4.addWidget(self.pause_btn)
        self.life_value = QLabel("今日动作 — · 阶段 —")
        self.life_value.setObjectName("sub")
        self.life_value.setWordWrap(True)
        v4.addWidget(self.life_value)
        grid2.addWidget(c4, 1)
        root.addLayout(grid2)

        # ---- 健康异常区（有才显示）----
        self.health_box = QWidget()
        hv = QVBoxLayout(self.health_box)
        hv.setContentsMargins(0, 0, 0, 0)
        self.health_lines = QLabel("")
        self.health_lines.setWordWrap(True)
        self.health_lines.setStyleSheet("color:#D0803A; font-size:12px;")
        hv.addWidget(self.health_lines)
        root.addWidget(self.health_box)
        self.health_box.setVisible(False)

        # ---- 共同活动 + 天气（第二批增值）----
        c5 = _card()
        v5 = QVBoxLayout(c5)
        v5.setContentsMargins(12, 10, 12, 10)
        h5 = QHBoxLayout()
        h5.addWidget(_card_title("共同活动"))
        h5.addStretch(1)
        self.companion_value = QLabel("检查中…")
        self.companion_value.setObjectName("sub")
        h5.addWidget(self.companion_value)
        v5.addLayout(h5)
        self.companion_detail = _card_value("没有进行中的活动，可以和 Momo 一起开始一个～")
        v5.addWidget(self.companion_detail)
        self.weather_label = QLabel("天气 —")
        self.weather_label.setObjectName("sub")
        v5.addWidget(self.weather_label)
        root.addWidget(c5)

        # ---- 按钮区 ----
        row1 = QHBoxLayout()
        for text, key in (("💬 和 Momo 聊天", "chat"), ("👀 显示 / 隐藏身体", "toggle_body"), ("⚙ 身体设置", "settings")):
            btn = QPushButton(text)
            btn.clicked.connect(lambda _=False, k=key: self._call(k))
            row1.addWidget(btn)
        root.addLayout(row1)
        row2 = QHBoxLayout()
        for text, key in (("启动大脑", "start"), ("重启大脑", "restart"), ("停止大脑", "stop")):
            btn = QPushButton(text)
            btn.clicked.connect(lambda _=False, k=key: self._call(k))
            row2.addWidget(btn)
        root.addLayout(row2)
        row3 = QHBoxLayout()
        for text, key in (("查看日志", "logs"), ("完全退出", "quit")):
            btn = QPushButton(text)
            btn.clicked.connect(lambda _=False, k=key: self._call(k))
            row3.addWidget(btn)
        root.addLayout(row3)

        self.status = QLabel("关闭此窗口只会回到托盘；明确退出才结束 Momo。")
        self.status.setObjectName("sub")
        self.status.setWordWrap(True)
        root.addWidget(self.status)
        root.addStretch(1)

        self.refresh()
        # 30 秒定时自动刷新
        self._timer = QTimer(self)
        self._timer.setInterval(30000)
        self._timer.timeout.connect(self.refresh)
        self._timer.start()

    # ---- 主题 ----
    def _toggle_theme(self) -> None:
        self._dark = not self._dark
        self.setStyleSheet(theme.sheet(self._dark))
        self.theme_btn.setText("☀ 浅色" if self._dark else "🌙 深色")
        self.health_lines.setStyleSheet(
            "color:#E8A35A; font-size:12px;" if self._dark else "color:#D0803A; font-size:12px;"
        )

    # ---- 动作 ----
    def _call(self, key: str) -> None:
        if key == "refresh":
            self.refresh()
            return
        fn = self.actions.get(key)
        if callable(fn):
            fn()

    def _background(self, name: str, fn) -> None:
        if name in self._busy:
            return
        self._busy.add(name)
        sig = _Result(self)
        sig.done.connect(self._finished)
        def work():
            try:
                result = fn() or {"ok": True}
                sig.done.emit(name, result, "")
            except Exception as exc:
                sig.done.emit(name, {}, str(exc))
        threading.Thread(target=work, daemon=True).start()

    def refresh(self) -> None:
        self._background("refresh", self.api.status)
        self._background("companion", self.api.companion)
        self._background("weather", self._fetch_weather)

    def _fetch_weather(self) -> dict:
        import urllib.request
        try:
            city = (self.get_body_state() or {}).get("weather_city") or "北京"
            geo = urllib.request.urlopen(
                "https://geocoding-api.open-meteo.com/v1/search?name=%s&count=1&language=zh" % urllib.parse.quote(city),
                timeout=6)
            g = json.loads(geo.read().decode("utf-8"))
            r = g.get("results") or []
            if not r:
                return {"ok": False}
            lat, lon = r[0]["latitude"], r[0]["longitude"]
            w = urllib.request.urlopen(
                "https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s&current=temperature_2m,weather_code&timezone=auto"
                % (lat, lon), timeout=6)
            d = json.loads(w.read().decode("utf-8"))
            cur = d.get("current") or {}
            return {"ok": True, "city": (r[0].get("name") or city), "temp": cur.get("temperature_2m"),
                    "code": cur.get("weather_code")}
        except Exception:
            return {"ok": False}

    def save_budget(self) -> None:
        amount = float(self.budget_spin.value())
        self._background("budget", lambda: self.api.set_budget(amount))

    def set_autonomy(self, checked: bool) -> None:
        self._background("autonomy", lambda: self.api.set_autonomy_paused(bool(checked)))

    def showEvent(self, event) -> None:
        super().showEvent(event)
        self.refresh()

    def _finished(self, name: str, data: dict, error: str) -> None:
        self._busy.discard(name)
        if name == "companion":
            if not error and data:
                acts = data.get("activities") or []
                cur_id = data.get("current_activity_id")
                cur = next((a for a in acts if a.get("activity_id") == cur_id), None)
                if cur:
                    self.companion_value.setText(f"{cur.get('state') or '进行中'} · 轮到 {cur.get('turn')}")
                    self.companion_detail.setText(f"「{cur.get('title') or cur.get('type')}」v{cur.get('version')} — 点击「和 Momo 聊天」继续")
                else:
                    self.companion_value.setText("空闲")
                    self.companion_detail.setText("没有进行中的活动，可以和 Momo 一起开始一个～")
            else:
                self.companion_value.setText("离线")
            return
        if name == "weather":
            if not error and data and data.get("ok"):
                self.weather_label.setText(f"天气 {data.get('city')}：{data.get('temp')}°C")
            else:
                self.weather_label.setText("天气 —（无法获取）")
            return
        if name != "refresh":
            self.status.setText("设置已同步到 Momo 大脑")
            self.refresh()
            return
        if error:
            self.dot.setText("●")
            self.dot.setStyleSheet("color:#C8C0D0; font-size:14px;")
            self.brain_state.setText("大脑离线")
            self.brain_pid.setText(f"连接失败：{error[:60]}")
            self.status.setText(error)
            return
        # 大脑在线
        self.dot.setStyleSheet(f"color:{'#E86A8A' if self._dark else '#FF8FA3'}; font-size:14px;")
        self.brain_state.setText(f"v{data.get('version') or '3.2'} 运行中" if data.get("ok") else "离线")
        self.brain_pid.setText(
            f"PID {data.get('pid') or '—'} · 运行 {_fmt_uptime(data.get('uptime_s') or 0)} · 启动阶段 {data.get('boot') or '—'}"
        )
        # 健康快照
        health = data.get("health") or []
        problems = [s for s in health if s.get("status") not in ("fresh", "unknown")]
        if problems:
            lines = "⚠ " + " ｜ ".join(f"{s.get('name')}: {s.get('status')}（{s.get('evidence') or ''}）" for s in problems[:4])
            self.health_box.setVisible(True)
            self.health_lines.setText(lines)
            self.brain_health.setText(f"健康：{len(problems)} 项异常")
        else:
            self.health_box.setVisible(False)
            self.brain_health.setText("健康：无异常")
        # 生活费
        budget = data.get("budget") or {}
        daily = float(budget.get("daily_cny") or 0)
        spent = float(budget.get("spent_cny") or 0)
        remain = float(budget.get("remaining_cny") or 0)
        self.budget_label.setText(f"今日已用 {spent:.3f} 元 · 剩余 {remain:.3f} 元")
        self.budget_tier.setText(f"档位 {budget.get('level') or '-'}（{budget.get('tier') or '-'}）· 每日额度 {daily:.2f} 元")
        pct = int(min(1000, max(0, spent / daily * 1000))) if daily > 0 else 0
        self.budget_bar.setValue(pct)
        self.budget_bar.setFormat("")
        if not self.budget_spin.hasFocus():
            self.budget_spin.setValue(daily)
        # 自主活动
        paused = bool(data.get("autonomy_paused"))
        self.pause_btn.blockSignals(True)
        self.pause_btn.setChecked(paused)
        self.pause_btn.setText("恢复自主活动" if paused else "暂停自主活动")
        self.pause_btn.blockSignals(False)
        self.autonomy_value.setText("已暂停" if paused else "进行中")
        self.autonomy_value.setStyleSheet(
            "color:#C8C0D0; font-size:12px;" if paused
            else ("color:#4CAF7D; font-size:12px;" if not self._dark else "color:#6FD09B; font-size:12px;")
        )
        # 生活节律
        life = data.get("life") or {}
        ia = life.get("internal_actions") or {}
        by_kind = ia.get("by_kind") or {}
        used = ia.get("attempts") or 0
        kind_parts = "、".join(f"{KIND_NAMES.get(k, k)} {v}" for k, v in sorted(by_kind.items()) if v) or "无"
        self.life_value.setText(f"今日动作 {used} 次（{kind_parts}）· 阶段 {life.get('phase') or '—'}")
        tooltip_lines = ["自主活动包含："]
        tooltip_lines.append("  · 主动搭话（问候/分享趣图）")
        tooltip_lines.append("  · 心智动作（搜索、看空间、读文章、解谜…）")
        tooltip_lines.append("  · 记想法 / 夜间小活动")
        tooltip_lines.append(f"今日已执行 {used} 次：{kind_parts}")
        tooltip_lines.append("暂停后这些活动全部停止，聊天不受影响。")
        self.pause_btn.setToolTip("\n".join(tooltip_lines))
        # 身体状态（本地已知）
        body = self.get_body_state() or {}
        dnd = ""
        if body.get("dnd_manual"):
            dnd = "免打扰：手动开启"
        elif body.get("dnd_auto_active"):
            dnd = "免打扰：自动时段"
        else:
            dnd = "免打扰：未开"
        self.body_state.setText(f"{'显示中' if body.get('visible') else '已隐藏'} · {dnd}")
        self.status.setText("刷新成功 · 鼠标悬停在「自主活动」按钮可看活动明细")

    def closeEvent(self, event) -> None:
        if self._closing_to_tray:
            event.ignore()
            self.hide()
            return
        super().closeEvent(event)
