"""免打扰（Do Not Disturb）：手动开关 + 自动时段。

判定写成纯函数，方便自检直接断言：
- 手动开关打开 → 免打扰
- 自动时段（默认 23:00~08:00，可关或改）→ 免打扰（支持跨午夜）
"""
from __future__ import annotations


def parse_hhmm(text: str, default: int = 0) -> int:
    """'23:30' → 分钟数；解析失败返回 default。"""
    try:
        hh, mm = str(text).strip().split(":")
        return max(0, min(23, int(hh))) * 60 + max(0, min(59, int(mm)))
    except Exception:
        return default


def in_window(minutes_now: int, start_min: int, end_min: int) -> bool:
    """当前分钟是否落在 [start, end) 内；跨午夜也能判。"""
    if start_min == end_min:
        return False
    if start_min < end_min:
        return start_min <= minutes_now < end_min
    return minutes_now >= start_min or minutes_now < end_min


def dnd_active(manual: bool, config: dict, minutes_now: int) -> bool:
    if manual:
        return True
    cfg = config or {}
    if cfg.get("dnd_auto", True) is False:
        return False
    start = parse_hhmm(cfg.get("dnd_from") or "23:00", 23 * 60)
    end = parse_hhmm(cfg.get("dnd_to") or "08:00", 8 * 60)
    return in_window(minutes_now, start, end)
