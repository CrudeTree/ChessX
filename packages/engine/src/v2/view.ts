import { isActive, isInCheck, legalActions, SETUP_PIECES } from './engine.js';
import type {
  Action,
  Card,
  CardInstance,
  Color,
  GameEvent,
  GameState,
  GameStatus,
  MoveRule,
  PieceDef,
  Square,
} from './types.js';

/** What the server persists for a v2 game: the rules state plus what the last action did (for the log and replay). */
export interface GameRecord {
  state: GameState;
  /** Bumped on every change, including resignations and timeouts. */
  seq: number;
  /** Events produced by the most recent action. */
  events: GameEvent[];
}

/** A card as the client needs to draw it. */
export interface ViewCard {
  id: string;
  type: 'piece' | 'spell';
  name: string;
  cost: number;
  /** Pieces: owner turns a seal made from this card waits before it hatches. */
  sealTimer?: number;
  /** Pieces: how it moves, in words. Spells: what it does. */
  text: string;
  /** Pieces: the move rules behind `text`, so the client can draw them. */
  rules?: ReadonlyArray<MoveRule>;
  /** Card face picture, when the card has one. */
  art?: string;
  /** Pieces: picture for the board token, when the card has one. */
  boardArt?: string;
  /** Black's face of the card, when it has one; draw a copy through `faceArt` to get its owner's face. */
  darkArt?: string;
  darkBoardArt?: string;
  /** Pieces: the card this one evolves from; it can only be played onto a piece of that card. */
  evolvesFrom?: string;
  /** Pieces: the evolution line and the level in it, 1 to 3. */
  line?: string;
  level?: number;
}

export interface ViewPiece {
  id: string;
  owner: Color;
  kind: string;
  name: string;
  cardId: string | null;
  square: Square;
  king: boolean;
  /** False while the piece has summoning sickness: it cannot capture yet (it still gives check). */
  active: boolean;
  /** Summoned during its owner's current turn: it cannot move until the owner's next turn either. */
  justSummoned: boolean;
}

export interface ViewSeal {
  id: string;
  owner: Color;
  square: Square;
  cardId: string;
  timer: number;
}

export interface PlayerView {
  you: Color;
  active: Color;
  phase: 'setup' | 'play';
  status: GameStatus;
  seq: number;
  events: GameEvent[];
  turns: Record<Color, number>;
  mana: Record<Color, number>;
  /** Your own hand; null for the opponent. */
  hand: CardInstance[] | null;
  handCount: Record<Color, number>;
  deckCount: Record<Color, number>;
  /** Discard piles are public. */
  discard: Record<Color, CardInstance[]>;
  pieces: ViewPiece[];
  /** Seals are public, including the card they will hatch into. */
  seals: ViewSeal[];
  setupDeployed: Record<Color, number>;
  setupTotal: number;
  actionTaken: boolean;
  cardPlayed: boolean;
  inCheck: boolean;
  /** Legal actions for the side to move when it is you (or both sides, in a practice game). */
  legalActions: Action[];
  /** Every card that appears in this game. */
  cards: Record<string, ViewCard>;
}

export interface ViewOptions {
  /** Practice game: one person plays both sides, so the viewer sees the side to move. */
  hotseat?: boolean;
}

const sortKey = (dirs: ReadonlyArray<readonly [number, number]>): string =>
  dirs.map(([f, r]) => `${f},${r}`).sort().join(' ');

const SETS: Record<string, string> = {
  [sortKey([[1, 0], [-1, 0], [0, 1], [0, -1]])]: 'straight',
  [sortKey([[1, 1], [1, -1], [-1, 1], [-1, -1]])]: 'diagonally',
  [sortKey([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]])]: 'in any direction',
  [sortKey([[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]])]: 'like a knight',
  [sortKey([[0, 1]])]: 'forward',
  [sortKey([[1, 1], [-1, 1]])]: 'diagonally forward',
  [sortKey([[1, 2], [-1, 2], [2, 1], [-2, 1]])]: 'like a knight, forward only',
  [sortKey([[2, 0], [-2, 0], [0, 2], [0, -2]])]: '2 squares straight',
};

function describeRule(rule: MoveRule): string {
  const where = SETS[sortKey(rule.dirs)] ?? `along ${rule.dirs.length} fixed direction${rule.dirs.length === 1 ? '' : 's'}`;
  const reach = rule.leap ? `Leaps ${where}` : rule.range >= 7 ? `Slides ${where}, any distance` : rule.range === 1 ? `Steps ${where}, 1 square` : `Slides ${where}, up to ${rule.range} squares`;
  if (rule.mode === 'move') return `${reach} (cannot capture that way)`;
  if (rule.mode === 'capture') return `Captures ${where}${rule.leap ? '' : ', 1 square'} (cannot move there otherwise)`;
  return reach;
}

/** A short plain-English description of how a piece moves. */
export function describeMovement(def: PieceDef): string {
  return def.rules.map(describeRule).join('. ') + '.';
}

/** The pictures on `owner`'s copy of a card: Black gets the card's dark face when it has one. */
export function faceArt(
  card: Pick<ViewCard, 'art' | 'boardArt' | 'darkArt' | 'darkBoardArt'>,
  owner: Color,
): { art?: string; boardArt?: string } {
  if (owner === 'black') return { art: card.darkArt ?? card.art, boardArt: card.darkBoardArt ?? card.boardArt };
  return { art: card.art, boardArt: card.boardArt };
}

function viewCard(card: Card): ViewCard {
  const out: ViewCard =
    card.type === 'piece'
      ? {
          id: card.id,
          type: 'piece',
          name: card.name,
          cost: card.cost,
          // Evolution cards are never sealed, so their timer means nothing.
          ...(card.evolvesFrom ? {} : { sealTimer: card.sealTimer }),
          text: describeMovement(card.piece),
          rules: card.piece.rules,
        }
      : { id: card.id, type: 'spell', name: card.name, cost: card.cost, text: card.text };
  if (card.art) out.art = card.art;
  if (card.darkArt) out.darkArt = card.darkArt;
  if (card.type === 'piece') {
    if (card.boardArt) out.boardArt = card.boardArt;
    if (card.darkBoardArt) out.darkBoardArt = card.darkBoardArt;
    if (card.evolvesFrom) out.evolvesFrom = card.evolvesFrom;
    if (card.line) out.line = card.line;
    if (card.level) out.level = card.level;
  }
  return out;
}

export function viewFor(record: GameRecord, you: Color, opts: ViewOptions = {}): PlayerView {
  const { state } = record;
  const viewer: Color = opts.hotseat ? state.active : you;
  const playing = state.status.kind === 'playing';
  return {
    you: viewer,
    active: state.active,
    phase: state.phase,
    status: state.status,
    seq: record.seq,
    events: record.events,
    turns: state.turns,
    mana: state.mana,
    hand: state.hand[viewer],
    handCount: { white: state.hand.white.length, black: state.hand.black.length },
    deckCount: { white: state.deck.white.length, black: state.deck.black.length },
    discard: state.discard,
    pieces: state.pieces.map((p) => ({
      id: p.id,
      owner: p.owner,
      kind: p.def.kind,
      name: p.def.name,
      cardId: p.cardId,
      square: p.square,
      king: !!p.def.king,
      active: isActive(state, p),
      justSummoned: p.summonedOnTurn === state.turns[p.owner],
    })),
    seals: state.seals.map((s) => ({ id: s.id, owner: s.owner, square: s.square, cardId: s.card.id, timer: s.timer })),
    setupDeployed: state.setupDeployed,
    setupTotal: SETUP_PIECES,
    actionTaken: state.actionTaken,
    cardPlayed: state.cardPlayed === true,
    inCheck: playing && state.phase === 'play' && isInCheck(state, state.active),
    legalActions: playing && state.active === viewer ? legalActions(state) : [],
    cards: Object.fromEntries(Object.values(state.catalog).map((c) => [c.id, viewCard(c)])),
  };
}
