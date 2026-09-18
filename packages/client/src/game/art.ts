import { allCards } from '@chessx/engine';
import { Assets, Texture } from 'pixi.js';

/** Card artwork textures, keyed by the card's `art` URL. Loaded once at startup. */
export const artTextures = new Map<string, Texture>();

export async function preloadArt(): Promise<void> {
  const urls = [...new Set(allCards().map((c) => c.art).filter((u): u is string => !!u))];
  await Promise.all(
    urls.map(async (url) => {
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
