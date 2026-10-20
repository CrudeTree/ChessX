import { describe, expect, it } from 'vitest';
import {
  FILES,
  KING,
  STARTER_CATALOG,
  applyLegalAction,
  bountyFor,
  evolveCost,
  faceArt,
  incomeFor,
  isInCheck,
  legalActions,
  MAX_INCOME,
  SHRINE_LAYOUTS,
  WELL,
  nextRecord,
  newGame,
  newRecord,
  rebuildSteps,
  stateAt,
  viewAt,
  type GameEvent,
  type GameRecord,
  parseSquare,
  pieceAt,
  sealAt,
  starterDeck,
  type Action,
  type Color,
  type GameState,
  type Piece,
  type PieceCard,
  cloneState,
  viewFor,
  withCurrentArt,
} from '../src/v2/index.js';

const S = parseSquare;

function game(seed = 7): GameState {
  return newGame({ seed, decks: { white: starterDeck(), black: starterDeck() } });
}

function act(state: GameState, action: Action): GameState {
  return applyLegalAction(state, action).state;
}

function give(state: GameState, color: Color, cardId: string): string {
  const uid = `t-${color}-${cardId}-${state.nextId++}`;
  state.hand[color].push({ uid, cardId });
  return uid;
}

function piece(state: GameState, owner: Color, cardId: string, square: string, activeFromTurn = 0): Piece {
  const card = STARTER_CATALOG[cardId];
  if (card?.type !== 'piece') throw new Error('not a piece');
  const p: Piece = { id: `x${state.nextId++}`, owner, def: card.piece, cardId, square: S(square), activeFromTurn };
  state.pieces.push(p);
  return p;
}

/** A bare play-phase position: only the two Kings, White to move on turn 1 with the given mana. */
function bare(mana = 3): GameState {
  const state = game();
  state.phase = 'play';
  state.pieces = state.pieces.filter((p) => p.def.king);
  state.hand = { white: [], black: [] };
  state.deck = { white: [], black: [] };
  state.seals = [];
  state.turns = { white: 1, black: 0 };
  state.mana = { white: mana, black: mana };
  state.active = 'white';
  state.actionTaken = false;
  state.cardPlayed = false;
  return state;
}

/** The deploy phase new games had before the 2026-10-08 ruling, as a saved game would hold it. */
function legacySetup(state: GameState): GameState {
  delete state.shrines;
  delete state.maxIncome;
  state.phase = 'setup';
  state.pieces = state.pieces.filter((p) => p.def.king);
  state.turns = { white: 0, black: 0 };
  state.mana = { white: 2, black: 2 };
  state.active = 'white';
  return state;
}

function find(state: GameState, predicate: (a: Action) => boolean): Action {
  const found = legalActions(state).find(predicate);
  if (!found) throw new Error('action not legal');
  return found;
}

describe('setup', () => {
  it('uses an 8x8 board with Kings on d1 and d8, 3 Initiates in front of each King, 3 cards each, and White to move', () => {
    const state = game();
    const at = (color: Color) => state.pieces.filter((p) => p.owner === color).map((p) => `${p.def.name}@${p.square}`).sort();
    expect(at('white')).toEqual([`King@${S('d1')}`, `Initiate@${S('c2')}`, `Initiate@${S('d2')}`, `Initiate@${S('e2')}`].sort());
    expect(at('black')).toEqual([`King@${S('d8')}`, `Initiate@${S('c7')}`, `Initiate@${S('d7')}`, `Initiate@${S('e7')}`].sort());
    expect(state.pieces.filter((p) => p.def.king).every((p) => p.def === KING)).toBe(true);
    expect(state.phase).toBe('play');
    expect(state.active).toBe('white');
    expect(state.turns).toEqual({ white: 1, black: 0 });
    // 3-card hands (Djabooty, 2026-10-10), then White's turn 1 draws one more. 6 mana each, and nothing more until a
    // mana square pays (Djabooty, 2026-10-20).
    expect(state.hand.white).toHaveLength(4);
    expect(state.hand.black).toHaveLength(3);
    expect(state.mana).toEqual({ white: 6, black: 6 });
    expect(SHRINE_LAYOUTS).toContainEqual(state.shrines);
    expect(FILES).toBe(8);
    expect(S('h8')).toBe(63);
    expect(() => S('i1')).toThrow();
    expect(() => S('a9')).toThrow();
  });

  it('starting Initiates come from outside the deck and can capture on turn 1', () => {
    const state = game();
    for (const color of ['white', 'black'] as Color[]) {
      expect(state.hand[color].length + state.deck[color].length).toBe(starterDeck().length);
    }
    const starters = state.pieces.filter((p) => !p.def.king);
    expect(starters.every((p) => p.activeFromTurn === 0)).toBe(true);
    expect(legalActions(state).some((a) => a.type === 'deploy')).toBe(false);
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('d2') && a.to === S('d3'))).toBe(true);
  });

  it('a game saved mid-setup under the old rule still alternates deployments, then White moves with +1 mana', () => {
    let state = legacySetup(game());
    state.hand.white = [];
    state.hand.black = [];
    for (let i = 0; i < 4; i++) {
      give(state, 'white', 'initiate');
      give(state, 'black', 'initiate');
    }
    give(state, 'white', 'recruit');
    const order: Color[] = [];
    for (let i = 0; i < 6; i++) {
      order.push(state.active);
      const deploy = find(state, (a) => a.type === 'deploy');
      state = act(state, deploy);
    }
    expect(order).toEqual(['white', 'black', 'white', 'black', 'white', 'black']);
    expect(state.phase).toBe('play');
    expect(state.active).toBe('white');
    expect(state.mana.white).toBe(3);
    expect(state.mana.black).toBe(2);
    expect(state.pieces.filter((p) => !p.def.king && p.owner === 'white')).toHaveLength(3);
  });

  it('old-rule setup only allows zero-cost pieces, only on the owner\'s back row', () => {
    const state = legacySetup(game());
    state.hand.white = [];
    const recruit = give(state, 'white', 'recruit');
    const initiate = give(state, 'white', 'initiate');
    const deploys = legalActions(state).filter((a) => a.type === 'deploy');
    expect(deploys.every((a) => a.type === 'deploy' && a.cardUid === initiate)).toBe(true);
    expect(deploys.some((a) => a.type === 'deploy' && a.cardUid === recruit)).toBe(false);
    expect(deploys.every((a) => a.type === 'deploy' && a.to < FILES)).toBe(true);
    expect(deploys).toHaveLength(FILES - 1);
    expect(deploys.some((a) => a.type === 'deploy' && a.to === S('d1'))).toBe(false);
  });

  it('setup pieces have no summoning sickness on turn 1', () => {
    const state = bare();
    const init = piece(state, 'white', 'initiate', 'd2');
    state.hand.white = [];
    piece(state, 'black', 'initiate', 'e3');
    const capture = legalActions(state).find((a) => a.type === 'move' && a.from === init.square && a.to === S('e3'));
    expect(capture).toBeDefined();
  });
});

describe('turn flow and resources', () => {
  it('a move ends the turn: the other side gains its mana square\'s +1 mana (no cap) and draws a card at once', () => {
    let state = bare(40);
    state.shrines = ['d4', 'e4', 'd5', 'e5'].map(S);
    piece(state, 'black', 'initiate', 'd5');
    state.deck.black = [{ uid: 'dk1', cardId: 'squire' }];
    expect(legalActions(state).some((a) => a.type === 'endTurn')).toBe(false);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1')));
    expect(state.active).toBe('black');
    expect(state.actionTaken).toBe(false);
    expect(state.mana.black).toBe(41);
    expect(state.hand.black.map((c) => c.uid)).toContain('dk1');
    expect(legalActions(state).some((a) => a.type === 'endTurn')).toBe(false);
  });

  it('cards do not end the turn: play as many as the mana pays for, then the move ends it (Djabooty, 2026-10-10)', () => {
    let state = bare(8);
    piece(state, 'white', 'initiate', 'c3');
    const squire = give(state, 'white', 'squire');
    const recruit = give(state, 'white', 'recruit');
    const insight = give(state, 'white', 'insight');
    state.deck.white = [{ uid: 'a', cardId: 'duskfang' }, { uid: 'b', cardId: 'duskfang' }];
    state = act(state, find(state, (a) => a.type === 'summon' && a.cardUid === squire && a.to === S('a1')));
    state = act(state, find(state, (a) => a.type === 'seal' && a.cardUid === recruit && a.target === S('c3')));
    state = act(state, { type: 'spell', cardUid: insight });
    expect(state.active).toBe('white');
    expect(state.mana.white).toBe(5);
    expect(state.hand.white.map((c) => c.cardId)).toEqual(['duskfang']);
    // A Duskfang costs 9, so the cards are done but for a pitch; the move is all that is left.
    expect(legalActions(state).every((a) => a.type === 'move' || a.type === 'pitch')).toBe(true);
    state = act(state, find(state, (a) => a.type === 'move'));
    expect(state.active).toBe('black');
  });

  it('casts more than one spell in a turn (Djabooty, 2026-10-10)', () => {
    const state = bare(10);
    const first = give(state, 'white', 'insight');
    const second = give(state, 'white', 'insight');
    state.deck.white = [{ uid: 'a', cardId: 'squire' }, { uid: 'b', cardId: 'squire' }, { uid: 'c', cardId: 'squire' }, { uid: 'd', cardId: 'squire' }];
    let next = act(state, { type: 'spell', cardUid: first });
    expect(next.active).toBe('white');
    expect(next.hand.white.length).toBe(2);
    next = act(next, { type: 'spell', cardUid: second });
    expect(next.active).toBe('white');
    expect(next.hand.white.map((c) => c.uid)).toEqual(['a', 'b']);
    expect(next.mana.white).toBe(8);
    next = act(next, find(next, (a) => a.type === 'move'));
    expect(next.active).toBe('black');
  });

  it('the move ends the turn even with affordable cards still in hand', () => {
    const state = bare(10);
    const insight = give(state, 'white', 'insight');
    state.deck.white = [{ uid: 'a', cardId: 'squire' }, { uid: 'b', cardId: 'squire' }];
    const next = act(state, find(state, (a) => a.type === 'move'));
    expect(next.active).toBe('black');
    expect(next.hand.white.map((c) => c.uid)).toContain(insight);
    expect(next.discard.white).toHaveLength(0);
  });

  it('a King in check must be answered first: no spell, only a move or a summon that blocks', () => {
    let state = bare(10);
    piece(state, 'black', 'initiate', 'f7');
    state.seals.push({ id: 'sw', owner: 'white', square: S('d6'), card: STARTER_CATALOG.wyrmling as PieceCard, timer: 1 });
    state.seals.push({ id: 'sq', owner: 'white', square: S('a5'), card: STARTER_CATALOG.squire as PieceCard, timer: 3 });
    give(state, 'black', 'insight');
    give(state, 'black', 'dispel');
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1') && a.to === S('c1')));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('f7') && a.to === S('f6')));
    expect(pieceAt(state, S('d6'))?.cardId).toBe('wyrmling');
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('c1') && a.to === S('b1')));
    expect(state.active).toBe('black');
    expect(isInCheck(state, 'black')).toBe(true);
    const answers = legalActions(state);
    expect(answers.some((a) => a.type === 'spell')).toBe(false);
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every((a) => !isInCheck(act(state, a), 'black'))).toBe(true);
    expect(() => act(state, { type: 'spell', cardUid: state.hand.black.find((c) => c.cardId === 'insight')!.uid })).toThrow();

    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d8') && a.to === S('c8')));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('b1') && a.to === S('a1')));
    expect(isInCheck(state, 'black')).toBe(false);
    const quiet = legalActions(state).filter((a) => a.type === 'spell');
    expect(quiet.some((a) => a.type === 'spell' && state.hand.black.find((c) => c.uid === a.cardUid)?.cardId === 'insight')).toBe(true);
    expect(quiet.some((a) => a.type === 'spell' && a.target === S('a5'))).toBe(true);
  });

  it('a summon that blocks a check answers it, and the turn goes on until the move (Djabooty, 2026-10-10)', () => {
    let state = bare(10);
    piece(state, 'black', 'warlord', 'a1');
    const squire = give(state, 'white', 'squire');
    const insight = give(state, 'white', 'insight');
    state.deck.white = [{ uid: 'a', cardId: 'recruit' }, { uid: 'b', cardId: 'recruit' }];
    expect(isInCheck(state, 'white')).toBe(true);
    const blocks = legalActions(state).filter((a): a is Extract<Action, { type: 'summon' }> => a.type === 'summon');
    expect(blocks.map((a) => a.to).sort((x, y) => x - y)).toEqual([S('b1'), S('c1')]);
    expect(legalActions(state).some((a) => a.type === 'spell')).toBe(false);
    state = act(state, find(state, (a) => a.type === 'summon' && a.cardUid === squire && a.to === S('c1')));
    expect(isInCheck(state, 'white')).toBe(false);
    expect(state.active).toBe('white');
    state = act(state, { type: 'spell', cardUid: insight });
    expect(state.active).toBe('white');
    state = act(state, find(state, (a) => a.type === 'move'));
    expect(state.active).toBe('black');
  });

  it('a game saved while an older rule held the turn open after the action can only end the turn', () => {
    let state = bare(10);
    give(state, 'white', 'insight');
    state.actionTaken = true;
    expect(legalActions(state)).toEqual([{ type: 'endTurn' }]);
    state = act(state, { type: 'endTurn' });
    expect(state.active).toBe('black');
    expect(state.actionTaken).toBe(false);
  });
});

describe('summoning', () => {
  it('costs the printed mana and goes on either of your first two rows (Djabooty, 2026-10-11)', () => {
    const state = bare(2);
    const wyrmling = give(state, 'white', 'wyrmling');
    const duskfang = give(state, 'white', 'duskfang');
    const summons = legalActions(state).filter((a): a is Extract<Action, { type: 'summon' }> => a.type === 'summon');
    expect(summons.every((a) => a.cardUid === wyrmling)).toBe(true);
    expect(summons.some((a) => a.cardUid === duskfang)).toBe(false);
    expect(summons.map((a) => a.to).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 2 * FILES }, (_, s) => s).filter((s) => s !== S('d1')),
    );
    const next = act(state, summons[0]!);
    expect(next.mana.white).toBe(0);
  });

  it('Black summons onto ranks 8 and 7, never onto a taken square', () => {
    let state = bare(5);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1') && a.to === S('e1')));
    piece(state, 'black', 'initiate', 'b7');
    const squire = give(state, 'black', 'squire');
    const to = legalActions(state)
      .filter((a): a is Extract<Action, { type: 'summon' }> => a.type === 'summon' && a.cardUid === squire)
      .map((a) => a.to);
    expect(to).toHaveLength(2 * FILES - 2);
    expect(to.every((s) => s >= S('a7'))).toBe(true);
    expect(to).not.toContain(S('b7'));
    expect(to).not.toContain(S('d8'));
  });

  it('a summoned piece cannot capture until its owner\'s next turn', () => {
    const state = bare(10);
    state.hand.white = [];
    piece(state, 'white', 'warlord', 'a1', 2);
    piece(state, 'black', 'initiate', 'a4');
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('a1') && a.to === S('a4'))).toBe(false);
    state.turns.white = 2;
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('a1') && a.to === S('a4'))).toBe(true);
  });

  it('a summoned piece gives check at once and fences the King, though it cannot capture yet', () => {
    let state = bare(10);
    state.pieces.find((p) => p.owner === 'white' && p.def.king)!.square = S('h1');
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('b2');
    const recruit = give(state, 'white', 'recruit');
    state = act(state, find(state, (a) => a.type === 'summon' && a.cardUid === recruit && a.to === S('b1')));
    expect(pieceAt(state, S('b1'))!.activeFromTurn).toBe(2);
    expect(isInCheck(state, 'black')).toBe(true);
    expect(state.active).toBe('white');
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('h1') && a.to === S('g1')));
    expect(state.active).toBe('black');
    expect(isInCheck(state, 'black')).toBe(true);
    const kingSteps = legalActions(state).filter((a) => a.type === 'move' && a.from === S('b2'));
    expect(kingSteps.some((a) => a.type === 'move' && a.to === S('a1'))).toBe(false);
    expect(kingSteps.some((a) => a.type === 'move' && a.to === S('c1'))).toBe(false);
    expect(kingSteps.some((a) => a.type === 'move' && a.to === S('a3'))).toBe(true);
  });

  it('a summoned piece cannot move until its owner\'s next turn (Djabooty, 2026-10-10)', () => {
    let state = bare(10);
    piece(state, 'black', 'initiate', 'f7');
    const squire = give(state, 'white', 'squire');
    state = act(state, find(state, (a) => a.type === 'summon' && a.cardUid === squire && a.to === S('a1')));
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('a1'))).toBe(false);
    const fresh = (s: GameState) => viewFor({ state: s, seq: 0, events: [] }, 'white').pieces.find((p) => p.square === S('a1'))!.justSummoned;
    expect(fresh(state)).toBe(true);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1')));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('f7')));
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('a1') && a.to === S('a2'))).toBe(true);
    expect(fresh(state)).toBe(false);
  });
});

describe('Dawn Paladin', () => {
  it('costs 7 (Djabooty, 2026-10-11), ends the Paladin line, and leaps like a knight or steps one square straight', () => {
    const card = STARTER_CATALOG.dawn_paladin!;
    expect(card).toMatchObject({ type: 'piece', cost: 7, line: 'Paladin', level: 3, evolvesFrom: 'paladin' });
    expect(starterDeck().filter((id) => id === 'dawn_paladin')).toHaveLength(1);
    const state = bare(0);
    piece(state, 'white', 'dawn_paladin', 'c4');
    piece(state, 'white', 'initiate', 'c5');
    piece(state, 'black', 'initiate', 'b6');
    piece(state, 'black', 'initiate', 'd4');
    const to = legalActions(state)
      .filter((a): a is Extract<Action, { type: 'move' }> => a.type === 'move' && a.from === S('c4'))
      .map((a) => a.to)
      .sort((x, y) => x - y);
    const expected = ['a3', 'a5', 'b2', 'b6', 'd2', 'd6', 'e3', 'e5', 'b4', 'c3', 'd4'].map(S).sort((x, y) => x - y);
    expect(to).toEqual(expected);
  });
});

describe('Duskfang', () => {
  it('costs 9 with no evolution line (Djabooty, 2026-10-11), seals on a 3-turn timer, steps one square diagonally and captures only with a knight leap', () => {
    const card = STARTER_CATALOG.duskfang!;
    expect(card).toMatchObject({ type: 'piece', cost: 9, sealTimer: 3, tribe: 'Beast' });
    expect(card).not.toHaveProperty('line');
    expect(card).not.toHaveProperty('evolvesFrom');
    expect(starterDeck().filter((id) => id === 'duskfang')).toHaveLength(1);
    const state = bare(0);
    piece(state, 'white', 'duskfang', 'c4');
    piece(state, 'white', 'initiate', 'b5');
    piece(state, 'black', 'initiate', 'd5');
    piece(state, 'black', 'initiate', 'b6');
    const to = legalActions(state)
      .filter((a): a is Extract<Action, { type: 'move' }> => a.type === 'move' && a.from === S('c4'))
      .map((a) => a.to)
      .sort((x, y) => x - y);
    const expected = ['b3', 'd3', 'b6'].map(S).sort((x, y) => x - y);
    expect(to).toEqual(expected);
  });
});

describe('Eclipse Knight', () => {
  it('costs 7, is the Paladin line\'s other final form (it took in Dawnfang, which moved the same), and leaps like a knight or steps one square diagonally', () => {
    const card = STARTER_CATALOG.eclipse_knight!;
    expect(card).toMatchObject({ type: 'piece', cost: 7, line: 'Paladin', level: 3, evolvesFrom: 'paladin' });
    expect(starterDeck().filter((id) => id === 'eclipse_knight')).toHaveLength(1);
    expect(STARTER_CATALOG.dawnfang).toBeUndefined();
    const state = bare(0);
    piece(state, 'white', 'eclipse_knight', 'c4');
    piece(state, 'white', 'initiate', 'b5');
    piece(state, 'white', 'initiate', 'a3');
    piece(state, 'black', 'initiate', 'd5');
    piece(state, 'black', 'initiate', 'b6');
    const to = legalActions(state)
      .filter((a): a is Extract<Action, { type: 'move' }> => a.type === 'move' && a.from === S('c4'))
      .map((a) => a.to)
      .sort((x, y) => x - y);
    const expected = ['a5', 'b2', 'b6', 'd2', 'd6', 'e3', 'e5', 'b3', 'd3', 'd5'].map(S).sort((x, y) => x - y);
    expect(to).toEqual(expected);
  });

  it('checks a King on d8 from e6 with its knight leap', () => {
    const state = bare(0);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('d8');
    piece(state, 'white', 'eclipse_knight', 'e6');
    expect(isInCheck(state, 'black')).toBe(true);
  });
});

describe('Recruit', () => {
  it('costs 1, seals on a 1-turn timer, starts the Warrior line, and steps one square straight to move or capture (the Page, msg-032)', () => {
    const card = STARTER_CATALOG.recruit!;
    expect(card).toMatchObject({ type: 'piece', cost: 1, sealTimer: 1, line: 'Warrior', level: 1 });
    expect(card).not.toHaveProperty('evolvesFrom');
    expect(starterDeck().filter((id) => id === 'recruit')).toHaveLength(2);
    const state = bare(0);
    piece(state, 'white', 'recruit', 'e3');
    piece(state, 'white', 'initiate', 'e2');
    piece(state, 'black', 'initiate', 'd3');
    const to = legalActions(state)
      .filter((a): a is Extract<Action, { type: 'move' }> => a.type === 'move' && a.from === S('e3'))
      .map((a) => a.to)
      .sort((x, y) => x - y);
    const expected = ['e4', 'd3', 'f3'].map(S).sort((x, y) => x - y);
    expect(to).toEqual(expected);
  });
});

describe('Wyrmling', () => {
  it('costs 2, seals on a 1-turn timer, starts the Dragon line, and leaps exactly two squares straight to move or capture', () => {
    const card = STARTER_CATALOG.wyrmling!;
    expect(card).toMatchObject({ type: 'piece', cost: 2, sealTimer: 1, line: 'Dragon', level: 1 });
    expect(starterDeck().filter((id) => id === 'wyrmling')).toHaveLength(2);
    const state = bare(0);
    piece(state, 'white', 'wyrmling', 'c4');
    piece(state, 'white', 'initiate', 'e4');
    piece(state, 'black', 'initiate', 'c5');
    piece(state, 'black', 'initiate', 'c6');
    const to = legalActions(state)
      .filter((a): a is Extract<Action, { type: 'move' }> => a.type === 'move' && a.from === S('c4'))
      .map((a) => a.to)
      .sort((x, y) => x - y);
    const expected = ['a4', 'c2', 'c6'].map(S).sort((x, y) => x - y);
    expect(to).toEqual(expected);
  });
});

describe('sealing', () => {
  it('seals only own non-King pieces, consumes the piece, and costs mana; the turn goes on', () => {
    const state = bare(2);
    const mine = piece(state, 'white', 'initiate', 'c3');
    piece(state, 'black', 'initiate', 'c6');
    const wyrmling = give(state, 'white', 'wyrmling');
    const seals = legalActions(state).filter((a) => a.type === 'seal');
    expect(seals).toHaveLength(1);
    expect(seals[0]).toMatchObject({ target: mine.square });
    const next = act(state, seals[0]!);
    expect(pieceAt(next, mine.square)).toBeUndefined();
    expect(sealAt(next, mine.square)?.card.id).toBe('wyrmling');
    expect(next.mana.white).toBe(0);
    expect(next.hand.white.some((c) => c.uid === wyrmling)).toBe(false);
    expect(next.active).toBe('white');
  });

  it('a timer-1 seal hatches at the start of its owner\'s next turn, after exactly one enemy move', () => {
    let state = bare(5);
    piece(state, 'white', 'initiate', 'c3');
    const squire = give(state, 'white', 'squire');
    state = act(state, find(state, (a) => a.type === 'seal' && a.cardUid === squire));
    expect(sealAt(state, S('c3'))?.timer).toBe(1);
    state = act(state, find(state, (a) => a.type === 'move'));
    expect(state.active).toBe('black');
    state = act(state, find(state, (a) => a.type === 'move'));
    expect(sealAt(state, S('c3'))).toBeUndefined();
    const hatched = pieceAt(state, S('c3'))!;
    expect(hatched.def.kind).toBe('squire');
    expect(hatched.activeFromTurn).toBe(state.turns.white + 1);
    // Unlike a summoned piece, a hatched one may move at once; it only cannot capture yet.
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('c3'))).toBe(true);
  });

  it('a timer-3 seal waits three of its owner\'s turns', () => {
    let state = bare(15);
    piece(state, 'white', 'initiate', 'c3');
    const duskfang = give(state, 'white', 'duskfang');
    state = act(state, find(state, (a) => a.type === 'seal' && a.cardUid === duskfang));
    state = act(state, find(state, (a) => a.type === 'move'));
    for (let round = 1; round <= 3; round++) {
      state = act(state, find(state, (a) => a.type === 'move'));
      if (round < 3) {
        expect(sealAt(state, S('c3'))?.timer).toBe(3 - round);
        state = act(state, find(state, (a) => a.type === 'move'));
      }
    }
    expect(pieceAt(state, S('c3'))?.def.kind).toBe('duskfang');
  });

  it('blocks movement and lines of attack like any piece', () => {
    const state = bare(0);
    state.pieces.find((p) => p.owner === 'white')!.square = S('a1');
    piece(state, 'black', 'warlord', 'a8');
    state.seals.push({ id: 's1', owner: 'white', square: S('a4'), card: STARTER_CATALOG.squire as never, timer: 2 });
    expect(isInCheck(state, 'white')).toBe(false);
    state.seals = [];
    expect(isInCheck(state, 'white')).toBe(true);
  });

  it('capturing the seal square destroys the seal and sends its card to the discard pile; nothing hatches', () => {
    let state = bare(5);
    piece(state, 'white', 'initiate', 'c3');
    piece(state, 'black', 'initiate', 'b4');
    const squire = give(state, 'white', 'squire');
    state = act(state, find(state, (a) => a.type === 'seal' && a.cardUid === squire));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1')));
    state = act(state, find(state, (a) => a.type === 'move' && a.to === S('c3')));
    expect(sealAt(state, S('c3'))).toBeUndefined();
    expect(state.discard.white.map((c) => c.cardId)).toContain('squire');
    expect(state.active).toBe('white');
    expect(pieceAt(state, S('c3'))?.owner).toBe('black');
  });

  it('a seal keeps blocking the line the sealed piece was blocking', () => {
    const state = bare(5);
    state.pieces.find((p) => p.owner === 'white')!.square = S('a1');
    piece(state, 'white', 'initiate', 'a2');
    piece(state, 'black', 'warlord', 'a8');
    const squire = give(state, 'white', 'squire');
    const sealMove = find(state, (a) => a.type === 'seal' && a.cardUid === squire);
    expect(isInCheck(act(state, sealMove), 'white')).toBe(false);
  });
});

describe('evolving (Djabooty, 2026-10-11)', () => {
  const moveTargets = (state: GameState, from: string) =>
    legalActions(state)
      .filter((a): a is Extract<Action, { type: 'move' }> => a.type === 'move' && a.from === S(from))
      .map((a) => a.to)
      .sort((x, y) => x - y);

  it('changes your piece into the next level on its square, for the printed mana; the turn goes on', () => {
    const state = bare(2);
    const recruit = piece(state, 'white', 'recruit', 'c3');
    const warrior = give(state, 'white', 'warrior');
    expect(legalActions(state).some((a) => a.type === 'evolve')).toBe(false);
    state.mana.white = 5;
    const evolves = legalActions(state).filter((a) => a.type === 'evolve');
    expect(evolves).toEqual([{ type: 'evolve', cardUid: warrior, target: S('c3') }]);
    const { state: next, events } = applyLegalAction(state, evolves[0]!);
    const evolved = pieceAt(next, S('c3'))!;
    expect(evolved).toMatchObject({ owner: 'white', cardId: 'warrior' });
    expect(evolved.def.kind).toBe('warrior');
    expect(next.pieces.some((p) => p.id === recruit.id)).toBe(false);
    expect(next.mana.white).toBe(1);
    expect(next.hand.white).toHaveLength(0);
    expect(next.active).toBe('white');
    expect(next.cardPlayed).toBe(true);
    expect(events).toContainEqual({
      type: 'evolved',
      color: 'white',
      pieceId: evolved.id,
      fromPieceId: recruit.id,
      square: S('c3'),
      name: 'Warrior',
      fromName: 'Recruit',
      cardId: 'warrior',
      cost: 4,
    });
  });

  it('the new piece waits like a summoned one, then moves with its new reach', () => {
    let state = bare(5);
    piece(state, 'white', 'recruit', 'c3');
    piece(state, 'black', 'initiate', 'c6');
    piece(state, 'black', 'initiate', 'h7');
    const warrior = give(state, 'white', 'warrior');
    state = act(state, find(state, (a) => a.type === 'evolve' && a.cardUid === warrior));
    expect(moveTargets(state, 'c3')).toEqual([]);
    const shown = viewFor({ state, seq: 0, events: [] }, 'white').pieces.find((p) => p.square === S('c3'))!;
    expect(shown).toMatchObject({ active: false, justSummoned: true });
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1') && a.to === S('e1')));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('h7') && a.to === S('h6')));
    expect(moveTargets(state, 'c3')).toEqual(['c4', 'c5', 'c6', 'c2', 'c1', 'b3', 'a3', 'd3', 'e3', 'f3'].map(S).sort((x, y) => x - y));
  });

  it('only a piece that was on the board before this turn can evolve: not one summoned, hatched or evolved this turn', () => {
    let state = bare(20);
    piece(state, 'white', 'initiate', 'c3');
    const summoned = give(state, 'white', 'recruit');
    const sealed = give(state, 'white', 'recruit');
    const first = give(state, 'white', 'warrior');
    const second = give(state, 'white', 'warrior');
    const warlord = give(state, 'white', 'warlord');
    state = act(state, find(state, (a) => a.type === 'summon' && a.cardUid === summoned && a.to === S('a1')));
    state = act(state, find(state, (a) => a.type === 'seal' && a.cardUid === sealed && a.target === S('c3')));
    expect(legalActions(state).some((a) => a.type === 'evolve')).toBe(false);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1') && a.to === S('e1')));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d8')));
    // The seal on c3 hatched as this turn began, so only the Recruit summoned last turn can evolve.
    expect(pieceAt(state, S('c3'))?.cardId).toBe('recruit');
    const targets = legalActions(state).filter((a) => a.type === 'evolve').map((a) => a.type === 'evolve' && a.target);
    expect(new Set(targets)).toEqual(new Set([S('a1')]));
    state = act(state, find(state, (a) => a.type === 'evolve' && a.cardUid === first && a.target === S('a1')));
    expect(legalActions(state).some((a) => a.type === 'evolve' && a.cardUid === warlord)).toBe(false);
    expect(legalActions(state).some((a) => a.type === 'evolve' && a.cardUid === second)).toBe(false);
  });

  it('goes only onto the card it evolves from (or an Initiate), and an evolution card is never summoned or sealed', () => {
    const state = bare(20);
    piece(state, 'white', 'recruit', 'c3');
    piece(state, 'white', 'initiate', 'e3');
    const warlord = give(state, 'white', 'warlord');
    const archmage = give(state, 'white', 'archmage');
    const mage = give(state, 'white', 'mage');
    const played = legalActions(state).filter((a) => a.type !== 'pitch' && 'cardUid' in a);
    // Level 3 goes onto nothing here; the Mage (level 2) only onto the Initiate, since there is no Apprentice.
    expect(played).toEqual([{ type: 'evolve', cardUid: mage, target: S('e3') }]);
    expect(played.some((a) => 'cardUid' in a && (a.cardUid === warlord || a.cardUid === archmage))).toBe(false);
  });

  it('Initiates take any path (Djabooty, 2026-10-11): a level-2 card goes onto one for its cost plus the level it skips', () => {
    const state = bare(5);
    const initiate = piece(state, 'white', 'initiate', 'e3');
    const warrior = give(state, 'white', 'warrior');
    const paladin = give(state, 'white', 'paladin');
    const mystic = give(state, 'white', 'mystic_dragon');
    const onto = (s: GameState) => legalActions(s).filter((a) => a.type === 'evolve').map((a) => a.type === 'evolve' && a.cardUid);
    // Warrior 4 + Recruit 1 = 5; Paladin 4 + Colt 2 = 6; Mystic Dragon 6 + Wyrmling 2 = 8.
    expect(onto(state)).toEqual([warrior]);
    state.mana.white = 8;
    expect(onto(state).sort()).toEqual([warrior, paladin, mystic].sort());
    const { state: next, events } = applyLegalAction(state, { type: 'evolve', cardUid: paladin, target: S('e3') });
    expect(next.mana.white).toBe(2);
    expect(pieceAt(next, S('e3'))).toMatchObject({ cardId: 'paladin', activeFromTurn: 2, summonedOnTurn: 1 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'evolved', fromPieceId: initiate.id, fromName: 'Initiate', name: 'Paladin', cost: 6 }));
  });

  it('a game whose cards came before any path keeps its Initiates on their own path', () => {
    const state = bare(20);
    state.catalog = { ...state.catalog, initiate: { ...(STARTER_CATALOG.initiate as PieceCard), anyPath: undefined } };
    piece(state, 'white', 'initiate', 'e3');
    give(state, 'white', 'warrior');
    expect(legalActions(state).some((a) => a.type === 'evolve')).toBe(false);
  });

  it('the Paladin has two final forms to choose from', () => {
    const state = bare(12);
    piece(state, 'white', 'paladin', 'c3');
    const dawn = give(state, 'white', 'dawn_paladin');
    const eclipse = give(state, 'white', 'eclipse_knight');
    const cards = legalActions(state).filter((a) => a.type === 'evolve').map((a) => a.type === 'evolve' && a.cardUid);
    expect(cards.sort()).toEqual([dawn, eclipse].sort());
  });

  it('an evolved piece gives check at once, and evolving never answers a check', () => {
    let state = bare(10);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('f6');
    piece(state, 'white', 'wyrmling', 'd4');
    piece(state, 'black', 'recruit', 'h7');
    give(state, 'black', 'warrior');
    const mystic = give(state, 'white', 'mystic_dragon');
    expect(isInCheck(state, 'black')).toBe(false);
    state = act(state, find(state, (a) => a.type === 'evolve' && a.cardUid === mystic));
    expect(isInCheck(state, 'black')).toBe(true);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1') && a.to === S('e1')));
    expect(state.active).toBe('black');
    expect(legalActions(state).some((a) => a.type === 'evolve')).toBe(false);
    expect(legalActions(state).length).toBeGreaterThan(0);
  });

  it('the Dragon line: a Wyrmling grows into a Mystic Dragon, then into a full queen, one level at a time', () => {
    let state = bare(20);
    // d4 is a mana square here: it pays the Dragon's side 1 mana as White's next turn starts.
    state.shrines = ['d4', 'e4', 'd5', 'e5'].map(S);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    piece(state, 'white', 'wyrmling', 'd4');
    const mystic = give(state, 'white', 'mystic_dragon');
    const ancient = give(state, 'white', 'ancient_mystic_dragon');
    expect(moveTargets(state, 'd4')).toHaveLength(4);
    expect(legalActions(state).some((a) => a.type === 'evolve' && a.cardUid === ancient)).toBe(false);
    state = act(state, find(state, (a) => a.type === 'evolve' && a.cardUid === mystic));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1') && a.to === S('e1')));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('a8') && a.to === S('b8')));
    // Range 2 in all eight directions (Djabooty, 2026-10-11).
    expect(moveTargets(state, 'd4')).toHaveLength(16);
    state = act(state, find(state, (a) => a.type === 'evolve' && a.cardUid === ancient));
    expect(state.mana.white).toBe(20 - 6 + 1 - 10);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('e1') && a.to === S('f1')));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('b8') && a.to === S('a8')));
    expect(pieceAt(state, S('d4'))?.def.kind).toBe('ancient_mystic_dragon');
    expect(moveTargets(state, 'd4')).toHaveLength(27);
  });

  it('a game saved before the evolution lines keeps its own cards', () => {
    const state = bare(5);
    const tower: PieceCard = {
      type: 'piece',
      id: 'tower',
      name: 'Tower',
      cost: 5,
      sealTimer: 3,
      piece: { kind: 'tower', name: 'Tower', rules: [{ dirs: [[1, 0], [-1, 0], [0, 1], [0, -1]], range: 8 }] },
    };
    state.catalog = { ...state.catalog, tower };
    const uid = give(state, 'white', 'tower');
    const next = act(state, find(state, (a) => a.type === 'summon' && a.cardUid === uid && a.to === S('a1')));
    expect(pieceAt(next, S('a1'))?.def.kind).toBe('tower');
  });
});

describe('spells', () => {
  it('Dispel destroys a seal, sending the card to its owner\'s discard pile; spells do not destroy seals otherwise', () => {
    let state = bare(5);
    state.seals.push({ id: 's1', owner: 'black', square: S('c6'), card: STARTER_CATALOG.duskfang as never, timer: 3 });
    const dispel = give(state, 'white', 'dispel');
    const insight = give(state, 'white', 'insight');
    expect(legalActions(state).filter((a) => a.type === 'spell' && a.cardUid === insight)).toHaveLength(1);
    state = act(state, { type: 'spell', cardUid: dispel, target: S('c6') });
    expect(sealAt(state, S('c6'))).toBeUndefined();
    expect(state.discard.black.map((c) => c.cardId)).toContain('duskfang');
  });

  it('Dispel costs 3 mana, so 2 mana cannot cast it', () => {
    expect(STARTER_CATALOG.dispel).toMatchObject({ type: 'spell', cost: 3 });
    const state = bare(2);
    state.seals.push({ id: 's1', owner: 'black', square: S('c6'), card: STARTER_CATALOG.duskfang as never, timer: 3 });
    const dispel = give(state, 'white', 'dispel');
    expect(legalActions(state).some((a) => a.type === 'spell' && a.cardUid === dispel)).toBe(false);
    state.mana.white = 3;
    expect(legalActions(state).some((a) => a.type === 'spell' && a.cardUid === dispel)).toBe(true);
  });
});

describe('Mana Surge, Resurrect, Shield, Freeze and Smite (Djabooty, 2026-10-12)', () => {
  type SpellAction = Extract<Action, { type: 'spell' }>;
  const casts = (state: GameState, uid: string): SpellAction[] =>
    legalActions(state).filter((a): a is SpellAction => a.type === 'spell' && a.cardUid === uid);
  const viewed = (state: GameState, square: string) =>
    viewFor({ state, seq: 0, events: [] }, 'white').pieces.find((p) => p.square === S(square));

  it('Mana Surge costs 1 and gains 3 mana, leaving you 2 ahead', () => {
    const state = bare(1);
    const surge = give(state, 'white', 'mana_surge');
    expect(casts(state, surge)).toEqual([{ type: 'spell', cardUid: surge }]);
    const { state: next, events } = applyLegalAction(state, { type: 'spell', cardUid: surge });
    expect(next.mana.white).toBe(3);
    expect(events).toContainEqual({ type: 'manaGained', color: 'white', mana: 3 });
    expect(next.discard.white.map((c) => c.cardId)).toEqual(['mana_surge']);
  });

  it('a captured piece goes on its captor\'s discard pile; a sacrificed one and the card a piece evolved from on its owner\'s', () => {
    let state = bare(20);
    piece(state, 'white', 'recruit', 'c3');
    piece(state, 'white', 'initiate', 'f3');
    piece(state, 'white', 'warlord', 'h1');
    piece(state, 'black', 'apprentice', 'h6');
    const warrior = give(state, 'white', 'warrior');
    const colt = give(state, 'white', 'colt');
    state = act(state, find(state, (a) => a.type === 'evolve' && a.cardUid === warrior && a.target === S('c3')));
    state = act(state, find(state, (a) => a.type === 'seal' && a.cardUid === colt && a.target === S('f3')));
    expect(state.discard.white.map((c) => c.cardId)).toEqual(['recruit', 'initiate']);
    const { state: next, events } = applyLegalAction(state, find(state, (a) => a.type === 'move' && a.from === S('h1') && a.to === S('h6')));
    expect(next.discard.white.map((c) => c.cardId)).toEqual(['recruit', 'initiate', 'apprentice']);
    expect(next.discard.black).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'captured', cardId: 'apprentice', bounty: 1 }));
  });

  it('Resurrect raises a piece card costing 4 or less from your discard pile, as your piece, onto your first two rows', () => {
    const state = bare(10);
    state.discard.white = [
      { uid: 'dw1', cardId: 'warrior' },
      { uid: 'dw2', cardId: 'duskfang' },
      { uid: 'dw3', cardId: 'insight' },
      { uid: 'dw4', cardId: 'mage' },
      { uid: 'dw5', cardId: 'mage' },
    ];
    state.discard.black = [{ uid: 'db1', cardId: 'colt' }];
    const resurrect = give(state, 'white', 'resurrect');
    // Duskfang costs 9, Insight is a spell, the Colt is in Black's pile, and of the two Mages the newest is offered.
    expect([...new Set(casts(state, resurrect).map((a) => a.pick))].sort()).toEqual(['dw1', 'dw5']);
    const squares = casts(state, resurrect).filter((a) => a.pick === 'dw5').map((a) => a.target);
    expect(squares).toContain(S('a2'));
    expect(squares).not.toContain(S('d1'));
    expect(squares).not.toContain(S('a3'));
    expect(() => act(state, { type: 'spell', cardUid: resurrect, target: S('a2'), pick: 'db1' })).toThrow();

    const { state: next, events } = applyLegalAction(state, { type: 'spell', cardUid: resurrect, target: S('a2'), pick: 'dw5' });
    expect(pieceAt(next, S('a2'))).toMatchObject({ owner: 'white', cardId: 'mage' });
    expect(next.discard.white.map((c) => c.uid).slice(0, 4)).toEqual(['dw1', 'dw2', 'dw3', 'dw4']);
    expect(next.discard.white.map((c) => c.cardId).slice(4)).toEqual(['resurrect']);
    expect(next.discard.black.map((c) => c.uid)).toEqual(['db1']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'raised', color: 'white', cardId: 'mage', square: S('a2') }));
    // It waits like a summoned piece.
    expect(legalActions(next).some((a) => a.type === 'move' && a.from === S('a2'))).toBe(false);
  });

  it('an enemy piece you capture can rise again on your side', () => {
    let state = bare(20);
    piece(state, 'white', 'warlord', 'h1');
    piece(state, 'black', 'apprentice', 'h6');
    const resurrect = give(state, 'white', 'resurrect');
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('h1') && a.to === S('h6')));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d8') && a.to === S('e8')));
    state = act(state, find(state, (a) => a.type === 'spell' && a.cardUid === resurrect && a.target === S('a1')));
    expect(pieceAt(state, S('a1'))).toMatchObject({ owner: 'white', cardId: 'apprentice' });
  });

  it('Resurrect has nothing to cast with no piece card it can reach', () => {
    const state = bare(10);
    state.discard.white = [{ uid: 'dw1', cardId: 'duskfang' }];
    state.discard.black = [{ uid: 'db1', cardId: 'initiate' }];
    const resurrect = give(state, 'white', 'resurrect');
    expect(casts(state, resurrect)).toEqual([]);
  });

  it('Shield: until your next turn the piece cannot be captured, and enemy spells cannot touch it', () => {
    let state = bare(10);
    piece(state, 'white', 'recruit', 'c4');
    piece(state, 'black', 'warlord', 'c8');
    give(state, 'black', 'smite');
    give(state, 'black', 'freeze');
    const shield = give(state, 'white', 'shield');
    expect(casts(state, shield).map((a) => a.target)).toEqual([S('c4')]);
    state = act(state, { type: 'spell', cardUid: shield, target: S('c4') });
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1') && a.to === S('e1')));
    expect(viewed(state, 'c4')?.shielded).toBe(true);
    expect(legalActions(state).some((a) => a.type === 'move' && a.to === S('c4'))).toBe(false);
    expect(legalActions(state).some((a) => a.type === 'spell' && a.target === S('c4'))).toBe(false);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d8') && a.to === S('e8')));
    expect(viewed(state, 'c4')?.shielded).toBeUndefined();
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('e1') && a.to === S('f1')));
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('c8') && a.to === S('c4'))).toBe(true);
  });

  it('Freeze: the enemy piece cannot move or capture on its owner\'s next turn, but still attacks', () => {
    let state = bare(10);
    piece(state, 'black', 'warlord', 'h2');
    const freeze = give(state, 'white', 'freeze');
    expect(casts(state, freeze).map((a) => a.target)).toEqual([S('h2')]);
    state = act(state, { type: 'spell', cardUid: freeze, target: S('h2') });
    expect(viewed(state, 'h2')?.frozen).toBe(true);
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('d1') && a.to === S('d2'))).toBe(false);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1') && a.to === S('c1')));
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('h2'))).toBe(false);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d8') && a.to === S('e8')));
    expect(viewed(state, 'h2')?.frozen).toBeUndefined();
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('c1') && a.to === S('b1')));
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('h2'))).toBe(true);
  });

  it('Smite destroys an enemy piece whose card costs 2 or less, for no bounty; its card goes to its owner\'s discard pile', () => {
    const state = bare(10);
    piece(state, 'black', 'colt', 'b6');
    piece(state, 'black', 'mage', 'g6');
    const smite = give(state, 'white', 'smite');
    expect(casts(state, smite).map((a) => a.target)).toEqual([S('b6')]);
    const { state: next, events } = applyLegalAction(state, { type: 'spell', cardUid: smite, target: S('b6') });
    expect(pieceAt(next, S('b6'))).toBeUndefined();
    expect(next.discard.black.map((c) => c.cardId)).toEqual(['colt']);
    expect(next.mana.white).toBe(7);
    expect(events).toContainEqual(expect.objectContaining({ type: 'destroyed', color: 'white', owner: 'black', cardId: 'colt', square: S('b6') }));
    expect(events.some((e) => e.type === 'captured')).toBe(false);
  });

  it('Smite cannot remove a piece that blocks an enemy line onto your own King', () => {
    const state = bare(10);
    piece(state, 'black', 'warlord', 'd6');
    piece(state, 'black', 'squire', 'd4');
    const smite = give(state, 'white', 'smite');
    expect(casts(state, smite)).toEqual([]);
  });

  it('a Smite that opens a line onto the enemy King gives check: the King is never taken', () => {
    const state = bare(10);
    piece(state, 'white', 'warlord', 'd3');
    piece(state, 'black', 'recruit', 'd6');
    const smite = give(state, 'white', 'smite');
    const opened = act(state, { type: 'spell', cardUid: smite, target: S('d6') });
    expect(legalActions(opened).some((a) => a.type === 'move' && a.to === S('d8'))).toBe(false);
    const { state: next, events } = applyLegalAction(opened, { type: 'move', from: S('d3'), to: S('d4') });
    expect(next.status.kind).toBe('playing');
    expect(events).toContainEqual({ type: 'check', color: 'black' });
  });

  it('no spell answers a check, not even a Smite on the checking piece', () => {
    const state = bare(10);
    piece(state, 'black', 'recruit', 'd2');
    give(state, 'white', 'smite');
    give(state, 'white', 'shield');
    give(state, 'white', 'mana_surge');
    expect(isInCheck(state, 'white')).toBe(true);
    expect(legalActions(state).some((a) => a.type === 'spell')).toBe(false);
  });

  it('tells the client what each spell does', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    expect(cards.resurrect).toMatchObject({ spell: 'raise', maxCost: 4 });
    expect(cards.smite).toMatchObject({ spell: 'destroyPiece', maxCost: 2 });
    expect(cards.shield).toMatchObject({ spell: 'shield' });
    expect(cards.lava_breath).toMatchObject({ spell: 'grant', grants: 'lavaBreath' });
  });
});

describe('mana (Djabooty, 2026-10-11)', () => {
  /**
   * Plays King shuffles until White has started `turn` turns, returning the turnStarted events White got, in a game with
   * a turn income (begun before the center squares); `old`: begun before that income was capped at +2.
   */
  function playTo(turn: number, old = false): { state: GameState; incomes: number[] } {
    let state = bare(0);
    delete state.shrines;
    state.maxIncome = MAX_INCOME;
    if (old) delete state.maxIncome;
    state.turns = { white: 0, black: 0 };
    state.active = 'black';
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    const incomes: number[] = [];
    while (state.turns.white < turn) {
      const { state: next, events } = applyLegalAction(state, find(state, (a) => a.type === 'move' && a.from === kingAt(state)));
      for (const e of events) if (e.type === 'turnStarted' && e.color === 'white') incomes.push(e.income!);
      state = next;
    }
    return { state, incomes };
  }
  const kingAt = (state: GameState) => state.pieces.find((p) => p.owner === state.active && p.def.king)!.square;

  it('a turn income is +1 on turns 1 to 5, then +2 for good (Djabooty, 2026-10-17: late games had too much mana)', () => {
    expect(Array.from({ length: 20 }, (_, i) => incomeFor(i + 1))).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const turnIncome = newGame({ seed: 7, decks: { white: starterDeck(), black: starterDeck() }, shrines: false });
    expect(turnIncome).toMatchObject({ maxIncome: 2, mana: { white: 3, black: 2 } });
    expect(turnIncome.shrines).toBeUndefined();
    const { state, incomes } = playTo(16);
    expect(incomes).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(state.mana.white).toBe(27);
    expect(viewFor({ state, seq: 0, events: [] }, 'white').maxIncome).toBe(2);
    expect(viewFor({ state, seq: 0, events: [] }, 'white').shrines).toBeUndefined();
    // The view shows what the side to move got this turn and what the other side's next turn brings.
    const { state: fifth } = playTo(5);
    const blackToMove = act(fifth, find(fifth, (a) => a.type === 'move' && a.from === kingAt(fifth)));
    expect(viewFor({ state: blackToMove, seq: 0, events: [] }, 'white').income).toEqual({ white: 2, black: 1 });
  });

  it('a game begun before the cap keeps the old ramp: +3 on turns 11 to 15, then +4', () => {
    expect(Array.from({ length: 20 }, (_, i) => incomeFor(i + 1, 4))).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4]);
    const { state, incomes } = playTo(16, true);
    expect(incomes).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4]);
    expect(state.mana.white).toBe(34);
    expect(state.maxIncome).toBeUndefined();
    expect(viewFor({ state, seq: 0, events: [] }, 'white')).toMatchObject({ maxIncome: 4, income: { white: 4, black: 4 } });
  });

  it('pitches a card from the hand for +1 mana, once a turn; it counts as a card for End turn', () => {
    let state = bare(0);
    const squire = give(state, 'white', 'squire');
    const dispel = give(state, 'white', 'dispel');
    const pitches = legalActions(state).filter((a) => a.type === 'pitch');
    expect(pitches).toEqual([{ type: 'pitch', cardUid: squire }, { type: 'pitch', cardUid: dispel }]);
    const { state: next, events } = applyLegalAction(state, { type: 'pitch', cardUid: dispel });
    expect(next.mana.white).toBe(1);
    expect(next.discard.white.map((c) => c.uid)).toEqual([dispel]);
    expect(next.hand.white.map((c) => c.uid)).toEqual([squire]);
    expect(next.active).toBe('white');
    expect(next.cardPlayed).toBe(true);
    expect(events).toEqual([{ type: 'pitched', color: 'white', cardId: 'dispel', mana: 1 }]);
    expect(legalActions(next).some((a) => a.type === 'pitch')).toBe(false);
    expect(viewFor({ state: next, seq: 0, events: [] }, 'white').pitched).toBe(true);
    // The pitched mana pays for a card at once, and next turn the pitch is back.
    expect(legalActions(next).some((a) => a.type === 'summon' && a.cardUid === squire)).toBe(true);
    state = act(next, find(next, (a) => a.type === 'move'));
    state = act(state, find(state, (a) => a.type === 'move'));
    expect(legalActions(state).some((a) => a.type === 'pitch' && a.cardUid === squire)).toBe(true);
  });

  it('cannot pitch while in check', () => {
    const state = bare(0);
    piece(state, 'black', 'warlord', 'a1');
    give(state, 'white', 'squire');
    expect(isInCheck(state, 'white')).toBe(true);
    expect(legalActions(state).some((a) => a.type === 'pitch')).toBe(false);
  });

  it('a capture pays half the captured card\'s cost, rounded up', () => {
    let state = bare(0);
    piece(state, 'white', 'warlord', 'a2');
    piece(state, 'black', 'warrior', 'a5');
    piece(state, 'black', 'initiate', 'h5');
    const { state: next, events } = applyLegalAction(state, { type: 'move', from: S('a2'), to: S('a5') });
    expect(next.mana.white).toBe(2);
    expect(events[0]).toMatchObject({ type: 'captured', name: 'Warrior', owner: 'black', cardId: 'warrior', bounty: 2 });
    state = act(next, find(next, (a) => a.type === 'move' && a.from === S('d8')));
    const mana = state.mana.white;
    state = act(state, { type: 'move', from: S('a5'), to: S('h5') });
    expect(state.mana.white).toBe(mana);
    expect(bountyFor(STARTER_CATALOG.duskfang)).toBe(5);
    expect(bountyFor(STARTER_CATALOG.squire)).toBe(1);
  });

  it('destroying a sacrifice pays nothing', () => {
    let state = bare(0);
    piece(state, 'white', 'warlord', 'a2');
    state.seals.push({ id: 's1', owner: 'black', square: S('a6'), card: STARTER_CATALOG.duskfang as PieceCard, timer: 2 });
    state = act(state, { type: 'move', from: S('a2'), to: S('a6') });
    expect(state.mana.white).toBe(0);
  });
});

describe('the mana squares (Djabooty, 2026-10-20)', () => {
  const CENTER = ['d4', 'e4', 'd5', 'e5'].map(S);
  const started = (events: GameEvent[]) => events.find((e) => e.type === 'turnStarted');
  const kingMove = (state: GameState) => find(state, (a) => a.type === 'move' && a.from === state.pieces.find((p) => p.owner === state.active && p.def.king)!.square);
  /** A bare position whose mana squares are the center, with `well` mana left in them. */
  function centered(well = WELL): GameState {
    const state = bare(0);
    state.shrines = [...CENTER];
    state.well = well;
    return state;
  }

  it('a new game has no turn income: 6 mana each, turn 1 brings nothing, and 12 mana wait in the squares', () => {
    const state = game();
    expect(state.maxIncome).toBeUndefined();
    expect(state.well).toBe(WELL);
    const { state: next, events } = applyLegalAction(state, find(state, (a) => a.type === 'move' && a.from === S('c2') && a.to === S('c3')));
    expect(started(events)).toMatchObject({ color: 'black', turn: 1, mana: 6, income: 0, held: [] });
    expect(next.mana).toEqual({ white: 6, black: 6 });
  });

  it('the squares are mirrored left to right and top to bottom, in the middle four rows, and differ from game to game', () => {
    expect(SHRINE_LAYOUTS).toHaveLength(8);
    for (const layout of SHRINE_LAYOUTS) {
      for (const square of layout) {
        const [file, rank] = [square % 8, Math.floor(square / 8)];
        expect(rank).toBeGreaterThanOrEqual(2);
        expect(rank).toBeLessThanOrEqual(5);
        expect(layout).toContain(rank * 8 + (7 - file));
        expect(layout).toContain((7 - rank) * 8 + file);
      }
    }
    expect(SHRINE_LAYOUTS).toContainEqual(CENTER);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const shrines = game(seed).shrines!;
      expect(SHRINE_LAYOUTS).toContainEqual(shrines);
      seen.add(shrines.join());
    }
    expect(seen.size).toBeGreaterThan(4);
  });

  it('each mana square a piece of yours stands on pays 1 mana at the start of your turn', () => {
    let state = centered();
    piece(state, 'white', 'initiate', 'd4');
    piece(state, 'white', 'recruit', 'e5');
    piece(state, 'black', 'initiate', 'd5');
    let result = applyLegalAction(state, kingMove(state));
    expect(started(result.events)).toMatchObject({ color: 'black', income: 1, held: [S('d5')] });
    expect(result.state.mana.black).toBe(1);
    state = result.state;
    result = applyLegalAction(state, kingMove(state));
    expect(started(result.events)).toMatchObject({ color: 'white', income: 2, held: [S('d4'), S('e5')] });
    expect(result.state.mana.white).toBe(2);
    expect(result.state.well).toBe(WELL - 3);
  });

  it('pays only what is still held when the turn starts: a holder taken in between earns nothing', () => {
    let state = centered();
    piece(state, 'white', 'initiate', 'd4');
    piece(state, 'black', 'initiate', 'e5');
    state = act(state, kingMove(state));
    expect(state.mana.black).toBe(1);
    const { state: after, events } = applyLegalAction(state, { type: 'move', from: S('e5'), to: S('d4') });
    expect(started(events)).toMatchObject({ color: 'white', income: 0, held: [] });
    expect(after.mana.white).toBe(0);
    expect(viewFor({ state: after, seq: 0, events: [] }, 'white').income).toEqual({ white: 0, black: 1 });
  });

  it('neither a sacrifice waiting on one nor a King standing on one holds it', () => {
    const state = centered();
    state.seals.push({ id: 's1', owner: 'black', square: S('e4'), card: STARTER_CATALOG.colt as PieceCard, timer: 3 });
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('d5');
    piece(state, 'black', 'recruit', 'e5');
    const { events } = applyLegalAction(state, kingMove(state));
    expect(started(events)).toMatchObject({ color: 'black', income: 1, held: [S('e5')] });
  });

  it('the view shows the mana squares, the mana left in them and what each side holds now', () => {
    const state = centered(9);
    piece(state, 'white', 'initiate', 'e4');
    piece(state, 'black', 'initiate', 'd5');
    piece(state, 'black', 'recruit', 'e5');
    const view = viewFor({ state, seq: 0, events: [] }, 'white');
    expect(view.shrines).toEqual(CENTER);
    expect(view.well).toBe(9);
    expect(view.income).toEqual({ white: 1, black: 2 });
    expect(view.maxIncome).toBe(4);
  });

  it('the last of the mana pays only as far as it goes', () => {
    let state = centered(1);
    piece(state, 'white', 'initiate', 'd4');
    piece(state, 'white', 'recruit', 'e4');
    state = act(state, kingMove(state));
    const { state: after, events } = applyLegalAction(state, kingMove(state));
    expect(started(events)).toMatchObject({ color: 'white', income: 1, held: [S('d4')] });
    expect(after.well).toBe(0);
  });

  it('dry squares move as the next turn starts, to another mirrored layout of empty squares, and fill up again', () => {
    let state = centered(1);
    piece(state, 'black', 'initiate', 'd5');
    // One square of every other layout but c4, f4, c5 and f5 is taken.
    for (const square of ['a3', 'b3', 'c3', 'd3', 'a4', 'b4']) piece(state, 'white', 'recruit', square);
    state = act(state, kingMove(state));
    expect(state.well).toBe(0);
    expect(state.shrines).toEqual(CENTER);
    // Black drained them on its turn; they move as White's starts, so White is first to the new ones.
    const { state: after, events } = applyLegalAction(state, kingMove(state));
    const moved = ['c4', 'f4', 'c5', 'f5'].map(S);
    expect(events[events.findIndex((e) => e.type === 'shrinesMoved')]).toEqual({ type: 'shrinesMoved', from: CENTER, to: moved });
    expect(events.findIndex((e) => e.type === 'shrinesMoved')).toBeLessThan(events.findIndex((e) => e.type === 'turnStarted'));
    expect(started(events)).toMatchObject({ color: 'white', income: 0, held: [] });
    expect(after.shrines).toEqual(moved);
    expect(after.well).toBe(WELL);
  });

  it('games begun on the morning of 2026-10-20 keep their center for good: it never runs dry', () => {
    let state = centered();
    delete state.well;
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    piece(state, 'white', 'initiate', 'd4');
    for (let i = 0; i < 30; i++) state = act(state, kingMove(state));
    expect(state.shrines).toEqual(CENTER);
    expect(state.mana.white).toBe(15);
    expect(state.well).toBeUndefined();
    expect(viewFor({ state, seq: 0, events: [] }, 'white').well).toBeUndefined();
  });
});

describe('Lava Breath (Djabooty, 2026-10-11)', () => {
  /** White to move with a Dragon on d4 that knows Lava Breath. */
  function breather(mana = 5, cardId = 'wyrmling'): GameState {
    const state = bare(mana);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('h8');
    piece(state, 'white', cardId, 'd4').abilities = ['lavaBreath'];
    return state;
  }
  const lavaTargets = (state: GameState) =>
    legalActions(state)
      .filter((a): a is Extract<Action, { type: 'lava' }> => a.type === 'lava')
      .map((a) => a.to)
      .sort((x, y) => x - y);

  it('the spell goes only onto one of your Dragons that does not know it yet', () => {
    const state = bare(5);
    piece(state, 'white', 'wyrmling', 'c3');
    piece(state, 'white', 'mystic_dragon', 'e3').abilities = ['lavaBreath'];
    piece(state, 'white', 'recruit', 'f3');
    piece(state, 'white', 'initiate', 'g3');
    piece(state, 'black', 'wyrmling', 'c6');
    const spell = give(state, 'white', 'lava_breath');
    const targets = legalActions(state).filter((a) => a.type === 'spell').map((a) => a.type === 'spell' && a.target);
    expect(targets).toEqual([S('c3')]);
    const { state: next, events } = applyLegalAction(state, { type: 'spell', cardUid: spell, target: S('c3') });
    expect(pieceAt(next, S('c3'))!.abilities).toEqual(['lavaBreath']);
    expect(next.mana.white).toBe(3);
    expect(next.discard.white.map((c) => c.uid)).toEqual([spell]);
    const dragon = pieceAt(state, S('c3'))!;
    expect(events).toEqual([
      { type: 'spellPlayed', color: 'white', cardId: 'lava_breath', target: S('c3') },
      { type: 'learned', color: 'white', pieceId: dragon.id, name: 'Wyrmling', square: S('c3'), ability: 'lavaBreath' },
    ]);
    expect(pieceAt(state, S('c3'))!.abilities).toBeUndefined();
    expect(viewFor({ state: next, seq: 0, events: [] }, 'white').pieces.find((p) => p.square === S('c3'))!.abilities).toEqual(['lavaBreath']);
  });

  it('spits lava onto an empty square the Dragon could move to, for 1 mana, once a turn; the turn goes on', () => {
    const state = breather();
    piece(state, 'white', 'initiate', 'b4');
    piece(state, 'black', 'initiate', 'd6');
    // A Wyrmling leaps 2 straight: b4 is taken by its own piece and d6 by an enemy.
    expect(lavaTargets(state)).toEqual([S('d2'), S('f4')]);
    const { state: next, events } = applyLegalAction(state, { type: 'lava', from: S('d4'), to: S('f4') });
    expect(next.mana.white).toBe(4);
    expect(next.active).toBe('white');
    expect(next.lava).toEqual([{ square: S('f4'), by: 'white', untilTurn: 2 }]);
    expect(events).toEqual([{ type: 'lava', color: 'white', pieceId: pieceAt(state, S('d4'))!.id, name: 'Wyrmling', from: S('d4'), square: S('f4') }]);
    expect(lavaTargets(next)).toEqual([]);
    expect(legalActions(next).some((a) => a.type === 'endTurn')).toBe(false);
    expect(state.lava).toEqual([]);
  });

  it('costs mana, never answers a check, and a Dragon that just arrived cannot spit yet', () => {
    expect(lavaTargets(breather(0))).toEqual([]);
    const checked = breather();
    piece(checked, 'black', 'warlord', 'a1');
    expect(isInCheck(checked, 'white')).toBe(true);
    expect(lavaTargets(checked)).toEqual([]);
    const fresh = breather();
    pieceAt(fresh, S('d4'))!.summonedOnTurn = 1;
    expect(lavaTargets(fresh)).toEqual([]);
  });

  it('no piece can move onto lava or be summoned onto it, though pieces pass over it and attack across it', () => {
    let state = breather(5, 'mystic_dragon');
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    piece(state, 'black', 'warlord', 'b6');
    state = act(state, { type: 'lava', from: S('d4'), to: S('b2') });
    expect(() => act(state, { type: 'lava', from: S('d4'), to: S('d2') })).toThrow();
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1') && a.to === S('e1')));
    // Black's Warlord slides down the b-file over the lava on b2 to b1, but cannot stop on b2.
    const warlord = legalActions(state).filter((a) => a.type === 'move' && a.from === S('b6')).map((a) => a.type === 'move' && a.to);
    expect(warlord).toContain(S('b3'));
    expect(warlord).toContain(S('b1'));
    expect(warlord).not.toContain(S('b2'));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('a8')));
    const squire = give(state, 'white', 'squire');
    expect(legalActions(state).some((a) => a.type === 'summon' && a.cardUid === squire && a.to === S('b2'))).toBe(false);
    expect(legalActions(state).some((a) => a.type === 'summon' && a.cardUid === squire && a.to === S('a2'))).toBe(true);
    // Lava does not block lines: a Warlord on b1 behind the lava still attacks along the b-file.
    const lined = bare(0);
    lined.lava = [{ square: S('a4'), by: 'black', untilTurn: 9 }];
    lined.pieces.find((p) => p.owner === 'white' && p.def.king)!.square = S('a1');
    piece(lined, 'black', 'warlord', 'a8');
    expect(isInCheck(lined, 'white')).toBe(true);
  });

  it('lasts the other player\'s next 2 turns, then cools as its maker\'s turn begins', () => {
    let state = breather();
    state = act(state, { type: 'lava', from: S('d4'), to: S('f4') });
    const turnsLeft = (s: GameState) => viewFor({ state: s, seq: 0, events: [] }, 'white').lava.map((l) => l.turnsLeft);
    expect(turnsLeft(state)).toEqual([2]);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1')));
    expect(turnsLeft(state)).toEqual([2]);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('h8')));
    expect(turnsLeft(state)).toEqual([1]);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === kingOf(state)));
    expect(turnsLeft(state)).toEqual([1]);
    const { state: cooled, events } = applyLegalAction(state, find(state, (a) => a.type === 'move' && a.from === kingOf(state)));
    expect(cooled.active).toBe('white');
    expect(cooled.lava).toEqual([]);
    expect(events).toContainEqual({ type: 'lavaCooled', square: S('f4') });
    expect(lavaTargets(cooled)).toContain(S('f4'));
  });
  const kingOf = (state: GameState) => state.pieces.find((p) => p.owner === state.active && p.def.king)!.square;

  it('a Dragon keeps Lava Breath when it evolves', () => {
    let state = breather(20);
    const mystic = give(state, 'white', 'mystic_dragon');
    state = act(state, find(state, (a) => a.type === 'evolve' && a.cardUid === mystic));
    expect(pieceAt(state, S('d4'))).toMatchObject({ cardId: 'mystic_dragon', abilities: ['lavaBreath'] });
    expect(lavaTargets(state)).toEqual([]);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1')));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('h8')));
    expect(lavaTargets(state)).toHaveLength(16);
  });

  it('cloneState copies the lava', () => {
    const state = breather();
    state.lava = [{ square: S('a4'), by: 'white', untilTurn: 3 }];
    const copy = cloneState(state);
    copy.lava![0]!.untilTurn = 9;
    copy.lava!.push({ square: S('b4'), by: 'white', untilTurn: 3 });
    expect(state.lava).toEqual([{ square: S('a4'), by: 'white', untilTurn: 3 }]);
  });
});

describe('the game log (Djabooty, 2026-10-11)', () => {
  it('events name the pieces as they were, so a saved log reads after they are gone', () => {
    let state = bare(5);
    piece(state, 'white', 'colt', 'b1');
    piece(state, 'black', 'apprentice', 'c3');
    const squire = give(state, 'white', 'squire');
    const summoned = applyLegalAction(state, find(state, (a) => a.type === 'summon' && a.cardUid === squire && a.to === S('h2')));
    expect(summoned.events[0]).toMatchObject({ type: 'summoned', name: 'Squire', cardId: 'squire', square: S('h2') });
    state = summoned.state;
    const { events } = applyLegalAction(state, { type: 'move', from: S('b1'), to: S('c3') });
    expect(events[0]).toMatchObject({ type: 'captured', name: 'Apprentice', owner: 'black', cardId: 'apprentice', bounty: 1 });
    expect(events[1]).toMatchObject({ type: 'moved', name: 'Colt', owner: 'white', from: S('b1'), to: S('c3') });
    expect(events[2]).toMatchObject({ type: 'turnStarted', color: 'black', turn: 1, income: 0, held: [] });
  });

  it('a record keeps every action\'s events, and the view sends them only when asked', () => {
    const start = { state: bare(5), seq: 1, events: [], history: [] };
    const first = applyLegalAction(start.state, find(start.state, (a) => a.type === 'move'));
    const r1 = nextRecord(start, first.state, first.events);
    const second = applyLegalAction(r1.state, find(r1.state, (a) => a.type === 'move'));
    const r2 = nextRecord(r1, second.state, second.events);
    expect(r2).toMatchObject({ seq: 3, events: second.events, history: [first.events, second.events] });
    expect(viewFor(r2, 'white')).not.toHaveProperty('history');
    expect(viewFor(r2, 'white', { history: true }).history).toEqual([first.events, second.events]);
    // A game saved before the history began starts it from its latest events.
    const old = { state: r1.state, seq: 2, events: first.events };
    expect(viewFor(old, 'black', { history: true }).history).toEqual([first.events]);
    expect(nextRecord(old, second.state, second.events).history).toEqual([first.events, second.events]);
  });
});

describe('looking back (Djabooty, 2026-10-13)', () => {
  /**
   * A random game played through a record, as the server plays it, ended by a resignation if still going. `income`: the
   * center squares, or a turn income capped at +2 (games begun from 2026-10-17), or one rising to +4 (before).
   */
  function played(seed: number, length: number, income: 'center' | 'capped' | 'rising' = 'center'): GameRecord {
    const begun = income === 'center' ? game(seed) : newGame({ seed, decks: { white: starterDeck(), black: starterDeck() }, shrines: false });
    if (income === 'rising') delete begun.maxIncome;
    let record = newRecord(begun);
    let pick = seed * 104729;
    for (let n = 0; n < length && record.state.status.kind === 'playing'; n++) {
      const actions = legalActions(record.state);
      pick = (pick * 1103515245 + 12345) & 0x7fffffff;
      const result = applyLegalAction(record.state, actions[pick % actions.length]!);
      record = nextRecord(record, result.state, result.events, result.action);
    }
    if (record.state.status.kind === 'playing') {
      const status = { kind: 'resigned', winner: 'black' } as const;
      record = nextRecord(record, { ...record.state, status }, [{ type: 'gameOver', status }], { type: 'end', status });
    }
    return record;
  }

  it('a record keeps every step, and replaying them comes back to the game as it is', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const record = played(seed, 150);
      expect(record.steps).toHaveLength(record.history!.length);
      expect(viewFor(record, 'white').steps).toBe(record.steps!.length);
      expect(stateAt(record, record.steps!.length)).toEqual(record.state);
    }
  });

  it('shows any earlier position as it stood, with what that step did and nothing to play', () => {
    const record = played(2, 60);
    const known: GameState[] = [];
    const start = viewAt(record, 0, 'white', false, known)!;
    expect(start.events).toEqual([]);
    expect(start.pieces).toEqual(viewFor({ state: game(2), seq: 1, events: [] }, 'white').pieces);
    for (const step of [1, 7, 30]) {
      const past = viewAt(record, step, 'white', false, known)!;
      expect(past.events).toEqual(record.history![step - 1]);
      expect(past.legalActions).toEqual([]);
    }
    // The states worked out on the way are kept, so stepping back replays nothing again.
    expect(known.length).toBe(31);
    expect(viewAt(record, record.steps!.length + 1, 'white')).toBeNull();
    expect(viewAt(record, -1, 'white')).toBeNull();
    expect(viewAt(record, 1.5, 'white')).toBeNull();
  });

  it('works the steps out again for a game kept before them, from its history', () => {
    const decks = { white: starterDeck(), black: starterDeck() };
    let took = 0;
    for (let seed = 1; seed <= 6; seed++) {
      // Games kept before their steps (begun before 2026-10-13) had the turn income that rose to +4.
      const record = played(seed, 200, 'rising');
      const { start, steps, ...old } = record;
      const began = performance.now();
      const rebuilt = rebuildSteps(old, decks);
      took = Math.max(took, performance.now() - began);
      expect(rebuilt?.steps).toHaveLength(steps!.length);
      expect(rebuilt!.start).toEqual(start);
      expect(stateAt(rebuilt!, steps!.length)).toEqual(record.state);
      // Events saved before the names, owners, cards and bounties were added to them.
      const later = ['name', 'owner', 'bounty', 'income', 'fromName', 'consumedName'];
      const bare = old.history!.map((events) =>
        events.map((e) => {
          const gone = ['captured', 'summoned', 'sealed', 'evolved'].includes(e.type) ? [...later, 'cardId'] : later;
          return Object.fromEntries(Object.entries(e).filter(([k]) => e.type === 'learned' || e.type === 'lava' || !gone.includes(k))) as GameEvent;
        }),
      );
      expect(rebuildSteps({ ...old, history: bare }, decks)?.steps).toHaveLength(steps!.length);
    }
    expect(took).toBeLessThan(2000);
  });

  it('works the steps out under each income rule: rising to +4, capped at +2, or the center squares', () => {
    const decks = { white: starterDeck(), black: starterDeck() };
    for (const income of ['rising', 'capped', 'center'] as const) {
      const record = played(4, 200, income);
      expect(record.state.turns.white).toBeGreaterThan(10);
      const { start, steps, ...old } = record;
      const rebuilt = rebuildSteps(old, decks);
      expect(rebuilt?.steps).toHaveLength(steps!.length);
      expect(rebuilt!.start).toEqual(start);
      expect(rebuilt!.start!.maxIncome).toBe(income === 'capped' ? MAX_INCOME : undefined);
      expect(rebuilt!.start!.shrines === undefined).toBe(income !== 'center');
      expect(stateAt(rebuilt!, steps!.length)).toEqual(record.state);
    }
  });

  it('leaves a game without steps when its history began late or its deck has changed', () => {
    const decks = { white: starterDeck(), black: starterDeck() };
    const { start, steps, ...old } = played(3, 80);
    expect(rebuildSteps({ ...old, history: old.history!.slice(1) }, decks)).toBeNull();
    expect(rebuildSteps(old, { white: [...decks.white].reverse(), black: decks.black })).toBeNull();
    expect(rebuildSteps(old, { white: decks.white.slice(1), black: decks.black })).toBeNull();
  });

  it('a game saved before steps were kept has none, and does not begin them halfway', () => {
    const old = { state: game(5), seq: 1, events: [], history: [] };
    const result = applyLegalAction(old.state, legalActions(old.state)[0]!);
    const next = nextRecord(old, result.state, result.events, result.action);
    expect(next.steps).toBeUndefined();
    expect(viewFor(next, 'white').steps).toBeUndefined();
    expect(viewAt(next, 0, 'white')).toBeNull();
  });
});

describe('starter deck', () => {
  it('is the agreed 30-card list', () => {
    const counts: Record<string, number> = {};
    for (const id of starterDeck()) counts[id] = (counts[id] ?? 0) + 1;
    expect(counts).toEqual({
      initiate: 2,
      squire: 1,
      recruit: 2,
      warrior: 1,
      warlord: 1,
      apprentice: 2,
      mage: 1,
      archmage: 1,
      colt: 2,
      paladin: 1,
      dawn_paladin: 1,
      eclipse_knight: 1,
      wyrmling: 2,
      mystic_dragon: 1,
      ancient_mystic_dragon: 1,
      duskfang: 1,
      insight: 2,
      dispel: 1,
      lava_breath: 1,
      mana_surge: 1,
      resurrect: 1,
      shield: 1,
      freeze: 1,
      smite: 1,
    });
    expect(starterDeck()).toHaveLength(30);
  });

  it('gives every card a type (Djabooty, 2026-10-11): a line\'s cards share its type', () => {
    const types = Object.fromEntries(Object.values(STARTER_CATALOG).map((c) => [c.id, c.tribe]));
    expect(types).toEqual({
      initiate: 'Zealot',
      squire: 'Warrior',
      recruit: 'Warrior',
      warrior: 'Warrior',
      warlord: 'Warrior',
      apprentice: 'Mage',
      mage: 'Mage',
      archmage: 'Mage',
      colt: 'Paladin',
      paladin: 'Paladin',
      dawn_paladin: 'Paladin',
      eclipse_knight: 'Paladin',
      wyrmling: 'Dragon',
      mystic_dragon: 'Dragon',
      ancient_mystic_dragon: 'Dragon',
      duskfang: 'Beast',
      insight: undefined,
      dispel: undefined,
      lava_breath: 'Dragon',
      mana_surge: undefined,
      resurrect: undefined,
      shield: undefined,
      freeze: undefined,
      smite: undefined,
    });
    for (const card of Object.values(STARTER_CATALOG)) {
      if (card.type === 'piece' && card.line) expect(card.tribe, card.id).toBe(card.line);
    }
  });

  it('every evolution card evolves from a card in the deck, one level down in the same line', () => {
    const deck = new Set(starterDeck());
    for (const id of deck) {
      const card = STARTER_CATALOG[id]!;
      if (card.type !== 'piece' || !card.evolvesFrom) continue;
      const from = STARTER_CATALOG[card.evolvesFrom]!;
      expect(deck.has(card.evolvesFrom)).toBe(true);
      expect(from).toMatchObject({ type: 'piece', line: card.line, level: card.level! - 1 });
    }
  });

  it('prices strong pieces late (Djabooty, 2026-10-11): a Paladin costs at least 4, and every level costs more than the one below', () => {
    expect(STARTER_CATALOG.paladin!.cost).toBeGreaterThanOrEqual(4);
    for (const card of Object.values(STARTER_CATALOG)) {
      if (card.type !== 'piece' || !card.evolvesFrom) continue;
      expect(card.cost, card.id).toBeGreaterThan(STARTER_CATALOG[card.evolvesFrom]!.cost);
    }
    const lineCost = (top: string): number => {
      const card = STARTER_CATALOG[top]!;
      return card.cost + (card.type === 'piece' && card.evolvesFrom ? lineCost(card.evolvesFrom) : 0);
    };
    expect([lineCost('paladin'), lineCost('archmage'), lineCost('warlord'), lineCost('dawn_paladin'), lineCost('ancient_mystic_dragon')]).toEqual([6, 8, 11, 13, 18]);
  });

  it('holds at most four cost-2 piece cards', () => {
    expect(starterDeck().filter((id) => STARTER_CATALOG[id]!.type === 'piece' && STARTER_CATALOG[id]!.cost === 2).length).toBeLessThanOrEqual(4);
  });

  it('prints Insight at 2 mana, and it draws 1 card and pays 1 mana back (Djabooty, 2026-10-11)', () => {
    expect(STARTER_CATALOG.insight).toMatchObject({ cost: 2, effect: { kind: 'draw', count: 1, mana: 1 }, text: 'Draw 1 card and gain 1 mana.' });
    const state = bare(3);
    state.deck.white = [{ uid: 'a', cardId: 'squire' }, { uid: 'b', cardId: 'squire' }];
    const insight = give(state, 'white', 'insight');
    const cast = act(state, { type: 'spell', cardUid: insight });
    expect(cast.mana.white).toBe(2);
    expect(cast.hand.white.map((c) => c.uid)).toEqual(['a']);
    expect(cast.discard.white.map((c) => c.uid)).toEqual([insight]);
  });

  it('a game saved before the change keeps its own Insight: draw 2, no mana', () => {
    const state = bare(3);
    state.catalog = { ...state.catalog, insight: { ...STARTER_CATALOG.insight!, effect: { kind: 'draw', count: 2 }, text: 'Draw 2 cards.' } as never };
    state.deck.white = [{ uid: 'a', cardId: 'squire' }, { uid: 'b', cardId: 'squire' }];
    const cast = act(state, { type: 'spell', cardUid: give(state, 'white', 'insight') });
    expect(cast.mana.white).toBe(1);
    expect(cast.hand.white.map((c) => c.uid)).toEqual(['a', 'b']);
  });
});

describe('endgame', () => {
  it('stalemate: King and seals only, King has no legal move, not in check', () => {
    let state = bare(0);
    state.pieces.find((p) => p.owner === 'black')!.square = S('a8');
    state.pieces.find((p) => p.owner === 'white')!.square = S('c6');
    piece(state, 'white', 'initiate', 'c7');
    state.seals.push({ id: 's1', owner: 'black', square: S('a7'), card: STARTER_CATALOG.squire as never, timer: 5 });
    state.seals.push({ id: 's2', owner: 'black', square: S('b8'), card: STARTER_CATALOG.squire as never, timer: 5 });
    state.seals.push({ id: 's3', owner: 'black', square: S('b7'), card: STARTER_CATALOG.squire as never, timer: 5 });
    state.active = 'white';
    state.actionTaken = false;
    state.mana.black = 0;
    state = act(state, find(state, (a) => a.type === 'move'));
    expect(state.status).toEqual({ kind: 'stalemate' });
    expect(legalActions(state)).toEqual([]);
  });

  it('checkmate: in check with no legal action loses to the other side', () => {
    let state = bare(0);
    state.pieces.find((p) => p.owner === 'black')!.square = S('a8');
    state.pieces.find((p) => p.owner === 'white')!.square = S('c7');
    piece(state, 'white', 'warlord', 'b1');
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('b1') && a.to === S('a1')));
    expect(state.status).toEqual({ kind: 'checkmate', winner: 'white' });
  });

  it('there is no pass: End turn only once no move is left, and only after a card (Djabooty, 2026-10-10)', () => {
    let state = bare(1);
    expect(legalActions(state).some((a) => a.type === 'endTurn')).toBe(false);
    expect(() => applyLegalAction(state, { type: 'endTurn' })).toThrow();
    // Boxed in by its own seals, the King has no move, but a Squire can still be summoned.
    state.pieces.find((p) => p.owner === 'white')!.square = S('a1');
    for (const [id, square] of [['s1', 'a2'], ['s2', 'b1'], ['s3', 'b2']] as const) {
      state.seals.push({ id, owner: 'white', square: S(square), card: STARTER_CATALOG.duskfang as PieceCard, timer: 5 });
    }
    const squire = give(state, 'white', 'squire');
    expect(legalActions(state).some((a) => a.type === 'move')).toBe(false);
    expect(legalActions(state).some((a) => a.type === 'endTurn')).toBe(false);
    state = act(state, find(state, (a) => a.type === 'summon' && a.cardUid === squire));
    expect(legalActions(state)).toEqual([{ type: 'endTurn' }]);
    state = act(state, { type: 'endTurn' });
    expect(state.active).toBe('black');
  });

  it('an empty deck skips the draw with no deck-out loss; checkmate stays the only win (msg-033)', () => {
    let state = bare(0);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    for (let turn = 0; turn < 6; turn++) {
      const ended = applyLegalAction(state, find(state, (a) => a.type === 'move'));
      expect(ended.events.some((e) => e.type === 'turnStarted')).toBe(true);
      expect(ended.events.some((e) => e.type === 'drew')).toBe(false);
      state = ended.state;
      expect(state.status).toEqual({ kind: 'playing' });
      expect(state.deck[state.active]).toHaveLength(0);
      expect(state.hand[state.active]).toHaveLength(0);
    }
  });

  it('an Initiate on the far rank with no piece card in hand stays an Initiate, and can still be sealed (msg-033)', () => {
    let state = bare(5);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    piece(state, 'white', 'initiate', 'e7');
    give(state, 'white', 'smite');
    expect(legalActions(state).filter((a) => a.type === 'move' && a.from === S('e7'))).toEqual([{ type: 'move', from: S('e7'), to: S('e8') }]);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('e7') && a.to === S('e8')));
    expect(pieceAt(state, S('e8'))).toMatchObject({ owner: 'white', cardId: 'initiate' });
    state = act(state, find(state, (a) => a.type === 'move'));
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('e8'))).toBe(false);
    expect(legalActions(state).some((a) => a.type === 'evolve')).toBe(false);
    const wyrmling = give(state, 'white', 'wyrmling');
    const mana = state.mana.white;
    state = act(state, find(state, (a) => a.type === 'seal' && a.cardUid === wyrmling && a.target === S('e8')));
    expect(pieceAt(state, S('e8'))).toBeUndefined();
    expect(sealAt(state, S('e8'))).toMatchObject({ owner: 'white', timer: 1 });
    expect(sealAt(state, S('e8'))!.card.id).toBe('wyrmling');
    expect(state.mana.white).toBe(mana - 2);
  });
});

describe('the Initiate is the pawn (Djabooty, 2026-10-17)', () => {
  const movesFrom = (state: GameState, from: string) =>
    legalActions(state)
      .filter((a): a is Extract<Action, { type: 'move' }> => a.type === 'move' && a.from === S(from) && !a.promote)
      .map((a) => a.to)
      .sort((a, b) => a - b);
  const squares = (...names: string[]) => names.map(S).sort((a, b) => a - b);

  it('moves 1 forward, or 2 on its first move, and captures 1 diagonally forward', () => {
    let state = bare(5);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    piece(state, 'white', 'initiate', 'd2');
    piece(state, 'black', 'initiate', 'e3');
    piece(state, 'black', 'initiate', 'g7');
    expect(movesFrom(state, 'd2')).toEqual(squares('d3', 'd4', 'e3'));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d2') && a.to === S('d4')));
    expect(pieceAt(state, S('d4'))?.moved).toBe(true);
    // Black's go down the board.
    expect(movesFrom(state, 'g7')).toEqual(squares('g6', 'g5'));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('g7') && a.to === S('g6')));
    expect(movesFrom(state, 'd4')).toEqual(squares('d5'));
  });

  it('its double step is blocked by a piece on the square between, and it never moves back or sideways', () => {
    const state = bare(5);
    piece(state, 'white', 'initiate', 'c3');
    piece(state, 'black', 'warrior', 'c4');
    expect(movesFrom(state, 'c3')).toEqual([]);
    const other = bare(5);
    piece(other, 'white', 'initiate', 'f3');
    piece(other, 'black', 'warrior', 'f5');
    expect(movesFrom(other, 'f3')).toEqual(squares('f4'));
  });

  it('attacks only diagonally forward: a King may stand right in front of an enemy Initiate', () => {
    const state = bare(5);
    piece(state, 'black', 'initiate', 'c3');
    const king = state.pieces.find((p) => p.owner === 'white' && p.def.king)!;
    king.square = S('c2');
    expect(isInCheck(state, 'white')).toBe(false);
    king.square = S('d2');
    expect(isInCheck(state, 'white')).toBe(true);
  });

  it('the Squire steps 1 square straight, moving and capturing alike', () => {
    const state = bare(5);
    piece(state, 'white', 'squire', 'f4');
    piece(state, 'black', 'warrior', 'f5');
    expect(movesFrom(state, 'f4')).toEqual(squares('f3', 'e4', 'g4', 'f5'));
  });

  it('reaching the far row it may become any piece card in hand, for free, as part of the move', () => {
    let state = bare(0);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    piece(state, 'white', 'initiate', 'e7');
    const warlord = give(state, 'white', 'warlord');
    const dragon = give(state, 'white', 'mystic_dragon');
    const squire = give(state, 'white', 'squire');
    give(state, 'white', 'initiate');
    give(state, 'white', 'smite');
    const arriving = legalActions(state).filter((a) => a.type === 'move' && a.from === S('e7'));
    expect(arriving).toEqual([
      { type: 'move', from: S('e7'), to: S('e8') },
      { type: 'move', from: S('e7'), to: S('e8'), promote: warlord },
      { type: 'move', from: S('e7'), to: S('e8'), promote: dragon },
      { type: 'move', from: S('e7'), to: S('e8'), promote: squire },
    ]);
    const { state: next, events } = applyLegalAction(state, { type: 'move', from: S('e7'), to: S('e8'), promote: warlord });
    expect(pieceAt(next, S('e8'))).toMatchObject({ owner: 'white', cardId: 'warlord' });
    expect(next.hand.white.map((c) => c.uid)).not.toContain(warlord);
    expect(next.mana.white).toBe(0);
    expect(next.discard.white.map((c) => c.cardId)).toEqual(['initiate']);
    expect(events.slice(0, 2)).toMatchObject([
      { type: 'moved', from: S('e7'), to: S('e8'), name: 'Initiate' },
      { type: 'evolved', color: 'white', square: S('e8'), name: 'Warlord', fromName: 'Initiate', cardId: 'warlord', cost: 0, promoted: true },
    ]);
    expect(next.active).toBe('black');
    // It moves on its owner's next turn, like any piece that arrived on the last one.
    const after = act(next, find(next, (a) => a.type === 'move'));
    expect(legalActions(after).some((a) => a.type === 'move' && a.from === S('e8') && a.to === S('e1'))).toBe(true);
  });

  it('it can also promote by capturing onto the far row, and the plain move keeps it an Initiate', () => {
    const state = bare(5);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    piece(state, 'white', 'initiate', 'e7');
    piece(state, 'black', 'warrior', 'f8');
    const paladin = give(state, 'white', 'paladin');
    const capture = find(state, (a) => a.type === 'move' && a.to === S('f8') && a.promote === paladin);
    const { state: next, events } = applyLegalAction(state, capture);
    expect(pieceAt(next, S('f8'))).toMatchObject({ owner: 'white', cardId: 'paladin' });
    expect(events.map((e) => e.type).slice(0, 3)).toEqual(['captured', 'moved', 'evolved']);
    const kept = act(state, find(state, (a) => a.type === 'move' && a.to === S('e8') && !a.promote));
    expect(pieceAt(kept, S('e8'))).toMatchObject({ cardId: 'initiate' });
    expect(kept.hand.white.map((c) => c.uid)).toContain(paladin);
  });

  it('an Initiate waiting on the far row promotes on a later turn when a piece card is dropped on it, for free', () => {
    let state = bare(0);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    piece(state, 'white', 'initiate', 'e8');
    const elsewhere = piece(state, 'white', 'initiate', 'b3');
    const colt = give(state, 'white', 'colt');
    const evolves = legalActions(state).filter((a) => a.type === 'evolve');
    expect(evolves).toEqual([{ type: 'evolve', cardUid: colt, target: S('e8') }]);
    const { state: next, events } = applyLegalAction(state, evolves[0]!);
    expect(pieceAt(next, S('e8'))).toMatchObject({ cardId: 'colt' });
    expect(pieceAt(next, elsewhere.square)).toMatchObject({ cardId: 'initiate' });
    expect(next.mana.white).toBe(0);
    expect(next.active).toBe('white');
    expect(events).toMatchObject([{ type: 'evolved', cost: 0, promoted: true }]);
    // Like any evolution, the new piece waits for its owner's next turn.
    expect(legalActions(next).some((a) => a.type === 'move' && a.from === S('e8'))).toBe(false);
  });

  it('a level-2 card still goes onto an Initiate elsewhere for its any-path price, and onto one on the far row for free', () => {
    const state = bare(7);
    piece(state, 'white', 'initiate', 'b3');
    piece(state, 'white', 'initiate', 'g8');
    const warrior = give(state, 'white', 'warrior');
    const card = STARTER_CATALOG.warrior as PieceCard;
    expect(evolveCost(state, card, pieceAt(state, S('b3'))!)).toBe(card.cost + STARTER_CATALOG.recruit!.cost);
    expect(evolveCost(state, card, pieceAt(state, S('g8'))!)).toBe(0);
    expect(evolveCost(state, STARTER_CATALOG.initiate as PieceCard, pieceAt(state, S('g8'))!)).toBeNull();
    expect(legalActions(state).filter((a) => a.type === 'evolve' && a.cardUid === warrior)).toHaveLength(2);
  });

  it('a game begun before the change keeps its straight-stepping Initiate, with no double step or promotion', () => {
    const state = bare(5);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    const def = { kind: 'initiate', name: 'Initiate', rules: [{ dirs: [[1, 0], [-1, 0], [0, 1], [0, -1]] as const, range: 1 }] };
    state.pieces.push({ id: 'old', owner: 'white', def, cardId: 'initiate', square: S('e7'), activeFromTurn: 0 });
    give(state, 'white', 'warlord');
    expect(movesFrom(state, 'e7')).toEqual(squares('e6', 'd7', 'f7', 'e8'));
    expect(legalActions(state).some((a) => a.type === 'move' && a.promote)).toBe(false);
    const next = act(state, find(state, (a) => a.type === 'move' && a.to === S('d7')));
    expect(pieceAt(next, S('d7'))).not.toHaveProperty('moved');
  });
});

describe('full games', () => {
  it('plays random legal actions without ever throwing or getting stuck', () => {
    let evolutions = 0;
    for (let seed = 1; seed <= 8; seed++) {
      let state = game(seed);
      let pick = seed * 7919;
      for (let step = 0; step < 500 && state.status.kind === 'playing'; step++) {
        const actions = legalActions(state);
        expect(actions.length).toBeGreaterThan(0);
        if (actions.some((a) => a.type === 'endTurn')) expect(actions.some((a) => a.type === 'move')).toBe(false);
        pick = (pick * 1103515245 + 12345) & 0x7fffffff;
        const action = actions[pick % actions.length]!;
        if (action.type === 'evolve') evolutions++;
        state = act(state, action);
      }
    }
    expect(evolutions).toBeGreaterThan(0);
  });

  it('every game starts straight in play with full hands and both starting rows', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const state = game(seed);
      expect(state.hand.white).toHaveLength(4);
      expect(state.hand.black).toHaveLength(3);
      expect(state.phase).toBe('play');
      expect(state.pieces).toHaveLength(8);
    }
  });
});


describe('port additions', () => {
  it('accepts a legal action whatever the key order, and never applies the caller\'s own object', () => {
    const state = bare(5);
    const squire = give(state, 'white', 'squire');
    const wire = JSON.parse(`{"to":0,"cardUid":"${squire}","type":"summon","junk":true}`) as Action;
    const next = applyLegalAction(state, wire).state;
    expect(pieceAt(next, 0)?.def.kind).toBe('squire');
    expect(() => applyLegalAction(state, { type: 'summon', cardUid: squire, to: S('d1') })).toThrow();
  });

  it('cloneState is independent of the original', () => {
    const state = bare(5);
    piece(state, 'white', 'initiate', 'c3');
    const copy = cloneState(state);
    copy.pieces[0]!.square = S('a1');
    copy.mana.white = 99;
    copy.hand.white.push({ uid: 'z', cardId: 'squire' });
    expect(state.mana.white).toBe(5);
    expect(state.hand.white).toHaveLength(0);
    expect(state.pieces[0]!.square).not.toBe(S('a1'));
  });

  it('the view hides the opponent\'s hand and deck contents but shows seals, discards and legal moves only on your turn', () => {
    const state = bare(5);
    give(state, 'white', 'squire');
    give(state, 'black', 'duskfang');
    state.deck.black = [{ uid: 'dk', cardId: 'dispel' }];
    state.seals.push({ id: 's1', owner: 'black', square: S('c6'), card: STARTER_CATALOG.duskfang as never, timer: 2 });
    const record = { state, seq: 3, events: [] };
    const white = viewFor(record, 'white');
    expect(white.hand?.map((c) => c.cardId)).toEqual(['squire']);
    expect(white.handCount).toEqual({ white: 1, black: 1 });
    expect(white.deckCount.black).toBe(1);
    expect(JSON.stringify(white)).not.toContain('dk');
    expect(white.seals[0]).toMatchObject({ cardId: 'duskfang', timer: 2 });
    expect(white.legalActions.length).toBeGreaterThan(0);
    const black = viewFor(record, 'black');
    expect(black.hand?.map((c) => c.cardId)).toEqual(['duskfang']);
    expect(black.legalActions).toEqual([]);
    const hotseat = viewFor(record, 'black', { hotseat: true });
    expect(hotseat.you).toBe('white');
    expect(hotseat.legalActions.length).toBeGreaterThan(0);
  });

  it('describes movement in words', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    expect(cards.paladin!.text).toBe('Leaps like a knight.');
    expect(cards.colt!.text).toBe('Leaps like a knight, forward only.');
    expect(cards.warrior!.text).toBe('Slides straight, up to 3 squares.');
    expect(cards.warlord!.text).toBe('Slides straight, any distance.');
    expect(cards.wyrmling!.text).toBe('Leaps 2 squares straight.');
    expect(cards.mystic_dragon!.text).toBe('Slides in any direction, up to 2 squares.');
    expect(cards.ancient_mystic_dragon!.text).toBe('Slides in any direction, any distance.');
    // A rule that only moves says "Moves", one that only captures says "Captures", like a chess pawn.
    expect(cards.duskfang!.text).toBe('Moves diagonally, 1 square. Captures like a knight.');
    expect(cards.initiate!.text).toBe('Moves forward, 1 square (2 on its first move). Captures diagonally forward, 1 square.');
    expect(cards.squire!.text).toBe('Steps straight, 1 square.');
    expect(cards.dispel!.type).toBe('spell');
  });

  it('sends types, the Initiate\'s any path and the longer viewer text', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    expect(cards.initiate).toMatchObject({
      tribe: 'Zealot',
      anyPath: true,
      promotes: true,
      abilityText: 'Any path: evolves into any level 2.\nPromotes: on the far row.',
    });
    expect(cards.initiate!.detail).toContain('any level-2 card');
    expect(cards.initiate!.detail).toContain('far row');
    expect(cards.squire).not.toHaveProperty('promotes');
    expect(cards.warrior).toMatchObject({ tribe: 'Warrior' });
    expect(cards.warrior).not.toHaveProperty('anyPath');
    expect(cards.lava_breath).toMatchObject({ type: 'spell', tribe: 'Dragon', grants: 'lavaBreath', cost: 2 });
    expect(cards.dispel!.detail).toContain('discard pile');
    expect(cards.insight).not.toHaveProperty('detail');
  });

  it('sends the evolution line, and no seal timer on cards that can only evolve', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    expect(cards.recruit).toMatchObject({ line: 'Warrior', level: 1, sealTimer: 1 });
    expect(cards.recruit!.evolvesFrom).toBeUndefined();
    expect(cards.warrior).toMatchObject({ line: 'Warrior', level: 2, evolvesFrom: 'recruit' });
    expect(cards.warrior).not.toHaveProperty('sealTimer');
    expect(cards.duskfang).toMatchObject({ sealTimer: 3 });
    expect(cards.duskfang).not.toHaveProperty('line');
  });

  it('sends piece move rules so the client can draw them', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    expect(cards.duskfang!.rules).toEqual(STARTER_CATALOG.duskfang!.type === 'piece' ? STARTER_CATALOG.duskfang!.piece.rules : null);
    expect(JSON.parse(JSON.stringify(cards.initiate!.rules))[1].mode).toBe('capture');
    expect(JSON.parse(JSON.stringify(cards.initiate!.rules))[0]).toMatchObject({ mode: 'move', firstRange: 2 });
    expect(cards.insight!.rules).toBeUndefined();
  });

  it('sends card art to the client, with no board picture for a spell', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    expect(cards.duskfang).toMatchObject({
      art: '/art/duskfang_white.png',
      boardArt: '/figures/duskfang_white.webp',
      darkArt: '/art/duskfang_dark.png',
      darkBoardArt: '/figures/duskfang_dark.webp',
    });
    expect(cards.insight).toMatchObject({ art: '/art/insight_white.png', darkArt: '/art/insight_dark.png' });
    expect(cards.insight).not.toHaveProperty('boardArt');
    expect(cards.insight).not.toHaveProperty('darkBoardArt');
  });

  it('gives every card a light face for White and a dark face for Black (Djabooty, 2026-10-11)', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    for (const id of Object.keys(STARTER_CATALOG)) {
      const card = cards[id]!;
      const onBoard = (file: string) => (card.type === 'piece' ? file : undefined);
      expect(faceArt(card, 'white')).toEqual({ art: `/art/${id}_white.png`, boardArt: onBoard(`/figures/${id}_white.webp`) });
      expect(faceArt(card, 'black')).toEqual({ art: `/art/${id}_dark.png`, boardArt: onBoard(`/figures/${id}_dark.webp`) });
    }
    // A card with only one picture shows it to both sides.
    const single = { art: '/art/new_card.png', boardArt: '/art/new_card.png' };
    expect(faceArt(single, 'black')).toEqual(single);
  });

  it('a saved game keeps its cards\' costs and moves but shows today\'s pictures and types', () => {
    const wyrmling = STARTER_CATALOG.wyrmling as PieceCard;
    const saved: PieceCard = {
      ...wyrmling,
      cost: 1,
      art: '/art/pic-002.png',
      boardArt: '/art/pic-002.png',
      darkArt: undefined,
      darkBoardArt: undefined,
      tribe: undefined,
    };
    const custom: PieceCard = { ...wyrmling, id: 'custom', name: 'Custom', art: '/art/custom.png' };
    const catalog = withCurrentArt({ wyrmling: saved, insight: { ...STARTER_CATALOG.insight!, art: undefined, darkArt: undefined }, custom });
    expect(catalog.wyrmling).toEqual({ ...wyrmling, cost: 1 });
    expect(catalog.insight).toEqual(STARTER_CATALOG.insight);
    expect(catalog.custom).toBe(custom);
  });

  it('resigned and timeout results end the game with no legal actions', () => {
    const state = bare(5);
    state.status = { kind: 'timeout', winner: 'black' };
    expect(legalActions(state)).toEqual([]);
  });
});
