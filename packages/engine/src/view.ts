import type { CardInstance } from './cards/types.js';
import { isInCheck } from './movement.js';
import { legalActions } from './rules.js';
import type { GameState, RuleConstants } from './state.js';
import type { Action, Color, GameEvent, GameStatus, Piece, Square } from './types.js';

export interface PlayerViewSide {
  turnsTaken: number;
  deckCount: number;
  handCount: number;
  /** Your own hand; null for the opponent. */
  hand: CardInstance[] | null;
  graveyard: CardInstance[];
}

/** What one player is allowed to know about the game. */
export interface PlayerView {
  you: Color;
  turn: Color;
  ply: number;
  status: GameStatus;
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

export function viewFor(state: GameState, you: Color): PlayerView {
  const side = (c: Color): PlayerViewSide => {
    const p = state.players[c];
    return {
      turnsTaken: p.turnsTaken,
      deckCount: p.deck.length,
      handCount: p.hand.length,
      hand: c === you ? p.hand : null,
      graveyard: p.graveyard,
    };
  };
  return {
    you,
    turn: state.turn,
    ply: state.ply,
    status: state.status,
    rules: state.rules,
    board: state.board,
    pieces: state.pieces,
    enPassant: state.enPassant,
    players: { white: side('white'), black: side('black') },
    events: state.events,
    inCheck: state.status.kind === 'playing' && isInCheck(state, state.turn),
    legalActions: state.turn === you ? legalActions(state, you) : [],
  };
}
