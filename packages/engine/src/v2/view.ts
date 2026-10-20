import {
  applyLegalAction,
  applyTrustedAction,
  cloneState,
  incomeCap,
  incomeFor,
  isActive,
  isFrozen,
  isInCheck,
  isShielded,
  LAVA_COST,
  LAVA_TURNS,
  legalActions,
  newGame,
  SETUP_PIECES,
  shrinesHeld,
} from './engine.js';
import { RNG_STEP } from './rng.js';
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
  type SpellEffect,
  type Square,
} from './types.js';

/** One step of a game: an action, or the game ending without one (a resignation or a timeout). */
export type Step = Action | { type: 'end'; status: GameStatus };

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
  /**
   * The game as it began, without its cards (they never change during a game), and the step behind each entry of
   * `history`, so the game can be shown as it stood after any step (`stateAt`), for players looking back through it
   * (Djabooty, 2026-10-13). Games begun before they were kept lack them.
   */
  start?: Omit<GameState, 'catalog'>;
  steps?: Step[];
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
  /** Pieces: on the far row it becomes any piece card from the hand, for free (the Initiate). */
  promotes?: boolean;
  /** Spells: the ability it teaches a piece. */
  grants?: Ability;
  /** Spells: what it does, and for Resurrect and Smite the highest card cost it reaches. */
  spell?: SpellEffect['kind'];
  maxCost?: number;
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
  /** Under a Shield until its owner's next turn: it cannot be captured or targeted by enemy spells. */
  shielded?: boolean;
  /** Frozen for its owner's turn being played or the next one: it cannot move or capture then. */
  frozen?: boolean;
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
  /**
   * Mana each side's next turn brings (the side to move: the turn it is playing). With center squares: what the ones
   * each side holds now pay at the start of its next turn, if it still holds them.
   */
  income: Record<Color, number>;
  /** The most mana a turn of this game brings. */
  maxIncome: number;
  /** The center squares that pay their holder; missing in games begun before them, which have a turn income. */
  shrines?: Square[];
  inCheck: boolean;
  /** Legal actions for the side to move when it is you (or both sides, in a practice game). */
  legalActions: Action[];
  /** Every card that appears in this game. */
  cards: Record<string, ViewCard>;
  /** Every action's events so far, oldest first; sent when asked for (`ViewOptions.history`). */
  history?: GameEvent[][];
  /** How many steps the game can be looked back through (`viewAt`); missing for games begun before steps were kept. */
  steps?: number;
}

export interface ViewOptions {
  /** Practice game: one person plays both sides, so the viewer sees the side to move. */
  hotseat?: boolean;
  /** Include the whole game's events, for a player opening the game. */
  history?: boolean;
  /** An earlier position, being looked back at: nothing can be played in it. */
  past?: boolean;
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
  const first = rule.firstRange && rule.firstRange > rule.range ? ` (${rule.firstRange} on its first move)` : '';
  const distance =
    (rule.leap ? '' : rule.range >= 7 ? ', any distance' : rule.range === 1 ? ', 1 square' : `, up to ${rule.range} squares`) + first;
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
    if (card.piece.promotes) out.promotes = true;
  } else {
    out.spell = card.effect.kind;
    if (card.effect.kind === 'grant') out.grants = card.effect.ability;
    if (card.effect.kind === 'raise' || card.effect.kind === 'destroyPiece') out.maxCost = card.effect.maxCost;
  }
  return out;
}

/** Every card of a catalog as the client draws it, by id: a game's cards, or the Binder's. */
export function viewCards(catalog: Record<string, Card>): Record<string, ViewCard> {
  return Object.fromEntries(Object.values(catalog).map((c) => [c.id, viewCard(c)]));
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
  const income = (color: Color) =>
    state.shrines ? shrinesHeld(state, color).length : incomeFor(nextTurn(color), incomeCap(state));
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
      ...(isShielded(state, p) ? { shielded: true } : {}),
      ...(isFrozen(state, p) ? { frozen: true } : {}),
    })),
    seals: state.seals.map((s) => ({ id: s.id, owner: s.owner, square: s.square, cardId: s.card.id, timer: s.timer })),
    lava: (state.lava ?? []).map((l) => ({ square: l.square, by: l.by, turnsLeft: lavaTurnsLeft(state, l.by, l.untilTurn) })),
    setupDeployed: state.setupDeployed,
    setupTotal: SETUP_PIECES,
    actionTaken: state.actionTaken,
    cardPlayed: state.cardPlayed === true,
    pitched: state.pitched === true,
    income: { white: income('white'), black: income('black') },
    maxIncome: incomeCap(state),
    ...(state.shrines ? { shrines: state.shrines } : {}),
    inCheck: playing && state.phase === 'play' && isInCheck(state, state.active),
    legalActions: playing && !opts.past && state.active === viewer ? legalActions(state) : [],
    cards: viewCards(state.catalog),
    ...(opts.history ? { history: record.history ?? (record.events.length ? [record.events] : []) } : {}),
    ...(record.start && record.steps ? { steps: record.steps.length } : {}),
  };
}

/** A new game's record, which keeps its history and its steps from the start. */
export function newRecord(state: GameState): GameRecord {
  const { catalog, ...start } = cloneState(state);
  return { state, seq: 1, events: [], history: [], start, steps: [] };
}

/** The record after a step: its events become the latest, and are added to the game's history, and the step to its steps. */
export function nextRecord(record: GameRecord, state: GameState, events: GameEvent[], step?: Step): GameRecord {
  const before = record.history ?? (record.events.length ? [record.events] : []);
  const next: GameRecord = { state, seq: record.seq + 1, events, history: [...before, events] };
  // Steps go on only beside a history that began with them, so the two always match.
  if (record.start && record.steps && step && record.steps.length === before.length) {
    next.start = record.start;
    next.steps = [...record.steps, step];
  }
  return next;
}

/**
 * The game as it stood after the first `step` steps of its record (0: as it began), or null when the record cannot
 * show it: begun before steps were kept, or a step the rules no longer allow. `known` holds the states worked out so
 * far, from the start, and is added to, so a player stepping back through a game replays each step only once.
 */
export function stateAt(record: GameRecord, step: number, known: GameState[] = []): GameState | null {
  const { start, steps } = record;
  if (!start || !steps || !Number.isInteger(step) || step < 0 || step > steps.length) return null;
  if (!known.length) known.push({ ...start, catalog: record.state.catalog });
  while (known.length <= step) {
    const state = known[known.length - 1]!;
    const next = steps[known.length - 1]!;
    try {
      known.push(next.type === 'end' ? { ...state, status: next.status } : applyLegalAction(state, next).state);
    } catch {
      return null;
    }
  }
  return known[step]!;
}

/** `you`'s view of the game as it stood after `step` steps (see `stateAt`), with what that step did as its events. */
export function viewAt(record: GameRecord, step: number, you: Color, hotseat = false, known?: GameState[]): PlayerView | null {
  const state = stateAt(record, step, known);
  if (!state) return null;
  return viewFor({ state, seq: record.seq, events: record.history?.[step - 1] ?? [] }, you, { hotseat, past: true });
}

/** How many steps `rebuildSteps` may try for a game, some of them again after a wrong turn. */
const REBUILD_TRIES = 5000;

/**
 * A record kept before its steps were (games begun before 2026-10-13), with them worked out again from its history,
 * or null where that cannot be done. The game began as `decks` shuffled with a seed that its random numbers, drawn
 * only for that shuffle, give away; each step is the legal action that does what that entry of the history tells.
 * It is only taken when playing them comes to the game as it is, so a history that began late, or a deck or rules
 * that have changed since, leave the game as it was, without steps.
 */
export function rebuildSteps(record: GameRecord, decks: Record<Color, string[]>): GameRecord | null {
  const { history, state: end } = record;
  if (record.steps || !history) return null;
  try {
    const rolls = Math.max(0, decks.white.length - 1) + Math.max(0, decks.black.length - 1);
    const shrines = end.shrines !== undefined;
    const begun = newGame({ seed: (end.rng - Math.imul(RNG_STEP, rolls)) | 0, decks, catalog: end.catalog, shrines });
    // The income cap the game began with (none, before 2026-10-17); the first turn's income is the same either way.
    if (!shrines) begun.maxIncome = end.maxIncome;
    // A card still held or in the deck at the end was never played.
    const kept = new Set([...end.hand.white, ...end.hand.black, ...end.deck.white, ...end.deck.black].map((c) => c.uid));
    // Two copies of a card in hand do the same, and only a discard pile tells them apart afterwards: the copy that
    // lies lower in it was most likely played first. A wrong guess shows at the end, and the other is tried then.
    const discarded = new Map<string, number>();
    for (const pile of [end.discard.white, end.discard.black]) pile.forEach((c, i) => discarded.set(c.uid, i));
    const rank = (step: Step) => ('cardUid' in step ? (discarded.get(step.cardUid) ?? Infinity) : 0);
    const steps: Step[] = [];
    let tries = REBUILD_TRIES;
    const walk = (state: GameState, at: number): boolean => {
      if (at === history.length) return sameValue({ ...state, catalog: null }, { ...end, catalog: null });
      const found = [...stepsDoing(state, history[at]!, kept)].sort(([a], [b]) => rank(a) - rank(b) || 0);
      for (const [step, next] of found) {
        if (--tries < 0) return false;
        steps.push(step);
        if (walk(next, at + 1)) return true;
        steps.pop();
      }
      return false;
    };
    if (!walk(begun, 0)) return null;
    const { catalog, ...start } = begun;
    return { ...record, start, steps };
  } catch {
    return null;
  }
}

/** The steps from `state` whose events are `events` (which may lack fields added to events since), with where each leads. */
function* stepsDoing(state: GameState, events: GameEvent[], kept: Set<string>): Generator<[Step, GameState]> {
  const only = events.length === 1 ? events[0]! : null;
  if (only?.type === 'gameOver' && (only.status.kind === 'resigned' || only.status.kind === 'timeout')) {
    yield [{ type: 'end', status: only.status }, { ...state, status: only.status }];
    return;
  }
  for (const action of legalActions(state)) {
    if ('cardUid' in action && kept.has(action.cardUid)) continue;
    if (!events.some((e) => shows(action, e)) && (action.type !== 'endTurn' || events.some((e) => DONE_BY.has(e.type)))) continue;
    const result = applyTrustedAction(state, action);
    if (result.events.length === events.length && events.every((e, i) => Object.entries(e).every(([k, v]) => sameValue(v, (result.events[i] as Record<string, unknown>)[k])))) {
      yield [action, result.state];
    }
  }
}

/** Events that an action other than End turn always leaves. */
const DONE_BY = new Set<GameEvent['type']>(['deployed', 'moved', 'summoned', 'sealed', 'evolved', 'spellPlayed', 'pitched', 'lava']);

/** Whether `e` is the event that `action` leaves, as far as can be told without playing it. */
function shows(action: Action, e: GameEvent): boolean {
  switch (action.type) {
    case 'deploy':
      return e.type === 'deployed' && e.square === action.to;
    case 'move':
      return e.type === 'moved' && e.from === action.from && e.to === action.to;
    case 'summon':
      return e.type === 'summoned' && e.square === action.to;
    case 'seal':
      return e.type === 'sealed' && e.square === action.target;
    case 'evolve':
      return e.type === 'evolved' && e.square === action.target;
    case 'spell':
      return e.type === 'spellPlayed' && e.target === action.target;
    case 'pitch':
      return e.type === 'pitched';
    case 'lava':
      return e.type === 'lava' && e.from === action.from && e.square === action.to;
    case 'endTurn':
      return false;
  }
}

/** Deep equality that ignores key order and keys left undefined. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameValue(x, (b as unknown[])[i]));
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((k) => sameValue(x[k], y[k]));
}
