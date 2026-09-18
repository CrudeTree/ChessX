import type { CardInstance } from './cards/types.js';
import { hasCard } from './cards/registry.js';
import { getPieceDef } from './pieces.js';
import { shuffleInPlace } from './rng.js';
import type { Color, GameEvent, GameStatus, Piece, Square } from './types.js';
import { sq } from './types.js';

export interface RuleConstants {
  deckSize: number;
  openingHand: number;
  /** Draw 1 card at the start of every Nth turn a player takes (5th, 10th, 15th...). */
  drawEvery: number;
  maxCopies: number;
}

export const DEFAULT_RULES: RuleConstants = {
  deckSize: 30,
  openingHand: 7,
  drawEvery: 5,
  maxCopies: 3,
};

export interface PlayerState {
  color: Color;
  deck: CardInstance[];
  hand: CardInstance[];
  graveyard: CardInstance[];
  /** Number of turns this player has started, including the current one. */
  turnsTaken: number;
  /** Draws owed by the timer. While > 0 the player's only legal action is `draw`. */
  pendingDraws: number;
}

export interface GameState {
  rules: RuleConstants;
  pieces: Record<string, Piece>;
  /** 64 entries; pieceId or null. */
  board: (string | null)[];
  players: Record<Color, PlayerState>;
  turn: Color;
  /** Half-moves played so far. */
  ply: number;
  /** Number of actions applied so far (including draws, which do not advance the ply). */
  seq: number;
  /** Square a pawn may capture onto via en passant this turn, if any. */
  enPassant: Square | null;
  status: GameStatus;
  nextId: number;
  rngState: number;
  /** Events produced by the most recent action. */
  events: GameEvent[];
}

export interface GameConfig {
  decks: Record<Color, string[]>;
  seed?: number;
  rules?: Partial<RuleConstants>;
}

export function validateDeck(deck: string[], rules: RuleConstants = DEFAULT_RULES): string[] {
  const problems: string[] = [];
  if (deck.length !== rules.deckSize) {
    problems.push(`Deck must have exactly ${rules.deckSize} cards (has ${deck.length}).`);
  }
  const counts = new Map<string, number>();
  for (const id of deck) {
    if (!hasCard(id)) {
      problems.push(`Unknown card: ${id}`);
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    if (n > rules.maxCopies) problems.push(`Too many copies of ${id}: ${n} (max ${rules.maxCopies}).`);
  }
  return problems;
}

export function createGame(config: GameConfig): GameState {
  const rules = { ...DEFAULT_RULES, ...config.rules };
  for (const color of ['white', 'black'] as Color[]) {
    const problems = validateDeck(config.decks[color], rules);
    if (problems.length) throw new Error(`${color} deck invalid: ${problems.join(' ')}`);
  }

  const state: GameState = {
    rules,
    pieces: {},
    board: new Array<string | null>(64).fill(null),
    players: {
      white: { color: 'white', deck: [], hand: [], graveyard: [], turnsTaken: 1, pendingDraws: 0 },
      black: { color: 'black', deck: [], hand: [], graveyard: [], turnsTaken: 0, pendingDraws: 0 },
    },
    turn: 'white',
    ply: 0,
    seq: 0,
    enPassant: null,
    status: { kind: 'playing' },
    nextId: 1,
    rngState: (config.seed ?? Date.now()) | 0,
    events: [],
  };

  setupStandardBoard(state);

  for (const color of ['white', 'black'] as Color[]) {
    const player = state.players[color];
    player.deck = config.decks[color].map((cardId) => ({
      instanceId: `c${state.nextId++}`,
      cardId,
    }));
    shuffleInPlace(player.deck, state);
    drawCards(state, color, rules.openingHand);
  }
  state.events = [];
  return state;
}

export function addPiece(state: GameState, kind: string, owner: Color, square: Square, hasMoved = false): Piece {
  const def = getPieceDef(kind);
  const piece: Piece = {
    id: `p${state.nextId++}`,
    kind,
    owner,
    square,
    atk: def.atk,
    def: def.def,
    maxDef: def.def,
    hp: def.hp,
    maxHp: def.hp,
    hasMoved,
    stance: 'attack',
  };
  state.pieces[piece.id] = piece;
  state.board[square] = piece.id;
  return piece;
}

function setupStandardBoard(state: GameState): void {
  const backRank = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
  for (let f = 0; f < 8; f++) {
    addPiece(state, backRank[f]!, 'white', sq(f, 0));
    addPiece(state, 'pawn', 'white', sq(f, 1));
    addPiece(state, 'pawn', 'black', sq(f, 6));
    addPiece(state, backRank[f]!, 'black', sq(f, 7));
  }
}

export function drawCards(state: GameState, color: Color, count: number): number {
  const player = state.players[color];
  let drawn = 0;
  while (drawn < count && player.deck.length > 0) {
    player.hand.push(player.deck.shift()!);
    drawn++;
  }
  if (drawn > 0) state.events.push({ type: 'drew', color, count: drawn });
  return drawn;
}

export function pieceAt(state: GameState, square: Square): Piece | undefined {
  const id = state.board[square];
  return id ? state.pieces[id] : undefined;
}

export function piecesOf(state: GameState, color: Color): Piece[] {
  return Object.values(state.pieces).filter((p) => p.owner === color);
}

export function findKing(state: GameState, color: Color): Piece | undefined {
  return Object.values(state.pieces).find((p) => p.owner === color && p.kind === 'king');
}

/** Deep copy. Hand-rolled because it runs many times per legality check. */
export function cloneState(state: GameState): GameState {
  const pieces: Record<string, Piece> = {};
  for (const id in state.pieces) {
    const p = state.pieces[id]!;
    pieces[id] = { ...p, summon: p.summon ? { ...p.summon } : undefined };
  }
  const clonePlayer = (p: PlayerState): PlayerState => ({
    color: p.color,
    deck: p.deck.slice(),
    hand: p.hand.slice(),
    graveyard: p.graveyard.slice(),
    turnsTaken: p.turnsTaken,
    pendingDraws: p.pendingDraws,
  });
  return {
    rules: state.rules,
    pieces,
    board: state.board.slice(),
    players: { white: clonePlayer(state.players.white), black: clonePlayer(state.players.black) },
    turn: state.turn,
    ply: state.ply,
    seq: state.seq,
    enPassant: state.enPassant,
    status: state.status,
    nextId: state.nextId,
    rngState: state.rngState,
    events: state.events.slice(),
  };
}
