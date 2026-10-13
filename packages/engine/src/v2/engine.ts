import { KING, STARTER_CATALOG } from './catalog.js';
import { nextRandom } from './rng.js';
import {
  FILES,
  backRank,
  forward,
  fileOf,
  inBounds,
  opposite,
  rankOf,
  sq,
  type Action,
  type Card,
  type CardInstance,
  type Color,
  type GameEvent,
  type GameState,
  type Lava,
  type Piece,
  type PieceCard,
  type Seal,
  type SpellEffect,
  type Square,
} from './types.js';

export const HAND_SIZE = 3;
export const START_MANA = 2;
/** Deploy phase of games saved before the 2026-10-08 setup ruling; new games skip it. */
export const SETUP_PIECES = 3;
export const KING_FILE = 3;
/** Mana a Lava Breath costs, and how many turns of the other player its lava lasts (Djabooty, 2026-10-11). */
export const LAVA_COST = 1;
export const LAVA_TURNS = 2;
/** Mana for pitching a card from your hand, once a turn (Djabooty, 2026-10-11). */
export const PITCH_MANA = 1;

/**
 * The mana a player's turn brings (Djabooty, 2026-10-11): +1 on their turns 1 to 5, +2 on 6 to 10, +3 on 11 to 15
 * and +4 after that, so the opening stays as it was and the big cards come within reach later.
 */
export function incomeFor(turn: number): number {
  return Math.min(4, 1 + Math.floor((Math.max(turn, 1) - 1) / 5));
}

/** Mana for capturing a piece: half its card's cost, rounded up (Djabooty, 2026-10-11). */
export function bountyFor(card: Card | undefined): number {
  return card ? Math.ceil(card.cost / 2) : 0;
}

export interface NewGameOptions {
  seed: number;
  decks: Record<Color, string[]>;
  catalog?: Record<string, Card>;
}

const COLORS: Color[] = ['white', 'black'];

/**
 * Copy of a state for look-ahead. Runs for every candidate action when legal moves are
 * computed, so it is hand-rolled: cards, piece definitions and the catalog are immutable
 * and shared; everything the rules mutate is copied.
 */
export function cloneState(state: GameState): GameState {
  return {
    ...state,
    turns: { ...state.turns },
    mana: { ...state.mana },
    hand: { white: state.hand.white.slice(), black: state.hand.black.slice() },
    deck: { white: state.deck.white.slice(), black: state.deck.black.slice() },
    discard: { white: state.discard.white.slice(), black: state.discard.black.slice() },
    pieces: state.pieces.map((p) => ({ ...p })),
    seals: state.seals.map((s) => ({ ...s })),
    lava: state.lava?.map((l) => ({ ...l })),
    setupDeployed: { ...state.setupDeployed },
  };
}

const clone = cloneState;

function newId(state: GameState, prefix: string): string {
  state.nextId += 1;
  return `${prefix}${state.nextId}`;
}

function shuffle<T>(state: GameState, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const roll = nextRandom(state.rng);
    state.rng = roll.state;
    const j = Math.floor(roll.value * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function draw(state: GameState, color: Color, count: number, events: GameEvent[]): void {
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const card = state.deck[color].shift();
    if (!card) break;
    state.hand[color].push(card);
    drawn += 1;
  }
  if (drawn > 0) events.push({ type: 'drew', color, count: drawn });
}

/** Files of the starting Initiates, on the rank in front of the King: c, d and e. */
export const START_FILES: readonly number[] = [2, 3, 4];

/**
 * Each side starts with 3 Initiates from outside the deck in front of the King (ruling by Djabooty,
 * 2026-10-08). They count as already on the board before the game began, so they can capture on turn 1.
 */
function placeStartingPieces(state: GameState, color: Color): void {
  const card = state.catalog.initiate;
  if (card?.type !== 'piece') return;
  for (const file of START_FILES) {
    state.pieces.push({
      id: newId(state, 'p'),
      owner: color,
      def: card.piece,
      cardId: card.id,
      square: sq(file, backRank(color) + forward(color)),
      activeFromTurn: 0,
    });
  }
}

export function newGame(options: NewGameOptions): GameState {
  const state: GameState = {
    catalog: options.catalog ?? STARTER_CATALOG,
    phase: 'play',
    active: 'white',
    turns: { white: 0, black: 0 },
    mana: { white: START_MANA, black: START_MANA },
    hand: { white: [], black: [] },
    deck: { white: [], black: [] },
    discard: { white: [], black: [] },
    pieces: [],
    seals: [],
    lava: [],
    setupDeployed: { white: 0, black: 0 },
    actionTaken: false,
    cardPlayed: false,
    status: { kind: 'playing' },
    nextId: 0,
    rng: options.seed | 0,
  };
  for (const color of COLORS) {
    const cards: CardInstance[] = options.decks[color].map((cardId) => {
      if (!state.catalog[cardId]) throw new Error(`Unknown card: ${cardId}`);
      return { uid: newId(state, 'c'), cardId };
    });
    state.deck[color] = shuffle(state, cards);
    state.pieces.push({
      id: newId(state, 'k'),
      owner: color,
      def: KING,
      cardId: null,
      square: sq(KING_FILE, backRank(color)),
      activeFromTurn: 0,
    });
    placeStartingPieces(state, color);
    draw(state, color, HAND_SIZE, []);
  }
  startTurn(state, 'white', []);
  return state;
}

// ---------------------------------------------------------------------------
// Board queries

export function pieceAt(state: GameState, square: Square): Piece | undefined {
  return state.pieces.find((p) => p.square === square);
}

export function sealAt(state: GameState, square: Square): Seal | undefined {
  return state.seals.find((s) => s.square === square);
}

function ownerAt(state: GameState, square: Square): Color | null {
  return pieceAt(state, square)?.owner ?? sealAt(state, square)?.owner ?? null;
}

export function lavaAt(state: GameState, square: Square): Lava | undefined {
  return state.lava?.find((l) => l.square === square);
}

/** A piece card's type; the starting Initiates and Kings have none. */
function tribeOf(state: GameState, piece: Piece): string | undefined {
  const card = piece.cardId ? state.catalog[piece.cardId] : undefined;
  return card?.type === 'piece' ? card.tribe : undefined;
}

/**
 * What playing evolution `card` onto `piece` costs, or null if it cannot go there. It goes onto the card it evolves
 * from for its printed cost. A level-2 card also goes onto a piece whose card takes any path (the Initiate), for its
 * cost plus the cost of the first level it skips (Djabooty, 2026-10-11).
 */
export function evolveCost(state: GameState, card: PieceCard, piece: Piece): number | null {
  if (!card.evolvesFrom || piece.def.king || !piece.cardId) return null;
  if (piece.cardId === card.evolvesFrom) return card.cost;
  const base = state.catalog[piece.cardId];
  const skipped = state.catalog[card.evolvesFrom];
  if (base?.type !== 'piece' || !base.anyPath || skipped?.type !== 'piece' || skipped.evolvesFrom) return null;
  return card.cost + skipped.cost;
}

export function isActive(state: GameState, piece: Piece): boolean {
  return state.turns[piece.owner] >= piece.activeFromTurn;
}

/** Under a Shield: until its owner's next turn it cannot be captured or targeted by enemy spells. */
export function isShielded(state: GameState, piece: Piece): boolean {
  return piece.shieldOnTurn !== undefined && piece.shieldOnTurn === state.turns[piece.owner];
}

/** Frozen for the owner's turn being played, or for its next one while the other side plays. */
export function isFrozen(state: GameState, piece: Piece): boolean {
  const ownerTurn = state.turns[piece.owner] + (state.active === piece.owner ? 0 : 1);
  return piece.frozenOnTurn !== undefined && piece.frozenOnTurn === ownerTurn;
}

export interface Reach {
  to: Square;
  mode: 'both' | 'move' | 'capture';
  occupant: Color | null;
}

/** Every square a piece's rules reach, stopping rays at the first piece or seal. */
export function reaches(state: GameState, piece: Piece): Reach[] {
  const out: Reach[] = [];
  const fwd = forward(piece.owner);
  const file = fileOf(piece.square);
  const rank = rankOf(piece.square);
  for (const rule of piece.def.rules) {
    const mode = rule.mode ?? 'both';
    for (const [df, dr0] of rule.dirs) {
      const dr = rule.relative ? dr0 * fwd : dr0;
      const steps = rule.leap ? 1 : rule.range;
      for (let step = 1; step <= steps; step++) {
        const f = file + df * step;
        const r = rank + dr * step;
        if (!inBounds(f, r)) break;
        const to = sq(f, r);
        const occupant = ownerAt(state, to);
        out.push({ to, mode, occupant });
        if (occupant !== null && !rule.leap) break;
      }
    }
  }
  return out;
}

/**
 * True if any piece of `by` reaches `square` with a capturing move. Pieces with summoning
 * sickness count too: they cannot capture yet, but they still attack, so they give check.
 */
export function isAttacked(state: GameState, square: Square, by: Color): boolean {
  for (const piece of state.pieces) {
    if (piece.owner !== by) continue;
    for (const reach of reaches(state, piece)) {
      if (reach.to === square && reach.mode !== 'move') return true;
    }
  }
  return false;
}

export function kingSquare(state: GameState, color: Color): Square {
  const king = state.pieces.find((p) => p.owner === color && p.def.king);
  if (!king) throw new Error(`${color} has no king`);
  return king.square;
}

export function isInCheck(state: GameState, color: Color): boolean {
  return isAttacked(state, kingSquare(state, color), opposite(color));
}

// ---------------------------------------------------------------------------
// Applying things (mutating a state the caller already cloned)

function removeFromHand(state: GameState, color: Color, uid: string): CardInstance {
  const index = state.hand[color].findIndex((c) => c.uid === uid);
  if (index < 0) throw new Error(`Card ${uid} is not in ${color}'s hand`);
  return state.hand[color].splice(index, 1)[0]!;
}

function pieceCard(state: GameState, cardId: string): PieceCard {
  const card = state.catalog[cardId];
  if (!card || card.type !== 'piece') throw new Error(`${cardId} is not a piece card`);
  return card;
}

/**
 * A piece leaving play puts its card on a discard pile, where Resurrect can find it (Djabooty, 2026-10-12): a captured
 * piece goes on its captor's pile, and one that was sacrificed, destroyed or evolved on its owner's. Kings have no card.
 */
function discardPiece(state: GameState, piece: Piece, pile: Color = piece.owner): void {
  if (piece.cardId) state.discard[pile].push({ uid: newId(state, 'c'), cardId: piece.cardId });
}

function capture(state: GameState, mover: Piece, to: Square, events: GameEvent[]): void {
  const victim = pieceAt(state, to);
  if (victim) {
    state.pieces = state.pieces.filter((p) => p.id !== victim.id);
    discardPiece(state, victim, mover.owner);
    const bounty = bountyFor(victim.cardId ? state.catalog[victim.cardId] : undefined);
    state.mana[mover.owner] += bounty;
    events.push({
      type: 'captured',
      pieceId: victim.id,
      by: mover.id,
      square: to,
      name: victim.def.name,
      owner: victim.owner,
      cardId: victim.cardId,
      bounty,
    });
    return;
  }
  const seal = sealAt(state, to);
  if (seal) {
    state.seals = state.seals.filter((s) => s.id !== seal.id);
    const instance: CardInstance = { uid: newId(state, 'c'), cardId: seal.card.id };
    state.discard[seal.owner].push(instance);
    events.push({ type: 'sealDestroyed', sealId: seal.id, by: mover.id, square: to, cardId: seal.card.id });
  }
}

function applyAction(state: GameState, action: Action, events: GameEvent[]): void {
  const color = state.active;
  switch (action.type) {
    case 'deploy': {
      const instance = removeFromHand(state, color, action.cardUid);
      const card = pieceCard(state, instance.cardId);
      const piece: Piece = {
        id: newId(state, 'p'),
        owner: color,
        def: card.piece,
        cardId: card.id,
        square: action.to,
        activeFromTurn: 0,
      };
      state.pieces.push(piece);
      state.setupDeployed[color] += 1;
      events.push({ type: 'deployed', color, pieceId: piece.id, square: piece.square, name: piece.def.name });
      return;
    }
    case 'move': {
      const piece = pieceAt(state, action.from);
      if (!piece) throw new Error('No piece to move');
      capture(state, piece, action.to, events);
      piece.square = action.to;
      state.actionTaken = true;
      events.push({ type: 'moved', pieceId: piece.id, from: action.from, to: action.to, name: piece.def.name, owner: piece.owner });
      return;
    }
    case 'summon': {
      const instance = removeFromHand(state, color, action.cardUid);
      const card = pieceCard(state, instance.cardId);
      state.mana[color] -= card.cost;
      const piece: Piece = {
        id: newId(state, 'p'),
        owner: color,
        def: card.piece,
        cardId: card.id,
        square: action.to,
        activeFromTurn: state.turns[color] + 1,
        summonedOnTurn: state.turns[color],
      };
      state.pieces.push(piece);
      state.cardPlayed = true;
      events.push({ type: 'summoned', color, pieceId: piece.id, square: piece.square, name: piece.def.name, cardId: card.id });
      return;
    }
    case 'seal': {
      const instance = removeFromHand(state, color, action.cardUid);
      const card = pieceCard(state, instance.cardId);
      state.mana[color] -= card.cost;
      const consumed = pieceAt(state, action.target);
      if (!consumed) throw new Error('No piece to seal');
      state.pieces = state.pieces.filter((p) => p.id !== consumed.id);
      discardPiece(state, consumed);
      const seal: Seal = { id: newId(state, 's'), owner: color, square: action.target, card, timer: card.sealTimer };
      state.seals.push(seal);
      state.cardPlayed = true;
      events.push({
        type: 'sealed',
        color,
        sealId: seal.id,
        square: seal.square,
        consumedPieceId: consumed.id,
        timer: seal.timer,
        consumedName: consumed.def.name,
        cardId: card.id,
      });
      return;
    }
    case 'evolve': {
      const instance = removeFromHand(state, color, action.cardUid);
      const card = pieceCard(state, instance.cardId);
      const old = pieceAt(state, action.target);
      if (!old) throw new Error('No piece to evolve');
      const cost = evolveCost(state, card, old);
      if (cost === null) throw new Error('Cannot evolve that piece');
      state.mana[color] -= cost;
      state.pieces = state.pieces.filter((p) => p.id !== old.id);
      discardPiece(state, old);
      // A new piece, so it waits like a summoned one: no move or capture until the owner's next turn (Djabooty, 2026-10-11).
      // What spells taught it stays with it, and so does a Shield.
      const piece: Piece = {
        id: newId(state, 'p'),
        owner: color,
        def: card.piece,
        cardId: card.id,
        square: action.target,
        activeFromTurn: state.turns[color] + 1,
        summonedOnTurn: state.turns[color],
        ...(old.abilities ? { abilities: old.abilities } : {}),
        ...(old.shieldOnTurn !== undefined ? { shieldOnTurn: old.shieldOnTurn } : {}),
      };
      state.pieces.push(piece);
      state.cardPlayed = true;
      events.push({
        type: 'evolved',
        color,
        pieceId: piece.id,
        fromPieceId: old.id,
        square: piece.square,
        name: piece.def.name,
        fromName: old.def.name,
        cardId: card.id,
        cost,
      });
      return;
    }
    case 'spell': {
      const instance = removeFromHand(state, color, action.cardUid);
      const card = state.catalog[instance.cardId];
      if (!card || card.type !== 'spell') throw new Error('Not a spell');
      state.mana[color] -= card.cost;
      state.discard[color].push(instance);
      state.cardPlayed = true;
      events.push({ type: 'spellPlayed', color, cardId: card.id, target: action.target });
      castSpell(state, card.id, card.effect, action, events);
      return;
    }
    case 'pitch': {
      const instance = removeFromHand(state, color, action.cardUid);
      state.discard[color].push(instance);
      state.mana[color] += PITCH_MANA;
      state.pitched = true;
      state.cardPlayed = true;
      events.push({ type: 'pitched', color, cardId: instance.cardId, mana: PITCH_MANA });
      return;
    }
    case 'lava': {
      const piece = pieceAt(state, action.from);
      if (!piece) throw new Error('No piece to breathe lava');
      state.mana[color] -= LAVA_COST;
      piece.lavaOnTurn = state.turns[color];
      state.lava = [...(state.lava ?? []), { square: action.to, by: color, untilTurn: state.turns[opposite(color)] + LAVA_TURNS }];
      state.cardPlayed = true;
      events.push({ type: 'lava', color, pieceId: piece.id, name: piece.def.name, from: action.from, square: action.to });
      return;
    }
    case 'endTurn': {
      endTurn(state, events);
      return;
    }
  }
}

type SpellAction = Extract<Action, { type: 'spell' }>;

function castSpell(state: GameState, cardId: string, effect: SpellEffect, action: SpellAction, events: GameEvent[]): void {
  const color = state.active;
  const target = action.target === undefined ? undefined : pieceAt(state, action.target);
  switch (effect.kind) {
    case 'draw':
      draw(state, color, effect.count, events);
      gainMana(state, color, effect.mana ?? 0, events);
      return;
    case 'mana':
      gainMana(state, color, effect.amount, events);
      return;
    case 'grant':
      if (!target) throw new Error('No piece to teach');
      target.abilities = [...(target.abilities ?? []), effect.ability];
      events.push({ type: 'learned', color, pieceId: target.id, name: target.def.name, square: target.square, ability: effect.ability });
      return;
    case 'shield':
      if (!target) throw new Error('No piece to shield');
      target.shieldOnTurn = state.turns[color];
      events.push({ type: 'shielded', color, pieceId: target.id, name: target.def.name, square: target.square });
      return;
    case 'freeze':
      if (!target) throw new Error('No piece to freeze');
      target.frozenOnTurn = state.turns[target.owner] + 1;
      events.push({ type: 'frozen', color, pieceId: target.id, name: target.def.name, square: target.square, owner: target.owner });
      return;
    case 'destroyPiece':
      if (!target) throw new Error('No piece to destroy');
      state.pieces = state.pieces.filter((p) => p.id !== target.id);
      discardPiece(state, target);
      events.push({
        type: 'destroyed',
        color,
        pieceId: target.id,
        name: target.def.name,
        square: target.square,
        owner: target.owner,
        cardId: target.cardId,
      });
      return;
    case 'raise':
      raise(state, action, events);
      return;
    case 'destroySeal': {
      const seal = action.target === undefined ? undefined : sealAt(state, action.target);
      if (!seal) return;
      state.seals = state.seals.filter((s) => s.id !== seal.id);
      state.discard[seal.owner].push({ uid: newId(state, 'c'), cardId: seal.card.id });
      events.push({ type: 'sealDestroyed', sealId: seal.id, by: cardId, square: seal.square, cardId: seal.card.id });
      return;
    }
  }
}

function gainMana(state: GameState, color: Color, mana: number, events: GameEvent[]): void {
  if (mana <= 0) return;
  state.mana[color] += mana;
  events.push({ type: 'manaGained', color, mana });
}

/** Resurrect: the picked card leaves the caster's discard pile and rises on the target square as their piece. */
function raise(state: GameState, action: SpellAction, events: GameEvent[]): void {
  const color = state.active;
  const instance = state.discard[color].find((i) => i.uid === action.pick);
  if (!instance || action.target === undefined) throw new Error('Nothing to raise');
  state.discard[color] = state.discard[color].filter((i) => i !== instance);
  const card = pieceCard(state, instance.cardId);
  const piece: Piece = {
    id: newId(state, 'p'),
    owner: color,
    def: card.piece,
    cardId: card.id,
    square: action.target,
    activeFromTurn: state.turns[color] + 1,
    summonedOnTurn: state.turns[color],
  };
  state.pieces.push(piece);
  events.push({ type: 'raised', color, pieceId: piece.id, name: piece.def.name, square: piece.square, cardId: card.id });
}

// ---------------------------------------------------------------------------
// Legal actions

function backRowSquares(color: Color): Square[] {
  return Array.from({ length: FILES }, (_, file) => sq(file, backRank(color)));
}

/** Where new pieces enter: your back row and the row in front of it (Djabooty, 2026-10-11). */
export function homeSquares(color: Color): Square[] {
  return [...backRowSquares(color), ...backRowSquares(color).map((s) => s + forward(color) * FILES)];
}

function handPieces(state: GameState, color: Color): { instance: CardInstance; card: PieceCard }[] {
  const out: { instance: CardInstance; card: PieceCard }[] = [];
  for (const instance of state.hand[color]) {
    const card = state.catalog[instance.cardId];
    if (card?.type === 'piece') out.push({ instance, card });
  }
  return out;
}

function tryAction(state: GameState, action: Action): GameState {
  const next = clone(state);
  applyAction(next, action, []);
  return next;
}

/** A pseudo-legal action is legal if it does not leave the mover's own King in check. */
function safe(state: GameState, action: Action): boolean {
  return !isInCheck(tryAction(state, action), state.active);
}

function deployActions(state: GameState): Action[] {
  const color = state.active;
  if (state.setupDeployed[color] >= SETUP_PIECES) return [];
  const free = backRowSquares(color).filter((s) => ownerAt(state, s) === null);
  const out: Action[] = [];
  for (const { instance, card } of handPieces(state, color)) {
    if (card.cost !== 0) continue;
    for (const to of free) out.push({ type: 'deploy', cardUid: instance.uid, to });
  }
  return out;
}

function moveActions(state: GameState): Action[] {
  const color = state.active;
  const out: Action[] = [];
  for (const piece of state.pieces) {
    if (piece.owner !== color || piece.summonedOnTurn === state.turns[color] || isFrozen(state, piece)) continue;
    const sick = !isActive(state, piece);
    for (const reach of reaches(state, piece)) {
      const empty = reach.occupant === null;
      const victim = reach.occupant === opposite(color) ? pieceAt(state, reach.to) : undefined;
      // A King is never taken, also when a spell (Smite, Dispel) opened a line onto it this turn: that is check.
      const enemy = reach.occupant === opposite(color) && !(victim && (isShielded(state, victim) || victim.def.king));
      const canMove = empty && reach.mode !== 'capture' && !lavaAt(state, reach.to);
      const canCapture = enemy && reach.mode !== 'move' && !sick;
      if (!canMove && !canCapture) continue;
      const action: Action = { type: 'move', from: piece.square, to: reach.to };
      if (safe(state, action)) out.push(action);
    }
  }
  return out;
}

function summonActions(state: GameState): Action[] {
  const color = state.active;
  const free = homeSquares(color).filter((s) => ownerAt(state, s) === null && !lavaAt(state, s));
  const out: Action[] = [];
  for (const { instance, card } of handPieces(state, color)) {
    if (card.evolvesFrom || card.cost > state.mana[color]) continue;
    for (const to of free) {
      const action: Action = { type: 'summon', cardUid: instance.uid, to };
      if (safe(state, action)) out.push(action);
    }
  }
  return out;
}

function sealActions(state: GameState): Action[] {
  const color = state.active;
  const targets = state.pieces.filter((p) => p.owner === color && !p.def.king);
  const out: Action[] = [];
  for (const { instance, card } of handPieces(state, color)) {
    if (card.evolvesFrom || card.cost > state.mana[color]) continue;
    for (const target of targets) {
      const action: Action = { type: 'seal', cardUid: instance.uid, target: target.square };
      if (safe(state, action)) out.push(action);
    }
  }
  return out;
}

/**
 * An evolution card goes onto one of your pieces of the card it evolves from, or, for a level-2 card, onto an
 * Initiate (see `evolveCost`). The piece must have been on the board since before this turn (no summoning sickness
 * left), so each step of a line gives the opponent a turn to answer (Djabooty, 2026-10-11).
 */
function evolveActions(state: GameState): Action[] {
  const color = state.active;
  const out: Action[] = [];
  for (const { instance, card } of handPieces(state, color)) {
    if (!card.evolvesFrom) continue;
    for (const piece of state.pieces) {
      if (piece.owner !== color || !isActive(state, piece)) continue;
      const cost = evolveCost(state, card, piece);
      if (cost === null || cost > state.mana[color]) continue;
      const action: Action = { type: 'evolve', cardUid: instance.uid, target: piece.square };
      if (safe(state, action)) out.push(action);
    }
  }
  return out;
}

/**
 * No spell is cast while your King is in check, not even one that would block it or remove the checking piece
 * (Djabooty, 2026-10-12). Enemy spells cannot touch a shielded piece, and no spell touches a King.
 */
function spellActions(state: GameState): Action[] {
  const color = state.active;
  if (isInCheck(state, color)) return [];
  const enemy = opposite(color);
  const out: Action[] = [];
  for (const instance of state.hand[color]) {
    const card = state.catalog[instance.cardId];
    if (card?.type !== 'spell' || card.cost > state.mana[color]) continue;
    const effect = card.effect;
    const onto = (pieces: Piece[]): Action[] =>
      pieces.map((p): Action => ({ type: 'spell', cardUid: instance.uid, target: p.square }));
    const own = state.pieces.filter((p) => p.owner === color && !p.def.king);
    const enemies = state.pieces.filter((p) => p.owner === enemy && !p.def.king && !isShielded(state, p));
    switch (effect.kind) {
      case 'destroySeal':
        for (const s of state.seals) {
          const action: Action = { type: 'spell', cardUid: instance.uid, target: s.square };
          if (safe(state, action)) out.push(action);
        }
        break;
      case 'grant':
        // Onto one of your pieces of the spell's type that does not know the ability yet.
        out.push(...onto(own.filter((p) => (!card.tribe || tribeOf(state, p) === card.tribe) && !p.abilities?.includes(effect.ability))));
        break;
      case 'shield':
        out.push(...onto(own.filter((p) => !isShielded(state, p))));
        break;
      case 'freeze':
        out.push(...onto(enemies.filter((p) => !isFrozen(state, p))));
        break;
      case 'destroyPiece':
        // Removing an enemy piece can open a line onto your own King, so this one is checked.
        for (const action of onto(enemies.filter((p) => p.cardId !== null && pieceCard(state, p.cardId).cost <= effect.maxCost))) {
          if (safe(state, action)) out.push(action);
        }
        break;
      case 'raise':
        out.push(...raiseActions(state, instance.uid, effect.maxCost));
        break;
      default:
        out.push({ type: 'spell', cardUid: instance.uid });
    }
  }
  return out;
}

/**
 * Resurrect: every piece card costing at most `maxCost` in your discard pile (the newest copy of each) onto every free
 * square of your first two rows.
 */
function raiseActions(state: GameState, cardUid: string, maxCost: number): Action[] {
  const color = state.active;
  const free = homeSquares(color).filter((s) => ownerAt(state, s) === null && !lavaAt(state, s));
  const out: Action[] = [];
  const seen = new Set<string>();
  for (const instance of [...state.discard[color]].reverse()) {
    const card = state.catalog[instance.cardId];
    if (card?.type !== 'piece' || card.cost > maxCost || seen.has(card.id)) continue;
    seen.add(card.id);
    for (const to of free) out.push({ type: 'spell', cardUid, target: to, pick: instance.uid });
  }
  return out;
}

/** Once a turn, any card in hand can be discarded for mana; never while in check, since it answers nothing. */
function pitchActions(state: GameState): Action[] {
  const color = state.active;
  if (state.pitched || isInCheck(state, color)) return [];
  return state.hand[color].map((c): Action => ({ type: 'pitch', cardUid: c.uid }));
}

/**
 * A piece with Lava Breath that was on the board before this turn spits lava, once a turn, onto an empty square it
 * could move to. Lava neither blocks nor makes an attack, so it never answers a check.
 */
function lavaActions(state: GameState): Action[] {
  const color = state.active;
  if (state.mana[color] < LAVA_COST || isInCheck(state, color)) return [];
  const turn = state.turns[color];
  const out: Action[] = [];
  for (const piece of state.pieces) {
    if (piece.owner !== color || !piece.abilities?.includes('lavaBreath')) continue;
    if (piece.summonedOnTurn === turn || piece.lavaOnTurn === turn) continue;
    const seen = new Set<Square>();
    for (const reach of reaches(state, piece)) {
      if (reach.occupant !== null || reach.mode === 'capture' || seen.has(reach.to) || lavaAt(state, reach.to)) continue;
      seen.add(reach.to);
      out.push({ type: 'lava', from: piece.square, to: reach.to });
    }
  }
  return out;
}

function cardActions(state: GameState): Action[] {
  return [
    ...summonActions(state),
    ...sealActions(state),
    ...evolveActions(state),
    ...spellActions(state),
    ...pitchActions(state),
    ...lavaActions(state),
  ];
}

/**
 * A turn is: play any cards the mana pays for (summon, seal, evolve, spell, pitch, lava), then move a piece, and the
 * move ends the turn (Djabooty, 2026-10-10). Nothing may leave your own King in check, so a King in check is answered
 * first, by a move or by a summon that blocks; no spell can do it. End turn closes a turn only when no move is left,
 * and only after a card, so there is still no pass. `actionTaken` is a game saved while an older rule kept the
 * turn open after the action.
 */
export function legalActions(state: GameState): Action[] {
  if (state.status.kind !== 'playing') return [];
  if (state.phase === 'setup') return deployActions(state);
  if (state.actionTaken) return [{ type: 'endTurn' }];
  const moves = moveActions(state);
  const out = [...moves, ...cardActions(state)];
  if (moves.length === 0 && state.cardPlayed) out.push({ type: 'endTurn' });
  return out;
}

const ENDS_TURN: ReadonlySet<Action['type']> = new Set(['move']);

// ---------------------------------------------------------------------------
// Turn flow

function startTurn(state: GameState, color: Color, events: GameEvent[]): void {
  state.active = color;
  state.turns[color] += 1;
  const income = incomeFor(state.turns[color]);
  state.mana[color] += income;
  state.actionTaken = false;
  state.cardPlayed = false;
  state.pitched = false;
  events.push({ type: 'turnStarted', color, turn: state.turns[color], mana: state.mana[color], income });
  draw(state, color, 1, events);

  // Lava cools once the other player has taken its turns: at the start of the turn of the side that made it.
  for (const lava of state.lava ?? []) {
    if (lava.by !== color || state.turns[opposite(color)] < lava.untilTurn) continue;
    state.lava = state.lava!.filter((l) => l !== lava);
    events.push({ type: 'lavaCooled', square: lava.square });
  }

  for (const seal of state.seals.filter((s) => s.owner === color)) {
    seal.timer -= 1;
    events.push({ type: 'sealTick', sealId: seal.id, timer: seal.timer });
    if (seal.timer > 0) continue;
    state.seals = state.seals.filter((s) => s.id !== seal.id);
    const piece: Piece = {
      id: newId(state, 'p'),
      owner: color,
      def: seal.card.piece,
      cardId: seal.card.id,
      square: seal.square,
      activeFromTurn: state.turns[color] + 1,
    };
    state.pieces.push(piece);
    events.push({ type: 'hatched', color, pieceId: piece.id, square: piece.square, name: piece.def.name });
  }

  if (isInCheck(state, color)) events.push({ type: 'check', color });
  if (moveActions(state).length === 0 && cardActions(state).length === 0) {
    state.status = isInCheck(state, color)
      ? { kind: 'checkmate', winner: opposite(color) }
      : { kind: 'stalemate' };
    events.push({ type: 'gameOver', status: state.status });
  }
}

function endTurn(state: GameState, events: GameEvent[]): void {
  startTurn(state, opposite(state.active), events);
}

/** Moves setup along: alternate deployments, skip a side that is done, then start White's first turn. */
function settleSetup(state: GameState, events: GameEvent[], justDeployed = true): void {
  if (state.phase !== 'setup') return;
  const canDeploy = (color: Color): boolean => {
    const probe = { ...state, active: color } as GameState;
    return deployActions(probe).length > 0;
  };
  const other = opposite(state.active);
  if (!justDeployed && canDeploy(state.active)) return;
  if (canDeploy(other) && (state.setupDeployed[other] <= state.setupDeployed[state.active] || !canDeploy(state.active))) {
    state.active = other;
    return;
  }
  if (canDeploy(state.active)) return;
  state.phase = 'play';
  state.turns = { white: 0, black: 0 };
  startTurn(state, 'white', events);
}

/** Field-by-field comparison, so the key order of an action that came over the wire does not matter. */
function sameAction(a: Action, b: Action): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return ['type', 'cardUid', 'from', 'to', 'target', 'pick'].every((key) => x[key] === y[key]);
}

export interface ApplyResult {
  state: GameState;
  events: GameEvent[];
}

/** Applies an action to a copy of the state. Throws if the action is not currently legal. */
export function applyLegalAction(state: GameState, action: Action): ApplyResult {
  // Apply the engine's own copy of the matching action, never the caller's object.
  const matched = legalActions(state).find((candidate) => sameAction(candidate, action));
  if (!matched) throw new Error(`Illegal action: ${JSON.stringify(action)}`);
  return applyTrustedAction(state, matched);
}

/**
 * Applies an action taken from `legalActions(state)` to a copy without checking it again, for look-ahead. With
 * `startNext` false a move leaves the other side's turn unstarted; an End turn then starts it.
 */
export function applyTrustedAction(state: GameState, action: Action, startNext = true): ApplyResult {
  const next = clone(state);
  const events: GameEvent[] = [];
  applyAction(next, action, events);
  if (next.phase === 'setup' && action.type === 'deploy') settleSetup(next, events);
  if (startNext && ENDS_TURN.has(action.type)) endTurn(next, events);
  return { state: next, events };
}
