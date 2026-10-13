"""Turns each figure's cut-out into a 3D model with Meshy or Tripo.

The API key is read from ~/.chessx/meshy.key or ~/.chessx/tripo.key (or MESHY_API_KEY / TRIPO_API_KEY) and never
printed. Models land in work/raw/<name>.glb with a preview picture beside them. Tasks are remembered in
work/tasks.json, so running it again picks up where it left off instead of paying twice; --again redoes the named ones.

    .venv/Scripts/python tools/figures/generate.py [--provider meshy|tripo] [--again] [name ...]
"""

import argparse
import base64
import io
import json
import os
import sys
import time
from pathlib import Path

import requests
from PIL import Image

from figures import FIGURES, WORK

CUTOUTS = WORK / "cutouts"
RAW = WORK / "raw"
TASKS = WORK / "tasks.json"
KEYS = Path.home() / ".chessx"
POLL_S = 15

MESHY = "https://api.meshy.ai/openapi/v1/image-to-3d"
TRIPO = "https://api.tripo3d.ai/v2/openapi"


class ApiError(Exception):
    pass


def read_key(provider: str) -> str | None:
    env = os.environ.get(f"{provider.upper()}_API_KEY")
    if env:
        return env.strip()
    path = KEYS / f"{provider}.key"
    return path.read_text(encoding="utf-8").strip() if path.exists() else None


def check(res: requests.Response) -> dict:
    if res.status_code >= 400:
        raise ApiError(f"HTTP {res.status_code}: {res.text[:300]}")
    return res.json()


def input_png(name: str) -> bytes:
    """The cut-out centred on a square with some room around it, as the generators like it."""
    cut = Image.open(CUTOUTS / f"{name}.png").convert("RGBA")
    side = int(max(cut.size) * 1.15)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(cut, ((side - cut.width) // 2, (side - cut.height) // 2))
    out = io.BytesIO()
    square.resize((1024, 1024), Image.Resampling.LANCZOS).save(out, "PNG")
    return out.getvalue()


class Meshy:
    def __init__(self, key: str):
        self.headers = {"Authorization": f"Bearer {key}"}

    def start(self, name: str) -> str:
        uri = "data:image/png;base64," + base64.b64encode(input_png(name)).decode()
        body = {
            "image_url": uri,
            "ai_model": "latest",
            "should_texture": True,
            "enable_pbr": False,
            "should_remesh": True,
            "topology": "triangle",
            "target_polycount": 30000,
            "target_formats": ["glb"],
        }
        return check(requests.post(MESHY, json=body, headers=self.headers, timeout=120))["result"]

    def poll(self, task: str) -> tuple[str, str | None, str | None]:
        """('running' | 'done' | 'failed', model url, preview url)."""
        data = check(requests.get(f"{MESHY}/{task}", headers=self.headers, timeout=60))
        status = data.get("status")
        if status == "SUCCEEDED":
            return "done", data["model_urls"]["glb"], data.get("thumbnail_url")
        if status in ("FAILED", "CANCELED", "EXPIRED"):
            raise ApiError(f"task {status}: {data.get('task_error', {}).get('message', '')}")
        return "running", None, None


class Tripo:
    def __init__(self, key: str):
        self.headers = {"Authorization": f"Bearer {key}"}

    def start(self, name: str) -> str:
        files = {"file": (f"{name}.png", input_png(name), "image/png")}
        token = check(requests.post(f"{TRIPO}/upload", files=files, headers=self.headers, timeout=120))["data"]["image_token"]
        body = {
            "type": "image_to_model",
            "file": {"type": "png", "file_token": token},
            "model_version": "v3.1-20260211",
            "texture": True,
            "pbr": False,
            "texture_quality": "detailed",
            "face_limit": 30000,
            "orientation": "align_image",
        }
        return check(requests.post(f"{TRIPO}/task", json=body, headers=self.headers, timeout=120))["data"]["task_id"]

    def poll(self, task: str) -> tuple[str, str | None, str | None]:
        data = check(requests.get(f"{TRIPO}/task/{task}", headers=self.headers, timeout=60))["data"]
        status = data.get("status")
        if status == "success":
            out = data.get("output", {})
            return "done", out.get("pbr_model") or out.get("model") or out.get("base_model"), out.get("rendered_image")
        if status in ("failed", "banned", "expired", "cancelled", "unknown"):
            raise ApiError(f"task {status}")
        return "running", None, None


def download(url: str, dst: Path) -> None:
    res = requests.get(url, timeout=300)
    res.raise_for_status()
    dst.write_bytes(res.content)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("names", nargs="*")
    parser.add_argument("--provider", choices=["meshy", "tripo"])
    parser.add_argument("--again", action="store_true", help="make the named figures again")
    args = parser.parse_args()

    provider = args.provider or next((p for p in ("meshy", "tripo") if read_key(p)), None)
    key = read_key(provider) if provider else None
    if not provider or not key:
        sys.exit(f"No API key: put it in {KEYS / 'meshy.key'} or {KEYS / 'tripo.key'}.")
    api = Meshy(key) if provider == "meshy" else Tripo(key)

    RAW.mkdir(parents=True, exist_ok=True)
    tasks = json.loads(TASKS.read_text()) if TASKS.exists() else {}
    names = args.names or [n for n in FIGURES if (CUTOUTS / f"{n}.png").exists()]

    def save() -> None:
        TASKS.write_text(json.dumps(tasks, indent=2))

    for name in names:
        done = (RAW / f"{name}.glb").exists()
        if (done or name in tasks) and not args.again:
            continue
        try:
            tasks[name] = {"provider": provider, "task": api.start(name)}
            print(f"{name}: started")
        except ApiError as e:
            print(f"{name}: could not start ({e})")
        save()

    waiting = {n for n in names if n in tasks and tasks[n]["provider"] == provider and not (RAW / f"{n}.glb").exists()}
    if args.again:
        waiting |= {n for n in names if n in tasks}
    while waiting:
        for name in sorted(waiting):
            try:
                state, model, preview = api.poll(tasks[name]["task"])
            except ApiError as e:
                print(f"{name}: failed ({e})")
                tasks.pop(name)
                waiting.discard(name)
                continue
            if state != "done" or not model:
                continue
            download(model, RAW / f"{name}.glb")
            if preview:
                download(preview, RAW / f"{name}.png")
            print(f"{name}: done")
            waiting.discard(name)
        save()
        if waiting:
            time.sleep(POLL_S)


if __name__ == "__main__":
    main()
