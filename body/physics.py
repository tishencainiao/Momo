"""物理：走路速度标定、甩抛抛物线、边缘反弹、落地摩擦。

设计口径：物理计算全部写成**纯函数**（不碰 Qt），这样能被自检直接断言，
GUI 只负责把算出来的位置 move() 过去。
"""
from __future__ import annotations

DEFAULT_GRAVITY = 2600.0        # px/s²
DEFAULT_RESTITUTION = 0.55      # 撞墙/落地保留多少速度
DEFAULT_FRICTION = 0.78         # 落地后水平速度衰减
THROW_MIN_SPEED = 520.0         # 松手速度超过这个才算「甩出去」
STOP_SPEED = 40.0               # 慢到这个程度就停


def walk_speed_px_s(stride_px: float, frames: int, fps: float) -> float:
    """走路速度：一圈动画走过的像素 / 一圈动画的秒数。"""
    if not frames or not fps:
        return 0.0
    return float(stride_px) * float(fps) / float(frames)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def screen_bounds(area, window_w: int, window_h: int):
    """把屏幕可用区域收成「窗口左上角能待的范围」。"""
    left = float(area.left())
    top = float(area.top())
    right = float(area.right() - window_w)
    bottom = float(area.bottom() - window_h)
    if right < left:
        right = left
    if bottom < top:
        bottom = top
    return left, top, right, bottom


def clamp_position(x: float, y: float, bounds) -> tuple:
    left, top, right, bottom = bounds
    return clamp(x, left, right), clamp(y, top, bottom)


def step_free(x: float, y: float, vx: float, vy: float, dt: float,
              bounds, gravity: float = DEFAULT_GRAVITY):
    """自由飞（甩抛）：受重力、撞四边反弹、落到地面后水平摩擦。返回 (x, y, vx, vy, on_ground, bounced)。"""
    left, top, right, bottom = bounds
    nx = x + vx * dt
    ny = y + vy * dt
    vy += gravity * dt
    bounced = False

    if nx <= left:
        nx = left
        vx = abs(vx) * DEFAULT_RESTITUTION
        bounced = True
    elif nx >= right:
        nx = right
        vx = -abs(vx) * DEFAULT_RESTITUTION
        bounced = True

    on_ground = False
    if ny <= top:
        ny = top
        vy = abs(vy) * DEFAULT_RESTITUTION
        bounced = True
    elif ny >= bottom:
        ny = bottom
        vy = 0.0
        on_ground = True
        if abs(vy) > 1:
            bounced = True

    if on_ground:
        vx *= DEFAULT_FRICTION
        if abs(vx) < STOP_SPEED:
            vx = 0.0

    return nx, ny, vx, vy, on_ground, bounced


def should_throw(vx: float, vy: float, threshold: float = THROW_MIN_SPEED) -> bool:
    """松手时速度够不够大（够大才当作甩出去，否则只是放下）。"""
    return (vx * vx + vy * vy) ** 0.5 >= threshold


def velocity_from_points(points, max_dt: float = 0.12):
    """用最近几个鼠标轨迹点估速度（px/s）。points: [(t, x, y), ...] 旧→新。"""
    if not points or len(points) < 2:
        return 0.0, 0.0
    (t0, x0, y0) = points[0]
    (t1, x1, y1) = points[-1]
    dt = t1 - t0
    if dt <= 0.0001:
        return 0.0, 0.0
    dt = min(dt, max_dt)
    return (x1 - x0) / dt, (y1 - y0) / dt


def facing_for_dx(dx: float, current: int = 1) -> int:
    """根据水平位移决定朝向（1=右，-1=左）。"""
    if dx > 1:
        return 1
    if dx < -1:
        return -1
    return current
