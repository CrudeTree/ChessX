import { describe, expect, it } from 'vitest';
import {
  BOT_LEVELS,
  STARTER_CATALOG,
  applyLegalAction,
  cloneState,
  isBotLevel,
  newGame,
  opposite,
  parseSquare,
  planTurn,
  starterDeck,
  type BotLevel,
  type Color,
  type GameState,
  type PieceCard,
} from '../src/v2/index.js';

const S = parseSquare;
/** A clock that never moves, so the look-ahead is never cut short and every run is the same. */
const frozen = (): number => 0;

function game(seed = 7): GameState {
  return newGame({ seed, decks: { white: starterDeck(), black: starterDeck() } });
}

/** The bot's whole turn. Every action must be legal; a plan that leaves the turn open is asked for again. */
function botTurn(state: GameState, level: BotLevel, seed: number): GameState {
  const color = state.active;
  for (let round = 0; round < 10; round++) {
    const plan = planTurn(state, level, seed + round, frozen);
    expect(plan.length).toBeGreaterThan(0);
    for (const action of plan) {
      state = applyLegalAction(state, action).state;
      if (state.status.kind !== 'playing' || state.active !== color) return state;
    }
  }
  throw new Error(`${level} did not finish its turn`);
}

/** Only the Kings (d1, d8), no cards, White to move. */
function bare(): GameState {
  const state = game();
  state.phase = 'play';
  state.pieces = state.pieces.filter((p) => p.def.king);
  state.hand = { white: [], black: [] };
  state.deck = { white: [], black: [] };
  state.seals = [];
  state.turns = { white: 3, black: 3 };
  state.mana = { white: 3, black: 3 };
  state.active = 'white';
  state.cardPlayed = false;
  return state;
}

function place(state: GameState, owner: Color, cardId: string, square: string): void {
  const card = STARTER_CATALOG[cardId] as PieceCard;
  state.pieces.push({ id: `t${state.nextId++}`, owner, def: card.piece, cardId, square: S(square), activeFromTurn: 0 });
}

describe('bot', () => {
  it('knows its levels', () => {
    expect(BOT_LEVELS).toEqual(['easy', 'medium', 'hard', 'expert']);
    expect(isBotLevel('hard')).toBe(true);
    expect(isBotLevel('grandmaster')).toBe(false);
  });

  it('plays only legal turns at every level', () => {
    let state = game(3);
    for (let turn = 0; turn < 24 && state.status.kind === 'playing'; turn++) {
      state = botTurn(state, BOT_LEVELS[turn % BOT_LEVELS.length]!, turn);
    }
    expect(state.turns.white).toBeGreaterThanOrEqual(12);
  });

  it.each(['medium', 'hard', 'expert'] as const)('%s takes a piece left unguarded', (level) => {
    const state = bare();
    place(state, 'white', 'warlord', 'a1');
    place(state, 'black', 'warrior', 'a5');
    expect(planTurn(state, level, 1, frozen)).toEqual([{ type: 'move', from: S('a1'), to: S('a5') }]);
  });

  it.each(['medium', 'hard', 'expert'] as const)('%s mates in one', (level) => {
    const state = bare();
    state.pieces.find((p) => p.def.king && p.owner === 'black')!.square = S('h8');
    place(state, 'black', 'initiate', 'g7');
    place(state, 'black', 'initiate', 'h7');
    place(state, 'white', 'warlord', 'a1');
    const after = planTurn(state, level, 1, frozen).reduce((s, action) => applyLegalAction(s, action).state, state);
    expect(after.status).toEqual({ kind: 'checkmate', winner: 'white' });
  });

  it.each(['medium', 'hard', 'expert'] as const)('%s neither takes a guarded piece at a loss nor steps where it is taken', (level) => {
    const state = bare();
    place(state, 'white', 'warlord', 'a1');
    place(state, 'black', 'recruit', 'a6');
    place(state, 'black', 'warlord', 'h6');
    const plan = planTurn(state, level, 1, frozen);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ type: 'move' });
    expect([S('a5'), S('a6')]).not.toContain((plan[0] as { to: number }).to);
  });

  it('plans the same turn for the same position and seed', () => {
    const state = botTurn(botTurn(game(5), 'easy', 1), 'easy', 2);
    for (const level of BOT_LEVELS) {
      expect(planTurn(cloneState(state), level, 9, frozen)).toEqual(planTurn(state, level, 9, frozen));
    }
  });

  it('cannot see the cards a player could not: the other hand and both decks', () => {
    const state = botTurn(botTurn(botTurn(game(5), 'easy', 1), 'easy', 2), 'easy', 3);
    const me = state.active;
    const them = opposite(me);
    const other = cloneState(state);
    other.deck[me] = [...other.deck[me]].reverse();
    const swap = other.deck[them].findIndex((c) => !other.hand[them].some((h) => h.cardId === c.cardId));
    expect(swap).toBeGreaterThanOrEqual(0);
    [other.hand[them][0], other.deck[them][swap]] = [other.deck[them][swap]!, other.hand[them][0]!];
    for (const level of BOT_LEVELS) {
      expect(planTurn(other, level, 4, frozen)).toEqual(planTurn(state, level, 4, frozen));
    }
  });
});
