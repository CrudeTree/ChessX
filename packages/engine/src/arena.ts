// Testing-arena mutations. These never go through the normal turn rules —
// a sandbox board where anything can be placed, moved, or discarded.

import { getCardDef, hasCard } from './cards/registry.js';
import type { CardInstance, SummonCardDef } from './cards/types.js';
import { hasPieceDef } from './pieces.js';
import { applyEffect, applySandboxAbility, beginSummon, IllegalActionError, offerOnSummonGrant, resolveSummon } from './rules.js';
import {
  addPiece,
  cloneState,
  DEFAULT_RULES,
  freshTurnInfo,
  pieceAt,
  piecesOf,
  type GameState,
} from './state.js';
import { fileOf, inBounds, opposite, rankOf, type Color, type Square } from './types.js';

export type ArenaOp =
  | { type: 'giveCard'; color: Color; cardId: string }
  | { type: 'dropCard'; cardId: string; color: Color; square: Square; fromHand?: string }
  | { type: 'spawnPiece'; kind: string; color: Color; square: Square }
  | { type: 'relocate'; from: Square; to: Square }
  | { type: 'removePiece'; square: Square }
  | { type: 'useAbility'; from: Square; to: Square; index?: number }
  | { type: 'setMana'; color: Color; mana: number };

const MANA_MAX = 99_999;

/** Empty board, empty hands, no decks. */
export function createArenaGame(seed?: number): GameState {
  return {
    rules: { ...DEFAULT_RULES, startingMana: 9999 },
    turnInfo: freshTurnInfo(),
    pieces: {},
    board: new Array<string | null>(64).fill(null),
    players: {
      white: { color: 'white', deck: [], hand: [], graveyard: [], turnsTaken: 1, pendingDraws: 0, mana: 9999 },
      black: { color: 'black', deck: [], hand: [], graveyard: [], turnsTaken: 0, pendingDraws: 0, mana: 9999 },
    },
    turn: 'white',
    ply: 0,
    seq: 0,
    enPassant: null,
    status: { kind: 'playing' },
    nextId: 1,
    rngState: (seed ?? Date.now()) | 0,
    events: [],
  };
}

/** Put a copy of `cardId` into `color`'s hand. */
export function giveCard(state: GameState, color: Color, cardId: string): string {
  if (!hasCard(cardId)) throw new IllegalActionError(`Unknown card: ${cardId}`);
  const instanceId = `a${state.nextId++}`;
  state.players[color].hand.push({ instanceId, cardId });
  return instanceId;
}

/** Take a piece off the board without graveyard / summon-fail side effects. */
export function removePieceAt(state: GameState, square: Square): boolean {
  const piece = pieceAt(state, square);
  if (!piece) return false;
  state.events.push({ type: 'destroyed', pieceId: piece.id, kind: piece.kind, owner: piece.owner, square: piece.square });
  state.board[piece.square] = null;
  delete state.pieces[piece.id];
  return true;
}

function assertColor(color: Color): void {
  if (color !== 'white' && color !== 'black') throw new IllegalActionError('Bad colour.');
}

function assertSquare(square: Square): void {
  if (!Number.isInteger(square) || !inBounds(fileOf(square), rankOf(square))) {
    throw new IllegalActionError('That is not a square on the board.');
  }
}

function takeHandCard(state: GameState, color: Color, instanceId: string): CardInstance {
  const hand = state.players[color].hand;
  const idx = hand.findIndex((c) => c.instanceId === instanceId);
  if (idx < 0) throw new IllegalActionError('That card is not in that hand.');
  return hand.splice(idx, 1)[0]!;
}

/** Moving a piece of colour C ticks pending summons on the opposite colour. */
function tickOppositeSummons(state: GameState, mover: Color): void {
  const victim = opposite(mover);
  for (const piece of [...piecesOf(state, victim)]) {
    if (!piece.summon) continue;
    piece.summon.turnsRemaining--;
    if (piece.summon.turnsRemaining <= 0) resolveSummon(state, piece);
    else state.events.push({ type: 'summonTick', square: piece.square, turnsRemaining: piece.summon.turnsRemaining });
  }
}

function playSandboxCard(state: GameState, cardId: string, color: Color, square: Square, inst: CardInstance): void {
  const card = getCardDef(cardId);
  const occupant = pieceAt(state, square);
  if (card.type === 'summon') {
    if (!occupant) {
      const spawned = addPiece(state, card.piece.kind, color, square, true);
      state.events.push({ type: 'summoned', color, cardId: card.id, pieceId: spawned.id, square });
      offerOnSummonGrant(state, spawned);
      return;
    }
    beginSummon(state, card as SummonCardDef, inst, occupant);
    return;
  }
  if (card.target !== 'none' && !occupant) {
    throw new IllegalActionError('Drop that spell on a piece.');
  }
  state.events.push({ type: 'cardPlayed', color, cardId: card.id, target: occupant ? square : undefined });
  for (const effect of card.effects) applyEffect(state, effect, color, occupant);
}

/** Apply a sandbox op and return a new state. The input is not mutated. */
export function applyArenaOp(state: GameState, op: ArenaOp): GameState {
  const next = cloneState(state);
  next.events = [];
  next.seq++;

  if (next.pendingGrant && op.type !== 'useAbility') {
    throw new IllegalActionError('Choose which adjacent piece receives the grant.');
  }

  switch (op.type) {
    case 'giveCard': {
      assertColor(op.color);
      giveCard(next, op.color, op.cardId);
      next.events.push({ type: 'drew', color: op.color, count: 1 });
      break;
    }
    case 'dropCard': {
      assertColor(op.color);
      assertSquare(op.square);
      if (!hasCard(op.cardId)) throw new IllegalActionError(`Unknown card: ${op.cardId}`);
      const inst = op.fromHand
        ? takeHandCard(next, op.color, op.fromHand)
        : { instanceId: `a${next.nextId++}`, cardId: op.cardId };
      if (inst.cardId !== op.cardId) throw new IllegalActionError('That card does not match the hand copy.');
      playSandboxCard(next, op.cardId, op.color, op.square, inst);
      break;
    }
    case 'spawnPiece': {
      assertColor(op.color);
      assertSquare(op.square);
      if (!hasPieceDef(op.kind)) throw new IllegalActionError(`Unknown piece: ${op.kind}`);
      removePieceAt(next, op.square);
      const spawned = addPiece(next, op.kind, op.color, op.square, true);
      offerOnSummonGrant(next, spawned);
      break;
    }
    case 'relocate': {
      assertSquare(op.from);
      assertSquare(op.to);
      if (op.from === op.to) break;
      const piece = pieceAt(next, op.from);
      if (!piece) throw new IllegalActionError('Nothing to move.');
      removePieceAt(next, op.to);
      next.board[op.from] = null;
      piece.square = op.to;
      next.board[op.to] = piece.id;
      next.events.push({ type: 'moved', pieceId: piece.id, from: op.from, to: op.to });
      tickOppositeSummons(next, piece.owner);
      break;
    }
    case 'removePiece': {
      assertSquare(op.square);
      if (!removePieceAt(next, op.square)) throw new IllegalActionError('Nothing on that square.');
      break;
    }
    case 'useAbility': {
      assertSquare(op.from);
      assertSquare(op.to);
      applySandboxAbility(next, op.from, op.to, op.index ?? 0);
      break;
    }
    case 'setMana': {
      assertColor(op.color);
      if (!Number.isInteger(op.mana) || op.mana < 0 || op.mana > MANA_MAX) {
        throw new IllegalActionError(`Mana must be 0–${MANA_MAX}.`);
      }
      next.players[op.color].mana = op.mana;
      break;
    }
    default:
      throw new IllegalActionError('Unknown arena action.');
  }
  return next;
}
