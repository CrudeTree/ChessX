import { describe, expect, it } from 'vitest';
import {
  FILES,
  KING,
  STARTER_CATALOG,
  applyLegalAction,
  faceArt,
  isInCheck,
  legalActions,
  newGame,
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
    // 3-card hands (Djabooty, 2026-10-10), then White's turn 1 draws one more and adds the normal +1 to the starting 2 mana.
    expect(state.hand.white).toHaveLength(4);
    expect(state.hand.black).toHaveLength(3);
    expect(state.mana).toEqual({ white: 3, black: 2 });
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
    piece(state, 'black', 'initiate', 'd3');
    const capture = legalActions(state).find((a) => a.type === 'move' && a.from === init.square && a.to === S('d3'));
    expect(capture).toBeDefined();
  });
});

describe('turn flow and resources', () => {
  it('a move ends the turn: the other side gains +1 mana (no cap) and draws a card at once', () => {
    let state = bare(40);
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
    expect(state.mana.white).toBe(4);
    expect(state.hand.white.map((c) => c.cardId)).toEqual(['duskfang', 'duskfang']);
    // A Duskfang costs 15, so the cards are done; the move is all that is left.
    expect(legalActions(state).every((a) => a.type === 'move')).toBe(true);
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
    expect(next.hand.white.length).toBe(3);
    next = act(next, { type: 'spell', cardUid: second });
    expect(next.active).toBe('white');
    expect(next.hand.white.map((c) => c.uid)).toEqual(['a', 'b', 'c', 'd']);
    expect(next.mana.white).toBe(6);
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
  it('costs the printed mana and goes only on the back row', () => {
    const state = bare(2);
    const wyrmling = give(state, 'white', 'wyrmling');
    const duskfang = give(state, 'white', 'duskfang');
    const summons = legalActions(state).filter((a) => a.type === 'summon');
    expect(summons.every((a) => a.type === 'summon' && a.cardUid === wyrmling && a.to < FILES && a.to !== S('d1'))).toBe(true);
    expect(summons.some((a) => a.type === 'summon' && a.cardUid === duskfang)).toBe(false);
    const next = act(state, summons[0]!);
    expect(next.mana.white).toBe(0);
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
  it('costs 15 with no evolution line (Djabooty, 2026-10-11), seals on a 3-turn timer, steps one square diagonally and captures only with a knight leap', () => {
    const card = STARTER_CATALOG.duskfang!;
    expect(card).toMatchObject({ type: 'piece', cost: 15, sealTimer: 3 });
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
    piece(state, 'black', 'initiate', 'c4');
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
    expect(events).toContainEqual({ type: 'evolved', color: 'white', pieceId: evolved.id, fromPieceId: recruit.id, square: S('c3') });
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

  it('goes only onto the card it evolves from, and an evolution card is never summoned or sealed', () => {
    const state = bare(20);
    piece(state, 'white', 'recruit', 'c3');
    piece(state, 'white', 'initiate', 'e3');
    const warlord = give(state, 'white', 'warlord');
    const mystic = give(state, 'white', 'mystic_dragon');
    const archmage = give(state, 'white', 'archmage');
    const uids = new Set([warlord, mystic, archmage]);
    expect(legalActions(state).some((a) => 'cardUid' in a && uids.has(a.cardUid))).toBe(false);
    expect(legalActions(state).some((a) => a.type === 'summon' || a.type === 'seal')).toBe(false);
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
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('d7');
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
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    piece(state, 'white', 'wyrmling', 'd4');
    const mystic = give(state, 'white', 'mystic_dragon');
    const ancient = give(state, 'white', 'ancient_mystic_dragon');
    expect(moveTargets(state, 'd4')).toHaveLength(4);
    expect(legalActions(state).some((a) => a.type === 'evolve' && a.cardUid === ancient)).toBe(false);
    state = act(state, find(state, (a) => a.type === 'evolve' && a.cardUid === mystic));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1') && a.to === S('e1')));
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('a8') && a.to === S('b8')));
    expect(moveTargets(state, 'd4')).toHaveLength(24);
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

describe('starter deck', () => {
  it('is the agreed 24-card list', () => {
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
    });
    expect(starterDeck()).toHaveLength(24);
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

  it('prints Insight at 2 mana, so turn 1 is a Wyrmling seal or an Insight, never both (msg-028)', () => {
    expect(STARTER_CATALOG.insight!.cost).toBe(2);
    const state = bare(3);
    piece(state, 'white', 'initiate', 'c2');
    const wyrmling = give(state, 'white', 'wyrmling');
    const insight = give(state, 'white', 'insight');
    expect(legalActions(state).some((a) => a.type === 'spell' && a.cardUid === insight)).toBe(true);
    const sealed = act(state, find(state, (a) => a.type === 'seal' && a.cardUid === wyrmling));
    expect(sealed.mana.white).toBe(1);
    expect(sealed.active).toBe('white');
    expect(legalActions(sealed).some((a) => a.type === 'spell' && a.cardUid === insight)).toBe(false);
    const cast = act(state, { type: 'spell', cardUid: insight });
    expect(cast.mana.white).toBe(1);
    expect(legalActions(cast).some((a) => a.type === 'seal' && a.cardUid === wyrmling)).toBe(false);
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

  it('a Squire on the far rank stays a Squire and can be sealed to a Wyrmling, the start of the queen line, the crown (msg-033)', () => {
    let state = bare(5);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    piece(state, 'white', 'squire', 'e7');
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('e7') && a.to === S('e8')));
    expect(pieceAt(state, S('e8'))).toMatchObject({ owner: 'white', cardId: 'squire' });
    expect(pieceAt(state, S('e8'))!.def.kind).toBe('squire');
    state = act(state, find(state, (a) => a.type === 'move'));
    expect(pieceAt(state, S('e8'))!.def.kind).toBe('squire');
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('e8'))).toBe(false);
    const wyrmling = give(state, 'white', 'wyrmling');
    const mana = state.mana.white;
    state = act(state, find(state, (a) => a.type === 'seal' && a.cardUid === wyrmling && a.target === S('e8')));
    expect(pieceAt(state, S('e8'))).toBeUndefined();
    expect(sealAt(state, S('e8'))).toMatchObject({ owner: 'white', timer: 1 });
    expect(sealAt(state, S('e8'))!.card.id).toBe('wyrmling');
    expect(state.mana.white).toBe(mana - 2);
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
    expect(cards.mystic_dragon!.text).toBe('Slides in any direction, up to 3 squares.');
    expect(cards.ancient_mystic_dragon!.text).toBe('Slides in any direction, any distance.');
    expect(cards.duskfang!.text).toBe('Steps diagonally, 1 square (cannot capture that way). Captures like a knight (cannot move there otherwise).');
    expect(cards.squire!.text).toContain('Steps forward');
    expect(cards.dispel!.type).toBe('spell');
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
    expect(JSON.parse(JSON.stringify(cards.squire!.rules))[1].mode).toBe('capture');
    expect(cards.insight!.rules).toBeUndefined();
  });

  it('sends card art where a card has a picture, and nothing where it has none', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    expect(cards.duskfang).toMatchObject({ art: '/art/pic-001.png', boardArt: '/art/pic-001.png' });
    expect(cards.dawn_paladin).toMatchObject({ art: '/art/pic-003.png', boardArt: '/art/pic-003.png' });
    expect(cards.eclipse_knight).toMatchObject({ art: '/art/pic-004.png', boardArt: '/art/pic-004.png' });
    expect(cards.squire!.art).toBeUndefined();
    expect(cards.squire!.boardArt).toBeUndefined();
    expect(cards.insight!.art).toBeUndefined();
  });

  it('gives each side its own face of a two-faced card: light for White, dark for Black (Djabooty, 2026-10-11)', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    const light = { art: '/art/paladin_white.png', boardArt: '/art/paladin_white.png' };
    const dark = { art: '/art/paladin_dark.png', boardArt: '/art/paladin_dark.png' };
    expect(cards.paladin).toMatchObject({ ...light, darkArt: dark.art, darkBoardArt: dark.boardArt });
    expect(faceArt(cards.paladin!, 'white')).toEqual(light);
    expect(faceArt(cards.paladin!, 'black')).toEqual(dark);
    // A card with one picture shows it to both sides.
    expect(cards.wyrmling).not.toHaveProperty('darkArt');
    expect(faceArt(cards.wyrmling!, 'black')).toEqual(faceArt(cards.wyrmling!, 'white'));
    expect(faceArt(cards.squire!, 'black')).toEqual({ art: undefined, boardArt: undefined });
  });

  it('resigned and timeout results end the game with no legal actions', () => {
    const state = bare(5);
    state.status = { kind: 'timeout', winner: 'black' };
    expect(legalActions(state)).toEqual([]);
  });
});
