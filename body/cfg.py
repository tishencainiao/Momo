"""身体配置：内置默认值 + body/config.json 覆盖 + 运行时状态（位置/大小）落盘。

配置只在启动时读一次；状态写在 data/body-state.json（data/ 不进版本库）。
"""
from __future__ import annotations

import json
import os

BODY_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BODY_DIR)                       # Momo 仓库根
DATA_DIR = os.path.join(ROOT_DIR, "data")
CONFIG_PATH = os.path.join(BODY_DIR, "config.json")
STATE_PATH = os.path.join(DATA_DIR, "body-state.json")
LOG_PATH = os.path.join(DATA_DIR, "body.log")

DEFAULTS = {
    "assets_dir": os.path.join(BODY_DIR, "assets"),
    "scale": 0.45,                   # 画布原生 640x360，0.45 倍时角色约 100x120px（与旧桌宠相近）
    "always_on_top": True,
    "fps_cap": 30,                   # 再高没意义（素材 24fps）
    "start_corner": "bottom-right",  # 首次启动位置
    "margin_x": 40,
    "margin_y": 120,
    "click_response": True,          # 点一下有回应动画
    "click_through": False,          # 整窗鼠标穿透（右键菜单可切）
    "port": 4010,                    # v0.2 起用（本地接口）
    "log_level": "info",
}


def load() -> dict:
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
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
