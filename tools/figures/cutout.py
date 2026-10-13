"""Cuts each piece's creature out of its card picture, for the 3D model generator.

Reads packages/client/public/art/<id>_<face>.png and writes work/cutouts/<id>_<face>.png:
the creature alone on a transparent background, cropped to it. Existing cut-outs are kept;
pass names (e.g. king_white) to redo just those.

    python -m venv .venv && .venv/Scripts/pip install rembg onnxruntime scipy
    .venv/Scripts/python tools/figures/cutout.py [name ...]
"""

import sys

import numpy as np
from PIL import Image, ImageFilter
from rembg import new_session, remove
from scipy import ndimage

from figures import ART, BORROWED_OUTLINE, FIGURES, WORK

OUT = WORK / "cutouts"


def keep_creature(alpha: Image.Image) -> Image.Image:
    """Drops loose bits of background (a corner of the platform, a puff of smoke) but keeps a wing seen apart."""
    a = np.array(alpha)
    labels, count = ndimage.label(a > 0, structure=np.ones((3, 3)))
    if count <= 1:
        return alpha
    areas = np.bincount(labels.ravel())[1:]
    keep = 1 + np.flatnonzero(areas >= areas.max() * 0.15)
    a[~np.isin(labels, keep)] = 0
    return Image.fromarray(a)


def main() -> None:
    names = sys.argv[1:] or FIGURES
    OUT.mkdir(parents=True, exist_ok=True)
    session = None
    for name in names:
        dst = OUT / f"{name}.png"
        src = ART / f"{name}.png"
        outline = BORROWED_OUTLINE.get(name, name)
        if not src.exists() or not (ART / f"{outline}.png").exists():
            print(f"{name}: no picture yet")
            continue
        if dst.exists() and not sys.argv[1:]:
            continue
        session = session or new_session("birefnet-general-lite")
        cut = remove(Image.open(ART / f"{outline}.png").convert("RGB"), session=session)
        alpha = keep_creature(cut.getchannel("A").point(lambda v: 0 if v < 24 else v))
        if outline != name:
            # The other face is drawn in the same pose, not to the pixel: a pixel in from its edge, no background shows.
            alpha = alpha.filter(ImageFilter.MinFilter(3))
        picture = Image.open(src).convert("RGBA")
        picture.putalpha(alpha)
        picture = picture.crop(alpha.getbbox())
        picture.save(dst)
        print(f"{name}: {picture.size}")


if __name__ == "__main__":
    main()
