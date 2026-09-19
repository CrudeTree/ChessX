// Prepares an admin-chosen picture for use as card art or a board sprite:
// fits it into a 512×512 transparent square and optionally knocks out a plain
// white background (the same treatment the shipped art had).

const SIZE = 512;

export interface PrepOptions {
  /** Turn the connected white backdrop transparent (for pictures on a plain white background). */
  knockoutWhite: boolean;
}

/** Pick a file from disk. Resolves null if the user cancels. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // Some browsers never fire change on cancel; a focus-back heuristic covers it.
    const onFocus = () => setTimeout(() => resolve(input.files?.[0] ?? null), 300);
    window.addEventListener('focus', onFocus, { once: true });
    input.click();
  });
}

/** Near-white and almost grey — the paper behind the subject, not icy-blue feathers. */
export function isPaperWhite(r: number, g: number, b: number, a: number): boolean {
  if (a === 0) return true;
  const lo = Math.min(r, g, b);
  const hi = Math.max(r, g, b);
  return lo >= 240 && hi - lo <= 18;
}

/**
 * Remove only the backdrop: flood from the edges through paper-white pixels.
 * A per-pixel threshold would also erase a white creature (Frost Owl).
 */
export function knockoutConnectedWhite(data: Uint8ClampedArray, w: number, h: number): void {
  const n = w * h;
  const bg = new Uint8Array(n);
  const stack: number[] = [];
  const tryPush = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (bg[p]) return;
    const i = p * 4;
    if (!isPaperWhite(data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!)) return;
    bg[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < w; x++) {
    tryPush(x, 0);
    tryPush(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    tryPush(0, y);
    tryPush(w - 1, y);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p / w) | 0;
    tryPush(x - 1, y);
    tryPush(x + 1, y);
    tryPush(x, y - 1);
    tryPush(x, y + 1);
  }
  for (let p = 0; p < n; p++) {
    if (bg[p]) data[p * 4 + 3] = 0;
  }
  // Soften the silhouette so downscaling does not leave a white halo.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (bg[p]) continue;
      const i = p * 4;
      const lo = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
      if (lo < 200) continue;
      const fringe =
        (x > 0 && bg[p - 1]) ||
        (x < w - 1 && bg[p + 1]) ||
        (y > 0 && bg[p - w]) ||
        (y < h - 1 && bg[p + w]);
      if (!fringe) continue;
      const t = Math.min(1, (lo - 200) / 40);
      data[i + 3] = Math.min(data[i + 3]!, Math.round((1 - t) * 255));
    }
  }
}

/** Load, knock out the backdrop first, then fit; returns a PNG data: URL. */
export async function prepareImage(file: File, opts: PrepOptions): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const src = document.createElement('canvas');
  src.width = bitmap.width;
  src.height = bitmap.height;
  const sctx = src.getContext('2d')!;
  sctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  if (opts.knockoutWhite) {
    const img = sctx.getImageData(0, 0, src.width, src.height);
    knockoutConnectedWhite(img.data, src.width, src.height);
    sctx.putImageData(img, 0, 0);
  }

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const scale = Math.min(SIZE / src.width, SIZE / src.height);
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);
  ctx.drawImage(src, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  return canvas.toDataURL('image/png');
}
