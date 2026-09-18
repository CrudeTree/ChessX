// Prepares an admin-chosen picture for use as card art or a board sprite:
// fits it into a 512×512 transparent square and optionally knocks out a plain
// white background (the same treatment the shipped art had).

const SIZE = 512;

export interface PrepOptions {
  /** Turn near-white pixels transparent (for pictures on a plain white background). */
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

/** Load, fit and (optionally) knock out; returns a PNG data: URL. */
export async function prepareImage(file: File, opts: PrepOptions): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const scale = Math.min(SIZE / bitmap.width, SIZE / bitmap.height);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  ctx.drawImage(bitmap, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  bitmap.close();

  if (opts.knockoutWhite) {
    const img = ctx.getImageData(0, 0, SIZE, SIZE);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lo = Math.min(d[i]!, d[i + 1]!, d[i + 2]!);
      if (lo >= 250) d[i + 3] = 0;
      else if (lo >= 225) d[i + 3] = Math.min(d[i + 3]!, Math.round(((250 - lo) / 25) * 255));
    }
    ctx.putImageData(img, 0, 0);
  }
  return canvas.toDataURL('image/png');
}
