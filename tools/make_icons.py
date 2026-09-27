"""Draw the lyrsync app icon (gradient + waveform bars) as PNGs, no dependencies."""
import math
import struct
import sys
import zlib
from pathlib import Path

C1, C2 = (123, 47, 247), (255, 92, 138)  # violet -> pink, diagonal
BARS = [0.26, 0.46, 0.66, 0.46, 0.26]  # bar heights as a fraction of the icon


def rounded_rect_sd(px, py, cx, cy, hw, hh, r):
    qx, qy = abs(px - cx) - hw + r, abs(py - cy) - hh + r
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def draw(size):
    bar_w = size * 0.075
    gap = size * 0.05
    total = len(BARS) * bar_w + (len(BARS) - 1) * gap
    x0 = (size - total) / 2
    bars = [(x0 + i * (bar_w + gap) + bar_w / 2, size / 2, bar_w / 2, h * size / 2) for i, h in enumerate(BARS)]
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            # soft glow toward the top-left
            glow = max(0.0, 1 - math.hypot(x - size * 0.3, y - size * 0.25) / (size * 0.9)) * 0.18
            r, g, b = (min(255, c1 + (c2 - c1) * t + 255 * glow) for c1, c2 in zip(C1, C2))
            a = 0.0
            for cx, cy, hw, hh in bars:
                sd = rounded_rect_sd(x + 0.5, y + 0.5, cx, cy, hw, hh, hw)
                a = max(a, min(1.0, max(0.0, 0.5 - sd)))
            row += bytes(int(round(v * (1 - a) + 255 * a)) for v in (r, g, b))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", raw) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "web/icons")
    out.mkdir(parents=True, exist_ok=True)
    for s in (180, 192, 512):
        (out / f"icon-{s}.png").write_bytes(draw(s))
        print("wrote", out / f"icon-{s}.png")
