"""Copies the cut-outs into the game as small WebP pictures, which stand on the board until a figure has its model.

    .venv/Scripts/python tools/figures/standees.py
"""

from PIL import Image

from figures import FIGURES, PUBLIC, WORK, write_index

HEIGHT = 320


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    for name in FIGURES:
        src = WORK / "cutouts" / f"{name}.png"
        if not src.exists():
            print(f"{name}: no cut-out yet")
            continue
        cut = Image.open(src).convert("RGBA")
        scale = min(1, HEIGHT / cut.height)
        cut = cut.resize((round(cut.width * scale), round(cut.height * scale)), Image.Resampling.LANCZOS)
        dst = PUBLIC / f"{name}.webp"
        cut.save(dst, "WEBP", quality=88, method=6)
        print(f"{name}: {cut.size} {dst.stat().st_size // 1024} KB")
    write_index()


if __name__ == "__main__":
    main()
