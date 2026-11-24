"""Momo 本机联脑客户端：聊天与桌面管理接口分离，管理请求必须带独立 token。"""
from __future__ import annotations

import json
import os
import secrets
import uuid
import urllib.error
import urllib.request

import cfg


class BrainError(RuntimeError):
    pass


class BrainAPI:
    def __init__(self, base_url: str = "", token_path: str = ""):
        self.base_url = (base_url or cfg.DEFAULTS.get("brain_url") or "http://127.0.0.1:3999").rstrip("/")
        self.token_path = token_path or os.path.join(cfg.DATA_DIR, "app-token")
        self._ensure_token()

    def _ensure_token(self) -> None:
        """身体与大脑首次启动前共用令牌；否则第一次管理请求必然 401。"""
        if not os.path.isabs(self.token_path):
            return
        if os.path.exists(self.token_path):
            return
        try:
            parent = os.path.dirname(self.token_path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            token = secrets.token_hex(24)
            with open(self.token_path, "x", encoding="utf-8") as fh:
                fh.write(token)
            try:
                os.chmod(self.token_path, 0o600)
            except OSError:
                pass
        except FileExistsError:
            pass
        except OSError:
            pass

    def _token(self) -> str:
        try:
            with open(self.token_path, "r", encoding="utf-8") as fh:
                return fh.read().strip()
        except OSError:
            return ""

    def request(self, method: str, path: str, payload=None, timeout: float = 8.0, manage: bool = True) -> dict:
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json; charset=utf-8"
        if manage:
            headers["Authorization"] = "Bearer " + self._token()
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                out = json.loads(res.read().decode("utf-8"))
                if not isinstance(out, dict):
                    raise BrainError("本机大脑返回了无法识别的内容")
                return out
        except urllib.error.HTTPError as exc:
            try:
                detail = json.loads(exc.read().decode("utf-8"))
                msg = detail.get("error") or detail.get("msg") or str(detail)
                if isinstance(msg, dict):
                    msg = msg.get("message") or str(msg)
            except Exception:
                msg = str(exc)
            raise BrainError("本机大脑拒绝请求：%s" % msg) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise BrainError("连不上 Momo 大脑，请先在主界面启动她") from exc
        except json.JSONDecodeError as exc:
            raise BrainError("本机大脑响应格式异常") from exc

    def status(self) -> dict:
        return self.request("GET", "/v1/app/status")

    def companion(self) -> dict:
        return self.request("GET", "/v1/app/companion")

    def set_budget(self, amount: float) -> dict:
        return self.request("POST", "/v1/app/budget", {"daily_cny": float(amount)})

    def set_autonomy_paused(self, paused: bool) -> dict:
        return self.request("POST", "/v1/app/autonomy", {"paused": bool(paused)})

    def chat(self, text: str, history=None, event_id: str = "") -> str:
        messages = []
        for item in (history or [])[-20:]:
            role = item.get("role")
            if role in ("user", "assistant"):
                messages.append({"role": role, "content": str(item.get("content") or "")[:2000]})
        messages.append({"role": "user", "content": str(text)[:2000]})
        eid = event_id or uuid.uuid4().hex
        out = self.request("POST", "/v1/chat/completions", {
            "model": "momo", "messages": messages, "stream": False, "momo_event_id": eid,
        }, timeout=45.0, manage=False)
        try:
            return str(out["choices"][0]["message"]["content"] or "").strip()
        except (KeyError, IndexError, TypeError) as exc:
            raise BrainError("Momo 还在准备回复，请稍后用同一事件重试") from exc
