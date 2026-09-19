// Testing-arena mutations. These never go through the normal turn rules —
// they exist so a player can set up a position and try cards. The server
// only accepts them on an arena game.

import { hasCard } from './cards/registry.js';
import { hasPieceDef } from './pieces.js';
import { addPiece, cloneState, pieceAt, type GameState } from './state.js';
import { fileOf, inBounds, rankOf, type Color, type Square } from './types.js';
import { IllegalActionError } from './rules.js';

export type ArenaOp =
  | { type: 'giveCard'; color: Color; cardId: string }
  | { type: 'spawnPiece'; kind: string; color: Color; square: Square }
  | { type: 'relocate'; from: Square; to: Square }
  | { type: 'removePiece'; square: Square }
  | { type: 'setMana'; color: Color; mana: number };

const MANA_MAX = 99_999;

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

function assertSquare(square: Square): void {
  if (!Number.isInteger(square) || !inBounds(fileOf(square), rankOf(square))) {
    throw new IllegalActionError('That is not a square on the board.');
  }
}

/** Apply a sandbox op and return a new state. The input is not mutated. */
export function applyArenaOp(state: GameState, op: ArenaOp): GameState {
  const next = cloneState(state);
  next.events = [];
  next.seq++;

  switch (op.type) {
    case 'giveCard': {
      if (op.color !== 'white' && op.color !== 'black') throw new IllegalActionError('Bad colour.');
      giveCard(next, op.color, op.cardId);
      next.events.push({ type: 'drew', color: op.color, count: 1 });
      break;
    }
    case 'spawnPiece': {
      if (op.color !== 'white' && op.color !== 'black') throw new IllegalActionError('Bad colour.');
      assertSquare(op.square);
      if (!hasPieceDef(op.kind)) throw new IllegalActionError(`Unknown piece: ${op.kind}`);
      removePieceAt(next, op.square);
      addPiece(next, op.kind, op.color, op.square, true);
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
      break;
    }
    case 'removePiece': {
      assertSquare(op.square);
      if (!removePieceAt(next, op.square)) throw new IllegalActionError('Nothing on that square.');
      break;
    }
    case 'setMana': {
      if (op.color !== 'white' && op.color !== 'black') throw new IllegalActionError('Bad colour.');
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
