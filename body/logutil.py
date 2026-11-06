"""日志：写 data/body.log，超过上限自动轮转（body.log → body.log.1，只留一代）。"""
from __future__ import annotations

import os
import time

MAX_BYTES = 2 * 1024 * 1024      # 2MB


def rotate_if_needed(path: str, max_bytes: int = MAX_BYTES) -> bool:
    """超限就把当前日志挪成 .1（旧的 .1 直接被覆盖）。返回是否轮转过。"""
    try:
        if not os.path.exists(path):
            return False
        if os.path.getsize(path) <= max_bytes:
            return False
        backup = path + ".1"
        try:
            if os.path.exists(backup):
                os.remove(backup)
        except OSError:
            pass
        os.replace(path, backup)
        return True
    except Exception:
        return False


def append(path: str, msg: str, max_bytes: int = MAX_BYTES) -> None:
    line = "[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        rotate_if_needed(path, max_bytes)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass
    try:
        print(line)
    except Exception:
        pass
