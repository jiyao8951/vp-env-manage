"""生成 FlowDeck 源图标 (1024x1024 PNG)，供 `tauri icon` 派生各尺寸。
仅使用标准库：zlib + struct 手写 PNG 编码。
"""
import math
import os
import struct
import zlib

SIZE = 1024


def rounded_rect_alpha(x, y, w, h, r, px, py):
    """返回点 (px, py) 在圆角矩形内的覆盖度（0..1，边缘做 1px 抗锯齿近似）。"""
    if px < x - 1 or px > x + w + 1 or py < y - 1 or py > y + h + 1:
        return 0.0
    # 内部矩形
    if x + r <= px <= x + w - r and y <= py <= y + h:
        return 1.0
    if y + r <= py <= y + h - r and x <= px <= x + w:
        return 1.0
    # 四个圆角
    cx, cy = None, None
    if px < x + r and py < y + r:
        cx, cy = x + r, y + r
    elif px > x + w - r and py < y + r:
        cx, cy = x + w - r, y + r
    elif px < x + r and py > y + h - r:
        cx, cy = x + r, y + h - r
    elif px > x + w - r and py > y + h - r:
        cx, cy = x + w - r, y + h - r
    if cx is None:
        return 0.0
    d = math.hypot(px - cx, py - cy)
    return max(0.0, min(1.0, r - d + 0.5))


def lerp(a, b, t):
    return a + (b - a) * t


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.png")
    rows = []
    r_bg = SIZE * 0.215
    # 三张"卡片"：Deck
    cards = [
        (0.205, 0.275, 0.590, 0.165),
        (0.205, 0.475, 0.480, 0.165),
        (0.205, 0.675, 0.370, 0.165),
    ]
    top = (0.114, 0.325, 0.886)   # indigo-600 #1D4ED8
    bottom = (0.043, 0.788, 0.941)  # sky-400 #06B6D4

    for py in range(SIZE):
        row = bytearray()
        t = py / (SIZE - 1)
        br = lerp(top[0], bottom[0], t)
        bg_ = lerp(top[1], bottom[1], t)
        bb = lerp(top[2], bottom[2], t)

        # 卡片覆盖度缓存（同一行的 x 方向独立，逐点算）
        for px in range(SIZE):
            a_bg = rounded_rect_alpha(0, 0, SIZE, SIZE, r_bg, px, py)
            cr = int(round(br * 255))
            cg = int(round(bg_ * 255))
            cb = int(round(bb * 255))
            ca = int(round(a_bg * 255))

            # 叠加白色卡片
            for (cx, cy, cw, ch) in cards:
                X, Y = cx * SIZE, cy * SIZE
                W, H = cw * SIZE, ch * SIZE
                a_card = rounded_rect_alpha(X, Y, W, H, H * 0.42, px, py)
                if a_card <= 0:
                    continue
                a = a_card * 0.96 * a_bg
                cr = int(round(lerp(cr, 255, a)))
                cg = int(round(lerp(cg, 255, a)))
                cb = int(round(lerp(cb, 255, a)))

            row += bytes((cr, cg, cb, ca))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    with open(out, "wb") as f:
        f.write(png)
    print("wrote", out, len(png), "bytes")


if __name__ == "__main__":
    main()
