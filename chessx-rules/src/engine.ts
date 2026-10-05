import { KING, STARTER_CATALOG } from './catalog';
import { nextRandom } from './rng';
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
  type Piece,
  type PieceCard,
  type Seal,
  type Square,
} from './types';

export const HAND_SIZE = 7;
export const START_MANA = 2;
export const SETUP_PIECES = 3;
export const KING_FILE = 3;

export interface NewGameOptions {
  seed: number;
  decks: Record<Color, string[]>;
  catalog?: Record<string, Card>;
}

const COLORS: Color[] = ['white', 'black'];

function clone(state: GameState): GameState {
  return structuredClone(state);
}

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

function isFreePiece(state: GameState, instance: CardInstance): boolean {
  const card = state.catalog[instance.cardId];
  return card?.type === 'piece' && card.cost === 0;
}

/**
 * Draws 7 cards. Setup needs 3 zero-cost pieces, so if the hand holds fewer, zero-cost pieces are pulled
 * from the deck in place of the most expensive other cards (which go back and the deck is reshuffled).
 * This is an assumption the owner can change: the rules text does not say where setup pieces come from.
 */
function openingHand(state: GameState, color: Color): void {
  draw(state, color, HAND_SIZE, []);
  let swapped = false;
  while (state.hand[color].filter((c) => isFreePiece(state, c)).length < SETUP_PIECES) {
    const incomingIndex = state.deck[color].findIndex((c) => isFreePiece(state, c));
    if (incomingIndex < 0) break;
    const outgoing = state.hand[color]
      .map((c, index) => ({ c, index, cost: (state.catalog[c.cardId] as { cost: number }).cost }))
      .filter(({ c }) => !isFreePiece(state, c))
      .sort((a, b) => b.cost - a.cost)[0];
    if (!outgoing) break;
    const [incoming] = state.deck[color].splice(incomingIndex, 1);
    const [leaving] = state.hand[color].splice(outgoing.index, 1, incoming!);
    state.deck[color].push(leaving!);
    swapped = true;
  }
  if (swapped) state.deck[color] = shuffle(state, state.deck[color]);
}

export function newGame(options: NewGameOptions): GameState {
  const state: GameState = {
    catalog: options.catalog ?? STARTER_CATALOG,
    phase: 'setup',
    active: 'white',
    turns: { white: 0, black: 0 },
    mana: { white: START_MANA, black: START_MANA },
    hand: { white: [], black: [] },
    deck: { white: [], black: [] },
    discard: { white: [], black: [] },
    pieces: [],
    seals: [],
    setupDeployed: { white: 0, black: 0 },
    actionTaken: false,
    spellPlayed: false,
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
    openingHand(state, color);
  }
  settleSetup(state, [], false);
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

export function isActive(state: GameState, piece: Piece): boolean {
  return state.turns[piece.owner] >= piece.activeFromTurn;
}

interface Reach {
  to: Square;
  mode: 'both' | 'move' | 'capture';
  occupant: Color | null;
}

/** Every square a piece's rules reach, stopping rays at the first piece or seal. */
function reaches(state: GameState, piece: Piece): Reach[] {
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

/** True if `by` has an active piece that could capture on `square`. Pieces with summoning sickness do not count. */
export function isAttacked(state: GameState, square: Square, by: Color): boolean {
  for (const piece of state.pieces) {
    if (piece.owner !== by || !isActive(state, piece)) continue;
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

function capture(state: GameState, mover: Piece, to: Square, events: GameEvent[]): void {
  const victim = pieceAt(state, to);
  if (victim) {
    state.pieces = state.pieces.filter((p) => p.id !== victim.id);
    events.push({ type: 'captured', pieceId: victim.id, by: mover.id, square: to });
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
      events.push({ type: 'deployed', color, pieceId: piece.id, square: piece.square });
      return;
    }
    case 'move': {
      const piece = pieceAt(state, action.from);
      if (!piece) throw new Error('No piece to move');
      capture(state, piece, action.to, events);
      piece.square = action.to;
      state.actionTaken = true;
      events.push({ type: 'moved', pieceId: piece.id, from: action.from, to: action.to });
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
      };
      state.pieces.push(piece);
      state.actionTaken = true;
      events.push({ type: 'summoned', color, pieceId: piece.id, square: piece.square });
      return;
    }
    case 'seal': {
      const instance = removeFromHand(state, color, action.cardUid);
      const card = pieceCard(state, instance.cardId);
      state.mana[color] -= card.cost;
      const consumed = pieceAt(state, action.target);
      if (!consumed) throw new Error('No piece to seal');
      state.pieces = state.pieces.filter((p) => p.id !== consumed.id);
      const seal: Seal = { id: newId(state, 's'), owner: color, square: action.target, card, timer: card.sealTimer };
      state.seals.push(seal);
      state.actionTaken = true;
      events.push({ type: 'sealed', color, sealId: seal.id, square: seal.square, consumedPieceId: consumed.id, timer: seal.timer });
      return;
    }
    case 'spell': {
      const instance = removeFromHand(state, color, action.cardUid);
      const card = state.catalog[instance.cardId];
      if (!card || card.type !== 'spell') throw new Error('Not a spell');
      state.mana[color] -= card.cost;
      state.discard[color].push(instance);
      state.spellPlayed = true;
      events.push({ type: 'spellPlayed', color, cardId: card.id, target: action.target });
      if (card.effect.kind === 'draw') {
        draw(state, color, card.effect.count, events);
      } else if (action.target !== undefined) {
        const seal = sealAt(state, action.target);
        if (seal) {
          state.seals = state.seals.filter((s) => s.id !== seal.id);
          state.discard[seal.owner].push({ uid: newId(state, 'c'), cardId: seal.card.id });
          events.push({ type: 'sealDestroyed', sealId: seal.id, by: card.id, square: seal.square, cardId: seal.card.id });
        }
      }
      return;
    }
    case 'endTurn': {
      endTurn(state, events);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Legal actions

function backRowSquares(color: Color): Square[] {
  return Array.from({ length: FILES }, (_, file) => sq(file, backRank(color)));
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
    if (piece.owner !== color) continue;
    const sick = !isActive(state, piece);
    for (const reach of reaches(state, piece)) {
      const empty = reach.occupant === null;
      const enemy = reach.occupant === opposite(color);
      const canMove = empty && reach.mode !== 'capture';
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
  const free = backRowSquares(color).filter((s) => ownerAt(state, s) === null);
  const out: Action[] = [];
  for (const { instance, card } of handPieces(state, color)) {
    if (card.cost > state.mana[color]) continue;
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
    if (card.cost > state.mana[color]) continue;
    for (const target of targets) {
      const action: Action = { type: 'seal', cardUid: instance.uid, target: target.square };
      if (safe(state, action)) out.push(action);
    }
  }
  return out;
}

function mainActions(state: GameState): Action[] {
  return [...moveActions(state), ...summonActions(state), ...sealActions(state)];
}

function spellActions(state: GameState): Action[] {
  const color = state.active;
  const out: Action[] = [];
  for (const instance of state.hand[color]) {
    const card = state.catalog[instance.cardId];
    if (card?.type !== 'spell' || card.cost > state.mana[color]) continue;
    const candidates: Action[] = card.effect.kind === 'destroySeal'
      ? state.seals.map((s) => ({ type: 'spell', cardUid: instance.uid, target: s.square }) as Action)
      : [{ type: 'spell', cardUid: instance.uid }];
    for (const action of candidates) {
      const after = tryAction(state, action);
      if (isInCheck(after, color)) continue;
      if (!state.actionTaken && mainActions(after).length === 0) continue;
      out.push(action);
    }
  }
  return out;
}

export function legalActions(state: GameState): Action[] {
  if (state.status.kind !== 'playing') return [];
  if (state.phase === 'setup') return deployActions(state);
  const out: Action[] = [];
  if (!state.actionTaken) out.push(...mainActions(state));
  if (!state.spellPlayed) out.push(...spellActions(state));
  if (state.actionTaken) out.push({ type: 'endTurn' });
  return out;
}

// ---------------------------------------------------------------------------
// Turn flow

function startTurn(state: GameState, color: Color, events: GameEvent[]): void {
  state.active = color;
  state.turns[color] += 1;
  state.mana[color] += 1;
  state.actionTaken = false;
  state.spellPlayed = false;
  events.push({ type: 'turnStarted', color, turn: state.turns[color], mana: state.mana[color] });
  draw(state, color, 1, events);

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
    events.push({ type: 'hatched', color, pieceId: piece.id, square: piece.square });
  }

  if (isInCheck(state, color)) events.push({ type: 'check', color });
  if (mainActions(state).length === 0) {
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

function sameAction(a: Action, b: Action): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface ApplyResult {
  state: GameState;
  events: GameEvent[];
}

/** Applies an action to a copy of the state. Throws if the action is not currently legal. */
export function applyLegalAction(state: GameState, action: Action): ApplyResult {
  if (!legalActions(state).some((candidate) => sameAction(candidate, action))) {
    throw new Error(`Illegal action: ${JSON.stringify(action)}`);
  }
  const next = clone(state);
  const events: GameEvent[] = [];
  applyAction(next, action, events);
  if (next.phase === 'setup' && action.type === 'deploy') settleSetup(next, events);
  return { state: next, events };
}
