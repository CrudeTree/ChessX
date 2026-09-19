import { getPieceDef } from './pieces.js';
import { findKing, pieceAt, piecesOf, type GameState } from './state.js';
import { fileOf, inBounds, rankOf, sq, type Color, type MovementSpec, type Piece, type Square } from './types.js';

export interface MoveCandidate {
  from: Square;
  to: Square;
  kind: 'move' | 'attack' | 'castle' | 'enPassant';
  /** Pawn reaches the last rank with this move. */
  promotion?: boolean;
  /** For castling. */
  rookFrom?: Square;
  rookTo?: Square;
  /** For en passant: the square of the pawn being attacked (differs from `to`). */
  captureSquare?: Square;
}

export const forwardDir = (color: Color): number => (color === 'white' ? 1 : -1);
export const lastRank = (color: Color): number => (color === 'white' ? 7 : 0);
export const pawnStartRank = (color: Color): number => (color === 'white' ? 1 : 6);

/**
 * Generate pseudo-legal moves for a piece (ignores whether the move leaves
 * the king in check). With `attacksOnly`, returns the squares this piece
 * threatens: pawn diagonals regardless of occupancy, no pushes, no castling.
 */
/**
 * Pieces being sacrificed and pieces in Defense mode can neither move nor
 * attack (so they also never give check).
 */
export function canAct(piece: Piece): boolean {
  return !piece.summon && piece.stance !== 'defense';
}

/** Board slice `pseudoMoves` needs. Used by the arena overlay. */
export type ReachBoard = Pick<GameState, 'board' | 'pieces' | 'enPassant'>;

/**
 * Squares this piece can reach from here, ignoring check, turn, and stance/summon
 * locks. The arena uses this so a selected unit shows the same dots as a real game.
 */
export function previewMoves(state: ReachBoard, piece: Piece): MoveCandidate[] {
  return pseudoMoves(state as GameState, { ...piece, summon: undefined, stance: 'attack' });
}

export function pseudoMoves(state: GameState, piece: Piece, attacksOnly = false): MoveCandidate[] {
  const out: MoveCandidate[] = [];
  if (!canAct(piece)) return out;

  const def = getPieceDef(piece.kind);
  const mv = def.movement;
  if (mv.immobile) return out;
  const from = piece.square;
  const f = fileOf(from);
  const r = rankOf(from);
  const dir = forwardDir(piece.owner);
  const flip = mv.relative ? dir : 1;

  /** Returns false if the ray should stop. */
  const consider = (tf: number, tr: number): boolean => {
    if (!inBounds(tf, tr)) return false;
    const to = sq(tf, tr);
    const occupant = pieceAt(state, to);
    if (!occupant) {
      out.push({ from, to, kind: 'move' });
      return true;
    }
    if (occupant.owner !== piece.owner) out.push({ from, to, kind: 'attack' });
    return false;
  };

  if (mv.pawn) {
    const promo = (tr: number) => tr === lastRank(piece.owner) || undefined;
    if (!attacksOnly) {
      const oneR = r + dir;
      if (inBounds(f, oneR) && !pieceAt(state, sq(f, oneR))) {
        out.push({ from, to: sq(f, oneR), kind: 'move', promotion: promo(oneR) });
        const twoR = r + 2 * dir;
        if (r === pawnStartRank(piece.owner) && inBounds(f, twoR) && !pieceAt(state, sq(f, twoR))) {
          out.push({ from, to: sq(f, twoR), kind: 'move' });
        }
      }
    }
    for (const df of [-1, 1]) {
      const tf = f + df;
      const tr = r + dir;
      if (!inBounds(tf, tr)) continue;
      const to = sq(tf, tr);
      const occupant = pieceAt(state, to);
      if (attacksOnly) {
        out.push({ from, to, kind: 'attack' });
      } else if (occupant && occupant.owner !== piece.owner) {
        out.push({ from, to, kind: 'attack', promotion: promo(tr) });
      } else if (!occupant && state.enPassant === to) {
        const victim = pieceAt(state, sq(tf, r));
        if (victim && victim.kind === 'pawn' && victim.owner !== piece.owner) {
          out.push({ from, to, kind: 'enPassant', captureSquare: victim.square });
        }
      }
    }
  }

  for (const [df, dr] of mv.leaps ?? []) {
    consider(f + df, r + dr * flip);
  }

  for (const group of mv.slides ?? []) {
    const range = group.range ?? 8;
    for (const [df, dr] of group.dirs) {
      for (let step = 1; step <= range; step++) {
        if (!consider(f + df * step, r + dr * step * flip)) break;
      }
    }
  }

  if (piece.kind === 'king' && !attacksOnly && !piece.hasMoved) {
    addCastling(state, piece, out);
  }

  return out;
}

function addCastling(state: GameState, king: Piece, out: MoveCandidate[]): void {
  const r = rankOf(king.square);
  const f = fileOf(king.square);
  const enemy = king.owner === 'white' ? 'black' : 'white';
  if (isSquareAttacked(state, king.square, enemy)) return;

  for (const side of [
    { rookFile: 7, step: 1 },
    { rookFile: 0, step: -1 },
  ]) {
    const rook = pieceAt(state, sq(side.rookFile, r));
    if (!rook || rook.kind !== 'rook' || rook.owner !== king.owner || rook.hasMoved || rook.summon) continue;
    let clear = true;
    for (let tf = f + side.step; tf !== side.rookFile; tf += side.step) {
      if (pieceAt(state, sq(tf, r))) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    const pass1 = sq(f + side.step, r);
    const pass2 = sq(f + 2 * side.step, r);
    if (isSquareAttacked(state, pass1, enemy) || isSquareAttacked(state, pass2, enemy)) continue;
    out.push({
      from: king.square,
      to: pass2,
      kind: 'castle',
      rookFrom: rook.square,
      rookTo: pass1,
    });
  }
}

export interface MovementPattern {
  /** Offsets [dFile, dRank] the piece can move to on an empty board, "forward" = +rank. */
  moves: [number, number][];
  /** Offsets that are attack-only (pawn diagonals). */
  attacks: [number, number][];
  /** Any ray continues beyond `radius`. */
  unbounded: boolean;
}

/**
 * Abstract movement pattern for teaching UIs: where could this piece go from
 * the centre of an empty board, within `radius` squares? Always drawn from
 * the owner's perspective (forward is up), so no colour flipping is needed.
 */
export function movementPattern(spec: MovementSpec, radius = 3): MovementPattern {
  if (spec.immobile) return { moves: [], attacks: [], unbounded: false };
  const moves: [number, number][] = [];
  const attacks: [number, number][] = [];
  let unbounded = false;
  const within = (df: number, dr: number) => Math.abs(df) <= radius && Math.abs(dr) <= radius;

  if (spec.pawn) {
    moves.push([0, 1]);
    attacks.push([-1, 1], [1, 1]);
  }
  for (const [df, dr] of spec.leaps ?? []) if (within(df, dr)) moves.push([df, dr]);
  for (const group of spec.slides ?? []) {
    const range = group.range ?? Infinity;
    if (range > radius) unbounded = true;
    for (const [df, dr] of group.dirs) {
      for (let step = 1; step <= Math.min(range, radius); step++) moves.push([df * step, dr * step]);
    }
  }
  return { moves, attacks, unbounded };
}

/** True if any piece of `byColor` threatens `square`. */
export function isSquareAttacked(state: GameState, square: Square, byColor: Color): boolean {
  for (const piece of piecesOf(state, byColor)) {
    for (const cand of pseudoMoves(state, piece, true)) {
      if (cand.to === square) return true;
    }
  }
  return false;
}

/** A missing king counts as "in check" so a captured king is never considered safe. */
export function isInCheck(state: GameState, color: Color): boolean {
  const king = findKing(state, color);
  if (!king) return true;
  return isSquareAttacked(state, king.square, color === 'white' ? 'black' : 'white');
}
