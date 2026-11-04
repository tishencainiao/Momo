#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gsv-guard：Momo 本地语音服务的空闲看门狗。
每 30s 检查 data/tts-last-used.txt；空闲超过 idle_minutes 就停掉 api_v2 并退出。
由 tts.py 拉起（幂等）。
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
PID_FILE = os.path.join(DATA, "gsv.pid")
LAST_USED = os.path.join(DATA, "tts-last-used.txt")
LOG = os.path.join(DATA, "tts.log")


def log(level, msg):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write("%s [%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), level, msg))
    except Exception:
        pass


def load_cfg():
    p = os.path.join(DATA, "tts-config.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def read_pid():
    try:
        with open(PID_FILE, "r", encoding="utf-8") as f:
            return int(f.read().strip() or 0)
    except Exception:
        return 0


def pid_alive(pid):
    if not pid:
        return False
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "PID eq %d" % pid, "/NH"],
            capture_output=True, text=True, timeout=10,
            creationflags=0x08000000,
        ).stdout
        return str(pid) in out
    except Exception:
        return False


def last_used_ts():
    try:
        with open(LAST_USED, "r", encoding="utf-8") as f:
            return float(f.read().strip())
    except Exception:
        return 0


def main():
    cfg = load_cfg()
    idle_minutes = float(cfg.get("idle_minutes", 15))
    idle_sec = idle_minutes * 60
    while True:
        pid = read_pid()
        if not pid_alive(pid):
            log("info", "guard: api_v2 不在，退出")
            return 0
        idle = time.time() - last_used_ts()
        if idle > idle_sec:
            log("info", "guard: 空闲 %.0f 分钟，停掉 api_v2 pid=%d" % (idle / 60, pid))
            try:
                subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"],
                               capture_output=True, timeout=30, creationflags=0x08000000)
            except Exception as e:
                log("warn", "guard: taskkill 失败 %s" % e)
            try:
                os.remove(PID_FILE)
            except Exception:
                pass
            return 0
        time.sleep(30)


if __name__ == "__main__":
    sys.exit(main())
