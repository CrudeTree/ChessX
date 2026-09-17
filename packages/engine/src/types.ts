// Core types shared by the whole engine.

export type Color = 'white' | 'black';

/** Board square index 0..63. index = rank * 8 + file. a1 = 0, h1 = 7, a8 = 56, h8 = 63. */
export type Square = number;

export const opposite = (c: Color): Color => (c === 'white' ? 'black' : 'white');
export const fileOf = (s: Square): number => s & 7;
export const rankOf = (s: Square): number => s >> 3;
export const sq = (file: number, rank: number): Square => rank * 8 + file;
export const inBounds = (file: number, rank: number): boolean =>
  file >= 0 && file < 8 && rank >= 0 && rank < 8;
export const squareName = (s: Square): string => 'abcdefgh'[fileOf(s)] + (rankOf(s) + 1);
export const parseSquare = (name: string): Square => {
  const file = 'abcdefgh'.indexOf(name[0]!);
  const rank = Number(name[1]) - 1;
  if (file < 0 || !inBounds(file, rank)) throw new Error(`Bad square: ${name}`);
  return sq(file, rank);
};

/**
 * Describes how a piece moves. Standard pieces and card-summoned pieces
 * both use this, so new creatures are pure data.
 *
 * Offsets are [dFile, dRank]. If `relative` is true, dRank is flipped for
 * black so "forward" means toward the enemy.
 */
export interface MovementSpec {
  /** Jumps (like a knight). Can land on empty or enemy squares. */
  leaps?: ReadonlyArray<readonly [number, number]>;
  /** Sliding rays (like rook/bishop). `range` undefined = unlimited. */
  slides?: ReadonlyArray<{ dirs: ReadonlyArray<readonly [number, number]>; range?: number }>;
  /** Standard pawn behaviour: push forward, attack diagonally, double-step, en passant, promotion. */
  pawn?: boolean;
  relative?: boolean;
}

export interface PieceDef {
  /** Unique kind id, e.g. "knight" or "the_ox". */
  kind: string;
  name: string;
  /** Glyph used by the renderer (unicode chess symbol or emoji). */
  glyph: string;
  /** Sacrifice tier. Pawn=1, Knight/Bishop=2, Rook=3, Queen=4. King=0 (never sacrificable). */
  tier: number;
  movement: MovementSpec;
  atk: number;
  def: number;
  hp: number;
  description?: string;
}

/** A summon in progress: this piece is being sacrificed and cannot move. */
export interface PendingSummon {
  cardInstanceId: string;
  cardId: string;
  turnsRemaining: number;
}

/**
 * Attack mode is the default. In Defense mode a piece's DEF acts as a shield
 * that absorbs damage before HP, but the piece cannot move or attack at all.
 * Switching stance in either direction costs the owner's turn.
 */
export type Stance = 'attack' | 'defense';

export interface Piece {
  id: string;
  kind: string;
  owner: Color;
  square: Square;
  atk: number;
  /** Current shield. Only absorbs damage while in Defense mode. */
  def: number;
  maxDef: number;
  /** Kings ignore HP: any piece landing on the king captures it. */
  hp: number;
  maxHp: number;
  hasMoved: boolean;
  stance: Stance;
  summon?: PendingSummon;
}

export type PromotionKind = 'queen' | 'rook' | 'bishop' | 'knight';

export type Action =
  | { type: 'move'; from: Square; to: Square; promotion?: PromotionKind }
  | { type: 'playCard'; cardInstanceId: string; target?: Square }
  | { type: 'setStance'; square: Square; stance: Stance }
  | { type: 'resign' };

export type GameStatus =
  | { kind: 'playing' }
  | { kind: 'checkmate'; winner: Color }
  | { kind: 'stalemate' }
  | { kind: 'kingCaptured'; winner: Color }
  | { kind: 'resigned'; winner: Color };

/** Events emitted while applying an action. The client uses these for animation and the log. */
export type GameEvent =
  | { type: 'moved'; pieceId: string; from: Square; to: Square; castle?: boolean }
  | { type: 'attacked'; attackerId: string; targetId: string; from: Square; to: Square; damage: number }
  /** `shield` is how much of the hit the defender's DEF absorbed. */
  | { type: 'damaged'; pieceId: string; square: Square; amount: number; shield: number; hp: number; def: number }
  | { type: 'stanceChanged'; pieceId: string; square: Square; stance: Stance }
  | { type: 'repelled'; pieceId: string; square: Square }
  | { type: 'destroyed'; pieceId: string; kind: string; owner: Color; square: Square }
  | { type: 'kingCaptured'; owner: Color; square: Square }
  | { type: 'promoted'; pieceId: string; square: Square; to: string }
  | { type: 'cardPlayed'; color: Color; cardId: string; target?: Square }
  | { type: 'summonStarted'; color: Color; cardId: string; square: Square; turns: number }
  | { type: 'summonTick'; square: Square; turnsRemaining: number }
  | { type: 'summoned'; color: Color; cardId: string; pieceId: string; square: Square }
  | { type: 'summonFailed'; color: Color; cardId: string; square: Square }
  | { type: 'statsChanged'; pieceId: string; square: Square; atk: number; def: number; hp: number; maxHp: number }
  | { type: 'drew'; color: Color; count: number }
  | { type: 'check'; color: Color }
  | { type: 'gameOver'; status: GameStatus };
