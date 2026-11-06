"""身体的本地接口：HTTP 指令 + SSE 事件（只监听 127.0.0.1，token 鉴权）。

设计要点（为什么这么定）：
- 只用标准库 `http.server`：不引 FastAPI/flask 之类全家桶；JSON 够用，SSE 也够低延迟。
- **所有 UI 操作都不在 HTTP 线程里做**：HTTP handler 只把指令塞进队列，GUI 线程用 QTimer
  取出来执行（Qt 控件必须在自己线程里碰）。这样也不会卡住事件流。
- token 写在 `body/body-token`（gitignore），每次启动若不存在就生成一个；请求必须带
  `Authorization: Bearer <token>` 或 `X-Momo-Token` 头，防止本机其它程序乱驱动身体。
- `/status` 返回的是 GUI 线程维护的快照（加锁读），不会因为界面忙而卡死。
"""
from __future__ import annotations

import hmac
import json
import os
import queue
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL = "1"


def load_or_create_token(path: str) -> str:
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                tok = fh.read().strip()
            if len(tok) >= 16:
                return tok
        tok = secrets.token_hex(16)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(tok)
        try:                                    # 尽量只让本用户可读（Windows 下多半被忽略）
            os.chmod(path, 0o600)
        except Exception:
            pass
        return tok
    except Exception:
        return secrets.token_hex(16)


class BodyAPI:
    """把 HTTP 请求变成 (命令队列) + (SSE 广播)。"""

    def __init__(self, token_path: str, log=print):
        self.token = load_or_create_token(token_path)
        self.log = log
        self.commands = queue.Queue(maxsize=64)
        self._subscribers = []
        self._lock = threading.Lock()
        self._snapshot = {"state": "idle", "anim": "", "visible": True, "scale": 1.0}
        self._server = None
        self._thread = None
        self.port = 0

    # ---------- 快照（GUI 线程写） ----------
    def update_snapshot(self, **kw) -> None:
        with self._lock:
            self._snapshot.update(kw)

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self._snapshot)

    # ---------- 事件广播（GUI 线程调） ----------
    def publish(self, name: str, **data) -> None:
        payload = {"event": name, "ts": round(time.time(), 3)}
        payload.update(data)
        with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass

    def subscribe(self):
        q = queue.Queue(maxsize=200)
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    # ---------- 启动 ----------
    def start(self, host: str = "127.0.0.1", port: int = 4010, tries: int = 10):
        api = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "MomoBody/" + PROTOCOL
            protocol_version = "HTTP/1.1"

            def log_message(self, fmt, *args):            # 静音默认访问日志
                pass

            # ---- 鉴权 ----
            def _authorized(self) -> bool:
                auth = self.headers.get("Authorization", "")
                tok = self.headers.get("X-Momo-Token", "")
                if auth.lower().startswith("bearer "):
                    tok = auth[7:].strip()
                return bool(tok) and hmac.compare_digest(tok, api.token)

            def _send(self, code: int, obj) -> None:
                body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except Exception:
                    pass

            def _deny(self) -> None:
                self._send(401, {"ok": False, "error": "unauthorized"})

            # ---- GET ----
            def do_GET(self):                              # noqa: N802
                path = self.path.split("?")[0].rstrip("/") or "/"
                if not self._authorized():
                    return self._deny()
                if path == "/status":
                    snap = api.snapshot()
                    snap.update({"ok": True, "protocol": PROTOCOL, "pid": os.getpid(),
                                 "port": api.port})
                    return self._send(200, snap)
                if path == "/events":
                    return self._sse()
                return self._send(404, {"ok": False, "error": "not found"})

            def _sse(self) -> None:
                q = api.subscribe()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()
                    self.wfile.write(b": connected\n\n")
                    self.wfile.flush()
                    last = time.time()
                    while True:
                        try:
                            item = q.get(timeout=1.0)
                            data = "event: %s\ndata: %s\n\n" % (
                                item.get("event", "message"),
                                json.dumps(item, ensure_ascii=False))
                            self.wfile.write(data.encode("utf-8"))
                            self.wfile.flush()
                            last = time.time()
                        except queue.Empty:
                            if time.time() - last > 15:      # 心跳，防中间层断流
                                self.wfile.write(b": ping\n\n")
                                self.wfile.flush()
                                last = time.time()
                except Exception:
                    pass
                finally:
                    api.unsubscribe(q)

            # ---- POST ----
            def do_POST(self):                             # noqa: N802
                path = self.path.split("?")[0].rstrip("/") or "/"
                if not self._authorized():
                    return self._deny()
                if not path.startswith("/cmd/"):
                    return self._send(404, {"ok": False, "error": "not found"})
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    raw = self.rfile.read(length) if length else b"{}"
                    payload = json.loads(raw.decode("utf-8") or "{}")
                    if not isinstance(payload, dict):
                        payload = {}
                except Exception:
                    return self._send(400, {"ok": False, "error": "bad json"})
                cmd = path[len("/cmd/"):]
                # 支持同步等待：请求头 X-Momo-Wait: 1（或 body 里 _wait:true），
                # 服务端最多等 4 秒把 GUI 线程的执行结果拿回来（截图这类需要即取即用）
                wait = str(self.headers.get("X-Momo-Wait", "")).strip() in ("1", "true", "yes")
                if "_wait" in payload:
                    wait = bool(payload.pop("_wait"))
                item = {"cmd": cmd, "payload": payload, "ts": time.time()}
                if wait:
                    item["event"] = threading.Event()
                    item["result"] = None
                try:
                    api.commands.put_nowait(item)
                except queue.Full:
                    return self._send(503, {"ok": False, "error": "busy"})
                if wait and item.get("event") is not None:
                    if item["event"].wait(4.0) and item.get("result") is not None:
                        return self._send(200, item["result"])
                    return self._send(202, {"ok": False, "timeout": True,
                                            "error": "身体没在 4 秒内完成该指令"})
                return self._send(200, {"ok": True, "queued": True, "cmd": cmd})

        last_err = None
        for i in range(max(1, tries)):
            try:
                srv = ThreadingHTTPServer((host, port + i), Handler)
                srv.daemon_threads = True
                self._server = srv
                self.port = port + i
                self._thread = threading.Thread(target=srv.serve_forever, daemon=True)
                self._thread.start()
                self.update_snapshot(port=self.port)
                return True, self.port
            except OSError as exc:
                last_err = exc
                continue
        return False, str(last_err or "端口占用")
