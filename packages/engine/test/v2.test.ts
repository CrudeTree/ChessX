import { describe, expect, it } from 'vitest';
import {
  FILES,
  KING,
  STARTER_CATALOG,
  applyLegalAction,
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
  state.spellPlayed = false;
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
  it('uses an 8x8 board with Kings on d1 and d8, 3 Initiates in front of each King, 7 cards each, and White to move', () => {
    const state = game();
    const at = (color: Color) => state.pieces.filter((p) => p.owner === color).map((p) => `${p.def.name}@${p.square}`).sort();
    expect(at('white')).toEqual([`King@${S('d1')}`, `Initiate@${S('c2')}`, `Initiate@${S('d2')}`, `Initiate@${S('e2')}`].sort());
    expect(at('black')).toEqual([`King@${S('d8')}`, `Initiate@${S('c7')}`, `Initiate@${S('d7')}`, `Initiate@${S('e7')}`].sort());
    expect(state.pieces.filter((p) => p.def.king).every((p) => p.def === KING)).toBe(true);
    expect(state.phase).toBe('play');
    expect(state.active).toBe('white');
    expect(state.turns).toEqual({ white: 1, black: 0 });
    // 7-card hands, then White's turn 1 draws one more and adds the normal +1 to the starting 2 mana.
    expect(state.hand.white).toHaveLength(8);
    expect(state.hand.black).toHaveLength(7);
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
    give(state, 'white', 'tower');
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
    const tower = give(state, 'white', 'tower');
    const initiate = give(state, 'white', 'initiate');
    const deploys = legalActions(state).filter((a) => a.type === 'deploy');
    expect(deploys.every((a) => a.type === 'deploy' && a.cardUid === initiate)).toBe(true);
    expect(deploys.some((a) => a.type === 'deploy' && a.cardUid === tower)).toBe(false);
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
  it('gives +1 mana (no cap) and a card at the start of each turn, and needs an action before ending', () => {
    let state = bare(40);
    state.deck.black = [{ uid: 'dk1', cardId: 'squire' }];
    expect(legalActions(state).some((a) => a.type === 'endTurn')).toBe(false);
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('d1')));
    expect(legalActions(state).some((a) => a.type === 'endTurn')).toBe(true);
    state = act(state, { type: 'endTurn' });
    expect(state.active).toBe('black');
    expect(state.mana.black).toBe(41);
    expect(state.hand.black.map((c) => c.uid)).toContain('dk1');
  });

  it('allows one action and one spell per turn', () => {
    const state = bare(10);
    const insight = give(state, 'white', 'insight');
    give(state, 'white', 'insight');
    state.deck.white = [{ uid: 'a', cardId: 'squire' }, { uid: 'b', cardId: 'squire' }, { uid: 'c', cardId: 'squire' }, { uid: 'd', cardId: 'squire' }];
    let next = act(state, { type: 'spell', cardUid: insight });
    expect(next.hand.white.length).toBe(3);
    expect(legalActions(next).some((a) => a.type === 'spell')).toBe(false);
    next = act(next, find(next, (a) => a.type === 'move'));
    expect(legalActions(next).filter((a) => a.type === 'move')).toHaveLength(0);
  });
});

describe('summoning', () => {
  it('costs the printed mana and goes only on the back row', () => {
    const state = bare(3);
    const hopper = give(state, 'white', 'hopper');
    const tower = give(state, 'white', 'tower');
    const summons = legalActions(state).filter((a) => a.type === 'summon');
    expect(summons.every((a) => a.type === 'summon' && a.cardUid === hopper && a.to < FILES && a.to !== S('d1'))).toBe(true);
    expect(summons.some((a) => a.type === 'summon' && a.cardUid === tower)).toBe(false);
    const next = act(state, summons[0]!);
    expect(next.mana.white).toBe(0);
  });

  it('a summoned piece cannot capture until its owner\'s next turn', () => {
    const state = bare(10);
    state.hand.white = [];
    piece(state, 'white', 'tower', 'a1', 2);
    piece(state, 'black', 'initiate', 'a4');
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('a1') && a.to === S('a4'))).toBe(false);
    state.turns.white = 2;
    expect(legalActions(state).some((a) => a.type === 'move' && a.from === S('a1') && a.to === S('a4'))).toBe(true);
  });

  it('a summoned piece gives check at once and fences the King, though it cannot capture yet', () => {
    let state = bare(10);
    state.pieces.find((p) => p.owner === 'black' && p.def.king)!.square = S('a8');
    const tower = give(state, 'white', 'tower');
    state = act(state, find(state, (a) => a.type === 'summon' && a.cardUid === tower && a.to === S('a1')));
    expect(pieceAt(state, S('a1'))!.activeFromTurn).toBe(2);
    expect(isInCheck(state, 'black')).toBe(true);
    state = act(state, { type: 'endTurn' });
    expect(state.active).toBe('black');
    expect(isInCheck(state, 'black')).toBe(true);
    const kingSteps = legalActions(state).filter((a) => a.type === 'move' && a.from === S('a8'));
    expect(kingSteps.some((a) => a.type === 'move' && a.to === S('a7'))).toBe(false);
    expect(kingSteps.some((a) => a.type === 'move' && a.to === S('b8'))).toBe(true);
  });
});

describe('Dawn Paladin', () => {
  it('costs 4, seals on a 3-turn timer, and leaps like a knight or steps one square straight', () => {
    const card = STARTER_CATALOG.dawn_paladin!;
    expect(card).toMatchObject({ type: 'piece', cost: 4, sealTimer: 3 });
    expect(starterDeck().filter((id) => id === 'dawn_paladin')).toHaveLength(3);
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
  it('costs 2, seals on a 3-turn timer, steps one square diagonally and captures only with a knight leap', () => {
    const card = STARTER_CATALOG.duskfang!;
    expect(card).toMatchObject({ type: 'piece', cost: 2, sealTimer: 3 });
    expect(starterDeck().filter((id) => id === 'duskfang')).toHaveLength(2);
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

describe('Wyrmling', () => {
  it('costs 2, seals on a 1-turn timer, and leaps exactly two squares straight to move or capture', () => {
    const card = STARTER_CATALOG.wyrmling!;
    expect(card).toMatchObject({ type: 'piece', cost: 2, sealTimer: 1 });
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
  it('seals only own non-King pieces, consumes the piece, and costs mana and the action', () => {
    const state = bare(5);
    const mine = piece(state, 'white', 'initiate', 'c3');
    piece(state, 'black', 'initiate', 'c6');
    const tower = give(state, 'white', 'tower');
    const seals = legalActions(state).filter((a) => a.type === 'seal');
    expect(seals).toHaveLength(1);
    expect(seals[0]).toMatchObject({ target: mine.square });
    const next = act(state, seals[0]!);
    expect(pieceAt(next, mine.square)).toBeUndefined();
    expect(sealAt(next, mine.square)?.card.id).toBe('tower');
    expect(next.mana.white).toBe(0);
    expect(next.hand.white.some((c) => c.uid === tower)).toBe(false);
    expect(legalActions(next).filter((a) => a.type === 'move')).toHaveLength(0);
  });

  it('a timer-1 seal hatches at the start of its owner\'s next turn, after exactly one enemy move', () => {
    let state = bare(5);
    piece(state, 'white', 'initiate', 'c3');
    const squire = give(state, 'white', 'squire');
    state = act(state, find(state, (a) => a.type === 'seal' && a.cardUid === squire));
    expect(sealAt(state, S('c3'))?.timer).toBe(1);
    state = act(state, { type: 'endTurn' });
    expect(sealAt(state, S('c3'))).toBeDefined();
    state = act(state, find(state, (a) => a.type === 'move'));
    state = act(state, { type: 'endTurn' });
    expect(sealAt(state, S('c3'))).toBeUndefined();
    const hatched = pieceAt(state, S('c3'))!;
    expect(hatched.def.kind).toBe('squire');
    expect(hatched.activeFromTurn).toBe(state.turns.white + 1);
  });

  it('a timer-3 seal waits three of its owner\'s turns', () => {
    let state = bare(10);
    piece(state, 'white', 'initiate', 'c3');
    const tower = give(state, 'white', 'tower');
    state = act(state, find(state, (a) => a.type === 'seal' && a.cardUid === tower));
    for (let round = 1; round <= 3; round++) {
      state = act(state, { type: 'endTurn' });
      state = act(state, find(state, (a) => a.type === 'move'));
      state = act(state, { type: 'endTurn' });
      if (round < 3) {
        expect(sealAt(state, S('c3'))?.timer).toBe(3 - round);
        state = act(state, find(state, (a) => a.type === 'move'));
      }
    }
    expect(pieceAt(state, S('c3'))?.def.kind).toBe('tower');
  });

  it('blocks movement and lines of attack like any piece', () => {
    const state = bare(0);
    state.pieces.find((p) => p.owner === 'white')!.square = S('a1');
    piece(state, 'black', 'tower', 'a8');
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
    state = act(state, { type: 'endTurn' });
    state = act(state, find(state, (a) => a.type === 'move' && a.to === S('c3')));
    expect(sealAt(state, S('c3'))).toBeUndefined();
    expect(state.discard.white.map((c) => c.cardId)).toContain('squire');
    state = act(state, { type: 'endTurn' });
    expect(pieceAt(state, S('c3'))?.owner).toBe('black');
  });

  it('a seal keeps blocking the line the sealed piece was blocking', () => {
    const state = bare(5);
    state.pieces.find((p) => p.owner === 'white')!.square = S('a1');
    piece(state, 'white', 'initiate', 'a2');
    piece(state, 'black', 'tower', 'a8');
    const squire = give(state, 'white', 'squire');
    const sealMove = find(state, (a) => a.type === 'seal' && a.cardUid === squire);
    expect(isInCheck(act(state, sealMove), 'white')).toBe(false);
  });
});

describe('spells', () => {
  it('Dispel destroys a seal, sending the card to its owner\'s discard pile; spells do not destroy seals otherwise', () => {
    let state = bare(5);
    state.seals.push({ id: 's1', owner: 'black', square: S('c6'), card: STARTER_CATALOG.tower as never, timer: 3 });
    const dispel = give(state, 'white', 'dispel');
    const insight = give(state, 'white', 'insight');
    expect(legalActions(state).filter((a) => a.type === 'spell' && a.cardUid === insight)).toHaveLength(1);
    state = act(state, { type: 'spell', cardUid: dispel, target: S('c6') });
    expect(sealAt(state, S('c6'))).toBeUndefined();
    expect(state.discard.black.map((c) => c.cardId)).toContain('tower');
  });

  it('Dispel costs 3 mana, so 2 mana cannot cast it', () => {
    expect(STARTER_CATALOG.dispel).toMatchObject({ type: 'spell', cost: 3 });
    const state = bare(2);
    state.seals.push({ id: 's1', owner: 'black', square: S('c6'), card: STARTER_CATALOG.tower as never, timer: 3 });
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
      squire: 5,
      hopper: 2,
      cathedral_runner: 2,
      tower: 2,
      dawn_paladin: 3,
      insight: 2,
      dispel: 2,
      wyrmling: 2,
      duskfang: 2,
    });
    expect(starterDeck()).toHaveLength(24);
  });

  it('holds at most four cost-2 cards', () => {
    expect(starterDeck().filter((id) => STARTER_CATALOG[id]!.cost === 2)).toHaveLength(4);
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
    state = act(state, { type: 'endTurn' });
    expect(state.status).toEqual({ kind: 'stalemate' });
    expect(legalActions(state)).toEqual([]);
  });

  it('checkmate: in check with no legal action loses to the other side', () => {
    let state = bare(0);
    state.pieces.find((p) => p.owner === 'black')!.square = S('a8');
    state.pieces.find((p) => p.owner === 'white')!.square = S('c7');
    piece(state, 'white', 'tower', 'b1');
    state = act(state, find(state, (a) => a.type === 'move' && a.from === S('b1') && a.to === S('a1')));
    state = act(state, { type: 'endTurn' });
    expect(state.status).toEqual({ kind: 'checkmate', winner: 'white' });
  });

  it('there is no pass: endTurn needs an action first', () => {
    const state = bare(0);
    expect(legalActions(state).some((a) => a.type === 'endTurn')).toBe(false);
    expect(() => applyLegalAction(state, { type: 'endTurn' })).toThrow();
  });
});

describe('full games', () => {
  it('plays random legal actions without ever throwing or getting stuck', () => {
    for (let seed = 1; seed <= 8; seed++) {
      let state = game(seed);
      let pick = seed * 7919;
      for (let step = 0; step < 500 && state.status.kind === 'playing'; step++) {
        const actions = legalActions(state);
        expect(actions.length).toBeGreaterThan(0);
        pick = (pick * 1103515245 + 12345) & 0x7fffffff;
        const nonEnd = actions.filter((a) => a.type !== 'endTurn');
        const pool = state.actionTaken || nonEnd.length === 0 ? actions : nonEnd;
        state = act(state, pool[pick % pool.length]!);
      }
    }
  });

  it('every game starts straight in play with full hands and both starting rows', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const state = game(seed);
      expect(state.hand.white).toHaveLength(8);
      expect(state.hand.black).toHaveLength(7);
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
    give(state, 'black', 'tower');
    state.deck.black = [{ uid: 'dk', cardId: 'dispel' }];
    state.seals.push({ id: 's1', owner: 'black', square: S('c6'), card: STARTER_CATALOG.tower as never, timer: 2 });
    const record = { state, seq: 3, events: [] };
    const white = viewFor(record, 'white');
    expect(white.hand?.map((c) => c.cardId)).toEqual(['squire']);
    expect(white.handCount).toEqual({ white: 1, black: 1 });
    expect(white.deckCount.black).toBe(1);
    expect(JSON.stringify(white)).not.toContain('dk');
    expect(white.seals[0]).toMatchObject({ cardId: 'tower', timer: 2 });
    expect(white.legalActions.length).toBeGreaterThan(0);
    const black = viewFor(record, 'black');
    expect(black.hand?.map((c) => c.cardId)).toEqual(['tower']);
    expect(black.legalActions).toEqual([]);
    const hotseat = viewFor(record, 'black', { hotseat: true });
    expect(hotseat.you).toBe('white');
    expect(hotseat.legalActions.length).toBeGreaterThan(0);
  });

  it('describes movement in words', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    expect(cards.hopper!.text).toBe('Leaps like a knight.');
    expect(cards.tower!.text).toBe('Slides straight, any distance.');
    expect(cards.squire!.text).toContain('Steps forward');
    expect(cards.dispel!.type).toBe('spell');
  });

  it('sends piece move rules so the client can draw them', () => {
    const cards = viewFor({ state: bare(), seq: 0, events: [] }, 'white').cards;
    expect(cards.duskfang!.rules).toEqual(STARTER_CATALOG.duskfang!.type === 'piece' ? STARTER_CATALOG.duskfang!.piece.rules : null);
    expect(JSON.parse(JSON.stringify(cards.squire!.rules))[1].mode).toBe('capture');
    expect(cards.insight!.rules).toBeUndefined();
  });

  it('resigned and timeout results end the game with no legal actions', () => {
    const state = bare(5);
    state.status = { kind: 'timeout', winner: 'black' };
    expect(legalActions(state)).toEqual([]);
  });
});
