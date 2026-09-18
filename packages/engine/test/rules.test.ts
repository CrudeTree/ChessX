import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
  getCardDef,
  IllegalActionError,
  isInCheck,
  legalActions,
  legalMoves,
  parseSquare as s,
  pieceAt,
  starterDeck,
  validateDeck,
  viewFor,
  type Action,
  type GameState,
} from '../src/index.js';

function newGame(seed = 1): GameState {
  return createGame({ decks: { white: starterDeck(), black: starterDeck() }, seed });
}

/** Take an owed draw if there is one (as a player would by clicking the deck). */
function drawIfOwed(state: GameState): GameState {
  return state.players[state.turn].pendingDraws > 0 ? applyAction(state, { type: 'draw' }) : state;
}

/** Act without ending the turn. */
function act(state: GameState, action: Action): GameState {
  return applyAction(drawIfOwed(state), action);
}

function end(state: GameState): GameState {
  return applyAction(state, { type: 'endTurn' });
}

/** A whole simple turn: move one piece, then end the turn. */
function move(state: GameState, from: string, to: string): GameState {
  return end(act(state, { type: 'move', from: s(from), to: s(to) }));
}

/** Move without ending the turn. */
function step(state: GameState, from: string, to: string): GameState {
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
    expect(() => step(newGame(), 'e2', 'e5')).toThrow(IllegalActionError);
    expect(() => step(newGame(), 'e7', 'e5')).toThrow(IllegalActionError); // not your piece
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

  it('en passant survives spells played after the double push, but not the following turn', () => {
    let g = newGame();
    g = step(g, 'e2', 'e4');
    const ws = giveCard(g, 'white', 'whetstone');
    g = act(g, { type: 'playCard', cardInstanceId: ws, target: s('e4') }); // spell after the push
    g = end(g);
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
  it('a turn is a sequence: one move, any spells, then endTurn', () => {
    let g = newGame();
    const ws = giveCard(g, 'white', 'whetstone');
    const sw = giveCard(g, 'white', 'shield_wall');
    g = act(g, { type: 'playCard', cardInstanceId: ws, target: s('e2') });
    expect(g.turn).toBe('white');
    g = step(g, 'e2', 'e4');
    expect(g.turn).toBe('white');
    expect(g.turnInfo.majorAction).toBe('move');
    // A second move is refused; another spell is fine.
    expect(() => step(g, 'd2', 'd4')).toThrow(/already moved/);
    expect(legalMoves(g)).toHaveLength(0);
    g = act(g, { type: 'playCard', cardInstanceId: sw, target: s('e4') });
    expect(pieceAt(g, s('e4'))!.atk).toBe(2);
    expect(pieceAt(g, s('e4'))!.maxDef).toBe(1);
    g = end(g);
    expect(g.turn).toBe('black');
    expect(g.turnInfo.majorAction).toBeNull();
  });

  it('you cannot end your turn until you have moved or summoned', () => {
    const g = newGame();
    expect(has(legalActions(g), 'endTurn')).toBe(false);
    expect(() => end(g)).toThrow(/Move a piece or summon/);
    // Spells alone do not count.
    const ws = giveCard(g, 'white', 'whetstone');
    const afterSpell = act(g, { type: 'playCard', cardInstanceId: ws, target: s('e2') });
    expect(has(legalActions(afterSpell), 'endTurn')).toBe(false);
    // A summon counts as the major action.
    const ox = giveCard(g, 'white', 'the_ox');
    const afterSummon = act(g, { type: 'playCard', cardInstanceId: ox, target: s('e2') });
    expect(has(legalActions(afterSummon), 'endTurn')).toBe(true);
    expect(end(afterSummon).turn).toBe('black');
  });

  it('if no move or summon is possible at all, the turn may be passed', () => {
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
    g.players.white.hand = g.players.white.hand.filter((c) => getCardDef(c.cardId).type !== 'summon');
    expect(legalMoves(g)).toHaveLength(0);
    expect(has(legalActions(g), 'endTurn')).toBe(true);
    g = end(g);
    expect(g.turn).toBe('black');
  });

  it('summoning and moving share the single major action', () => {
    let g = newGame();
    const ox = giveCard(g, 'white', 'the_ox');
    g = act(g, { type: 'playCard', cardInstanceId: ox, target: s('e2') });
    expect(g.turnInfo.majorAction).toBe('summon');
    expect(legalMoves(g)).toHaveLength(0);
    expect(() => step(g, 'd2', 'd4')).toThrow(/already summoned/);
    // A second summon this turn is also refused.
    const ox2 = giveCard(g, 'white', 'the_ox');
    expect(() => act(g, { type: 'playCard', cardInstanceId: ox2, target: s('d2') })).toThrow(/one summon|already/i);
    // Spells still fine.
    const fs = giveCard(g, 'white', 'foresight');
    g = act(g, { type: 'playCard', cardInstanceId: fs });
    g = end(g);
    expect(g.turn).toBe('black');

    // The other way round: move first, then summoning is refused.
    let h = newGame();
    const ox3 = giveCard(h, 'white', 'the_ox');
    h = step(h, 'a2', 'a3');
    expect(() => act(h, { type: 'playCard', cardInstanceId: ox3, target: s('e2') })).toThrow(/already moved/);
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
    const attackMode = step(g, 'e4', 'd5');
    expect(pieceAt(attackMode, s('d5'))!.hp).toBe(1);
    expect(pieceAt(attackMode, s('d5'))!.def).toBe(1);
    pawn.stance = 'defense';
    const defenseMode = step(g, 'e4', 'd5');
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
    g = step(g, 'e4', 'd5');
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
    g = step(g, 'e1', 'd2');
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
    // Spells may still be played while in check (the turn continues), summons may not.
    const ws = giveCard(g, 'black', 'whetstone');
    const ox = giveCard(g, 'black', 'the_ox');
    expect(legalActions(g).some((a) => a.type === 'playCard' && a.cardInstanceId === ws)).toBe(true);
    expect(legalActions(g).some((a) => a.type === 'playCard' && a.cardInstanceId === ox)).toBe(false);
    expect(() => act(g, { type: 'playCard', cardInstanceId: ox, target: s('a6') })).toThrow(/summon while in check/);
  });
});

describe('cards', () => {
  it('summons replace the sacrificed piece after the timer runs down', () => {
    let g = newGame();
    const ox = giveCard(g, 'white', 'the_ox');
    const acts = legalActions(g).filter((a) => a.type === 'playCard' && a.cardInstanceId === ox);
    expect(acts).toHaveLength(8); // any of the 8 pawns (tier 1)

    g = end(act(g, { type: 'playCard', cardInstanceId: ox, target: s('e2') }));
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(3);
    g = move(g, 'a7', 'a6');
    expect(legalMoves(g).some((m) => m.from === s('e2'))).toBe(false);
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(2);
    g = move(g, 'a2', 'a3');
    g = move(g, 'a6', 'a5');
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(1);
    g = move(g, 'b2', 'b3');
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
    g = end(act(g, { type: 'playCard', cardInstanceId: ox, target: s('e4') }));
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
    g = end(act(g, { type: 'playCard', cardInstanceId: boar, target: s('e2') }));
    g = move(g, 'a7', 'a6');
    g = move(g, 'a2', 'a3');
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
    g = end(act(g, { type: 'playCard', cardInstanceId: ox, target: s('e2') }));
    g = move(g, 'a7', 'a6');
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(2);
    g = act(g, { type: 'playCard', cardInstanceId: ritual, target: s('e2') });
    expect(pieceAt(g, s('e2'))!.kind).toBe('the_ox');
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
    expect(() => step(g, 'a7', 'a6')).toThrow(IllegalActionError);
  });

  it('kings and sacrifices cannot change stance', () => {
    const g = newGame();
    expect(() => act(g, { type: 'setStance', square: s('e1'), stance: 'defense' })).toThrow(IllegalActionError);
    expect(legalActions(g).some((a) => a.type === 'setStance' && a.square === s('e1'))).toBe(false);
  });
});
