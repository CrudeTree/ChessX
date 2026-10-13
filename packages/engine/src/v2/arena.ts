// The arena: a sandbox for trying any card. A piece card goes onto any square ready to move, any card goes into
// either hand or discard pile, anything but a King comes off the board, mana is set by hand and a turn can be passed
// without a move. Everything else plays by the normal rules. The server keeps the earlier positions for Undo.

import { starterDeck } from './catalog.js';
import { cloneState, isInCheck, lavaAt, legalActions, newGame, newId, passTurn, pieceAt, sealAt, type ApplyResult } from './engine.js';
import { FILES, RANKS, opposite, type Color, type GameEvent, type GameState, type GameStatus, type Square } from './types.js';

/** Mana each side has when the arena opens, and the most it can be set to. */
export const ARENA_MANA = 10;
export const ARENA_MAX_MANA = 99;
/** The most cards a hand or a discard pile can be given, so a sandbox cannot grow without end. */
export const ARENA_MAX_CARDS = 30;

export type ArenaEdit =
  /** A piece card onto any square but a King's, as `color`'s piece, ready to move. Whatever stood there goes. */
  | { type: 'place'; cardId: string; color: Color; square: Square }
  /** A card into `color`'s hand. */
  | { type: 'give'; cardId: string; color: Color }
  /** A card onto `color`'s discard pile, where Resurrect finds it. */
  | { type: 'bury'; cardId: string; color: Color }
  /** A piece (a King too) or a sacrifice onto another square. Whatever stood there goes, unless it is a King. */
  | { type: 'relocate'; from: Square; to: Square }
  /** A piece (not a King), a sacrifice or lava off the board. */
  | { type: 'remove'; square: Square }
  | { type: 'mana'; color: Color; mana: number }
  /** The side to move ends its turn without a move. */
  | { type: 'pass' };

/** What the arena asks the server for: an edit, one step back, or the empty board again. */
export type ArenaOp = ArenaEdit | { type: 'undo' } | { type: 'reset' };

/** An arena op that cannot be made, with a message for the player. */
export class ArenaError extends Error {}

const COLORS: readonly Color[] = ['white', 'black'];

/** The arena as it opens: the two Kings, empty hands, a starter deck each to draw from and mana to spare. */
export function newArena(seed: number): GameState {
  const state = newGame({ seed, decks: { white: starterDeck(), black: starterDeck() } });
  state.pieces = state.pieces.filter((p) => p.def.king);
  for (const color of COLORS) {
    state.deck[color].push(...state.hand[color]);
    state.hand[color] = [];
    state.mana[color] = ARENA_MANA;
  }
  return state;
}

const isSquare = (s: unknown): s is Square => typeof s === 'number' && Number.isInteger(s) && s >= 0 && s < FILES * RANKS;

/** An arena op as it came over the wire, checked field by field. Throws ArenaError when it is not one. */
export function parseArenaOp(raw: unknown): ArenaOp {
  const op = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const cardId = (): string => {
    if (typeof op.cardId !== 'string') throw new ArenaError('Pick a card.');
    return op.cardId;
  };
  const color = (): Color => {
    if (op.color !== 'white' && op.color !== 'black') throw new ArenaError('Pick a side.');
    return op.color;
  };
  const square = (key: 'square' | 'from' | 'to'): Square => {
    const s = op[key];
    if (!isSquare(s)) throw new ArenaError('That is not a square.');
    return s;
  };
  switch (op.type) {
    case 'place':
      return { type: 'place', cardId: cardId(), color: color(), square: square('square') };
    case 'give':
    case 'bury':
      return { type: op.type, cardId: cardId(), color: color() };
    case 'relocate':
      return { type: 'relocate', from: square('from'), to: square('to') };
    case 'remove':
      return { type: 'remove', square: square('square') };
    case 'mana':
      if (typeof op.mana !== 'number' || !Number.isFinite(op.mana)) throw new ArenaError('Mana is a number.');
      return { type: 'mana', color: color(), mana: op.mana };
    case 'pass':
    case 'undo':
    case 'reset':
      return { type: op.type };
    default:
      throw new ArenaError('The arena cannot do that.');
  }
}

/** Empties a square for something to go there. A King never makes way. */
function clear(state: GameState, square: Square): void {
  if (pieceAt(state, square)?.def.king) throw new ArenaError('A King stands there.');
  state.pieces = state.pieces.filter((p) => p.square !== square);
  state.seals = state.seals.filter((s) => s.square !== square);
  if (state.lava) state.lava = state.lava.filter((l) => l.square !== square);
}

const winnerOf = (s: GameStatus): Color | null => ('winner' in s ? s.winner : null);

/** After an edit the side to move may have run out of moves, or have one again: the game ends, or goes on. */
function settle(state: GameState, before: GameStatus, events: GameEvent[]): void {
  state.status = { kind: 'playing' };
  if (state.phase !== 'play' || legalActions(state).length > 0) return;
  state.status = isInCheck(state, state.active) ? { kind: 'checkmate', winner: opposite(state.active) } : { kind: 'stalemate' };
  if (before.kind !== state.status.kind || winnerOf(before) !== winnerOf(state.status)) events.push({ type: 'gameOver', status: state.status });
}

/** Applies an arena edit to a copy of the state. Throws ArenaError when it cannot be made. */
export function applyArenaEdit(state: GameState, edit: ArenaEdit): ApplyResult {
  if (edit.type === 'pass') return passTurn(state);
  const next = cloneState(state);
  switch (edit.type) {
    case 'place': {
      const card = next.catalog[edit.cardId];
      if (card?.type !== 'piece') throw new ArenaError(card ? 'Only pieces go on the board.' : 'Unknown card.');
      clear(next, edit.square);
      next.pieces.push({ id: newId(next, 'p'), owner: edit.color, def: card.piece, cardId: card.id, square: edit.square, activeFromTurn: 0 });
      break;
    }
    case 'give':
    case 'bury': {
      if (!next.catalog[edit.cardId]) throw new ArenaError('Unknown card.');
      const pile = edit.type === 'give' ? next.hand[edit.color] : next.discard[edit.color];
      if (pile.length >= ARENA_MAX_CARDS) throw new ArenaError(edit.type === 'give' ? 'That hand is full.' : 'That discard pile is full.');
      pile.push({ uid: newId(next, 'c'), cardId: edit.cardId });
      break;
    }
    case 'relocate': {
      const thing = pieceAt(next, edit.from) ?? sealAt(next, edit.from);
      if (!thing) throw new ArenaError('Nothing stands there.');
      if (edit.to === edit.from) break;
      clear(next, edit.to);
      thing.square = edit.to;
      break;
    }
    case 'remove': {
      const piece = pieceAt(next, edit.square);
      if (piece?.def.king) throw new ArenaError('The Kings stay on the board.');
      if (piece) next.pieces = next.pieces.filter((p) => p !== piece);
      else if (sealAt(next, edit.square)) next.seals = next.seals.filter((s) => s.square !== edit.square);
      else if (lavaAt(next, edit.square)) next.lava = next.lava!.filter((l) => l.square !== edit.square);
      else throw new ArenaError('Nothing stands there.');
      break;
    }
    case 'mana':
      next.mana[edit.color] = Math.max(0, Math.min(ARENA_MAX_MANA, Math.round(edit.mana)));
      break;
  }
  const events: GameEvent[] = [];
  settle(next, state.status, events);
  return { state: next, events };
}
