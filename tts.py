#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Momo 语音：本地 GPT-SoVITS 优先，edge-tts 兜底。
契约（voice.js 不变）：python tts.py <text> <out.mp3> <voice>
成功：exit 0 且 out 文件存在；失败：exit 1。
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
LOG = os.path.join(DATA, "tts.log")
LAST_USED = os.path.join(DATA, "tts-last-used.txt")
PID_FILE = os.path.join(DATA, "gsv.pid")
GUARD_PID = os.path.join(DATA, "gsv-guard.pid")

DEFAULTS = {
    "gsv_enabled": True,
    "gsv_root": os.path.join(ROOT, "..", "tools", "gpt-sovits"),
    "venv_python": os.path.join(ROOT, "..", "tools", "gpt-sovits", ".venv", "Scripts", "python.exe"),
    "gsv_api": "http://127.0.0.1:9880",
    "gsv_ready_timeout": 35,
    "gsv_synth_timeout": 20,
    "edge_fallback_voice": "zh-CN-XiaoxiaoNeural",
    "idle_minutes": 15,
}


def log(level, msg):
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write("%s [%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), level, msg))
    except Exception:
        pass


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def touch(path):
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(str(time.time()))
    except Exception:
        pass


def tcp_alive(host="127.0.0.1", port=9880, timeout=2.0):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


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


def ensure_guard():
    """确保空闲看门狗在跑（幂等）。"""
    try:
        if pid_alive(read_guard_pid()):
            return
        guard = os.path.join(ROOT, "gsv-guard.py")
        if not os.path.exists(guard):
            return
        py = sys.executable
        p = subprocess.Popen(
            [py, guard],
            cwd=ROOT, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=0x00000008 | 0x00000200,
        )
        with open(GUARD_PID, "w", encoding="utf-8") as f:
            f.write(str(p.pid))
    except Exception as e:
        log("warn", "启动看门狗失败: %s" % e)


def read_guard_pid():
    try:
        with open(GUARD_PID, "r", encoding="utf-8") as f:
            return int(f.read().strip() or 0)
    except Exception:
        return 0


def spawn_gsv(cfg):
    """拉起 api_v2（不阻塞），返回是否已发起。"""
    root = os.path.abspath(cfg["gsv_root"])
    py = os.path.abspath(cfg["venv_python"])
    api = os.path.join(root, "api_v2.py")
    if not (os.path.exists(py) and os.path.exists(api)):
        log("warn", "gsv 路径不存在：py=%s api=%s" % (py, api))
        return False
    if pid_alive(read_pid()):
        return True  # 已在加载中
    log_path = os.path.join(DATA, "gsv-api.log")
    env = dict(os.environ)
    env["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"
    try:
        with open(log_path, "ab") as lf:
            p = subprocess.Popen(
                [py, api, "-a", "127.0.0.1", "-p", "9880", "-c", "GPT_SoVITS/configs/tts_infer.yaml"],
                cwd=root, env=env, stdin=subprocess.DEVNULL,
                stdout=lf, stderr=lf,
                creationflags=0x00000008 | 0x00000200,  # DETACHED_PROCESS
            )
        try:
            with open(PID_FILE, "w", encoding="utf-8") as f:
                f.write(str(p.pid))
        except Exception:
            pass
        log("info", "已拉起 api_v2 pid=%s" % p.pid)
        return True
    except Exception as e:
        log("warn", "拉起 api_v2 失败: %s" % e)
        return False


def wait_ready(cfg, timeout):
    """端口通即视为就绪（api_v2 在模型加载完成后才启动服务）。"""
    url = cfg["gsv_api"]
    host, port = url.replace("http://", "").replace("https://", "").rsplit(":", 1)
    deadline = time.time() + max(1, int(timeout))
    while time.time() < deadline:
        if tcp_alive(host, int(port), 1.5):
            return True
        time.sleep(0.5)
    return False


def http_tts(cfg, payload, timeout):
    req = urllib.request.Request(
        cfg["gsv_api"] + "/tts",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status != 200:
            raise RuntimeError("http %d" % resp.status)
        return resp.read()


def ffmpeg_bin():
    for p in (
        os.path.join(ROOT, "..", "tools", "ffmpeg", "bin", "ffmpeg.exe"),
        os.path.join(ROOT, "..", "tools", "gpt-sovits", "ffmpeg.exe"),
    ):
        p = os.path.abspath(p)
        if os.path.exists(p):
            return p
    return "ffmpeg"


def wav_to_mp3(wav_path, mp3_path):
    r = subprocess.run(
        [ffmpeg_bin(), "-y", "-loglevel", "error", "-i", wav_path, "-codec:a", "libmp3lame", "-q:a", "4", mp3_path],
        capture_output=True, timeout=60,
        creationflags=0x08000000,
    )
    if r.returncode != 0 or not os.path.exists(mp3_path):
        raise RuntimeError("ffmpeg 转 mp3 失败: %s" % (r.stderr or b"")[:200])


def edge_tts(out, text, voice):
    py = os.path.abspath(os.path.join(ROOT, "..", "tools", "gpt-sovits", ".venv", "Scripts", "python.exe"))
    if not os.path.exists(py):
        py = sys.executable
    cmd = [py, "-m", "edge_tts", "--voice", voice, "--text", text, "--write-media", out]
    r = subprocess.run(cmd, capture_output=True, timeout=40, creationflags=0x08000000)
    if r.returncode != 0 or not os.path.exists(out):
        raise RuntimeError("edge-tts 失败: %s" % (r.stderr or b"")[:300])


def main():
    if len(sys.argv) < 3:
        log("error", "参数不足: %s" % sys.argv)
        return 1
    text, out = sys.argv[1], sys.argv[2]
    voice = sys.argv[3] if len(sys.argv) > 3 else "default"
    touch(LAST_USED)

    cfg = load_json(os.path.join(DATA, "tts-config.json"), {})
    merged = dict(DEFAULTS)
    merged.update(cfg)
    cfg = merged
    profiles = load_json(os.path.join(DATA, "tts-profiles.json"), {})
    profile = profiles.get(voice)

    # 1) 本地 GPT-SoVITS
    if profile and cfg.get("gsv_enabled"):
        try:
            host, port = cfg["gsv_api"].replace("http://", "").rsplit(":", 1)
            if not tcp_alive(host, int(port), 1.5):
                spawn_gsv(cfg)
            ensure_guard()
            if wait_ready(cfg, int(cfg.get("gsv_ready_timeout", 35))):
                payload = {
                    "text": text,
                    "text_lang": "zh",
                    "ref_audio_path": profile["ref_audio"].replace("\\", "/"),
                    "prompt_lang": "zh",
                    "prompt_text": profile.get("ref_text", ""),
                    "text_split_method": profile.get("text_split_method", "cut5"),
                    "batch_size": 1,
                    "media_type": "wav",
                    "streaming_mode": False,
                    "speed_factor": float(profile.get("speed_factor", 1.0)),
                    "temperature": float(profile.get("temperature", 0.8)),
                }
                wav = http_tts(cfg, payload, float(cfg.get("gsv_synth_timeout", 20)))
                tmp = out + ".tmp.wav"
                with open(tmp, "wb") as f:
                    f.write(wav)
                wav_to_mp3(tmp, out)
                try:
                    os.remove(tmp)
                except Exception:
                    pass
                log("info", "gsv ok voice=%s len=%d" % (voice, len(text)))
                return 0
            else:
                log("warn", "gsv 就绪等待超时(%ss)，走兜底" % cfg.get("gsv_ready_timeout"))
        except Exception as e:
            log("warn", "gsv 失败，走兜底: %s" % e)

    # 2) edge-tts 兜底
    try:
        edge_voice = (profile or {}).get("edge_voice") or cfg.get("edge_fallback_voice", "zh-CN-XiaoxiaoNeural")
        # 兼容：voice 本身就是 edge 音色名
        if voice and voice not in profiles and ("Neural" in voice or "-" in voice):
            edge_voice = voice
        edge_tts(out, text, edge_voice)
        log("info", "edge ok voice=%s len=%d" % (edge_voice, len(text)))
        return 0
    except Exception as e:
        log("error", "edge 失败: %s" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
