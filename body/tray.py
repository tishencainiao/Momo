"""系统托盘：一个图标管「大脑 + 身体」。

借鉴旧桌宠的托盘交互（图标常驻、菜单里显示/隐藏、退出），但代码自写，
并且把「大脑」也纳进来：显示状态、重启、停止/启动守护。

安全口径（重要）：
- 找大脑进程必须按命令行匹配 `...\\Momo\\index.js` 全路径，**绝不按进程名 node.exe 乱杀**
  （这台机器上还跑着 DSH 等其他 node 进程）。
- 重启用「只杀不拉」：杀掉 node 后由 supervise.ps1 在 3 秒内自动拉起，避免双进程抢端口。
- 停止大脑要连守护一起停，否则杀了也会被立刻拉起；这个动作会二次确认。
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
from typing import Optional

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtGui import QAction, QIcon
from PySide6.QtWidgets import QApplication, QMenu, QMessageBox, QSystemTrayIcon

import cfg

_PS = ["powershell", "-NoProfile", "-NonInteractive", "-Command"]
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
BRAIN_MARK = "Momo\\index.js"


def _run_ps(script: str, timeout: float = 8.0) -> str:
    """跑一段 PowerShell，返回 stdout（失败返回空串）。

    坑：不要加 -WindowStyle Hidden —— 在捕获输出的场景下它会卡住不返回；
    CREATE_NO_WINDOW + stdin=DEVNULL 已经足够安静。
    """
    try:
        p = subprocess.run(_PS + [script], capture_output=True, text=True,
                           timeout=timeout, creationflags=_NO_WINDOW,
                           stdin=subprocess.DEVNULL)
        return (p.stdout or "").strip()
    except Exception:
        return ""


def _pids(name_like: str, where: str) -> list:
    # 注意：-Filter 里不支持名字通配，改成枚举后用 -like 过滤（本机进程数不多，够快）
    # $_.ProcessId -ne $PID：排除「正在跑这次查询的 powershell 自己」（它的命令行里就带着关键字）
    script = ("Get-CimInstance Win32_Process | Where-Object {{ $_.Name -like '{0}' "
              "-and $_.ProcessId -ne $PID -and ({1}) }} | "
              "Select-Object -ExpandProperty ProcessId".format(name_like, where))
    out = _run_ps(script)
    return [int(x) for x in out.split() if x.isdigit()]


def find_brain_pids() -> list:
    # PowerShell 的 -like 里反斜杠不是转义符，写单个 \ 就是字面量
    return _pids("node.exe", "$_.CommandLine -like '*Momo\\index.js*'")


def find_supervisor_pids() -> list:
    # 必须带 -File，否则「正在跑这条查询的 powershell 自己」也会命中
    return _pids("powershell.exe", "$_.CommandLine -like '*-File*supervise.ps1*'")


def find_body_pids() -> list:
    return _pids("python*.exe", "$_.CommandLine -like '*body\\main.py*'")


def kill_pids(pids) -> int:
    killed = 0
    for pid in pids:
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True,
                           timeout=10, creationflags=_NO_WINDOW)
            killed += 1
        except Exception:
            pass
    return killed


class BodyTray(QObject):
    """托盘 + 菜单。全部动作都通过信号交给主窗口/主程序执行。"""

    body_toggle = Signal()
    body_restart = Signal()
    body_quit = Signal()
    volume_changed = Signal(int)
    muted_changed = Signal(bool)

    def __init__(self, window, sound, icon_path: str, parent=None):
        super().__init__(parent)
        self.window = window
        self.sound = sound
        self._status = {"brain": "?", "supervisor": "?", "body": "?"}
        self._busy = False

        self.tray = QSystemTrayIcon(QIcon(icon_path or ""), self)
        self.tray.setToolTip("Momo")
        self.menu = QMenu()
        self.menu.aboutToShow.connect(self._refresh_labels)

        # ---- 状态（只读）----
        self.act_brain = QAction("大脑：检查中…", self.menu)
        self.act_brain.setEnabled(False)
        self.menu.addAction(self.act_brain)
        self.act_body = QAction("身体：显示中", self.menu)
        self.act_body.setEnabled(False)
        self.menu.addAction(self.act_body)
        self.menu.addSeparator()

        # ---- 身体 ----
        self.act_toggle = QAction("隐藏身体", self.menu)
        self.act_toggle.triggered.connect(lambda: self.body_toggle.emit())
        self.menu.addAction(self.act_toggle)

        act_restart_body = QAction("重启身体", self.menu)
        act_restart_body.triggered.connect(lambda: self.body_restart.emit())
        self.menu.addAction(act_restart_body)

        # ---- 大脑 ----
        act_restart_brain = QAction("重启大脑（杀进程，守护自动拉起）", self.menu)
        act_restart_brain.triggered.connect(self._restart_brain)
        self.menu.addAction(act_restart_brain)

        self.act_stop_brain = QAction("停止大脑（含守护）", self.menu)
        self.act_stop_brain.triggered.connect(self._stop_brain)
        self.menu.addAction(self.act_stop_brain)

        # ---- 音效 ----
        sound_menu = self.menu.addMenu("音效")
        self.act_mute = QAction("静音", sound_menu, checkable=True)
        self.act_mute.setChecked(bool(getattr(sound, "muted", False)))
        self.act_mute.toggled.connect(self._on_mute)
        sound_menu.addAction(self.act_mute)
        sound_menu.addSeparator()
        self.act_audio = QAction("试听 / 重开音频", sound_menu)
        self.act_audio.triggered.connect(self._reinit_audio)
        sound_menu.addAction(self.act_audio)
        for label, vol in (("小（40%）", 40), ("中（70%）", 70), ("大（100%）", 100)):
            act = QAction(label, sound_menu, checkable=True)
            act.setChecked(int(getattr(sound, "volume", 70)) == vol)
            act.triggered.connect(lambda _c=False, v=vol: self._set_volume(v))
            sound_menu.addAction(act)

        self.menu.addSeparator()
        act_settings = QAction("设置…", self.menu)
        act_settings.triggered.connect(self._open_settings)
        self.menu.addAction(act_settings)
        act_plugins = QAction("插件面板", self.menu)
        act_plugins.triggered.connect(self._open_plugins)
        self.menu.addAction(act_plugins)
        self.act_dnd = QAction("免打扰", self.menu, checkable=True)
        self.act_dnd.setChecked(bool(getattr(window, "dnd_manual", False)))
        self.act_dnd.toggled.connect(self._toggle_dnd)
        self.menu.addAction(self.act_dnd)

        act_log = QAction("查看日志", self.menu)
        act_log.triggered.connect(self._open_log)
        self.menu.addAction(act_log)

        act_quit = QAction("退出身体（托盘也会消失）", self.menu)
        act_quit.triggered.connect(lambda: self.body_quit.emit())
        self.menu.addAction(act_quit)

        self.tray.setContextMenu(self.menu)
        self.tray.activated.connect(self._on_activated)
        self.tray.show()

        # 后台定时刷新状态，避免点开菜单时卡顿
        self._timer = QTimer(self)
        self._timer.setInterval(15000)
        self._timer.timeout.connect(self._refresh_async)
        self._timer.start()
        self._refresh_async()

    # ---------- 状态 ----------
    def _refresh_async(self) -> None:
        if self._busy:
            return
        self._busy = True

        def work():
            brain = find_brain_pids()
            sup = find_supervisor_pids()
            self._status = {
                "brain": ("运行中 PID %s" % ",".join(str(p) for p in brain)) if brain else "未运行",
                "supervisor": "守护在" if sup else "无守护",
                "body": "显示中" if self.window.isVisible() else "已隐藏",
            }
            self._busy = False

        threading.Thread(target=work, daemon=True).start()

    def _refresh_labels(self) -> None:
        self._status["body"] = "显示中" if self.window.isVisible() else "已隐藏"
        self.act_brain.setText("大脑：%s（%s）" % (self._status["brain"], self._status["supervisor"]))
        self.act_body.setText("身体：%s" % self._status["body"])
        self.act_toggle.setText("隐藏身体" if self.window.isVisible() else "显示身体")
        try:
            if hasattr(self.act_dnd, "setChecked") and hasattr(self.window, "in_dnd"):
                self.act_dnd.setChecked(bool(self.window.in_dnd()))
        except Exception:
            pass
        self.act_stop_brain.setText("停止大脑（含守护）" if self._status["brain"] != "未运行"
                                    else "大脑已停（用「重启大脑」启动）")

    # ---------- 页面动作 ----------
    def _on_activated(self, reason) -> None:
        if reason == QSystemTrayIcon.Trigger:      # 左键点图标：切显隐
            self.body_toggle.emit()

    def _on_mute(self, checked: bool) -> None:
        self.sound.set_muted(bool(checked))
        self.muted_changed.emit(bool(checked))

    def _reinit_audio(self) -> None:
        """重开音频输出并试听一声——换过耳机/虚拟声卡程序退出后没声音时用。"""
        try:
            ready = self.sound.reinit() if hasattr(self.sound, "reinit") else 0
            played = self.sound.play("click")
            name = getattr(self.sound, "device_name", "")
            self._notify("音频已重开（%s，就绪 %d 个，试听%s）"
                         % (name or "默认设备", ready, "已播" if played else "未播"))
        except Exception as exc:
            self._notify("重开音频失败：%s" % exc)

    def _set_volume(self, vol: int) -> None:
        self.sound.set_volume(vol)
        self.sound.set_muted(False)
        self.act_mute.setChecked(False)
        for act in self.menu.actions():
            if act.menu():
                for sub in act.menu().actions():
                    if sub.isCheckable() and sub is not self.act_mute:
                        sub.setChecked(sub.text().startswith(("小", "中", "大")) and str(vol) in sub.text())
        self.volume_changed.emit(vol)

    def _open_settings(self) -> None:
        try:
            self.window.open_settings()
        except Exception as exc:
            self._notify("打开设置失败：%s" % exc)

    def _open_plugins(self) -> None:
        try:
            self.window.open_plugin_panel()
        except Exception as exc:
            self._notify("打开插件面板失败：%s" % exc)

    def _toggle_dnd(self, checked: bool) -> None:
        try:
            active = self.window.set_dnd(bool(checked))
            self._notify("免打扰：%s" % ("开（静音、不自己玩、不播报）" if active else "关"))
        except Exception as exc:
            self._notify("切换免打扰失败：%s" % exc)

    def _open_log(self) -> None:
        path = cfg.LOG_PATH
        try:
            if os.path.exists(path):
                os.startfile(path)
        except Exception:
            pass

    # ---------- 大脑动作 ----------
    def _restart_brain(self) -> None:
        """确定性重启：先停守护 → 再杀 node → 再起一个守护。

        为什么不「只杀 node 靠守护自愈」：这台机器上可能同时存在多个
        supervise.ps1（手动开的 + 开机自启的），只杀 node 会让它们同时拉起，
        抢 3999 端口互相踢。所以先把守护收干净，再起唯一一个。
        """
        sups, pids = find_supervisor_pids(), find_brain_pids()
        kill_pids(sups)
        kill_pids(pids)
        self._start_supervisor()
        self._notify("已重启大脑（守护收干净后重起，约 5~10 秒）")
        QTimer.singleShot(9000, self._refresh_async)

    def _stop_brain(self) -> None:
        pids, sups = find_brain_pids(), find_supervisor_pids()
        if not pids and not sups:
            self._notify("大脑本来就没在跑")
            return
        box = QMessageBox()
        box.setWindowTitle("停止大脑")
        box.setText("停止大脑后 Momo 将不再回复 QQ 消息（守护也一起停）。\n确定要停吗？")
        box.setStandardButtons(QMessageBox.Yes | QMessageBox.No)
        box.setDefaultButton(QMessageBox.No)
        if box.exec() != QMessageBox.Yes:
            return
        kill_pids(sups)      # 先杀守护，否则杀了 node 也会被拉起来
        kill_pids(pids)
        self._notify("大脑已停止（守护已停；用「重启大脑」恢复）")
        QTimer.singleShot(2500, self._refresh_async)

    def _start_supervisor(self) -> None:
        script = os.path.join(cfg.ROOT_DIR, "supervise.ps1")
        if not os.path.exists(script):
            self._notify("找不到 supervise.ps1")
            return
        try:
            subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                              "-File", script],
                             cwd=cfg.ROOT_DIR, creationflags=_NO_WINDOW,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as exc:
            self._notify("启动守护失败：%s" % exc)

    def _notify(self, text: str) -> None:
        try:
            self.tray.showMessage("Momo", text, QSystemTrayIcon.Information, 4000)
        except Exception:
            pass
