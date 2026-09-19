import type { CardInstance } from './cards/types.js';
import { isInCheck } from './movement.js';
import { legalActions } from './rules.js';
import { isStormed, manaIncome, type GameState, type RuleConstants, type TurnInfo, type TurnPhase } from './state.js';
import type { Action, Color, GameEvent, GameStatus, PendingGrant, Piece, Square, StormCloud } from './types.js';

export interface PlayerViewSide {
  turnsTaken: number;
  /** Draws this player still has to take by clicking their deck. */
  pendingDraws: number;
  deckCount: number;
  handCount: number;
  /** Your own hand; null for the opponent. */
  hand: CardInstance[] | null;
  graveyard: CardInstance[];
  /** Current mana pool (public information, like the board). */
  mana: number;
  /** What this side will collect at the end of their turn with the board as it stands. */
  manaIncome: number;
}

/** What one player is allowed to know about the game. */
export interface PlayerView {
  you: Color;
  turn: Color;
  ply: number;
  seq: number;
  status: GameStatus;
  /** What the side to move has done so far this turn. */
  turnInfo: TurnInfo;
  /** Where the side to move is in their turn (draw owed, or main: cards then a move). */
  phase: TurnPhase;
  rules: RuleConstants;
  board: (string | null)[];
  pieces: Record<string, Piece>;
  enPassant: Square | null;
  players: Record<Color, PlayerViewSide>;
  events: GameEvent[];
  inCheck: boolean;
  /** Legal actions for you. Empty when it is not your turn. */
  legalActions: Action[];
  /** Summoned creature is waiting for you to pick a grant target. */
  pendingGrant: PendingGrant | null;
  /** Public storm clouds. Timers are visible to everyone; enemy pieces under them are not. */
  storms: Pick<StormCloud, 'square' | 'turnsRemaining'>[];
}

export interface ViewOptions {
  /** Show both hands face-up (testing arena). */
  openHands?: boolean;
  /** Skip check detection and legal-move lists. */
  sandbox?: boolean;
}

function hideEnemyStormOccupants(
  state: GameState,
  you: Color,
): { board: (string | null)[]; pieces: Record<string, Piece>; hiddenIds: Set<string> } {
  const hiddenIds = new Set<string>();
  const board = state.board.slice();
  const pieces = { ...state.pieces };
  for (const cloud of state.storms ?? []) {
    const id = board[cloud.square];
    if (!id) continue;
    const piece = state.pieces[id];
    if (!piece || piece.owner === you) continue;
    hiddenIds.add(id);
    board[cloud.square] = null;
    delete pieces[id];
  }
  return { board, pieces, hiddenIds };
}

function redactFogEvents(events: GameEvent[], hiddenIds: Set<string>, state: GameState, you: Color): GameEvent[] {
  return events.map((e) => {
    if (e.type === 'manaGained') {
      return {
        ...e,
        pieces: e.pieces.filter((p) => {
          if (!isStormed(state, p.square)) return true;
          const id = state.board[p.square];
          const piece = id ? state.pieces[id] : undefined;
          return piece?.owner === you;
        }),
      };
    }
    if (e.type === 'destroyed' && hiddenIds.has(e.pieceId)) {
      return { ...e, kind: 'hidden', pieceId: 'hidden' };
    }
    if (e.type === 'moved' && hiddenIds.has(e.pieceId)) {
      return { ...e, pieceId: 'hidden' };
    }
    if (e.type === 'attacked' && (hiddenIds.has(e.attackerId) || hiddenIds.has(e.targetId))) {
      return {
        ...e,
        attackerId: hiddenIds.has(e.attackerId) ? 'hidden' : e.attackerId,
        targetId: hiddenIds.has(e.targetId) ? 'hidden' : e.targetId,
      };
    }
    return e;
  });
}

export function viewFor(state: GameState, you: Color, opts?: ViewOptions): PlayerView {
  const side = (c: Color): PlayerViewSide => {
    const p = state.players[c];
    return {
      turnsTaken: p.turnsTaken,
      pendingDraws: p.pendingDraws,
      deckCount: p.deck.length,
      handCount: p.hand.length,
      hand: c === you || opts?.openHands ? p.hand : null,
      graveyard: p.graveyard,
      mana: p.mana,
      manaIncome: manaIncome(state, c),
    };
  };
  const fog = opts?.sandbox
    ? { board: state.board, pieces: state.pieces, hiddenIds: new Set<string>() }
    : hideEnemyStormOccupants(state, you);
  return {
    you,
    turn: state.turn,
    ply: state.ply,
    seq: state.seq,
    status: state.status,
    turnInfo: state.turnInfo,
    phase: state.players[state.turn].pendingDraws > 0 ? 'draw' : 'main',
    rules: state.rules,
    board: fog.board,
    pieces: fog.pieces,
    enPassant: state.enPassant,
    players: { white: side('white'), black: side('black') },
    events: opts?.sandbox ? state.events : redactFogEvents(state.events, fog.hiddenIds, state, you),
    inCheck: !opts?.sandbox && state.status.kind === 'playing' && isInCheck(state, state.turn),
    legalActions: opts?.sandbox || state.turn !== you ? [] : legalActions(state, you),
    pendingGrant: state.pendingGrant ?? null,
    storms: (state.storms ?? []).map((c) => ({ square: c.square, turnsRemaining: c.turnsRemaining })),
  };
}
