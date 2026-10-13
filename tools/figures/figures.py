"""Shared paths and the list of figures: every piece card's two faces, and the two Kings."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "packages" / "client" / "public" / "art"
# What the game loads: <name>.webp (the creature cut out of its card) and <name>.glb (its 3D model), and index.json.
PUBLIC = ROOT / "packages" / "client" / "public" / "figures"
WORK = Path(__file__).resolve().parent / "work"

PIECES = [
    "recruit", "warrior", "warlord", "squire",
    "apprentice", "mage", "archmage", "initiate",
    "colt", "paladin", "dawn_paladin", "eclipse_knight",
    "wyrmling", "mystic_dragon", "ancient_mystic_dragon", "duskfang",
    "king",
]

FIGURES = [f"{piece}_{face}" for piece in PIECES for face in ("white", "dark")]

# Card pictures the cutter cannot take the creature out of (a dark dragon in green fire), and the other face of the
# card, drawn in the same pose, whose outline cuts it out instead.
BORROWED_OUTLINE = {"ancient_mystic_dragon_dark": "ancient_mystic_dragon_white"}

# Creatures drawn in front of something that is not theirs (the Warlord's tower), and points on the cut-out, as
# fractions of its width and height, on the creature to keep and on what to drop, for Segment Anything.
ISOLATE = {
    "warlord_white": {
        "keep": [(0.57, 0.37), (0.58, 0.48), (0.58, 0.59), (0.57, 0.85), (0.43, 0.81), (0.71, 0.81),
                 (0.38, 0.95), (0.76, 0.95), (0.17, 0.69), (0.88, 0.67)],
        "drop": [(0.58, 0.17), (0.36, 0.16), (0.38, 0.35), (0.79, 0.35), (0.10, 0.83), (0.76, 0.05)],
    },
    "warlord_dark": {
        "keep": [(0.53, 0.34), (0.53, 0.44), (0.53, 0.49), (0.53, 0.81), (0.43, 0.85), (0.64, 0.85),
                 (0.40, 0.96), (0.65, 0.96), (0.17, 0.65), (0.82, 0.67)],
        "drop": [(0.53, 0.15), (0.37, 0.14), (0.36, 0.35), (0.72, 0.31), (0.09, 0.92), (0.68, 0.06)],
    },
}

# Models generated standing on a slab from their card (the dark Mystic Dragon's little chessboard), and the height
# of its top as a fraction of the model's: what lies below that, over the slab, is cut away.
SLABS = {"mystic_dragon_dark": 0.065}


def write_index() -> None:
    """index.json: which figures the game can stand up, as a cut-out and as a model."""
    names = lambda ext: sorted(p.stem for p in PUBLIC.glob(f"*.{ext}"))
    index = {"standees": names("webp"), "models": names("glb")}
    (PUBLIC / "index.json").write_text(json.dumps(index, separators=(",", ":")) + "\n")
