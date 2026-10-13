"""Cuts away the slab some models were generated standing on (see SLABS in figures.py).

Reads work/raw/<name>.glb and writes work/trimmed/<name>.glb, which optimize.mjs then takes instead. It reads the
models the generator makes: one mesh of one primitive, its indices and attributes in a single buffer.

    .venv/Scripts/python tools/figures/trim.py [name ...]
"""

import json
import struct
import sys

import numpy as np
from scipy.spatial import ConvexHull, Delaunay

from figures import SLABS, WORK

RAW = WORK / "raw"
OUT = WORK / "trimmed"
COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
TYPES = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
# The slab's underside: whatever lies this low, as a fraction of the model's height.
UNDERSIDE = 0.01
# Its sides lean a little past its underside's outline.
SIDES = 1.03


def read_glb(path):
    data = path.read_bytes()
    size = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20 + size])
    at = 20 + size
    return gltf, data[at + 8:at + 8 + struct.unpack_from("<I", data, at)[0]]


def write_glb(path, gltf, binary) -> None:
    text = json.dumps(gltf, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    binary += b"\0" * (-len(binary) % 4)
    chunks = struct.pack("<II", len(text), 0x4E4F534A) + text + struct.pack("<II", len(binary), 0x004E4942) + binary
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 12 + len(chunks)) + chunks)


def trim(name: str, top: float) -> None:
    gltf, binary = read_glb(RAW / f"{name}.glb")
    (mesh,) = gltf["meshes"]
    (prim,) = mesh["primitives"]
    accessors, views = gltf["accessors"], gltf["bufferViews"]

    def read(index):
        a = accessors[index]
        view = views[a["bufferView"]]
        n = COMPONENTS[a["type"]]
        start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        return np.frombuffer(binary, TYPES[a["componentType"]], a["count"] * n, start).reshape(-1, n)

    attributes = {key: read(index) for key, index in prim["attributes"].items()}
    triangles = read(prim["indices"]).reshape(-1, 3)
    position = attributes["POSITION"]
    low, high = position[:, 1].min(), position[:, 1].max()
    height = (position[:, 1] - low) / (high - low)

    underside = position[height < UNDERSIDE][:, [0, 2]]
    outline = underside[ConvexHull(underside).vertices]
    middle = outline.mean(0)
    slab = Delaunay(middle + (outline - middle) * SIDES)
    on_slab = slab.find_simplex(position[triangles].mean(1)[:, [0, 2]]) >= 0
    keep = ~((height[triangles] < top).all(1) & on_slab)

    used = np.unique(triangles[keep])
    renumber = np.zeros(len(position), np.uint32)
    renumber[used] = np.arange(len(used), dtype=np.uint32)
    arrays = {prim["indices"]: renumber[triangles[keep]].ravel()}
    for key, index in prim["attributes"].items():
        arrays[index] = np.ascontiguousarray(attributes[key][used])

    # Lay the buffer out again: each view in turn, the changed accessors' data in place of the old.
    out = bytearray()
    for v, view in enumerate(views):
        owner = next((i for i, a in enumerate(accessors) if a.get("bufferView") == v and i in arrays), None)
        chunk = arrays[owner].tobytes() if owner is not None else binary[view.get("byteOffset", 0):][:view["byteLength"]]
        out += b"\0" * (-len(out) % 4)
        view["byteOffset"] = len(out)
        view["byteLength"] = len(chunk)
        out += chunk
    for index, array in arrays.items():
        a = accessors[index]
        a["byteOffset"] = 0
        a["count"] = len(array) // COMPONENTS[a["type"]] if array.ndim == 1 else len(array)
        if "min" in a:
            a["min"] = array.reshape(a["count"], -1).min(0).tolist()
            a["max"] = array.reshape(a["count"], -1).max(0).tolist()
    gltf["buffers"] = [{"byteLength": len(out)}]

    OUT.mkdir(parents=True, exist_ok=True)
    write_glb(OUT / f"{name}.glb", gltf, bytes(out))
    print(f"{name}: {len(triangles) - keep.sum()} of {len(triangles)} triangles cut")


def main() -> None:
    names = sys.argv[1:] or list(SLABS)
    for name in names:
        if name not in SLABS:
            print(f"{name}: no slab to cut")
        elif not (RAW / f"{name}.glb").exists():
            print(f"{name}: no model yet")
        else:
            trim(name, SLABS[name])


if __name__ == "__main__":
    main()
