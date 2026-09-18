import { allCards } from '@chessx/engine';
import { Assets, Texture } from 'pixi.js';

/** Card artwork textures, keyed by the image URL. Loaded at startup and whenever the catalog changes. */
export const artTextures = new Map<string, Texture>();

/** Every image the current catalog refers to (card pictures and board sprites). */
function artUrls(): string[] {
  const urls = new Set<string>();
  for (const c of allCards()) {
    if (c.art) urls.add(c.art);
    if (c.boardArt) urls.add(c.boardArt);
  }
  return [...urls];
}

/** Load any textures not loaded yet. Safe to call repeatedly (e.g. after the admin uploads new art). */
export async function preloadArt(): Promise<void> {
  const missing = artUrls().filter((u) => !artTextures.has(u));
  await Promise.all(
    missing.map(async (url) => {
      try {
        const tex = await Assets.load<Texture>(url);
        // The art is 512px and is always drawn much smaller (cards ~46px, board ~80px);
        // nearest-neighbour at those ratios speckles, so let the GPU filter it.
        tex.source.scaleMode = 'linear';
        tex.source.autoGenerateMipmaps = true;
        artTextures.set(url, tex);
      } catch {
        /* missing art just falls back to the glyph */
      }
    }),
  );
}
