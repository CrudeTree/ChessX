import { incomeFor, isActive, isInCheck, LAVA_COST, LAVA_TURNS, legalActions, SETUP_PIECES } from './engine.js';
import {
  opposite,
  type Ability,
  type Action,
  type Card,
  type CardInstance,
  type Color,
  type GameEvent,
  type GameState,
  type GameStatus,
  type MoveRule,
  type PieceDef,
  type Square,
} from './types.js';

/** What the server persists for a v2 game: the rules state plus what the last action did (for the log and replay). */
export interface GameRecord {
  state: GameState;
  /** Bumped on every change, including resignations and timeouts. */
  seq: number;
  /** Events produced by the most recent action. */
  events: GameEvent[];
  /**
   * The events of every action so far, oldest first, so the whole log can be shown when a game is opened again
   * (Djabooty, 2026-10-11). Games saved before it began keep only what happened since.
   */
  history?: GameEvent[][];
}

/** What spells can teach a piece, for the card viewer and the rules. */
export const ABILITIES: Record<Ability, { name: string; text: string }> = {
  lavaBreath: {
    name: 'Lava Breath',
    text: `Once a turn, spend ${LAVA_COST} mana to spit lava onto an empty square this piece could move to. No piece can move onto it or be summoned onto it until the other player has taken ${LAVA_TURNS} more turns.`,
  },
};

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
  /** The card's type (Warrior, Mage, Paladin, Dragon, Beast, Zealot); for a spell, the type it is made for. */
  tribe?: string;
  /** Pieces: printed under how it moves, for a piece that does more (the Initiate's any path). */
  abilityText?: string;
  /** Pieces: any level-2 card can be played onto it (the Initiate). */
  anyPath?: boolean;
  /** Spells: the ability it teaches a piece. */
  grants?: Ability;
  /** The longer rules for the card viewer. */
  detail?: string;
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
  /** Abilities spells taught it. */
  abilities?: Ability[];
}

export interface ViewLava {
  square: Square;
  /** Who made it. */
  by: Color;
  /** Turns of the other player it still blocks, counting the one being played. */
  turnsLeft: number;
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
  lava: ViewLava[];
  setupDeployed: Record<Color, number>;
  setupTotal: number;
  actionTaken: boolean;
  cardPlayed: boolean;
  /** The side to move pitched a card this turn. */
  pitched: boolean;
  /** Mana each side's next turn brings (the side to move: the turn it is playing). */
  income: Record<Color, number>;
  inCheck: boolean;
  /** Legal actions for the side to move when it is you (or both sides, in a practice game). */
  legalActions: Action[];
  /** Every card that appears in this game. */
  cards: Record<string, ViewCard>;
  /** Every action's events so far, oldest first; sent when asked for (`ViewOptions.history`). */
  history?: GameEvent[][];
}

export interface ViewOptions {
  /** Practice game: one person plays both sides, so the viewer sees the side to move. */
  hotseat?: boolean;
  /** Include the whole game's events, for a player opening the game. */
  history?: boolean;
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

/**
 * "Steps", "Slides" and "Leaps" move and capture alike. A rule that only moves reads "Moves", one that only captures
 * "Captures", like a chess pawn's "moves forward, captures diagonally", so the card text stays short.
 */
function describeRule(rule: MoveRule): string {
  const where = SETS[sortKey(rule.dirs)] ?? `along ${rule.dirs.length} fixed direction${rule.dirs.length === 1 ? '' : 's'}`;
  const distance = rule.leap ? '' : rule.range >= 7 ? ', any distance' : rule.range === 1 ? ', 1 square' : `, up to ${rule.range} squares`;
  if (rule.mode === 'move') return `Moves ${where}${distance}`;
  if (rule.mode === 'capture') return `Captures ${where}${distance}`;
  const verb = rule.leap ? 'Leaps' : rule.range === 1 ? 'Steps' : 'Slides';
  return `${verb} ${where}${distance}`;
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
  if (card.tribe) out.tribe = card.tribe;
  if (card.detail) out.detail = card.detail;
  if (card.type === 'piece') {
    if (card.boardArt) out.boardArt = card.boardArt;
    if (card.darkBoardArt) out.darkBoardArt = card.darkBoardArt;
    if (card.evolvesFrom) out.evolvesFrom = card.evolvesFrom;
    if (card.line) out.line = card.line;
    if (card.level) out.level = card.level;
    if (card.abilityText) out.abilityText = card.abilityText;
    if (card.anyPath) out.anyPath = true;
  } else if (card.effect.kind === 'grant') {
    out.grants = card.effect.ability;
  }
  return out;
}

/** Turns of `by`'s opponent a lava square still blocks, counting the one being played. */
function lavaTurnsLeft(state: GameState, by: Color, untilTurn: number): number {
  const other = opposite(by);
  return untilTurn - state.turns[other] + (state.active === other ? 1 : 0);
}

export function viewFor(record: GameRecord, you: Color, opts: ViewOptions = {}): PlayerView {
  const { state } = record;
  const viewer: Color = opts.hotseat ? state.active : you;
  const playing = state.status.kind === 'playing';
  const nextTurn = (color: Color) => state.turns[color] + (state.active === color ? 0 : 1);
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
      ...(p.abilities?.length ? { abilities: p.abilities } : {}),
    })),
    seals: state.seals.map((s) => ({ id: s.id, owner: s.owner, square: s.square, cardId: s.card.id, timer: s.timer })),
    lava: (state.lava ?? []).map((l) => ({ square: l.square, by: l.by, turnsLeft: lavaTurnsLeft(state, l.by, l.untilTurn) })),
    setupDeployed: state.setupDeployed,
    setupTotal: SETUP_PIECES,
    actionTaken: state.actionTaken,
    cardPlayed: state.cardPlayed === true,
    pitched: state.pitched === true,
    income: { white: incomeFor(nextTurn('white')), black: incomeFor(nextTurn('black')) },
    inCheck: playing && state.phase === 'play' && isInCheck(state, state.active),
    legalActions: playing && state.active === viewer ? legalActions(state) : [],
    cards: Object.fromEntries(Object.values(state.catalog).map((c) => [c.id, viewCard(c)])),
    ...(opts.history ? { history: record.history ?? (record.events.length ? [record.events] : []) } : {}),
  };
}

/** The record after an action: its events become the latest, and are added to the game's history. */
export function nextRecord(record: GameRecord, state: GameState, events: GameEvent[]): GameRecord {
  const before = record.history ?? (record.events.length ? [record.events] : []);
  return { state, seq: record.seq + 1, events, history: [...before, events] };
}
