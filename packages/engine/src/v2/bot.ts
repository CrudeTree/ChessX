// The computer opponent. It only plays what `legalActions` offers and values pieces from their cards (cost, and how
// much of the board they reach), so every card, including ones added later, is open to it without code of its own.
// It knows what a player knows: before it thinks, the other side's hand and both decks are dealt again at random.

import { applyTrustedAction, bountyFor, cloneState, isInCheck, isShielded, legalActions, reaches } from './engine.js';
import { nextRandom } from './rng.js';
import {
  FILES,
  RANKS,
  fileOf,
  inBounds,
  opposite,
  rankOf,
  sq,
  type Action,
  type CardInstance,
  type Color,
  type GameState,
  type Piece,
  type PieceCard,
  type PieceDef,
  type Square,
} from './types.js';

export type BotLevel = 'easy' | 'medium' | 'hard' | 'expert';
export const BOT_LEVELS: readonly BotLevel[] = ['easy', 'medium', 'hard', 'expert'];
export const BOT_NAMES: Record<BotLevel, string> = {
  easy: 'Easy bot',
  medium: 'Medium bot',
  hard: 'Hard bot',
  expert: 'Expert bot',
};

export function isBotLevel(value: unknown): value is BotLevel {
  return typeof value === 'string' && (BOT_LEVELS as readonly string[]).includes(value);
}

/** How widely one side's turn is searched. */
interface TurnWidth {
  /** Positions kept after each card played. */
  beam: number;
  /** Most cards played before the move. */
  cards: number;
  /** Moves played into the other side's turn (so check and mate count) after a quick look at all of them. */
  moves: number;
}

interface Level {
  /** One width per turn looked at: the bot's own, the reply, the bot's next. */
  turns: TurnWidth[];
  /** Turns carried on to the next one looked at: the bot's best few, then the best few replies to each. */
  keep: number[];
  /** Random error on each candidate turn's score; a Recruit is worth about 2.4. */
  noise: number;
  /** Sees pieces left where they can be taken, its own and the other side's. */
  threats: boolean;
  /** Stops looking further ahead after this long. */
  budgetMs: number;
}

const LEVELS: Record<BotLevel, Level> = {
  easy: { turns: [{ beam: 2, cards: 1, moves: 6 }], keep: [], noise: 1.5, threats: false, budgetMs: 1000 },
  medium: { turns: [{ beam: 3, cards: 3, moves: 10 }], keep: [], noise: 0.45, threats: true, budgetMs: 1500 },
  hard: {
    turns: [
      { beam: 4, cards: 4, moves: 10 },
      { beam: 2, cards: 1, moves: 8 },
    ],
    keep: [10],
    noise: 0.12,
    threats: true,
    budgetMs: 2500,
  },
  expert: {
    turns: [
      { beam: 5, cards: 4, moves: 12 },
      { beam: 2, cards: 2, moves: 8 },
      { beam: 1, cards: 0, moves: 8 },
    ],
    keep: [14, 5],
    noise: 0,
    threats: true,
    budgetMs: 3000,
  },
};

interface Weights {
  mana: number;
  /** Mana above this buys nothing more: the dearest card costs 10, and the decks run out. */
  manaCap: number;
  card: number;
  ability: number;
  /** A sacrifice's piece counts this much less for each turn it has left to rise. */
  sealDecay: number;
  mobility: number;
  advance: number;
  center: number;
  kingAdvance: number;
  shelter: number;
  kingDanger: number;
  /** Per free square the King could step to. */
  escape: number;
  check: number;
  /** For the side well ahead: per square the other King is from the middle, and per square its pieces are nearer it. */
  hunt: number;
  near: number;
  /** Share of its best capture credited to the side about to act. */
  threat: number;
  /** Share of the other side's best capture, which the side about to act can still answer. */
  threatOther: number;
  /** Per center square a piece (not a King) stands on: it pays 1 mana a turn, the only income. */
  shrine: number;
  /** Per piece (up to 2) aiming at a center square, to take it or hold it. */
  shrineAim: number;
}

const WEIGHTS: Weights = {
  mana: 0.25,
  manaCap: 10,
  card: 0.3,
  ability: 0.8,
  sealDecay: 0.85,
  mobility: 0.03,
  advance: 0.03,
  center: 0.04,
  kingAdvance: 0.15,
  shelter: 0.1,
  kingDanger: 0.2,
  escape: 0.12,
  check: 0.35,
  hunt: 0.3,
  near: 0.15,
  threat: 0.8,
  threatOther: 0.3,
  shrine: 0.7,
  shrineAim: 0.06,
};

const WIN = 10_000;
/** A King taking a piece counts as a very dear attacker, so it only wins what is not guarded. */
const KING_ATTACKER = 50;
const COLORS: readonly Color[] = ['white', 'black'];
const END_TURN: Action = { type: 'endTurn' };
const AROUND: Square[][] = Array.from({ length: FILES * RANKS }, (_, square) => {
  const out: Square[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      const file = fileOf(square) + df;
      const rank = rankOf(square) + dr;
      if ((df !== 0 || dr !== 0) && inBounds(file, rank)) out.push(sq(file, rank));
    }
  }
  return out;
});

// ---------------------------------------------------------------------------
// What things are worth

const reachCache = new WeakMap<PieceDef, number>();
const worthCache = new WeakMap<PieceCard, number>();

/** Squares a piece reaches on an empty board, averaged over the board; a move-only or capture-only reach counts less. */
function openReach(def: PieceDef): number {
  const cached = reachCache.get(def);
  if (cached !== undefined) return cached;
  let total = 0;
  for (let square = 0; square < FILES * RANKS; square++) {
    for (const rule of def.rules) {
      const weight = rule.mode === 'move' ? 0.5 : rule.mode === 'capture' ? 0.6 : 1;
      const steps = rule.leap ? 1 : rule.range;
      for (const [df, dr] of rule.dirs) {
        for (let step = 1; step <= steps && inBounds(fileOf(square) + df * step, rankOf(square) + dr * step); step++) {
          total += weight;
        }
      }
    }
  }
  const reach = total / (FILES * RANKS);
  reachCache.set(def, reach);
  return reach;
}

/** What a piece card is worth on the board. */
function cardWorth(card: PieceCard): number {
  let worth = worthCache.get(card);
  if (worth === undefined) {
    worth = 1 + 0.5 * card.cost + 0.25 * openReach(card.piece);
    worthCache.set(card, worth);
  }
  return worth;
}

function pieceWorth(state: GameState, piece: Piece, w: Weights): number {
  const card = piece.cardId ? state.catalog[piece.cardId] : undefined;
  const base = card?.type === 'piece' ? cardWorth(card) : 1 + 0.25 * openReach(piece.def);
  return base + (piece.abilities?.length ?? 0) * w.ability;
}

/** Whether a piece can capture on its owner's turn `turn`. */
function canCapture(piece: Piece, turn: number): boolean {
  return turn >= piece.activeFromTurn && piece.frozenOnTurn !== turn && piece.summonedOnTurn !== turn;
}

const ahead = (color: Color, square: Square): number => (color === 'white' ? rankOf(square) : RANKS - 1 - rankOf(square));
const centrality = (square: Square): number =>
  3 - Math.max(Math.abs(fileOf(square) - 3.5), Math.abs(rankOf(square) - 3.5));

/**
 * How good a position is for `me` with `toMove` about to act: in the middle of its turn, or after the other side's
 * move before the turn has passed. The other side's score is exactly the negative.
 */
function evaluate(state: GameState, me: Color, toMove: Color, w: Weights): number {
  const status = state.status;
  if (status.kind === 'stalemate') return 0;
  if (status.kind !== 'playing') return status.winner === me ? WIN : -WIN;
  const other = opposite(toMove);
  const sign = (color: Color): number => (color === me ? 1 : -1);
  // The owner turn on which each side next captures, and on which it would take back a capture.
  const moverTurn = state.turns[toMove] + (toMove === state.active && !state.actionTaken ? 0 : 1);
  const otherTurn = state.turns[other] + 1;
  const control = { white: new Uint8Array(64), black: new Uint8Array(64) };
  const cheapest = { white: new Float64Array(64).fill(Infinity), black: new Float64Array(64).fill(Infinity) };
  const guarded = { white: new Uint8Array(64), black: new Uint8Array(64) };
  const occupant = new Array<Color | null>(64).fill(null);
  const lava = new Uint8Array(64);
  const kings: Partial<Record<Color, Square>> = {};
  const material = { white: 0, black: 0 };
  let score = 0;

  for (const piece of state.pieces) occupant[piece.square] = piece.owner;
  for (const spot of state.lava ?? []) lava[spot.square] = 1;
  const shrines = state.shrines ?? [];
  for (const piece of state.pieces) {
    const side = piece.owner;
    if (!piece.def.king && shrines.includes(piece.square)) score += sign(side) * w.shrine;
    const worth = piece.def.king ? KING_ATTACKER : pieceWorth(state, piece, w);
    const takes = canCapture(piece, side === toMove ? moverTurn : otherTurn);
    const guards = canCapture(piece, side === toMove ? moverTurn + 1 : otherTurn);
    let mobility = 0;
    for (const reach of reaches(state, piece)) {
      if (reach.occupant !== side) mobility += reach.mode === 'move' ? 0.5 : 1;
      if (reach.mode === 'move') continue;
      control[side][reach.to] += 1;
      if (takes && worth < cheapest[side][reach.to]!) cheapest[side][reach.to] = worth;
      if (guards) guarded[side][reach.to] = 1;
    }
    if (piece.def.king) {
      kings[side] = piece.square;
      score -= sign(side) * w.kingAdvance * ahead(side, piece.square);
      continue;
    }
    material[side] += worth;
    score +=
      sign(side) *
      (worth + w.mobility * mobility + w.advance * Math.min(5, ahead(side, piece.square)) + w.center * centrality(piece.square));
  }
  for (const seal of state.seals) {
    const worth = cardWorth(seal.card) * w.sealDecay ** seal.timer;
    material[seal.owner] += worth;
    score += sign(seal.owner) * worth;
  }
  for (const square of shrines) {
    for (const side of COLORS) score += sign(side) * w.shrineAim * Math.min(2, control[side][square]!);
  }
  const mana = (color: Color): number => Math.min(state.mana[color], w.manaCap);
  score += w.mana * (mana(me) - mana(opposite(me)));
  score += w.card * (state.hand[me].length - state.hand[opposite(me)].length);

  for (const side of COLORS) {
    const king = kings[side];
    if (king === undefined) continue;
    const enemy = opposite(side);
    let danger = 0;
    let shelter = 0;
    let escapes = 0;
    for (const near of AROUND[king]!) {
      danger += Math.min(2, control[enemy][near]!);
      if (occupant[near] === side) shelter += 1;
      else if (!lava[near] && control[enemy][near] === 0) escapes += 1;
    }
    score += sign(side) * (w.shelter * Math.min(3, shelter) - w.kingDanger * danger + w.escape * Math.min(3, escapes));
    if (side === toMove && control[enemy][king]! > 0) score -= sign(side) * w.check;
  }

  // Well ahead, drive the other King to the edge and close in on it, so a won game ends in mate.
  const leader: Color = material.white >= material.black ? 'white' : 'black';
  const lead = Math.abs(material.white - material.black);
  const hunted = kings[opposite(leader)];
  if (lead > 2 && hunted !== undefined) {
    let distance = 0;
    let hunters = 0;
    for (const piece of state.pieces) {
      if (piece.owner !== leader) continue;
      distance += Math.max(Math.abs(fileOf(piece.square) - fileOf(hunted)), Math.abs(rankOf(piece.square) - rankOf(hunted)));
      hunters += 1;
    }
    const scale = Math.min(1, (lead - 2) / 6);
    score += sign(leader) * scale * (w.hunt * (2.5 - centrality(hunted)) + w.near * (7 - distance / Math.max(1, hunters)));
  }

  if (w.threat > 0) score += sign(toMove) * w.threat * bestCapture(state, toMove, cheapest[toMove], guarded[other], w);
  if (w.threatOther > 0) score += sign(other) * w.threatOther * bestCapture(state, other, cheapest[other], guarded[toMove], w);
  return score;
}

/** The most `by` wins with one capture: what it can take, less the taker if that square is guarded. */
function bestCapture(state: GameState, by: Color, cheapest: Float64Array, guarded: Uint8Array, w: Weights): number {
  let best = 0;
  for (const piece of state.pieces) {
    if (piece.owner === by || piece.def.king) continue;
    const taker = cheapest[piece.square]!;
    if (taker === Infinity || isShielded(state, piece)) continue;
    const bounty = piece.cardId ? bountyFor(state.catalog[piece.cardId]) * w.mana : 0;
    const worth = pieceWorth(state, piece, w);
    best = Math.max(best, (guarded[piece.square] ? worth - taker : worth) + bounty);
  }
  for (const seal of state.seals) {
    if (seal.owner === by) continue;
    const taker = cheapest[seal.square]!;
    if (taker === Infinity) continue;
    const worth = cardWorth(seal.card) * w.sealDecay ** seal.timer;
    best = Math.max(best, guarded[seal.square] ? worth - taker : worth);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Planning a turn

interface Line {
  actions: Action[];
  state: GameState;
  /** `evaluate` for the side that played the line. */
  score: number;
}

/** Same pieces, sacrifices, lava, hand and mana: two orders of the same cards end in the same place. */
function positionKey(state: GameState): string {
  const pieces = state.pieces
    .map(
      (p) =>
        `${p.owner[0]}${p.cardId ?? 'K'}${p.square}:${p.summonedOnTurn ?? ''}:${p.abilities?.join('') ?? ''}:` +
        `${p.shieldOnTurn ?? ''}:${p.frozenOnTurn ?? ''}:${p.lavaOnTurn ?? ''}`,
    )
    .sort()
    .join(' ');
  const seals = state.seals.map((s) => `${s.owner[0]}${s.card.id}${s.square}:${s.timer}`).sort().join(' ');
  const lava = (state.lava ?? []).map((l) => `${l.square}:${l.untilTurn}`).sort().join(' ');
  const hand = state.hand[state.active].map((c) => c.uid).join(' ');
  return [pieces, seals, lava, hand, state.mana.white, state.mana.black, state.pitched ? 1 : 0, state.discard[state.active].length].join('|');
}

/** Which card or piece an action uses, so the beam keeps a mix of plays instead of one card on every square. */
function playedWith(action: Action): string {
  if ('cardUid' in action) return action.cardUid;
  return action.type === 'lava' ? `lava${action.from}` : action.type;
}

/**
 * The side to move's best whole turns, best first: cards, keeping the best few positions after each, then the move
 * that ends the turn (or End turn when no move is left).
 */
function turnLines(start: GameState, width: TurnWidth, w: Weights): Line[] {
  const me = start.active;
  const them = opposite(me);
  const lines: Line[] = [];
  const seen = new Set<string>();
  let frontier: Line[] = [{ actions: [], state: start, score: 0 }];
  for (let played = 0; frontier.length > 0; played++) {
    const children: Line[] = [];
    for (const node of frontier) {
      const moves: { action: Action; open: GameState; score: number; check: boolean }[] = [];
      for (const action of legalActions(node.state)) {
        if (action.type === 'move') {
          const open = applyTrustedAction(node.state, action, false).state;
          moves.push({ action, open, score: evaluate(open, me, them, w), check: isInCheck(open, them) });
        } else if (action.type === 'endTurn') {
          const after = applyTrustedAction(node.state, action).state;
          lines.push({ actions: [...node.actions, action], state: after, score: evaluate(after, me, after.active, w) });
        } else if (played < width.cards) {
          const after = applyTrustedAction(node.state, action).state;
          const key = positionKey(after);
          if (seen.has(key)) continue;
          seen.add(key);
          children.push({ actions: [...node.actions, action], state: after, score: evaluate(after, me, me, w) });
        }
      }
      moves.sort((a, b) => b.score - a.score);
      moves.forEach((move, rank) => {
        if (rank >= width.moves && !move.check) return;
        const after = applyTrustedAction(move.open, END_TURN).state;
        lines.push({ actions: [...node.actions, move.action], state: after, score: evaluate(after, me, after.active, w) });
      });
    }
    children.sort((a, b) => b.score - a.score);
    const uses = new Map<string, number>();
    frontier = [];
    for (const child of children) {
      if (frontier.length >= width.beam) break;
      const used = playedWith(child.actions[child.actions.length - 1]!);
      if ((uses.get(used) ?? 0) >= 2) continue;
      uses.set(used, (uses.get(used) ?? 0) + 1);
      frontier.push(child);
    }
  }
  return lines.sort((a, b) => b.score - a.score);
}

interface Search {
  me: Color;
  level: Level;
  weights: Weights;
  deadline: number;
  now: () => number;
}

/** The bot's value of a position at the start of a turn, `ply` turns into the look-ahead (alpha-beta). */
function lookAhead(state: GameState, ply: number, alpha: number, beta: number, s: Search): number {
  const width = s.level.turns[ply];
  if (state.status.kind !== 'playing' || !width || s.now() > s.deadline) return evaluate(state, s.me, state.active, s.weights);
  const lines = turnLines(state, width, s.weights);
  if (lines.length === 0) return evaluate(state, s.me, state.active, s.weights);
  const mine = state.active === s.me;
  if (ply + 1 >= s.level.turns.length) return mine ? lines[0]!.score : -lines[0]!.score;
  let best = mine ? -Infinity : Infinity;
  for (const line of lines.slice(0, s.level.keep[ply] ?? 1)) {
    const value = lookAhead(line.state, ply + 1, alpha, beta, s);
    if (mine) {
      best = Math.max(best, value);
      alpha = Math.max(alpha, value);
    } else {
      best = Math.min(best, value);
      beta = Math.min(beta, value);
    }
    if (alpha >= beta) break;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Hidden cards and chance

function randomizer(seed: number): () => number {
  let state = seed | 0;
  return () => {
    const roll = nextRandom(state);
    state = roll.state;
    return roll.value;
  };
}

function gaussian(random: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
}

/** Shuffled from a fixed order, so the result does not depend on the order the cards were in. */
function dealt(cards: CardInstance[], random: () => number): CardInstance[] {
  const out = [...cards].sort((a, b) =>
    a.cardId === b.cardId ? (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0) : a.cardId < b.cardId ? -1 : 1,
  );
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The game as the bot may know it: the other side's hand dealt at random from its unseen cards, both decks shuffled. */
function dealUnseen(state: GameState, me: Color, random: () => number): GameState {
  const world = cloneState(state);
  const them = opposite(me);
  world.deck[me] = dealt(world.deck[me], random);
  const unseen = dealt([...world.hand[them], ...world.deck[them]], random);
  const handSize = world.hand[them].length;
  world.hand[them] = unseen.slice(0, handSize);
  world.deck[them] = unseen.slice(handSize);
  return world;
}

/** A card it draws is unknown until drawn, so the plan stops after a card that draws and the turn is planned again. */
function upToFirstDraw(state: GameState, actions: Action[]): Action[] {
  const hand = state.hand[state.active];
  const cut = actions.findIndex((action) => {
    if (action.type !== 'spell') return false;
    const card = state.catalog[hand.find((c) => c.uid === action.cardUid)?.cardId ?? ''];
    return card?.type === 'spell' && card.effect.kind === 'draw';
  });
  return cut < 0 ? actions : actions.slice(0, cut + 1);
}

/**
 * The bot's turn for the side to move: the cards it plays, then the move that ends the turn (or End turn). After a
 * card that draws, the plan stops there; play it and ask again. `seed` picks the hidden cards it imagines and the
 * mistakes of the easier levels; `now` lets tests freeze the clock that bounds the look-ahead.
 */
export function planTurn(state: GameState, level: BotLevel, seed = 1, now: () => number = Date.now): Action[] {
  const options = legalActions(state);
  if (options.length <= 1) return options;
  const settings = LEVELS[level];
  const weights = settings.threats ? WEIGHTS : { ...WEIGHTS, threat: 0, threatOther: 0 };
  const random = randomizer(seed);
  const me = state.active;
  const world = dealUnseen(state, me, random);
  const s: Search = { me, level: settings, weights, deadline: now() + settings.budgetMs, now };
  const lines = turnLines(world, settings.turns[0]!, weights);
  if (lines.length === 0) return [options[0]!];

  let scored = lines.map((line) => ({ line, value: line.score }));
  if (settings.turns.length > 1) {
    const deep: typeof scored = [];
    let alpha = -Infinity;
    for (const line of lines.slice(0, settings.keep[0] ?? 1)) {
      if (deep.length > 0 && now() > s.deadline) break;
      // With noise every candidate needs its exact value, so none is cut short.
      const value = lookAhead(line.state, 1, settings.noise > 0 ? -Infinity : alpha, Infinity, s);
      deep.push({ line, value });
      alpha = Math.max(alpha, value);
    }
    scored = deep;
  }
  let best = scored[0]!;
  let bestValue = -Infinity;
  for (const entry of scored) {
    const value = entry.value + settings.noise * gaussian(random);
    if (value > bestValue) {
      best = entry;
      bestValue = value;
    }
  }
  return upToFirstDraw(state, best.line.actions);
}
