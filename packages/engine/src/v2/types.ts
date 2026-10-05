// ChessX v2 rules: 8x8 board, Kings only at the start, mana-based summoning and sealing.
// Ported from the standalone `chessx-rules/` reference engine. Everything here is namespaced
// under `v2` when imported from `@chessx/engine`, so the original (v1) engine is untouched.

export type Color = 'white' | 'black';
export const opposite = (c: Color): Color => (c === 'white' ? 'black' : 'white');

export const FILES = 8;
export const RANKS = 8;
export const FILE_NAMES = 'abcdefgh';

/** Square index = rank * FILES + file. a1 = 0, h1 = 7, a8 = 56, h8 = 63. */
export type Square = number;
export const sq = (file: number, rank: number): Square => rank * FILES + file;
export const fileOf = (s: Square): number => s % FILES;
export const rankOf = (s: Square): number => Math.floor(s / FILES);
export const inBounds = (file: number, rank: number): boolean =>
  file >= 0 && file < FILES && rank >= 0 && rank < RANKS;
export const squareName = (s: Square): string => FILE_NAMES[fileOf(s)]! + String(rankOf(s) + 1);
export function parseSquare(name: string): Square {
  const file = FILE_NAMES.indexOf(name[0] ?? '');
  const rank = Number(name.slice(1)) - 1;
  if (file < 0 || !Number.isInteger(rank) || !inBounds(file, rank)) throw new Error(`Bad square: ${name}`);
  return sq(file, rank);
}
/** Rank index of a player's back row. */
export const backRank = (c: Color): number => (c === 'white' ? 0 : RANKS - 1);
export const forward = (c: Color): number => (c === 'white' ? 1 : -1);

/**
 * One way a piece moves. Offsets are [dFile, dRank]. With `relative`, dRank is
 * flipped for Black so "forward" always points at the enemy.
 * `leap`: land exactly on the offset, ignoring pieces in between.
 * Otherwise the piece slides up to `range` squares and stops at the first piece.
 * `mode`: 'both' moves and captures, 'move' never captures, 'capture' only captures.
 */
export interface MoveRule {
  dirs: ReadonlyArray<readonly [number, number]>;
  range: number;
  leap?: boolean;
  relative?: boolean;
  mode?: 'both' | 'move' | 'capture';
}

export interface PieceDef {
  kind: string;
  name: string;
  rules: ReadonlyArray<MoveRule>;
  king?: boolean;
}

/** A piece card. `cost` is the mana to summon or seal it. `sealTimer` is printed on the card. */
export interface PieceCard {
  type: 'piece';
  id: string;
  name: string;
  cost: number;
  sealTimer: number;
  piece: PieceDef;
}

export type SpellEffect = { kind: 'destroySeal' } | { kind: 'draw'; count: number };

export interface SpellCard {
  type: 'spell';
  id: string;
  name: string;
  cost: number;
  effect: SpellEffect;
  text: string;
}

export type Card = PieceCard | SpellCard;

export interface CardInstance {
  uid: string;
  cardId: string;
}

export interface Piece {
  id: string;
  owner: Color;
  def: PieceDef;
  /** Card it came from, or null for Kings. */
  cardId: string | null;
  square: Square;
  /**
   * Owner turn number from which this piece may capture and give check. A piece that
   * appears on owner turn N has activeFromTurn N + 1. Pieces deployed in setup use 0.
   */
  activeFromTurn: number;
}

export interface Seal {
  id: string;
  owner: Color;
  square: Square;
  card: PieceCard;
  /** Owner turns left. The piece hatches at the start of the owner's turn when this reaches 0. */
  timer: number;
}

/** `resigned` and `timeout` are set by the server (they are not decided by the rules). */
export type GameStatus =
  | { kind: 'playing' }
  | { kind: 'checkmate'; winner: Color }
  | { kind: 'stalemate' }
  | { kind: 'resigned'; winner: Color }
  | { kind: 'timeout'; winner: Color };

export interface GameState {
  catalog: Record<string, Card>;
  phase: 'setup' | 'play';
  active: Color;
  turns: Record<Color, number>;
  mana: Record<Color, number>;
  hand: Record<Color, CardInstance[]>;
  deck: Record<Color, CardInstance[]>;
  discard: Record<Color, CardInstance[]>;
  pieces: Piece[];
  seals: Seal[];
  setupDeployed: Record<Color, number>;
  actionTaken: boolean;
  spellPlayed: boolean;
  status: GameStatus;
  nextId: number;
  rng: number;
}

export type Action =
  | { type: 'deploy'; cardUid: string; to: Square }
  | { type: 'move'; from: Square; to: Square }
  | { type: 'summon'; cardUid: string; to: Square }
  | { type: 'seal'; cardUid: string; target: Square }
  | { type: 'spell'; cardUid: string; target?: Square }
  | { type: 'endTurn' };

export type GameEvent =
  | { type: 'deployed'; color: Color; pieceId: string; square: Square }
  | { type: 'turnStarted'; color: Color; turn: number; mana: number }
  | { type: 'drew'; color: Color; count: number }
  | { type: 'moved'; pieceId: string; from: Square; to: Square }
  | { type: 'captured'; pieceId: string; by: string; square: Square }
  | { type: 'sealDestroyed'; sealId: string; by: string; square: Square; cardId: string }
  | { type: 'summoned'; color: Color; pieceId: string; square: Square }
  | { type: 'sealed'; color: Color; sealId: string; square: Square; consumedPieceId: string; timer: number }
  | { type: 'sealTick'; sealId: string; timer: number }
  | { type: 'hatched'; color: Color; pieceId: string; square: Square }
  | { type: 'spellPlayed'; color: Color; cardId: string; target?: Square }
  | { type: 'check'; color: Color }
  | { type: 'gameOver'; status: GameStatus };
