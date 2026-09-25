"""Generate the extension icon and activity-bar glyph.

No image library is available in this environment, so the PNG is rasterised
directly: a rounded square in the DeepSeek blue with a white harness mark
(four plugin nodes wired to one centre). Rendered at 4x and box-filtered down
for smooth edges.
"""

import struct
import zlib
from pathlib import Path

SIZE = 128
SS = 4  # supersampling factor
BLUE = (77, 107, 254)
WHITE = (255, 255, 255)
RADIUS = 26.0
GLYPH_CENTER = SIZE / 2
NODE_RADIUS = 9.0
NODE_OFFSET = 34.0
LINK_HALF_WIDTH = 3.4
CENTER_RADIUS = 11.0


def rounded_square_coverage(x: float, y: float) -> float:
    """Anti-aliased coverage of the rounded-square background at a point."""
    half = SIZE / 2
    inset = half - RADIUS
    dx = abs(x - half) - inset
    dy = abs(y - half) - inset
    if dx <= 0 and dy <= 0:
        return 1.0
    if dx > RADIUS or dy > RADIUS:
        return 0.0
    # Distance outside the corner circle.
    d = (max(dx, 0.0) ** 2 + max(dy, 0.0) ** 2) ** 0.5 - RADIUS
    if d <= -0.5:
        return 1.0
    if d >= 0.5:
        return 0.0
    return 0.5 - d


def distance_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    length_sq = vx * vx + vy * vy
    t = 0.0 if length_sq == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / length_sq))
    cx, cy = ax + t * vx, ay + t * vy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def glyph_coverage(x: float, y: float) -> float:
    """Coverage of the white harness mark at a point."""
    nodes = [
        (GLYPH_CENTER, GLYPH_CENTER - NODE_OFFSET),
        (GLYPH_CENTER + NODE_OFFSET, GLYPH_CENTER),
        (GLYPH_CENTER, GLYPH_CENTER + NODE_OFFSET),
        (GLYPH_CENTER - NODE_OFFSET, GLYPH_CENTER),
    ]
    best = 0.0
    for nx, ny in nodes:
        d = ((x - nx) ** 2 + (y - ny) ** 2) ** 0.5 - NODE_RADIUS
        best = max(best, 0.5 - d)
    for nx, ny in nodes:
        d = distance_to_segment(x, y, GLYPH_CENTER, GLYPH_CENTER, nx, ny) - LINK_HALF_WIDTH
        best = max(best, 0.5 - d)
    d = ((x - GLYPH_CENTER) ** 2 + (y - GLYPH_CENTER) ** 2) ** 0.5 - CENTER_RADIUS
    best = max(best, 0.5 - d)
    return max(0.0, min(1.0, best))


def render() -> bytes:
    rows = []
    for y in range(SIZE):
        row = bytearray()
        row.append(0)  # PNG filter type: none
        for x in range(SIZE):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    px = x + (sx + 0.5) / SS
                    py = y + (sy + 0.5) / SS
                    bg = rounded_square_coverage(px, py)
                    if bg <= 0.0:
                        continue
                    glyph = glyph_coverage(px, py)
                    alpha = bg
                    cr = BLUE[0] * (1 - glyph) + WHITE[0] * glyph
                    cg = BLUE[1] * (1 - glyph) + WHITE[1] * glyph
                    cb = BLUE[2] * (1 - glyph) + WHITE[2] * glyph
                    r += cr * alpha
                    g += cg * alpha
                    b += cb * alpha
                    a += alpha
            samples = SS * SS
            if a <= 0.0:
                row.extend((0, 0, 0, 0))
            else:
                row.extend(
                    (
                        int(round(r / a)),
                        int(round(g / a)),
                        int(round(b / a)),
                        int(round(255 * a / samples)),
                    )
                )
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def main() -> None:
    raw = render()
    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    target = Path(__file__).resolve().parent.parent / "media" / "icon.png"
    target.write_bytes(png)
    print(f"wrote {target} ({len(png)} bytes)")


if __name__ == "__main__":
    main()
