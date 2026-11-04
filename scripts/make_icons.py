#!/usr/bin/env python3
"""Draw Reader's icon set with the stdlib. No Pillow."""

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src-tauri" / "icons"
SRC = ROOT / "scripts" / "icon-source.png"


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path: Path, size: int) -> None:
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            row.extend(pixel(x, y, size))
        rows.append(b"\x00" + bytes(row))
    raw = b"".join(rows)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def pixel(x: int, y: int, size: int) -> tuple[int, int, int, int]:
    nx = (x + 0.5) / size
    ny = (y + 0.5) / size
    # Rounded green tile.
    inset = 0.08
    radius = 0.18
    inside = rounded(nx, ny, inset, 1 - inset, inset, 1 - inset, radius)
    if not inside:
        return (0, 0, 0, 0)
    # Cream page with a dark spine.
    page = 0.28 < nx < 0.78 and 0.22 < ny < 0.78
    spine = 0.24 < nx < 0.32 and 0.20 < ny < 0.80
    rule = page and 0.36 < ny < 0.40 or page and 0.46 < ny < 0.49 or page and 0.54 < ny < 0.57
    if spine:
        return (8, 48, 38, 255)
    if rule:
        return (15, 110, 86, 255)
    if page:
        return (247, 244, 238, 255)
    return (15, 110, 86, 255)


def rounded(x: float, y: float, x0: float, x1: float, y0: float, y1: float, r: float) -> bool:
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def write_ico(path: Path, pngs: list[tuple[int, bytes]]) -> None:
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries = b""
    body = b""
    for size, data in pngs:
        entries += struct.pack("<BBBBHHII", size if size < 256 else 0, size if size < 256 else 0, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        body += data
    path.write_bytes(header + entries + body)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    write_png(SRC, 1024)
    for name, size in (("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512)):
        write_png(OUT / name, size)
    # Tauri accepts a PNG-backed icns stand-in only via `tauri icon`.
    # The ICO below is enough for the Windows exe icon resource when present;
    # macOS .icns is produced by `tauri icon` in CI when the CLI can run it.
    pngs = []
    for size in (16, 32, 48, 64, 128, 256):
        tmp = OUT / f".tmp-{size}.png"
        write_png(tmp, size)
        pngs.append((size, tmp.read_bytes()))
        tmp.unlink()
    write_ico(OUT / "icon.ico", pngs)
    # Placeholder icns: `tauri icon` replaces this. A valid icns header with
    # the 256px PNG in an `ic07` entry is accepted by the bundler.
    png256 = (OUT / "128x128@2x.png").read_bytes()
    icns = b"icns" + struct.pack(">I", 8 + 8 + len(png256)) + b"ic07" + struct.pack(">I", 8 + len(png256)) + png256
    (OUT / "icon.icns").write_bytes(icns)
    print(f"wrote icons to {OUT}")


if __name__ == "__main__":
    main()
