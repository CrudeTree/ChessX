import { fileOf, getPieceDef, rankOf, STANDARD_PIECES, v2, type Color } from '@chessx/engine';
import type { GameSummary } from '@chessx/protocol';
import { glyphFor } from './v2/GameScreen.js';

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
  if (game.rules === 2) return drawV2(ctx, game, size);
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

/** The 8x8 board, centred in the same square canvas so the home page cards line up. */
function drawV2(ctx: CanvasRenderingContext2D, game: GameSummary, size: number): void {
  const sq = size / v2.RANKS;
  const x0 = (size - sq * v2.FILES) / 2;
  const flipped = game.yourColor === 'black';
  ctx.fillStyle = '#1c1c28';
  ctx.fillRect(0, 0, size, size);
  for (let sf = 0; sf < v2.FILES; sf++) {
    for (let sr = 0; sr < v2.RANKS; sr++) {
      ctx.fillStyle = (sf + sr) % 2 === 0 ? LIGHT : DARK;
      ctx.fillRect(x0 + sf * sq, sr * sq, sq, sq);
    }
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of game.pieces) {
    const f = v2.fileOf(p.square);
    const r = v2.rankOf(p.square);
    const sf = flipped ? v2.FILES - 1 - f : f;
    const sr = flipped ? r : v2.RANKS - 1 - r;
    const x = x0 + sf * sq + sq / 2;
    const y = sr * sq + sq / 2;
    ctx.beginPath();
    ctx.arc(x, y, sq * 0.42, 0, Math.PI * 2);
    if (p.kind === 'seal') {
      ctx.setLineDash([sq * 0.12, sq * 0.1]);
      ctx.lineWidth = Math.max(1.5, sq * 0.08);
      ctx.strokeStyle = p.owner === 'white' ? '#f7f3ea' : '#1c1b24';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `${sq * 0.5}px "Segoe UI Symbol", "DejaVu Sans", sans-serif`;
      ctx.fillStyle = p.owner === 'white' ? '#f7f3ea' : '#1c1b24';
      ctx.fillText('⧗', x, y);
      continue;
    }
    ctx.fillStyle = p.owner === 'white' ? '#f7f3ea' : '#1c1b24';
    ctx.fill();
    ctx.strokeStyle = p.owner === 'white' ? '#2b2420' : '#d8d2e6';
    ctx.lineWidth = Math.max(1, sq * 0.05);
    ctx.stroke();
    ctx.font = `${sq * 0.6}px "Segoe UI Symbol", "DejaVu Sans", sans-serif`;
    ctx.fillStyle = p.owner === 'white' ? '#2b2420' : '#f2eee6';
    ctx.fillText(glyphFor(p.kind, p.kind.replace(/_/g, ' ')), x, y + sq * 0.03);
  }
}

export const colorName = (c: Color): string => (c === 'white' ? 'White' : 'Black');
