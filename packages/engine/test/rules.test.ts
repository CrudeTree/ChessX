import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAction,
  applyArenaOp,
  createArenaGame,
  applyBalance,
  baseCardDef,
  createGame,
  customCardsGiven,
  describeAbility,
  describeCard,
  describeMovement,
  DIRS,
  EMPTY_BALANCE,
  getCardDef,
  getPieceDef,
  IllegalActionError,
  isInCheck,
  legalActions,
  legalMoves,
  parseSquare as s,
  pieceAt,
  pruneUnknownCards,
  rebasePieces,
  REWARD_CARDS,
  STARTER_CARDS,
  starterDeck,
  validateBalance,
  validateDeck,
  viewFor,
  type Action,
  type GameState,
  type SummonCardDef,
} from '../src/index.js';

/** A game with a deep mana pool so card tests can play cards straight away. */
function newGame(seed = 1): GameState {
  return createGame({ decks: { white: starterDeck(), black: starterDeck() }, seed, rules: { startingMana: 9999 } });
}

/** A game with the real starting mana (0). */
function realGame(seed = 1): GameState {
  return createGame({ decks: { white: starterDeck(), black: starterDeck() }, seed });
}

/** Take an owed draw if there is one (as a player would by clicking the deck). */
function drawIfOwed(state: GameState): GameState {
  return state.players[state.turn].pendingDraws > 0 ? applyAction(state, { type: 'draw' }) : state;
}

/** Apply an action (taking an owed draw first, as a player would). */
function act(state: GameState, action: Action): GameState {
  return applyAction(drawIfOwed(state), action);
}

/** Pass the turn (only legal when no move exists). */
function end(state: GameState): GameState {
  return applyAction(state, { type: 'endTurn' });
}

/** Move a piece. Under the phase rules the move ends the turn by itself. */
function move(state: GameState, from: string, to: string): GameState {
  return act(state, { type: 'move', from: s(from), to: s(to) });
}

/** Put a specific card into a player's hand so tests don't depend on the shuffle. */
function giveCard(state: GameState, color: 'white' | 'black', cardId: string): string {
  const inst = { instanceId: `test-${cardId}-${state.nextId++}`, cardId };
  state.players[color].hand.push(inst);
  return inst.instanceId;
}

const has = (actions: Action[], type: Action['type']) => actions.some((a) => a.type === type);

describe('setup', () => {
  it('deals 7 cards from a 30 card deck and sets up a standard board', () => {
    const g = newGame();
    expect(g.players.white.hand).toHaveLength(7);
    expect(g.players.white.deck).toHaveLength(23);
    expect(Object.keys(g.pieces)).toHaveLength(32);
    expect(pieceAt(g, s('e1'))?.kind).toBe('king');
    expect(pieceAt(g, s('d8'))?.kind).toBe('queen');
  });

  it('is deterministic for a given seed', () => {
    const a = newGame(42);
    const b = newGame(42);
    expect(a.players.white.hand.map((c) => c.cardId)).toEqual(b.players.white.hand.map((c) => c.cardId));
  });

  it('validates deck size (25-40) and copy limits', () => {
    expect(validateDeck(starterDeck())).toEqual([]);
    expect(validateDeck(starterDeck().slice(0, 25))).toEqual([]);
    expect(validateDeck(starterDeck().slice(0, 24)).length).toBeGreaterThan(0);
    expect(validateDeck([...starterDeck(), ...starterDeck().slice(0, 11)]).length).toBeGreaterThan(0); // 41
    expect(validateDeck(new Array(30).fill('the_ox')).length).toBeGreaterThan(0);
    expect(validateDeck([...starterDeck().slice(0, 24), 'not_a_card']).length).toBeGreaterThan(0);
  });
});

describe('chess movement', () => {
  it('white has 20 legal moves at the start', () => {
    expect(legalMoves(newGame())).toHaveLength(20);
  });

  it('rejects illegal moves', () => {
    expect(() => move(newGame(), 'e2', 'e5')).toThrow(IllegalActionError);
    expect(() => move(newGame(), 'e7', 'e5')).toThrow(IllegalActionError); // not your piece
  });

  it("scholar's mate is checkmate", () => {
    let g = newGame();
    g = move(g, 'e2', 'e4');
    g = move(g, 'e7', 'e5');
    g = move(g, 'd1', 'h5');
    g = move(g, 'b8', 'c6');
    g = move(g, 'f1', 'c4');
    g = move(g, 'g8', 'f6');
    g = move(g, 'h5', 'f7');
    expect(g.status).toEqual({ kind: 'checkmate', winner: 'white' });
    expect(legalActions(g)).toHaveLength(0);
  });

  it('en passant and castling work', () => {
    let g = newGame();
    g = move(g, 'e2', 'e4');
    g = move(g, 'a7', 'a6');
    g = move(g, 'e4', 'e5');
    g = move(g, 'd7', 'd5');
    expect(g.enPassant).toBe(s('d6'));
    g = move(g, 'e5', 'd6');
    expect(pieceAt(g, s('d5'))).toBeUndefined();
    expect(pieceAt(g, s('d6'))?.kind).toBe('pawn');

    g = move(g, 'a6', 'a5');
    g = move(g, 'g1', 'f3');
    g = move(g, 'a5', 'a4');
    g = move(g, 'f1', 'c4');
    g = move(g, 'a4', 'a3');
    g = move(g, 'e1', 'g1'); // castle
    expect(pieceAt(g, s('g1'))?.kind).toBe('king');
    expect(pieceAt(g, s('f1'))?.kind).toBe('rook');
  });

  it('en passant is offered on the very next turn only, whatever else happened that turn', () => {
    let g = newGame();
    const ws = giveCard(g, 'white', 'whetstone');
    g = act(g, { type: 'playCard', cardInstanceId: ws, target: s('e2') }); // a spell before the push
    g = move(g, 'e2', 'e4');
    g = move(g, 'a7', 'a6');
    g = move(g, 'e4', 'e5');
    g = move(g, 'd7', 'd5');
    expect(g.enPassant).toBe(s('d6'));
    g = move(g, 'a2', 'a3'); // white does not take it...
    g = move(g, 'a6', 'a5');
    expect(legalMoves(g).some((m) => m.from === s('e5') && m.to === s('d6'))).toBe(false); // ...and it is gone
  });

  it('pawn promotes to queen by default', () => {
    let g = newGame();
    g = move(g, 'a2', 'a4');
    g = move(g, 'b7', 'b5');
    g = move(g, 'a4', 'b5');
    g = move(g, 'h7', 'h6');
    g = move(g, 'b5', 'b6');
    g = move(g, 'h6', 'h5');
    g = move(g, 'b6', 'b7');
    g = move(g, 'h5', 'h4');
    g = move(g, 'b7', 'a8');
    expect(pieceAt(g, s('a8'))?.kind).toBe('queen');
  });
});

describe('turn structure', () => {
  it('phases: any number of cards, then one move which ends the turn', () => {
    let g = newGame();
    expect(viewFor(g, 'white').phase).toBe('main');
    const ws = giveCard(g, 'white', 'whetstone');
    const sw = giveCard(g, 'white', 'shield_wall');
    g = act(g, { type: 'playCard', cardInstanceId: ws, target: s('e2') });
    g = act(g, { type: 'playCard', cardInstanceId: sw, target: s('e2') });
    expect(g.turn).toBe('white');
    expect(g.turnInfo.cardsPlayed).toBe(2);
    expect(pieceAt(g, s('e2'))!.atk).toBe(2);
    expect(pieceAt(g, s('e2'))!.maxDef).toBe(1);
    // The move closes the turn: black to play, mana collected, turn info reset.
    g = move(g, 'e2', 'e4');
    expect(g.turn).toBe('black');
    expect(g.turnInfo.cardsPlayed).toBe(0);
    expect(g.events.map((e) => e.type)).toEqual(expect.arrayContaining(['moved', 'manaGained', 'turnEnded']));
    // Nothing more can be done for white now.
    expect(() => act(g, { type: 'playCard', cardInstanceId: giveCard(g, 'white', 'whetstone'), target: s('e4') })).toThrow(IllegalActionError);
  });

  it('you cannot end your turn without moving; cards (even summons) do not count', () => {
    const g = newGame();
    expect(has(legalActions(g), 'endTurn')).toBe(false);
    expect(() => end(g)).toThrow(/Move a piece/);
    const ws = giveCard(g, 'white', 'whetstone');
    const afterSpell = act(g, { type: 'playCard', cardInstanceId: ws, target: s('e2') });
    expect(has(legalActions(afterSpell), 'endTurn')).toBe(false);
    const ox = giveCard(g, 'white', 'the_ox');
    const afterSummon = act(g, { type: 'playCard', cardInstanceId: ox, target: s('e2') });
    expect(has(legalActions(afterSummon), 'endTurn')).toBe(false);
    expect(() => end(afterSummon)).toThrow(/Move a piece/);
    expect(move(afterSummon, 'a2', 'a3').turn).toBe('black');
  });

  it('several cards, including several summons, may be played in one turn if the mana allows', () => {
    let g = newGame();
    const ox = giveCard(g, 'white', 'the_ox');
    const ox2 = giveCard(g, 'white', 'the_ox');
    const fs = giveCard(g, 'white', 'foresight');
    const before = g.players.white.mana;
    g = act(g, { type: 'playCard', cardInstanceId: ox, target: s('e2') });
    g = act(g, { type: 'playCard', cardInstanceId: ox2, target: s('d2') });
    g = act(g, { type: 'playCard', cardInstanceId: fs });
    expect(g.players.white.mana).toBe(before - 200 - 200 - 200);
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(3);
    expect(pieceAt(g, s('d2'))!.summon?.turnsRemaining).toBe(3);
    // Sacrifices cannot be the piece that moves; any other piece can.
    expect(legalMoves(g).some((m) => m.from === s('e2') || m.from === s('d2'))).toBe(false);
    g = move(g, 'a2', 'a3');
    expect(g.turn).toBe('black');

    // Mana is the only limit: with exactly one card's worth, only one card is playable.
    let h = realGame();
    h.players.white.mana = 200;
    const a = giveCard(h, 'white', 'the_ox');
    const b = giveCard(h, 'white', 'the_ox');
    h = act(h, { type: 'playCard', cardInstanceId: a, target: s('e2') });
    expect(legalActions(h).some((x) => x.type === 'playCard' && x.cardInstanceId === b)).toBe(false);
    expect(() => act(h, { type: 'playCard', cardInstanceId: b, target: s('d2') })).toThrow(/Not enough mana/);
  });

  it('if no move is possible at all, the turn may be passed', () => {
    let g = newGame();
    // Freeze every white piece that can act by putting them all in Defense mode
    // over a few turns; when white has no legal move left, End Turn becomes a pass.
    // Simpler: strip white down to a lone king boxed in by its own frozen pawns.
    for (const id of Object.keys(g.pieces)) {
      const p = g.pieces[id]!;
      if (p.owner === 'white' && p.kind !== 'king' && p.kind !== 'pawn') {
        delete g.pieces[id];
        g.board[p.square] = null;
      }
    }
    for (const p of Object.values(g.pieces)) if (p.owner === 'white' && p.kind === 'pawn') p.stance = 'defense';
    // King on e1 is boxed by frozen pawns on d2/e2/f2 and empty d1/f1 — it can still move sideways.
    // Occupy d1 and f1 with frozen pawns too so nothing can move.
    for (const sqn of ['d1', 'f1']) {
      const src = pieceAt(g, s(sqn === 'd1' ? 'a2' : 'h2'))!;
      g.board[src.square] = null;
      src.square = s(sqn);
      g.board[src.square] = src.id;
    }
    // Playable summons in hand do not remove the pass: only a move would.
    giveCard(g, 'white', 'the_ox');
    expect(legalMoves(g)).toHaveLength(0);
    expect(has(legalActions(g), 'endTurn')).toBe(true);
    g = end(g);
    expect(g.turn).toBe('black');
    expect(g.players.white.mana).toBeGreaterThan(9999); // passing still collects income
  });

  it('on every 5th turn the player owes a draw and must take it before anything else', () => {
    let g = newGame();
    const w0 = g.players.white.hand.length;
    g = move(g, 'a2', 'a3');
    g = move(g, 'a7', 'a6');
    g = move(g, 'b2', 'b3');
    g = move(g, 'b7', 'b6');
    g = move(g, 'c2', 'c3');
    g = move(g, 'c7', 'c6');
    g = move(g, 'd2', 'd3');
    g = move(g, 'd7', 'd6'); // white starts turn 5
    expect(g.players.white.turnsTaken).toBe(5);
    expect(g.players.white.pendingDraws).toBe(1);
    expect(legalActions(g)).toEqual([{ type: 'draw' }]);
    expect(() => applyAction(g, { type: 'move', from: s('e2'), to: s('e4') })).toThrow(/Draw a card first/);
    expect(() => applyAction(g, { type: 'endTurn' })).toThrow(/Draw a card first/);
    g = applyAction(g, { type: 'draw' });
    expect(g.players.white.hand.length).toBe(w0 + 1);
    expect(g.turn).toBe('white');
    expect(legalMoves(g).length).toBeGreaterThan(0);
  });

  it('resigning ends the game', () => {
    const g = applyAction(newGame(), { type: 'resign' });
    expect(g.status).toEqual({ kind: 'resigned', winner: 'black' });
  });

  it('player views hide the opponent hand and deck, but show the counts', () => {
    let g = newGame();
    const v = viewFor(g, 'black');
    expect(v.players.black.hand).toHaveLength(7);
    expect(v.players.white.hand).toBeNull();
    expect(v.players.white.handCount).toBe(7);
    expect(v.players.white.deckCount).toBe(23);
    expect(v.legalActions).toHaveLength(0); // white to move
    expect(viewFor(g, 'white').legalActions.length).toBeGreaterThan(20);

    // Nothing that identifies a hidden card may appear anywhere in the serialised view,
    // including after a draw (the event only says how many).
    g = move(g, 'a2', 'a3'); g = move(g, 'a7', 'a6'); g = move(g, 'b2', 'b3'); g = move(g, 'b7', 'b6');
    g = move(g, 'c2', 'c3'); g = move(g, 'c7', 'c6'); g = move(g, 'd2', 'd3'); g = move(g, 'd7', 'd6');
    g = applyAction(g, { type: 'draw' }); // white draws on turn 5
    const json = JSON.stringify(viewFor(g, 'black'));
    for (const hidden of [...g.players.white.hand, ...g.players.white.deck, ...g.players.black.deck]) {
      expect(json).not.toContain(hidden.instanceId);
    }
    expect(viewFor(g, 'black').players.white.handCount).toBe(8);
  });
});

describe('combat with HP', () => {
  it('a 1 ATK attack on a 3 HP piece damages it and the attacker stays put', () => {
    let g = newGame();
    g = move(g, 'e2', 'e4');
    g = move(g, 'd7', 'd5');
    pieceAt(g, s('d5'))!.hp = 3;
    pieceAt(g, s('d5'))!.maxHp = 3;
    g = move(g, 'e4', 'd5');
    const target = pieceAt(g, s('d5'))!;
    expect(target.owner).toBe('black');
    expect(target.hp).toBe(2);
    expect(pieceAt(g, s('e4'))?.owner).toBe('white');
    expect(g.turn).toBe('black');
  });

  it('DEF only shields in Defense mode, and is depleted before HP', () => {
    let g = newGame();
    g = move(g, 'e2', 'e4');
    g = move(g, 'd7', 'd5');
    const pawn = pieceAt(g, s('d5'))!;
    pawn.hp = 2;
    pawn.maxHp = 2;
    pawn.def = 1;
    pawn.maxDef = 1;
    const attackMode = move(g, 'e4', 'd5');
    expect(pieceAt(attackMode, s('d5'))!.hp).toBe(1);
    expect(pieceAt(attackMode, s('d5'))!.def).toBe(1);
    pawn.stance = 'defense';
    const defenseMode = move(g, 'e4', 'd5');
    expect(pieceAt(defenseMode, s('d5'))!.hp).toBe(2);
    expect(pieceAt(defenseMode, s('d5'))!.def).toBe(0);
  });

  it('a big hit wipes the shield and the HP behind it (DEF 3 / HP 1 vs ATK 4)', () => {
    let g = newGame();
    g = move(g, 'e2', 'e4');
    g = move(g, 'd7', 'd5');
    const pawn = pieceAt(g, s('d5'))!;
    pawn.def = 3;
    pawn.maxDef = 3;
    pawn.stance = 'defense';
    pieceAt(g, s('e4'))!.atk = 4;
    g = move(g, 'e4', 'd5');
    expect(pieceAt(g, s('d5'))!.owner).toBe('white');
    const dmg = g.events.find((e) => e.type === 'damaged');
    expect(dmg && dmg.type === 'damaged' && dmg.shield).toBe(3);
  });

  it("the King's attack destroys any piece regardless of HP and DEF", () => {
    let g = newGame();
    // Put a beefy black piece next to the white king: knight to d2 with 5 HP, 3 DEF, in Defense mode.
    const knight = pieceAt(g, s('b8'))!;
    const d2 = pieceAt(g, s('d2'))!;
    delete g.pieces[d2.id];
    g.board[s('d2')] = null;
    g.board[knight.square] = null;
    knight.square = s('d2');
    g.board[s('d2')] = knight.id;
    knight.hp = 5;
    knight.maxHp = 5;
    knight.def = 3;
    knight.maxDef = 3;
    knight.stance = 'defense';
    expect(pieceAt(g, s('e1'))!.atk).toBe(1);
    g = move(g, 'e1', 'd2');
    expect(pieceAt(g, s('d2'))!.kind).toBe('king'); // king took the square
    expect(Object.values(g.pieces).some((p) => p.id === knight.id)).toBe(false);
    expect(g.events.some((e) => e.type === 'attacked' && e.execution === true)).toBe(true);
    expect(g.events.some((e) => e.type === 'destroyed' && e.pieceId === knight.id)).toBe(true);
  });

  it('a piece that survives a capture still gives check; you cannot end the turn in check', () => {
    let g = newGame();
    g = move(g, 'e2', 'e4');
    g = move(g, 'd7', 'd5');
    g = move(g, 'e4', 'd5');
    g = move(g, 'e7', 'e6');
    g = move(g, 'd5', 'e6');
    g = move(g, 'g8', 'h6'); // knight to h6, where it could capture on f7
    const pawn = pieceAt(g, s('e6'))!;
    pawn.hp = 5;
    pawn.maxHp = 5;
    g = move(g, 'e6', 'f7');
    expect(isInCheck(g, 'black')).toBe(true);
    // Nxf7 would only deal 1 damage and leave the king in check, so it is not legal...
    expect(legalMoves(g).some((m) => m.from === s('h6') && m.to === s('f7'))).toBe(false);
    // ...but the King's royal strike destroys the pawn outright, so Kxf7 is.
    expect(legalMoves(g).some((m) => m.from === s('e8') && m.to === s('f7'))).toBe(true);
    // Every legal move resolves the check; ending the turn is not offered.
    for (const m of legalMoves(g)) expect(isInCheck(applyAction(g, m), 'black')).toBe(false);
    expect(has(legalActions(g), 'endTurn')).toBe(false);
    expect(() => end(g)).toThrow(/in check/);
    // Cards may still be played while in check (the move that follows must resolve it).
    const ws = giveCard(g, 'black', 'whetstone');
    const ox = giveCard(g, 'black', 'the_ox');
    expect(legalActions(g).some((a) => a.type === 'playCard' && a.cardInstanceId === ws)).toBe(true);
    expect(legalActions(g).some((a) => a.type === 'playCard' && a.cardInstanceId === ox)).toBe(true);
    g = act(g, { type: 'playCard', cardInstanceId: ox, target: s('a7') });
    expect(isInCheck(g, 'black')).toBe(true);
    expect(() => move(g, 'b7', 'b6')).toThrow(/out of check/);
    g = move(g, 'e8', 'f7');
    expect(g.turn).toBe('white');
  });
});

describe('cards', () => {
  it('summons replace the sacrificed piece after the timer runs down', () => {
    let g = newGame();
    const ox = giveCard(g, 'white', 'the_ox');
    const acts = legalActions(g).filter((a) => a.type === 'playCard' && a.cardInstanceId === ox);
    expect(acts).toHaveLength(8); // any of the 8 pawns (tier 1)

    g = act(g, { type: 'playCard', cardInstanceId: ox, target: s('e2') });
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(3);
    expect(legalMoves(g).some((m) => m.from === s('e2'))).toBe(false); // the sacrifice is frozen
    g = move(g, 'a2', 'a3');
    g = move(g, 'a7', 'a6');
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(2);
    g = move(g, 'b2', 'b3');
    g = move(g, 'a6', 'a5');
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(1);
    g = move(g, 'c2', 'c3');
    g = move(g, 'a5', 'a4');
    const summoned = pieceAt(g, s('e2'))!;
    expect(summoned.kind).toBe('the_ox');
    expect(summoned.atk).toBe(2);
    expect(summoned.hp).toBe(2);
    expect(g.players.white.graveyard.some((c) => c.instanceId === ox)).toBe(true);
    const oxMoves = legalMoves(g).filter((m) => m.from === s('e2')).map((m) => m.to);
    expect(oxMoves).toContain(s('e3'));
    expect(oxMoves).toContain(s('e4'));
    expect(oxMoves).not.toContain(s('f3'));
  });

  it('a summon fails if the sacrificed piece is destroyed', () => {
    let g = newGame();
    g = move(g, 'e2', 'e4');
    g = move(g, 'd7', 'd5');
    const ox = giveCard(g, 'white', 'the_ox');
    g = move(act(g, { type: 'playCard', cardInstanceId: ox, target: s('e4') }), 'a2', 'a3');
    g = move(g, 'd5', 'e4');
    expect(pieceAt(g, s('e4'))!.owner).toBe('black');
    expect(g.events.some((e) => e.type === 'summonFailed') || g.players.white.graveyard.some((c) => c.instanceId === ox)).toBe(true);
    expect(Object.values(g.pieces).some((p) => p.kind === 'the_ox')).toBe(false);
  });

  it('tier requirements are enforced (including per-card overrides)', () => {
    const g = newGame();
    // War Chariot is tier 3: sacrifice a tier 2 (knight or bishop).
    const chariot = giveCard(g, 'white', 'war_chariot');
    const chariotTargets = legalActions(g)
      .filter((a): a is Extract<Action, { type: 'playCard' }> => a.type === 'playCard' && a.cardInstanceId === chariot)
      .map((a) => a.target);
    expect(chariotTargets.sort()).toEqual([s('b1'), s('c1'), s('f1'), s('g1')].sort());
    // Elder Wyrm overrides the default: it is a beefed-up queen, so it costs a tier 4 (the queen).
    const wyrm = giveCard(g, 'white', 'elder_wyrm');
    const wyrmTargets = legalActions(g)
      .filter((a): a is Extract<Action, { type: 'playCard' }> => a.type === 'playCard' && a.cardInstanceId === wyrm)
      .map((a) => a.target);
    expect(wyrmTargets).toEqual([s('d1')]);
    expect(() => act(g, { type: 'playCard', cardInstanceId: wyrm, target: s('a1') })).toThrow(IllegalActionError);
  });

  it('spells modify stats, deal damage and draw', () => {
    let g = newGame();
    const hide = giveCard(g, 'white', 'iron_hide');
    g = move(act(g, { type: 'playCard', cardInstanceId: hide, target: s('e2') }), 'a2', 'a3');
    expect(pieceAt(g, s('e2'))!.hp).toBe(3);
    expect(pieceAt(g, s('e2'))!.maxHp).toBe(3);

    const hex = giveCard(g, 'black', 'hex');
    g = move(act(g, { type: 'playCard', cardInstanceId: hex, target: s('e2') }), 'a7', 'a6');
    expect(pieceAt(g, s('e2'))!.hp).toBe(2);

    const before = g.players.white.hand.length;
    const fs = giveCard(g, 'white', 'foresight');
    g = act(g, { type: 'playCard', cardInstanceId: fs });
    expect(g.players.white.hand.length).toBe(before + 2); // +1 given, -1 played, +2 drawn
  });

  describe('mana', () => {
    it('starts at 0 and every card has a cost of at least 150', () => {
      const g = realGame();
      expect(g.players.white.mana).toBe(0);
      expect(g.players.black.mana).toBe(0);
      for (const id of [...STARTER_CARDS, ...REWARD_CARDS]) expect(getCardDef(id).cost).toBeGreaterThanOrEqual(150);
    });

    it('cards cannot be played without mana, with a clear error', () => {
      const g = realGame();
      const ws = giveCard(g, 'white', 'whetstone');
      expect(legalActions(g).some((a) => a.type === 'playCard')).toBe(false);
      expect(() => act(g, { type: 'playCard', cardInstanceId: ws, target: s('e2') })).toThrow(/Not enough mana.*costs 150.*have 0/);
    });

    it('a full army earns 32 mana at the end of its turn, one per tier per piece', () => {
      let g = realGame();
      expect(viewFor(g, 'white').players.white.manaIncome).toBe(32); // 8 + 2·2 + 2·2 + 2·3 + 4 + 6
      g = move(g, 'e2', 'e4');
      expect(g.players.white.mana).toBe(32);
      expect(g.players.black.mana).toBe(0); // black has not ended a turn yet
      const gained = g.events.find((e) => e.type === 'manaGained');
      expect(gained).toMatchObject({ type: 'manaGained', color: 'white', total: 32, mana: 32 });
      if (gained?.type !== 'manaGained') throw new Error('unreachable');
      expect(gained.pieces).toHaveLength(16);
      expect(gained.pieces.find((p) => p.square === s('e1'))?.amount).toBe(6); // the King
      expect(gained.pieces.find((p) => p.square === s('e4'))?.amount).toBe(1); // the pawn that moved
      g = move(g, 'e7', 'e5');
      expect(g.players.black.mana).toBe(32);
    });

    it('losing pieces lowers income; playing a card spends it', () => {
      let g = realGame();
      g = move(g, 'e2', 'e4');
      g = move(g, 'd7', 'd5');
      g = move(g, 'e4', 'd5'); // pawn takes pawn: black now has 15 pieces
      expect(g.players.white.mana).toBe(64);
      expect(viewFor(g, 'black').players.black.manaIncome).toBe(31);
      g = move(g, 'a7', 'a6');
      expect(g.players.black.mana).toBe(63);

      // After five ended turns white has 160 and can afford a 150 spell; it is deducted immediately.
      for (const [f, t] of [['a2', 'a3'], ['a6', 'a5'], ['b2', 'b3'], ['a5', 'a4'], ['c2', 'c3'], ['h7', 'h6']] as const) g = move(g, f, t);
      expect(g.players.white.mana).toBe(160);
      const ws = giveCard(g, 'white', 'whetstone');
      expect(legalActions(g).some((a) => a.type === 'playCard' && a.cardInstanceId === ws)).toBe(true);
      g = act(g, { type: 'playCard', cardInstanceId: ws, target: s('e1') });
      expect(g.players.white.mana).toBe(10);
      expect(viewFor(g, 'white').players.white.mana).toBe(10);
    });
  });

  it('Hex only targets enemy Tier 1 pieces (and can destroy one)', () => {
    let g = newGame();
    const hex = giveCard(g, 'white', 'hex');
    const targets = legalActions(g)
      .filter((a): a is Extract<Action, { type: 'playCard' }> => a.type === 'playCard' && a.cardInstanceId === hex)
      .map((a) => a.target!)
      .sort();
    expect(targets).toEqual([...'abcdefgh'].map((f) => s(`${f}7`)).sort()); // the eight black pawns
    expect(() => act(g, { type: 'playCard', cardInstanceId: hex, target: s('e8') })).toThrow(IllegalActionError); // king
    expect(() => act(g, { type: 'playCard', cardInstanceId: hex, target: s('b8') })).toThrow(IllegalActionError); // knight (tier 2)
    expect(() => act(g, { type: 'playCard', cardInstanceId: hex, target: s('e2') })).toThrow(IllegalActionError); // own pawn
    g = act(g, { type: 'playCard', cardInstanceId: hex, target: s('e7') });
    expect(pieceAt(g, s('e7'))).toBeUndefined();
  });

  it('the King is Tier 6 and still never a sacrifice', () => {
    const g = newGame();
    expect(pieceAt(g, s('e1'))!.kind).toBe('king');
    // No summon card's sacrifice tier can reach it, and it is excluded explicitly anyway.
    for (const id of ['the_ox', 'war_chariot', 'elder_wyrm', 'storm_drake']) giveCard(g, 'white', id);
    const summonTargets = legalActions(g).filter((a) => {
      if (a.type !== 'playCard') return false;
      const inst = g.players.white.hand.find((c) => c.instanceId === a.cardInstanceId)!;
      return getCardDef(inst.cardId).type === 'summon' && a.target === s('e1');
    });
    expect(summonTargets).toHaveLength(0);
  });

  it('reward spells: Battle Cry buffs all pawns, Second Wind restores, Battle Trance frees a defender, Smite hits for 2', () => {
    let g = newGame();
    const cry = giveCard(g, 'white', 'battle_cry');
    g = act(g, { type: 'playCard', cardInstanceId: cry });
    for (const f of 'abcdefgh') expect(pieceAt(g, s(`${f}2`))!.atk).toBe(2);
    expect(pieceAt(g, s('b1'))!.atk).toBe(1); // knights untouched

    // Put e2 in Defense, then Battle Trance frees it and it may still move this turn.
    g = act(g, { type: 'setStance', square: s('e2'), stance: 'defense' });
    expect(legalMoves(g).some((m) => m.from === s('e2'))).toBe(false);
    const trance = giveCard(g, 'white', 'battle_trance');
    expect(legalActions(g).some((a) => a.type === 'playCard' && a.cardInstanceId === trance && a.target === s('e2'))).toBe(true);
    g = act(g, { type: 'playCard', cardInstanceId: trance, target: s('e2') });
    expect(pieceAt(g, s('e2'))!.stance).toBe('attack');
    expect(legalMoves(g).some((m) => m.from === s('e2'))).toBe(true);

    // Smite: 2 damage. Give the target 3 HP so it survives with 1, then Second Wind restores it.
    const smite = giveCard(g, 'white', 'smite');
    const e7 = pieceAt(g, s('e7'))!;
    e7.hp = 3;
    e7.maxHp = 3;
    g = act(g, { type: 'playCard', cardInstanceId: smite, target: s('e7') });
    expect(pieceAt(g, s('e7'))!.hp).toBe(1);
    g = move(g, 'a2', 'a3');
    const wind = giveCard(g, 'black', 'second_wind');
    g = act(g, { type: 'playCard', cardInstanceId: wind, target: s('e7') });
    expect(pieceAt(g, s('e7'))!.hp).toBe(3);
  });

  it('reward creatures have sensible movement patterns', () => {
    let g = newGame();
    const boar = giveCard(g, 'white', 'thornback_boar');
    g = move(act(g, { type: 'playCard', cardInstanceId: boar, target: s('e2') }), 'a2', 'a3');
    g = move(g, 'a7', 'a6');
    g = move(g, 'b2', 'b3');
    g = move(g, 'a6', 'a5'); // boar summoned at start of white's turn 3
    expect(pieceAt(g, s('e2'))!.kind).toBe('thornback_boar');
    const to = legalMoves(g).filter((m) => m.from === s('e2')).map((m) => m.to);
    expect(to).toContain(s('e3'));
    expect(to).toContain(s('e4')); // charges forward 2
    expect(to).not.toContain(s('d2')); // d2 occupied by own pawn
    expect(to).not.toContain(s('e1')); // never backwards
  });

  it('Dark Ritual hastens a summon', () => {
    let g = newGame();
    const ox = giveCard(g, 'white', 'the_ox');
    const ritual = giveCard(g, 'white', 'dark_ritual');
    g = move(act(g, { type: 'playCard', cardInstanceId: ox, target: s('e2') }), 'a2', 'a3');
    g = move(g, 'a7', 'a6');
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(2);
    g = act(g, { type: 'playCard', cardInstanceId: ritual, target: s('e2') });
    expect(pieceAt(g, s('e2'))!.kind).toBe('the_ox');
  });
});

describe('balance patches', () => {
  it('apply on top of the shipped catalog and can be removed again', () => {
    applyBalance({ cards: { stone_sentinel: { cost: 250, piece: { hp: 2 } }, hex: { effects: [{ kind: 'damage', amount: 2 }] } }, pieces: { pawn: { manaYield: 2, atk: 2 } } });
    expect(getCardDef('stone_sentinel').cost).toBe(250);
    expect((getCardDef('stone_sentinel') as SummonCardDef).piece.hp).toBe(2);
    expect((getCardDef('stone_sentinel') as SummonCardDef).piece.def).toBe(1); // untouched field follows the code
    expect(getCardDef('stone_sentinel').text).toMatch(/1 ATK \/ 1 DEF \/ 2 HP/);
    expect(getPieceDef('stone_sentinel').hp).toBe(2); // the creature registry follows the card
    expect(getCardDef('hex').text).toBe('Deal 2 damage to target enemy Tier 1 piece.');
    expect(getPieceDef('pawn').atk).toBe(2);
    expect(getPieceDef('knight').atk).toBe(1);

    // The patched numbers drive the game: pawns now make 2 mana each (8 more per turn), and hit for 2.
    let g = realGame();
    expect(viewFor(g, 'white').players.white.manaIncome).toBe(40);
    g = move(g, 'e2', 'e4');
    expect(g.players.white.mana).toBe(40);
    expect(pieceAt(g, s('e4'))!.atk).toBe(2); // new pieces read the live definition

    applyBalance(EMPTY_BALANCE);
    expect(getCardDef('stone_sentinel').cost).toBe(200);
    expect((getCardDef('stone_sentinel') as SummonCardDef).piece.hp).toBe(3);
    expect(getCardDef('stone_sentinel').text).toBe(baseCardDef('stone_sentinel').text);
    expect(getPieceDef('pawn').atk).toBe(1);
    expect(viewFor(realGame(), 'white').players.white.manaIncome).toBe(32);
  });

  it('rebasePieces carries a stat change onto pieces already on the board, keeping buffs', () => {
    let g = newGame();
    const ws = giveCard(g, 'white', 'whetstone');
    g = act(g, { type: 'playCard', cardInstanceId: ws, target: s('e2') }); // e2 pawn: 2 ATK
    expect(pieceAt(g, s('e2'))!.base).toEqual({ atk: 1, def: 0, hp: 1 });

    applyBalance({ cards: {}, pieces: { pawn: { atk: 3, hp: 2 } } });
    expect(rebasePieces(g)).toBe(true);
    expect(pieceAt(g, s('d2'))!.atk).toBe(3); // plain pawn follows the new base
    expect(pieceAt(g, s('e2'))!.atk).toBe(4); // buffed pawn keeps its +1
    expect(pieceAt(g, s('d2'))!.hp).toBe(2);
    expect(pieceAt(g, s('d2'))!.maxHp).toBe(2);
    expect(pieceAt(g, s('b1'))!.atk).toBe(1); // knights untouched
    expect(rebasePieces(g)).toBe(false); // idempotent

    applyBalance(EMPTY_BALANCE);
    expect(rebasePieces(g)).toBe(true);
    expect(pieceAt(g, s('d2'))!.atk).toBe(1);
    expect(pieceAt(g, s('e2'))!.atk).toBe(2);
    expect(pieceAt(g, s('d2'))!.hp).toBe(1);
  });

  it('admin-created cards register, play like any other, and can be removed again', () => {
    const wolf = {
      id: 'custom_wolf',
      type: 'summon' as const,
      name: 'Dire Wolf',
      glyph: '🐺',
      art: '/uploads/abc.png',
      boardArt: '/uploads/def.png',
      cost: 150,
      tier: 2,
      summonTurns: 1,
      text: 'A wolf.',
      piece: { kind: 'custom_wolf', name: 'Dire Wolf', glyph: '🐺', tier: 2, movement: { leaps: DIRS.KNIGHT }, atk: 2, def: 0, hp: 2 },
      give: 'everyone' as const,
    };
    const zap = {
      id: 'custom_zap',
      type: 'spell' as const,
      name: 'Zap',
      glyph: '⚡',
      cost: 150,
      target: 'enemyPiece' as const,
      text: 'Zap.',
      effects: [{ kind: 'damage' as const, amount: 1 }],
      give: 'reward' as const,
    };
    expect(validateBalance({ cards: {}, pieces: {}, customCards: [wolf, zap] })).toEqual([]);
    expect(validateBalance({ cards: {}, pieces: {}, customCards: [{ ...wolf, id: 'wolf' }] })).toEqual(expect.arrayContaining([expect.stringMatching(/bad id|kind must match/)]));
    expect(validateBalance({ cards: {}, pieces: {}, customCards: [{ ...wolf, art: 'https://evil.example/x.png' }] })).toEqual([expect.stringMatching(/card image/)]);

    applyBalance({ cards: {}, pieces: {}, customCards: [wolf, zap] });
    expect(getCardDef('custom_wolf').name).toBe('Dire Wolf');
    expect(getPieceDef('custom_wolf').atk).toBe(2);
    expect(customCardsGiven('everyone')).toEqual(['custom_wolf']);
    expect(customCardsGiven('reward')).toEqual(['custom_zap']);

    let g = newGame();
    const w = giveCard(g, 'white', 'custom_wolf');
    g = act(g, { type: 'playCard', cardInstanceId: w, target: s('e2') });
    g = move(g, 'a2', 'a3');
    g = move(g, 'a7', 'a6'); // wolf rises at the start of white's next turn (1 turn)
    expect(pieceAt(g, s('e2'))!.kind).toBe('custom_wolf');
    const z = giveCard(g, 'black', 'custom_zap');
    g = move(g, 'b2', 'b3');
    g = act(g, { type: 'playCard', cardInstanceId: z, target: s('e2') });
    expect(pieceAt(g, s('e2'))!.hp).toBe(1);

    // Deleting the cards: the creature and any copies in hands/decks are pruned from saved games.
    applyBalance(EMPTY_BALANCE);
    expect(() => getCardDef('custom_wolf')).toThrow();
    giveCard(g, 'white', 'custom_zap');
    expect(pruneUnknownCards(g)).toBe(true);
    expect(pieceAt(g, s('e2'))).toBeUndefined();
    expect(g.players.white.hand.some((c) => c.cardId === 'custom_zap')).toBe(false);
    expect(pruneUnknownCards(g)).toBe(false);
    expect(legalActions(g).length).toBeGreaterThan(0); // the game still works
  });

  it('rule patches change what new games start with', () => {
    applyBalance({ cards: {}, pieces: {}, rules: { startingMana: 300, openingHand: 5 } });
    const g = createGame({ decks: { white: starterDeck(), black: starterDeck() }, seed: 1 });
    expect(g.players.white.mana).toBe(300);
    expect(g.players.black.hand).toHaveLength(5);
    expect(g.rules.drawEvery).toBe(5); // untouched rule still follows the code
    applyBalance(EMPTY_BALANCE);
    expect(realGame().players.white.mana).toBe(0);
    expect(realGame().players.white.hand).toHaveLength(7);
    expect(validateBalance({ cards: {}, pieces: {}, rules: { startingMana: -1 } })).toEqual([expect.stringMatching(/starting mana/)]);
  });

  it('rejects nonsense', () => {
    expect(validateBalance({ cards: { nope: { cost: 1 } }, pieces: {} })).toEqual([expect.stringMatching(/Unknown card/)]);
    expect(validateBalance({ cards: { hex: { cost: -5 } }, pieces: {} })).toEqual([expect.stringMatching(/cost/)]);
    expect(validateBalance({ cards: { the_ox: { piece: { hp: 0 } } }, pieces: {} })).toEqual([expect.stringMatching(/HP/)]);
    expect(validateBalance({ cards: {}, pieces: { king: { movement: { pawn: true } } } })).toEqual([expect.stringMatching(/King/)]);
    expect(validateBalance({ cards: {}, pieces: { rook: { movement: { leaps: [] } } } })).toEqual([expect.stringMatching(/not be able to move/)]);
    expect(validateBalance({ cards: { the_ox: { cost: 300, piece: { movement: { leaps: [[1, 2]], slides: [{ dirs: [[0, 1]], range: 2 }], relative: true } } } }, pieces: { queen: { manaYield: 10 } } })).toEqual([]);
  });

  it('describes movement and cards from their numbers', () => {
    expect(describeMovement({ leaps: DIRS.KNIGHT })).toBe('Jumps like a Knight.');
    expect(describeMovement({ slides: [{ dirs: DIRS.ORTHOGONAL, range: 2 }] })).toBe('Moves up to 2 squares orthogonally.');
    expect(describeMovement({ slides: [{ dirs: DIRS.ALL }] })).toBe('Slides any distance in any direction.');
    expect(describeMovement({ leaps: DIRS.ALL })).toBe('Moves 1 square in any direction.');
  });
});

describe('creature abilities', () => {
  const knight = {
    id: 'custom_ngk',
    type: 'summon' as const,
    name: 'Nullglass Knight',
    glyph: '🛡️',
    cost: 200,
    tier: 2,
    summonTurns: 1,
    text: 'Grants an adjacent piece a defense of 1.',
    piece: {
      kind: 'custom_ngk',
      name: 'Nullglass Knight',
      glyph: '🛡️',
      tier: 2,
      movement: { leaps: DIRS.ALL },
      atk: 1,
      def: 1,
      hp: 2,
      abilities: [{ kind: 'grantAdjacent' as const, def: 1 }],
    },
    give: 'everyone' as const,
  };

  afterEach(() => applyBalance(EMPTY_BALANCE));

  it('Nullglass Knight grants +1 DEF to an adjacent friendly piece once per turn', () => {
    applyBalance({ cards: {}, pieces: {}, customCards: [knight] });
    let g = newGame();
    const card = giveCard(g, 'white', 'custom_ngk');
    g = act(g, { type: 'playCard', cardInstanceId: card, target: s('e2') });
    g = move(g, 'a2', 'a3');
    g = move(g, 'a7', 'a6');
    expect(pieceAt(g, s('e2'))!.kind).toBe('custom_ngk');

    const d2 = pieceAt(g, s('d2'))!;
    expect(d2.def).toBe(0);
    expect(legalActions(g).some((a) => a.type === 'useAbility' && a.from === s('e2') && a.to === s('d2'))).toBe(true);
    expect(legalActions(g).some((a) => a.type === 'useAbility' && a.from === s('e2') && a.to === s('e4'))).toBe(false); // not adjacent
    expect(legalActions(g).some((a) => a.type === 'useAbility' && a.to === s('e7'))).toBe(false); // enemy
    expect(legalActions(g).some((a) => a.type === 'useAbility' && a.to === s('e1'))).toBe(false); // king

    g = act(g, { type: 'useAbility', from: s('e2'), to: s('d2') });
    expect(g.turn).toBe('white'); // does not end the turn
    expect(pieceAt(g, s('d2'))!.def).toBe(1);
    expect(pieceAt(g, s('d2'))!.maxDef).toBe(1);
    expect(g.events.some((e) => e.type === 'abilityUsed' && e.def === 1)).toBe(true);
    expect(() => act(g, { type: 'useAbility', from: s('e2'), to: s('f2') })).toThrow(/already used/);
    expect(legalMoves(g).some((m) => m.from === s('e2'))).toBe(true); // can still move
  });

  it('works in Defense mode, but not while the piece is being sacrificed', () => {
    applyBalance({ cards: {}, pieces: {}, customCards: [knight] });
    let g = newGame();
    const card = giveCard(g, 'white', 'custom_ngk');
    g = act(g, { type: 'playCard', cardInstanceId: card, target: s('e2') });
    expect(legalActions(g).some((a) => a.type === 'useAbility')).toBe(false); // still summoning
    g = move(g, 'a2', 'a3');
    g = move(g, 'a7', 'a6');
    g = act(g, { type: 'setStance', square: s('e2'), stance: 'defense' });
    expect(legalMoves(g).some((m) => m.from === s('e2'))).toBe(false);
    expect(legalActions(g).some((a) => a.type === 'useAbility' && a.from === s('e2'))).toBe(false); // frozen by stance
    g = move(g, 'b2', 'b3');
    g = move(g, 'b7', 'b6');
    expect(legalActions(g).some((a) => a.type === 'useAbility' && a.from === s('e2') && a.to === s('d2'))).toBe(true);
    g = act(g, { type: 'useAbility', from: s('e2'), to: s('d2') });
    expect(pieceAt(g, s('d2'))!.def).toBe(1);
  });

  it('awakens a Nullglass Knight whose ability was only written in the card text', () => {
    const { abilities: _drop, ...piece } = knight.piece;
    const legacy = { ...knight, piece: { ...piece } };
    applyBalance({ cards: {}, pieces: {}, customCards: [legacy] });
    expect(getPieceDef('custom_ngk').abilities).toEqual([{ kind: 'grantAdjacent', def: 1 }]);
    expect(describeAbility({ kind: 'grantAdjacent', def: 1 })).toBe('Once per turn: grant an adjacent friendly piece +1 DEF.');
    expect(describeCard(getCardDef('custom_ngk') as SummonCardDef)).toMatch(/Once per turn: grant an adjacent friendly piece \+1 DEF/);
  });

  it('rejects a grant ability with no stat change', () => {
    expect(
      validateBalance({
        cards: {},
        pieces: {},
        customCards: [{ ...knight, piece: { ...knight.piece, abilities: [{ kind: 'grantAdjacent' }] } }],
      }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/ATK\/DEF\/HP/)]));
  });
});

describe('stance', () => {
  it('any number of pieces may switch stance in a turn, and each is frozen until the turn ends', () => {
    let g = newGame();
    for (const sqn of ['a2', 'b2', 'c2', 'd2', 'e2']) g = act(g, { type: 'setStance', square: s(sqn), stance: 'defense' });
    expect(g.turn).toBe('white');
    expect(g.turnInfo.stanceChanged).toHaveLength(5);
    // Switching one straight back the same turn is refused; a different pawn may still be pushed.
    expect(() => act(g, { type: 'setStance', square: s('a2'), stance: 'attack' })).toThrow(/changed stance this turn/);
    expect(legalMoves(g).some((m) => m.from === s('e2'))).toBe(false);
    expect(legalMoves(g).some((m) => m.from === s('f2'))).toBe(true);
    g = move(g, 'f2', 'f3');
    expect(g.turn).toBe('black');
    for (const sqn of ['a2', 'b2', 'c2', 'd2', 'e2']) expect(pieceAt(g, s(sqn))!.stance).toBe('defense');
  });

  it('pieces in Defense mode stay frozen until switched back; switching back freezes them for that turn only', () => {
    let g = newGame();
    g = move(act(g, { type: 'setStance', square: s('e2'), stance: 'defense' }), 'a2', 'a3');
    g = move(g, 'a7', 'a6');
    expect(legalMoves(g).some((m) => m.from === s('e2'))).toBe(false);
    g = move(g, 'b2', 'b3');
    g = move(g, 'a6', 'a5');
    expect(legalMoves(g).some((m) => m.from === s('e2'))).toBe(false); // still frozen many turns later
    g = act(g, { type: 'setStance', square: s('e2'), stance: 'attack' });
    expect(legalMoves(g).some((m) => m.from === s('e2'))).toBe(false); // frozen for the rest of this turn
    g = move(g, 'c2', 'c3'); // but another piece may move
    g = move(g, 'a5', 'a4');
    expect(legalMoves(g).some((m) => m.from === s('e2'))).toBe(true); // free next turn
  });

  it('a piece in Defense mode does not give check; switching back to Attack restores the threat', () => {
    let g = newGame();
    g = move(g, 'e2', 'e4');
    g = move(g, 'f7', 'f6');
    g = move(g, 'd1', 'h5'); // queen gives check on the h5-e8 diagonal
    expect(isInCheck(g, 'black')).toBe(true);
    g = move(g, 'g7', 'g6'); // block
    g = move(act(g, { type: 'setStance', square: s('h5'), stance: 'defense' }), 'a2', 'a3');
    g = move(g, 'g6', 'g5'); // legal: a Defense-mode queen cannot attack
    expect(isInCheck(g, 'black')).toBe(false);
    g = move(act(g, { type: 'setStance', square: s('h5'), stance: 'attack' }), 'a3', 'a4');
    expect(isInCheck(g, 'black')).toBe(true);
    expect(() => move(g, 'a7', 'a6')).toThrow(IllegalActionError);
  });

  it('kings and sacrifices cannot change stance', () => {
    const g = newGame();
    expect(() => act(g, { type: 'setStance', square: s('e1'), stance: 'defense' })).toThrow(IllegalActionError);
    expect(legalActions(g).some((a) => a.type === 'setStance' && a.square === s('e1'))).toBe(false);
  });
});

describe('testing arena', () => {
  it('starts on an empty board with empty hands', () => {
    const g = createArenaGame(1);
    expect(Object.keys(g.pieces)).toHaveLength(0);
    expect(g.board.every((id) => id === null)).toBe(true);
    expect(g.players.white.hand).toHaveLength(0);
    expect(g.players.black.hand).toHaveLength(0);
    expect(g.players.white.deck).toHaveLength(0);
  });

  it('puts a card in hand, a piece on an empty square, and can relocate or remove it', () => {
    let g = createArenaGame(1);
    g = applyArenaOp(g, { type: 'giveCard', color: 'white', cardId: 'the_ox' });
    expect(g.players.white.hand).toHaveLength(1);
    expect(g.players.white.hand[0]!.cardId).toBe('the_ox');

    g = applyArenaOp(g, { type: 'spawnPiece', kind: 'the_ox', color: 'white', square: s('e4') });
    expect(pieceAt(g, s('e4'))!.kind).toBe('the_ox');
    g = applyArenaOp(g, { type: 'relocate', from: s('e4'), to: s('e5') });
    expect(pieceAt(g, s('e4'))).toBeUndefined();
    expect(pieceAt(g, s('e5'))!.kind).toBe('the_ox');
    g = applyArenaOp(g, { type: 'removePiece', square: s('e5') });
    expect(pieceAt(g, s('e5'))).toBeUndefined();
  });

  it('spawns a summon on an empty square and starts a timer on a piece', () => {
    let g = createArenaGame(1);
    g = applyArenaOp(g, { type: 'dropCard', cardId: 'the_ox', color: 'white', square: s('e4') });
    expect(pieceAt(g, s('e4'))!.kind).toBe('the_ox');
    expect(pieceAt(g, s('e4'))!.owner).toBe('white');

    g = applyArenaOp(g, { type: 'spawnPiece', kind: 'pawn', color: 'white', square: s('e2') });
    g = applyArenaOp(g, { type: 'dropCard', cardId: 'the_ox', color: 'white', square: s('e2') });
    expect(pieceAt(g, s('e2'))!.kind).toBe('pawn');
    expect(pieceAt(g, s('e2'))!.summon?.cardId).toBe('the_ox');
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(3);
  });

  it('ticks a pending summon when the opposite colour moves', () => {
    let g = createArenaGame(1);
    g = applyArenaOp(g, { type: 'spawnPiece', kind: 'pawn', color: 'white', square: s('e2') });
    g = applyArenaOp(g, { type: 'dropCard', cardId: 'the_ox', color: 'white', square: s('e2') });
    g = applyArenaOp(g, { type: 'spawnPiece', kind: 'knight', color: 'black', square: s('a4') });

    g = applyArenaOp(g, { type: 'relocate', from: s('a4'), to: s('a5') });
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(2);
    g = applyArenaOp(g, { type: 'relocate', from: s('a5'), to: s('a6') });
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(1);
    g = applyArenaOp(g, { type: 'relocate', from: s('a6'), to: s('a7') });
    expect(pieceAt(g, s('e2'))!.kind).toBe('the_ox');
    expect(pieceAt(g, s('e2'))!.summon).toBeUndefined();
    expect(pieceAt(g, s('e2'))!.owner).toBe('white');
  });

  it('does not tick a summon when the same colour moves', () => {
    let g = createArenaGame(1);
    g = applyArenaOp(g, { type: 'spawnPiece', kind: 'pawn', color: 'white', square: s('e2') });
    g = applyArenaOp(g, { type: 'dropCard', cardId: 'the_ox', color: 'white', square: s('e2') });
    g = applyArenaOp(g, { type: 'spawnPiece', kind: 'knight', color: 'white', square: s('a4') });
    g = applyArenaOp(g, { type: 'relocate', from: s('a4'), to: s('a5') });
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(3);
  });

  it('replaces whatever is already on the square and can set mana', () => {
    let g = createArenaGame(1);
    g = applyArenaOp(g, { type: 'spawnPiece', kind: 'knight', color: 'black', square: s('e2') });
    expect(pieceAt(g, s('e2'))!.kind).toBe('knight');
    expect(pieceAt(g, s('e2'))!.owner).toBe('black');
    g = applyArenaOp(g, { type: 'setMana', color: 'white', mana: 500 });
    expect(g.players.white.mana).toBe(500);
    expect(() => applyArenaOp(g, { type: 'giveCard', color: 'white', cardId: 'nope' })).toThrow(IllegalActionError);
  });
});
