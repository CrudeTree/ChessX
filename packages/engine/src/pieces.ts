import type { PieceDef } from './types.js';

const ORTHOGONAL = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const DIAGONAL = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;
const ALL_DIRS = [...ORTHOGONAL, ...DIAGONAL] as const;
const KNIGHT_LEAPS = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
] as const;

export const DIRS = { ORTHOGONAL, DIAGONAL, ALL: ALL_DIRS, KNIGHT: KNIGHT_LEAPS };

export const STANDARD_PIECES: Record<string, PieceDef> = {
  pawn: {
    kind: 'pawn',
    name: 'Pawn',
    glyph: '♟',
    tier: 1,
    movement: { pawn: true },
    description:
      'Moves one square forward (two from its starting square). Attacks diagonally forward. En passant: if an enemy pawn just double-stepped past you, you may capture it on the very next turn as if it had moved one square. Promotes when it reaches the last rank.',
  },
  knight: {
    kind: 'knight',
    name: 'Knight',
    glyph: '♞',
    tier: 2,
    movement: { leaps: KNIGHT_LEAPS },
    description: 'Jumps in an L-shape: two squares one way, one square sideways. Ignores pieces in between.',
  },
  bishop: {
    kind: 'bishop',
    name: 'Bishop',
    glyph: '♝',
    tier: 2,
    movement: { slides: [{ dirs: DIAGONAL }] },
    description: 'Slides any distance diagonally.',
  },
  rook: {
    kind: 'rook',
    name: 'Rook',
    glyph: '♜',
    tier: 3,
    movement: { slides: [{ dirs: ORTHOGONAL }] },
    description: 'Slides any distance horizontally or vertically. Can castle with the King.',
  },
  queen: {
    kind: 'queen',
    name: 'Queen',
    glyph: '♛',
    tier: 4,
    movement: { slides: [{ dirs: ALL_DIRS }] },
    description: 'Slides any distance in any direction.',
  },
  king: {
    kind: 'king',
    name: 'King',
    glyph: '♚',
    tier: 6,
    movement: { leaps: ALL_DIRS },
    description:
      "Moves one square in any direction. Castling: if neither the King nor that Rook has moved, the squares between are empty and none are attacked, the King may move two squares toward the Rook and the Rook hops over it. Royal strike: the King's capture destroys any piece, even one in Defense. Any enemy piece reaching its square captures it. Cannot have Defense.",
  },
};

/** Definitions as shipped in code. `registry` is what the game actually uses (base + balance patches). */
const base = new Map<string, PieceDef>(Object.entries(STANDARD_PIECES));
const registry = new Map<string, PieceDef>(Object.entries(STANDARD_PIECES));

/** Register a piece as shipped (used by the card catalog for creatures). */
export function registerPieceDef(def: PieceDef): void {
  base.set(def.kind, def);
  registry.set(def.kind, def);
}

/** Replace the live definition without touching the shipped one (balance patches). */
export function setPieceDef(def: PieceDef): void {
  registry.set(def.kind, def);
}

/** Forget a creature entirely (an admin-created card was deleted). */
export function removePieceDef(kind: string): void {
  if (kind in STANDARD_PIECES) return;
  base.delete(kind);
  registry.delete(kind);
}

export function hasPieceDef(kind: string): boolean {
  return registry.has(kind);
}

export function getPieceDef(kind: string): PieceDef {
  const def = registry.get(kind);
  if (!def) throw new Error(`Unknown piece kind: ${kind}`);
  return def;
}

/** True if this kind can ever hold Defense charges (tanks). Kings never can. */
export function canHaveDefense(kind: string): boolean {
  if (kind === 'king' || !hasPieceDef(kind)) return false;
  return (getPieceDef(kind).defense ?? 0) > 0;
}

/** The definition as shipped in code, before any balance patch. */
export function basePieceDef(kind: string): PieceDef {
  const def = base.get(kind);
  if (!def) throw new Error(`Unknown piece kind: ${kind}`);
  return def;
}

export function allPieceDefs(): PieceDef[] {
  return [...registry.values()];
}

export const STANDARD_KINDS = Object.keys(STANDARD_PIECES);
