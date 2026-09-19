import type { CardInstance } from './cards/types.js';
import { isInCheck } from './movement.js';
import { legalActions } from './rules.js';
import { manaIncome, type GameState, type RuleConstants, type TurnInfo, type TurnPhase } from './state.js';
import type { Action, Color, GameEvent, GameStatus, Piece, Square } from './types.js';

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
}

export interface ViewOptions {
  /** Show both hands face-up (testing arena). */
  openHands?: boolean;
  /** Skip check detection and legal-move lists. */
  sandbox?: boolean;
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
  return {
    you,
    turn: state.turn,
    ply: state.ply,
    seq: state.seq,
    status: state.status,
    turnInfo: state.turnInfo,
    phase: state.players[state.turn].pendingDraws > 0 ? 'draw' : 'main',
    rules: state.rules,
    board: state.board,
    pieces: state.pieces,
    enPassant: state.enPassant,
    players: { white: side('white'), black: side('black') },
    events: state.events,
    inCheck: !opts?.sandbox && state.status.kind === 'playing' && isInCheck(state, state.turn),
    legalActions: opts?.sandbox || state.turn !== you ? [] : legalActions(state, you),
  };
}
