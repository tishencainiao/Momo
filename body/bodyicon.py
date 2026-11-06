"""托盘图标：从 idle 帧生成多尺寸 .ico（纯 Qt，不依赖 Pillow）。

生成的 icon.ico 落在 body/assets/ 下（assets 不进版本库），启动时若缺失会自动生成。
"""
from __future__ import annotations

import os
import struct

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, Qt
from PySide6.QtGui import QImage, QImageWriter

SIZES = (16, 24, 32, 48, 64, 128, 256)


def _first_idle_frame(assets_dir: str) -> str:
    """找 idle 分类下第一段的第一帧。找不到就退回任意一段。"""
    root = os.path.join(assets_dir, "frameseq")
    for cat in ("idle", "turn", "random", "move", "click"):
        cat_dir = os.path.join(root, cat)
        if not os.path.isdir(cat_dir):
            continue
        for name in sorted(os.listdir(cat_dir)):
            clip = os.path.join(cat_dir, name)
            if os.path.isdir(clip) and os.path.exists(os.path.join(clip, "f_0001.webp")):
                return os.path.join(clip, "f_0001.webp")
    return ""


def _png_bytes(img: QImage) -> bytes:
    ba = QByteArray()
    buf = QBuffer(ba)
    buf.open(QIODevice.WriteOnly)
    img.save(buf, "PNG")
    buf.close()
    return bytes(ba.data())


def icon_pngs(assets_dir: str, sizes=SIZES):
    """返回 [(size, png_bytes), ...]；源图取不到则返回空列表。"""
    src = _first_idle_frame(assets_dir)
    if not src:
        return []
    base = QImage(src)
    if base.isNull():
        return []
    # 用「看得见的部分」居中裁一个方图，避免四周大片透明
    img = base.convertToFormat(QImage.Format_ARGB32)
    box = _alpha_bbox(img)
    if box is not None:
        x, y, w, h = box
        side = max(w, h)
        cx, cy = x + w // 2, y + h // 2
        left = max(0, min(img.width() - side, cx - side // 2))
        top = max(0, min(img.height() - side, cy - side // 2))
        side = min(side, img.width() - left, img.height() - top)
        img = img.copy(left, top, side, side)

    out = []
    for size in sizes:
        scaled = img.scaled(size, size, Qt.KeepAspectRatio, Qt.SmoothTransformation)
        canvas = QImage(size, size, QImage.Format_ARGB32)
        canvas.fill(0)
        from PySide6.QtGui import QPainter
        p = QPainter(canvas)
        p.drawImage((size - scaled.width()) // 2, (size - scaled.height()) // 2, scaled)
        p.end()
        out.append((size, _png_bytes(canvas)))
    return out


def _alpha_bbox(img: QImage):
    w, h = img.width(), img.height()
    minx, miny, maxx, maxy = w, h, -1, -1
    buf = memoryview(img.constBits())
    stride = img.bytesPerLine()
    for y in range(0, h, 2):
        row = y * stride
        for x in range(0, w, 2):
            if buf[row + x * 4 + 3] > 8:
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    if maxx < 0:
        return None
    return minx, miny, maxx - minx + 1, maxy - miny + 1


def build_ico(pngs) -> bytes:
    """把若干 PNG 打包成 ICO（Vista+ 支持 PNG 压缩项）。"""
    count = len(pngs)
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    data = b""
    offset = 6 + 16 * count
    for size, png in pngs:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset)
        data += png
        offset += len(png)
    return header + entries + data


def ensure_icon(assets_dir: str, out_path: str = "", force: bool = False) -> str:
    """确保 icon.ico 存在，返回路径（失败返回空串）。"""
    out_path = out_path or os.path.join(assets_dir, "icon.ico")
    if os.path.exists(out_path) and not force:
        return out_path
    pngs = icon_pngs(assets_dir)
    if not pngs:
        return ""
    ico = build_ico(pngs)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "wb") as fh:
        fh.write(ico)
    return out_path
