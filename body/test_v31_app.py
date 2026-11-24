"""v3.1 本机应用接口纯测试；不连接真实 Momo、QQ 或模型。"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brain_api import BrainAPI


class FakeResponse:
    def __init__(self, data): self.data = data
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self): return json.dumps(self.data).encode("utf-8")


class AppApiTest(unittest.TestCase):
    def test_management_uses_independent_token(self):
        with tempfile.TemporaryDirectory() as d:
            tok = os.path.join(d, "app-token")
            with open(tok, "w", encoding="utf-8") as f: f.write("secret-token")
            api = BrainAPI("http://127.0.0.1:3999", tok)
            seen = {}
            def fake(req, timeout):
                seen["auth"] = req.headers.get("Authorization")
                seen["path"] = req.full_url
                return FakeResponse({"ok": True, "budget": {}})
            with mock.patch("urllib.request.urlopen", fake):
                api.status()
            self.assertEqual(seen["auth"], "Bearer secret-token")
            self.assertTrue(seen["path"].endswith("/v1/app/status"))

    def test_chat_has_event_id_but_no_management_token(self):
        api = BrainAPI("http://127.0.0.1:3999", "missing")
        seen = {}
        def fake(req, timeout):
            seen["payload"] = json.loads(req.data.decode("utf-8"))
            seen["auth"] = req.headers.get("Authorization")
            return FakeResponse({"choices": [{"message": {"content": "我在"}}]})
        with mock.patch("urllib.request.urlopen", fake):
            out = api.chat("你好", [], "evt-1")
        self.assertEqual(out, "我在")
        self.assertEqual(seen["payload"]["momo_event_id"], "evt-1")
        self.assertIsNone(seen["auth"])

    def test_first_launch_creates_shared_token(self):
        with tempfile.TemporaryDirectory() as d:
            tok = os.path.join(d, "nested", "app-token")
            api = BrainAPI("http://127.0.0.1:3999", tok)
            self.assertTrue(os.path.isfile(tok))
            with open(tok, "r", encoding="utf-8") as f:
                first = f.read()
            self.assertEqual(len(first), 48)
            BrainAPI("http://127.0.0.1:3999", tok)
            with open(tok, "r", encoding="utf-8") as f:
                self.assertEqual(f.read(), first)


if __name__ == "__main__": unittest.main(verbosity=2)
