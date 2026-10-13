import { describe, expect, it } from 'vitest';
import {
  ARENA_MANA,
  ARENA_MAX_CARDS,
  ARENA_MAX_MANA,
  ArenaError,
  STARTER_CATALOG,
  applyArenaEdit,
  applyLegalAction,
  incomeFor,
  legalActions,
  newArena,
  parseArenaOp,
  parseSquare,
  pieceAt,
  sealAt,
  viewCards,
  type ArenaEdit,
  type GameState,
  type PieceCard,
} from '../src/v2/index.js';

const S = parseSquare;

function edit(state: GameState, e: ArenaEdit): GameState {
  return applyArenaEdit(state, e).state;
}

describe('the arena', () => {
  it('opens with the two Kings, empty hands, full decks and mana to spare', () => {
    const state = newArena(1);
    expect(state.pieces.map((p) => [p.owner, p.def.name, p.square])).toEqual([
      ['white', 'King', S('d1')],
      ['black', 'King', S('d8')],
    ]);
    expect(state.hand).toEqual({ white: [], black: [] });
    expect(state.deck.white).toHaveLength(30);
    expect(state.deck.black).toHaveLength(30);
    expect(state.mana).toEqual({ white: ARENA_MANA, black: ARENA_MANA });
    expect(state.active).toBe('white');
    expect(state.status).toEqual({ kind: 'playing' });
  });

  it('places a piece for either side, ready to move, in place of what stood there', () => {
    let state = edit(newArena(1), { type: 'place', cardId: 'warrior', color: 'white', square: S('a4') });
    expect(pieceAt(state, S('a4'))).toMatchObject({ owner: 'white', cardId: 'warrior' });
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('a4'))).toBe(true);
    state = edit(state, { type: 'place', cardId: 'colt', color: 'black', square: S('a4') });
    expect(pieceAt(state, S('a4'))).toMatchObject({ owner: 'black', cardId: 'colt' });
    expect(state.pieces).toHaveLength(3);
  });

  it('only places piece cards, and never on a King', () => {
    const state = newArena(1);
    expect(() => applyArenaEdit(state, { type: 'place', cardId: 'warrior', color: 'white', square: S('d1') })).toThrow(ArenaError);
    expect(() => applyArenaEdit(state, { type: 'place', cardId: 'smite', color: 'white', square: S('a4') })).toThrow(ArenaError);
    expect(() => applyArenaEdit(state, { type: 'place', cardId: 'storm_drake', color: 'white', square: S('a4') })).toThrow(ArenaError);
  });

  it('moves anything, a King too, and takes anything but a King off the board', () => {
    let state = newArena(1);
    state = edit(state, { type: 'place', cardId: 'warrior', color: 'white', square: S('a4') });
    state = edit(state, { type: 'place', cardId: 'colt', color: 'black', square: S('b4') });
    state = edit(state, { type: 'relocate', from: S('a4'), to: S('b4') });
    expect(pieceAt(state, S('a4'))).toBeUndefined();
    expect(pieceAt(state, S('b4'))).toMatchObject({ owner: 'white', cardId: 'warrior' });
    state = edit(state, { type: 'relocate', from: S('d1'), to: S('h1') });
    expect(pieceAt(state, S('h1'))?.def.king).toBe(true);
    expect(() => applyArenaEdit(state, { type: 'relocate', from: S('b4'), to: S('d8') })).toThrow(ArenaError);
    expect(() => applyArenaEdit(state, { type: 'relocate', from: S('c3'), to: S('c4') })).toThrow(ArenaError);

    const card = STARTER_CATALOG.duskfang as PieceCard;
    state.seals.push({ id: 's-test', owner: 'black', square: S('e5'), card, timer: 3 });
    state.lava = [{ square: S('f5'), by: 'white', untilTurn: 5 }];
    state = edit(state, { type: 'remove', square: S('b4') });
    state = edit(state, { type: 'remove', square: S('e5') });
    state = edit(state, { type: 'remove', square: S('f5') });
    expect(pieceAt(state, S('b4'))).toBeUndefined();
    expect(sealAt(state, S('e5'))).toBeUndefined();
    expect(state.lava).toEqual([]);
    expect(() => applyArenaEdit(state, { type: 'remove', square: S('h1') })).toThrow(ArenaError);
    expect(() => applyArenaEdit(state, { type: 'remove', square: S('c3') })).toThrow(ArenaError);
  });

  it('gives any card to either hand or discard pile, up to a limit', () => {
    let state = edit(newArena(1), { type: 'give', cardId: 'smite', color: 'black' });
    state = edit(state, { type: 'bury', cardId: 'paladin', color: 'white' });
    expect(state.hand.black.map((c) => c.cardId)).toEqual(['smite']);
    expect(state.discard.white.map((c) => c.cardId)).toEqual(['paladin']);
    expect(() => applyArenaEdit(state, { type: 'give', cardId: 'nope', color: 'white' })).toThrow(ArenaError);
    for (let i = 1; i < ARENA_MAX_CARDS; i++) state = edit(state, { type: 'give', cardId: 'insight', color: 'black' });
    expect(() => applyArenaEdit(state, { type: 'give', cardId: 'insight', color: 'black' })).toThrow(ArenaError);
  });

  it('sets mana between 0 and the most', () => {
    let state = edit(newArena(1), { type: 'mana', color: 'white', mana: 500 });
    expect(state.mana.white).toBe(ARENA_MAX_MANA);
    state = edit(state, { type: 'mana', color: 'black', mana: -4 });
    expect(state.mana.black).toBe(0);
    state = edit(state, { type: 'mana', color: 'black', mana: 6.6 });
    expect(state.mana.black).toBe(7);
  });

  it('passes the turn without a move: the other side gets its income and its draw, and its sacrifices count down', () => {
    const before = newArena(1);
    before.seals.push({ id: 's-test', owner: 'black', square: S('e5'), card: STARTER_CATALOG.colt as PieceCard, timer: 1 });
    const { state, events } = applyArenaEdit(before, { type: 'pass' });
    expect(state.active).toBe('black');
    expect(state.mana.black).toBe(ARENA_MANA + incomeFor(1));
    expect(state.hand.black).toHaveLength(1);
    expect(pieceAt(state, S('e5'))).toMatchObject({ owner: 'black', cardId: 'colt' });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['turnStarted', 'drew', 'hatched']));
  });

  it('plays by the normal rules in between', () => {
    const state = edit(newArena(1), { type: 'give', cardId: 'recruit', color: 'white' });
    const summon = legalActions(state).find((a) => a.type === 'summon' && a.to === S('a2'));
    expect(summon).toBeDefined();
    const after = applyLegalAction(state, summon!).state;
    expect(pieceAt(after, S('a2'))).toMatchObject({ owner: 'white', cardId: 'recruit' });
    expect(after.mana.white).toBe(ARENA_MANA - STARTER_CATALOG.recruit!.cost);
  });

  it('ends the game when an edit leaves the side to move no way out, and goes on once it has one again', () => {
    let state = edit(newArena(1), { type: 'place', cardId: 'warlord', color: 'black', square: S('a2') });
    expect(state.status).toEqual({ kind: 'playing' });
    const mate = applyArenaEdit(state, { type: 'place', cardId: 'warlord', color: 'black', square: S('a1') });
    expect(mate.state.status).toEqual({ kind: 'checkmate', winner: 'black' });
    expect(mate.events).toEqual([{ type: 'gameOver', status: { kind: 'checkmate', winner: 'black' } }]);
    // Still mate after another edit: no second game-over.
    const still = applyArenaEdit(mate.state, { type: 'give', cardId: 'smite', color: 'black' });
    expect(still.state.status.kind).toBe('checkmate');
    expect(still.events).toEqual([]);
    state = edit(mate.state, { type: 'remove', square: S('a1') });
    expect(state.status).toEqual({ kind: 'playing' });
    expect(legalActions(state).length).toBeGreaterThan(0);
  });

  it('reads ops off the wire field by field', () => {
    expect(parseArenaOp({ type: 'place', cardId: 'colt', color: 'black', square: 9, extra: 1 })).toEqual({
      type: 'place',
      cardId: 'colt',
      color: 'black',
      square: 9,
    });
    expect(parseArenaOp({ type: 'undo' })).toEqual({ type: 'undo' });
    expect(parseArenaOp({ type: 'mana', color: 'white', mana: 12 })).toEqual({ type: 'mana', color: 'white', mana: 12 });
    for (const bad of [
      null,
      'pass',
      { type: 'teleport' },
      { type: 'place', cardId: 'colt', color: 'green', square: 9 },
      { type: 'remove', square: 64 },
      { type: 'remove', square: 1.5 },
      { type: 'relocate', from: 3 },
      { type: 'give', cardId: 5, color: 'white' },
      { type: 'mana', color: 'white', mana: Number.NaN },
    ]) {
      expect(() => parseArenaOp(bad)).toThrow(ArenaError);
    }
  });

  it('draws every catalog card for the Binder', () => {
    const cards = viewCards(STARTER_CATALOG);
    expect(Object.keys(cards)).toEqual(Object.keys(STARTER_CATALOG));
    expect(cards.warlord).toMatchObject({ type: 'piece', line: 'Warrior', level: 3, evolvesFrom: 'warrior' });
    expect(cards.smite).toMatchObject({ type: 'spell', spell: 'destroyPiece' });
  });
});
