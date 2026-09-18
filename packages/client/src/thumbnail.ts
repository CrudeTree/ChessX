import { fileOf, getPieceDef, rankOf, STANDARD_PIECES, type Color } from '@chessx/engine';
import type { GameSummary } from '@chessx/protocol';

const LIGHT = '#d6c9a8';
const DARK = '#7a5f45';

/**
 * Draw a small snapshot of a game's board onto a canvas, oriented so the
 * viewer's colour is at the bottom. Cheap 2D-canvas text glyphs; the home
 * page may show dozens of these.
 */
export function drawThumbnail(canvas: HTMLCanvasElement, game: GameSummary, size = 220): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const sq = size / 8;
  const flipped = game.yourColor === 'black';

  for (let sf = 0; sf < 8; sf++) {
    for (let sr = 0; sr < 8; sr++) {
      ctx.fillStyle = (sf + sr) % 2 === 0 ? LIGHT : DARK;
      ctx.fillRect(sf * sq, sr * sq, sq, sq);
    }
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of game.pieces) {
    const f = fileOf(p.square);
    const r = rankOf(p.square);
    const sf = flipped ? 7 - f : f;
    const sr = flipped ? r : 7 - r;
    const x = sf * sq + sq / 2;
    const y = sr * sq + sq / 2;
    const def = getPieceDef(p.kind);
    const standard = p.kind in STANDARD_PIECES;
    if (standard) {
      ctx.font = `${sq * 0.82}px "Segoe UI Symbol", "DejaVu Sans", sans-serif`;
      ctx.lineWidth = Math.max(1, sq * 0.06);
      ctx.strokeStyle = p.owner === 'white' ? '#2b2420' : '#d8d2e6';
      ctx.fillStyle = p.owner === 'white' ? '#f7f3ea' : '#1c1b24';
      ctx.strokeText(def.glyph, x, y + sq * 0.04);
      ctx.fillText(def.glyph, x, y + sq * 0.04);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, sq * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = p.owner === 'white' ? 'rgba(247,243,234,0.85)' : 'rgba(28,27,36,0.85)';
      ctx.fill();
      ctx.font = `${sq * 0.6}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
      ctx.fillStyle = '#000';
      ctx.fillText(def.glyph, x, y + sq * 0.04);
    }
  }
}

export const colorName = (c: Color): string => (c === 'white' ? 'White' : 'Black');
