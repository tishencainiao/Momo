"""身体配置：内置默认值 + body/config.json 覆盖 + 运行时状态（位置/大小）落盘。

配置只在启动时读一次；状态写在 data/body-state.json（data/ 不进版本库）。
"""
from __future__ import annotations

import json
import os
import sys


def _base_dir() -> str:
    """身体主目录：源码跑 = body/；PyInstaller 打包后 = exe 所在目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


BODY_DIR = _base_dir()


def _root_dir() -> str:
    """寻找真正的大脑根目录，避免 dist/Momo/Momo.exe 把数据写到 dist/data。"""
    if os.environ.get("MOMO_ROOT"):
        return os.path.abspath(os.environ["MOMO_ROOT"])
    if not getattr(sys, "frozen", False):
        return os.path.dirname(BODY_DIR)
    cur = BODY_DIR
    for _ in range(6):
        if os.path.isfile(os.path.join(cur, "index.js")) and os.path.isdir(os.path.join(cur, "plugins")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return BODY_DIR                       # 便携包未带大脑时仍可读身体；主界面会提示大脑不可用


ROOT_DIR = _root_dir()
# 允许用环境变量指定数据目录（打包版放在别处跑时很有用）
DATA_DIR = os.environ.get("MOMO_BODY_DATA") or os.path.join(ROOT_DIR, "data")
CONFIG_PATH = os.environ.get("MOMO_BODY_CONFIG") or os.path.join(BODY_DIR, "config.json")
STATE_PATH = os.path.join(DATA_DIR, "body-state.json")
LOG_PATH = os.path.join(DATA_DIR, "body.log")

DEFAULTS = {
    "assets_dir": os.path.join(BODY_DIR, "assets"),
    "scale": 0.40,                   # 画布 640x360；0.40 时角色约 108px 高（右键可切三档/微调）
    "tiers": [0.30, 0.40, 0.50],     # 右键菜单的三档（小/中/大）
    "volume": 70,                    # 点击音效音量 0~100
    "voice_volume": 85,              # 桌面语音（克隆音色）音量 0~100
    "mute": False,
    "sound_enabled": True,
    "always_on_top": True,
    "fps_cap": 30,                   # 再高没意义（素材 24fps）
    "start_corner": "bottom-right",  # 首次启动位置
    "margin_x": 40,
    "margin_y": 120,
    "click_response": True,          # 点一下有回应动画
    "squash_enabled": True,          # 点击 Q 弹挤压（像被戳了一下的软体）
    "squash_duration_ms": 320,       # 一次挤压+回弹的总时长
    "click_through": False,          # 整窗鼠标穿透（右键菜单可切）
    "port": 4010,                    # 本地接口端口（v0.2 起）
    "api_enabled": True,             # 关掉就只显示、不接受任何指令
    "away_after_s": 180,             # 键鼠空闲超过多少秒算「主人不在电脑前」
    "sense_interval_ms": 5000,       # 感官采样间隔
    "window_title_enabled": True,     # 默认仅当前前台窗口标题，不保存长期历史
    "screenshot_enabled": False,      # 截图默认完全关闭；免打扰时也强制关闭
    "brain_url": "http://127.0.0.1:3999",
    "manage_brain_on_launch": True,   # 双击应用时由现有守护启动隐藏大脑
    "dnd_manual": False,             # 手动免打扰（快捷键/托盘/设置页可切）
    "dnd_auto": True,                # 自动免打扰时段
    "weather_city": "北京",           # 主界面天气卡片城市
    "dnd_from": "23:00",
    "dnd_to": "08:00",
    "log_level": "info",
}


def load() -> dict:
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as fh:   # 容忍 BOM（PowerShell 写的配置带 BOM）
                user = json.load(fh) or {}
            if isinstance(user, dict):
                cfg.update(user)
        except Exception as exc:                                  # 配置坏了不能拖垮身体
            print("[cfg] %s 读取失败：%s（用默认值）" % (CONFIG_PATH, exc))
    return cfg


def load_state() -> dict:
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh) or {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_state(state: dict) -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, STATE_PATH)
    except Exception as exc:
        print("[cfg] 保存状态失败：%s" % exc)


def save_config(cfg: dict) -> None:
    """把用户改动（音量/静音/缩放等）写回 body/config.json。

    注意：跳过以下划线开头的内部键（如 `_log` 是运行时注入的日志函数，
    直接 json.dump 会因为不可序列化把配置文件写坏）。
    """
    try:
        data = {k: v for k, v in cfg.items() if k != "assets_dir" and not str(k).startswith("_")}
        with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
    except Exception as exc:
        print("[cfg] 保存配置失败：%s" % exc)
