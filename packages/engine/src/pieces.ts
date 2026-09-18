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

/** Every piece starts with 1 ATK, 0 DEF, 1 HP. Cards modify from there. */
export const BASE_STATS = { atk: 1, def: 0, hp: 1 } as const;

export const STANDARD_PIECES: Record<string, PieceDef> = {
  pawn: {
    kind: 'pawn',
    name: 'Pawn',
    glyph: '♟',
    tier: 1,
    movement: { pawn: true },
    ...BASE_STATS,
    description: 'Moves one square forward (two from its starting square). Attacks diagonally forward. Promotes when it reaches the last rank.',
  },
  knight: {
    kind: 'knight',
    name: 'Knight',
    glyph: '♞',
    tier: 2,
    movement: { leaps: KNIGHT_LEAPS },
    ...BASE_STATS,
    description: 'Jumps in an L-shape: two squares one way, one square sideways. Ignores pieces in between.',
  },
  bishop: {
    kind: 'bishop',
    name: 'Bishop',
    glyph: '♝',
    tier: 2,
    movement: { slides: [{ dirs: DIAGONAL }] },
    ...BASE_STATS,
    description: 'Slides any distance diagonally.',
  },
  rook: {
    kind: 'rook',
    name: 'Rook',
    glyph: '♜',
    tier: 3,
    movement: { slides: [{ dirs: ORTHOGONAL }] },
    ...BASE_STATS,
    description: 'Slides any distance horizontally or vertically. Can castle with the King.',
  },
  queen: {
    kind: 'queen',
    name: 'Queen',
    glyph: '♛',
    tier: 4,
    movement: { slides: [{ dirs: ALL_DIRS }] },
    ...BASE_STATS,
    description: 'Slides any distance in any direction.',
  },
  king: {
    kind: 'king',
    name: 'King',
    glyph: '♚',
    tier: 6,
    movement: { leaps: ALL_DIRS },
    ...BASE_STATS,
    description: 'Moves one square in any direction. Has no HP: any enemy piece reaching its square captures it. Cannot enter Defense mode.',
  },
};

const registry = new Map<string, PieceDef>(Object.entries(STANDARD_PIECES));

export function registerPieceDef(def: PieceDef): void {
  registry.set(def.kind, def);
}

export function getPieceDef(kind: string): PieceDef {
  const def = registry.get(kind);
  if (!def) throw new Error(`Unknown piece kind: ${kind}`);
  return def;
}

export function allPieceDefs(): PieceDef[] {
  return [...registry.values()];
}
