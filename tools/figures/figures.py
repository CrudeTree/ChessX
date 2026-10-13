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


def write_index() -> None:
    """index.json: which figures the game can stand up, as a cut-out and as a model."""
    names = lambda ext: sorted(p.stem for p in PUBLIC.glob(f"*.{ext}"))
    (PUBLIC / "index.json").write_text(json.dumps({"standees": names("webp"), "models": names("glb")}) + "\n")
