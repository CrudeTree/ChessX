import { describe, expect, it } from 'vitest';
import {
  FILES,
  KING,
  STARTER_CATALOG,
  applyLegalAction,
  bountyFor,
  faceArt,
  incomeFor,
  isInCheck,
  legalActions,
  nextRecord,
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

describe('mana (Djabooty, 2026-10-11)', () => {
  /** Plays King shuffles until White has started `turn` turns, returning the turnStarted events White got. */
  function playTo(turn: number): { state: GameState; incomes: number[] } {
    let state = bare(0);
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

  it('income steps up: +1 on turns 1 to 5, +2 on 6 to 10, +3 on 11 to 15, then +4', () => {
    expect(Array.from({ length: 20 }, (_, i) => incomeFor(i + 1))).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4]);
    const { state, incomes } = playTo(16);
    expect(incomes).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4]);
    expect(state.mana.white).toBe(34);
    // The view shows what the side to move got this turn and what the other side's next turn brings.
    const { state: fifth } = playTo(5);
    const blackToMove = act(fifth, find(fifth, (a) => a.type === 'move' && a.from === kingAt(fifth)));
    expect(viewFor({ state: blackToMove, seq: 0, events: [] }, 'white').income).toEqual({ white: 2, black: 1 });
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
    expect(events[2]).toMatchObject({ type: 'turnStarted', color: 'black', turn: 1, income: 1 });
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

describe('starter deck', () => {
  it('is the agreed 25-card list', () => {
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
    });
    expect(starterDeck()).toHaveLength(25);
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
    expect(cards.mystic_dragon!.text).toBe('Slides in any direction, up to 2 squares.');
    expect(cards.ancient_mystic_dragon!.text).toBe('Slides in any direction, any distance.');
    // A rule that only moves says "Moves", one that only captures says "Captures", like a chess pawn.
    expect(cards.duskfang!.text).toBe('Moves diagonally, 1 square. Captures like a knight.');
    expect(cards.squire!.text).toBe('Moves forward, 1 square. Captures diagonally forward, 1 square.');
    expect(cards.dispel!.type).toBe('spell');
  });

  it('sends types, the Initiate\'s any path and the longer viewer text', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    expect(cards.initiate).toMatchObject({ tribe: 'Zealot', anyPath: true, abilityText: 'Any path: evolves into any level 2.' });
    expect(cards.initiate!.detail).toContain('any level-2 card');
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
    expect(JSON.parse(JSON.stringify(cards.squire!.rules))[1].mode).toBe('capture');
    expect(cards.insight!.rules).toBeUndefined();
  });

  it('sends card art to the client, with no board picture for a spell', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    expect(cards.duskfang).toMatchObject({
      art: '/art/duskfang_white.png',
      boardArt: '/art/duskfang_white.png',
      darkArt: '/art/duskfang_dark.png',
      darkBoardArt: '/art/duskfang_dark.png',
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
      expect(faceArt(card, 'white')).toEqual({ art: `/art/${id}_white.png`, boardArt: onBoard(`/art/${id}_white.png`) });
      expect(faceArt(card, 'black')).toEqual({ art: `/art/${id}_dark.png`, boardArt: onBoard(`/art/${id}_dark.png`) });
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
