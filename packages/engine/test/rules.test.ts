import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createGame,
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

function move(state: GameState, from: string, to: string): GameState {
  return applyAction(state, { type: 'move', from: s(from), to: s(to) });
}

/** Put a specific card into a player's hand so tests don't depend on the shuffle. */
function giveCard(state: GameState, color: 'white' | 'black', cardId: string): string {
  const inst = { instanceId: `test-${cardId}-${state.nextId++}`, cardId };
  state.players[color].hand.push(inst);
  return inst.instanceId;
}

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

  it('validates deck size and copy limits', () => {
    expect(validateDeck(starterDeck())).toEqual([]);
    expect(validateDeck(starterDeck().slice(1)).length).toBeGreaterThan(0);
    expect(validateDeck(new Array(30).fill('the_ox')).length).toBeGreaterThan(0);
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

describe('combat with HP', () => {
  it('a 1 ATK attack on a 2 HP piece damages it and the attacker stays put', () => {
    let g = newGame();
    g = move(g, 'e2', 'e4');
    g = move(g, 'd7', 'd5');
    // Buff the black pawn on d5 to 3 HP before white attacks it.
    pieceAt(g, s('d5'))!.hp = 3;
    pieceAt(g, s('d5'))!.maxHp = 3;
    g = move(g, 'e4', 'd5');
    const target = pieceAt(g, s('d5'))!;
    expect(target.owner).toBe('black');
    expect(target.hp).toBe(2);
    expect(pieceAt(g, s('e4'))?.owner).toBe('white');
    expect(g.turn).toBe('black');
    expect(g.events.some((e) => e.type === 'repelled')).toBe(true);
  });

  it('DEF reduces damage', () => {
    let g = newGame();
    g = move(g, 'e2', 'e4');
    g = move(g, 'd7', 'd5');
    const pawn = pieceAt(g, s('d5'))!;
    pawn.hp = 2;
    pawn.maxHp = 2;
    pawn.def = 1;
    g = move(g, 'e4', 'd5');
    expect(pieceAt(g, s('d5'))!.hp).toBe(2);
  });

  it('a piece that can survive a capture still gives check that must be answered', () => {
    let g = newGame();
    g = move(g, 'e2', 'e4');
    g = move(g, 'd7', 'd5');
    g = move(g, 'e4', 'd5');
    g = move(g, 'e7', 'e6');
    g = move(g, 'd5', 'e6');
    g = move(g, 'a7', 'a6');
    // White pawn on e6 attacks f7. Make it tough and move it to give check.
    const pawn = pieceAt(g, s('e6'))!;
    pawn.hp = 5;
    pawn.maxHp = 5;
    g = move(g, 'e6', 'f7');
    expect(isInCheck(g, 'black')).toBe(true);
    // Kxf7 would only deal 1 damage and leave the king in check, so it is not legal.
    const kingMoves = legalMoves(g).filter((m) => m.from === s('e8'));
    expect(kingMoves.some((m) => m.to === s('f7'))).toBe(false);
    // Every legal action must resolve the check.
    for (const a of legalActions(g)) {
      const after = applyAction(g, a);
      expect(isInCheck(after, 'black')).toBe(false);
    }
    // A card that does nothing about the check is not legal while in check.
    const cards = legalActions(g).filter((a) => a.type === 'playCard');
    expect(cards).toHaveLength(0);
  });
});

describe('cards', () => {
  it('summons replace the sacrificed piece after the timer runs down', () => {
    let g = newGame();
    const ox = giveCard(g, 'white', 'the_ox');
    const acts = legalActions(g).filter((a) => a.type === 'playCard' && a.cardInstanceId === ox);
    expect(acts).toHaveLength(8); // any of the 8 pawns (tier 1)

    g = applyAction(g, { type: 'playCard', cardInstanceId: ox, target: s('e2') });
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(3);
    expect(g.turn).toBe('black');
    // Sacrificing pawn cannot move.
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
    // Ox moves up to 2 orthogonally: e3 is open, e4 is open.
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
    g = applyAction(g, { type: 'playCard', cardInstanceId: ox, target: s('e4') });
    g = move(g, 'd5', 'e4');
    expect(pieceAt(g, s('e4'))!.owner).toBe('black');
    expect(g.events.some((e) => e.type === 'summonFailed')).toBe(true);
    expect(g.players.white.graveyard.some((c) => c.instanceId === ox)).toBe(true);
    expect(Object.values(g.pieces).some((p) => p.kind === 'the_ox')).toBe(false);
  });

  it('tier requirements are enforced', () => {
    const g = newGame();
    const wyrm = giveCard(g, 'white', 'elder_wyrm'); // tier 4 needs a rook
    const targets = legalActions(g)
      .filter((a): a is Extract<Action, { type: 'playCard' }> => a.type === 'playCard' && a.cardInstanceId === wyrm)
      .map((a) => a.target);
    expect(targets.sort()).toEqual([s('a1'), s('h1')].sort());
    expect(() => applyAction(g, { type: 'playCard', cardInstanceId: wyrm, target: s('e2') })).toThrow(IllegalActionError);
  });

  it('spells modify stats, deal damage and draw', () => {
    let g = newGame();
    const hide = giveCard(g, 'white', 'iron_hide');
    g = applyAction(g, { type: 'playCard', cardInstanceId: hide, target: s('e2') });
    expect(pieceAt(g, s('e2'))!.hp).toBe(3);
    expect(pieceAt(g, s('e2'))!.maxHp).toBe(3);

    const hex = giveCard(g, 'black', 'hex');
    g = applyAction(g, { type: 'playCard', cardInstanceId: hex, target: s('e2') });
    expect(pieceAt(g, s('e2'))!.hp).toBe(2);

    const before = g.players.white.hand.length;
    const fs = giveCard(g, 'white', 'foresight');
    g = applyAction(g, { type: 'playCard', cardInstanceId: fs });
    expect(g.players.white.hand.length).toBe(before + 2); // +1 given, -1 played, +2 drawn
  });

  it('Hex can destroy a piece and cannot target the king', () => {
    let g = newGame();
    const hex = giveCard(g, 'white', 'hex');
    expect(() => applyAction(g, { type: 'playCard', cardInstanceId: hex, target: s('e8') })).toThrow(IllegalActionError);
    g = applyAction(g, { type: 'playCard', cardInstanceId: hex, target: s('e7') });
    expect(pieceAt(g, s('e7'))).toBeUndefined();
  });

  it('Dark Ritual hastens a summon', () => {
    let g = newGame();
    const ox = giveCard(g, 'white', 'the_ox');
    const ritual = giveCard(g, 'white', 'dark_ritual');
    g = applyAction(g, { type: 'playCard', cardInstanceId: ox, target: s('e2') });
    g = move(g, 'a7', 'a6');
    expect(pieceAt(g, s('e2'))!.summon?.turnsRemaining).toBe(2);
    g = applyAction(g, { type: 'playCard', cardInstanceId: ritual, target: s('e2') });
    expect(pieceAt(g, s('e2'))!.kind).toBe('the_ox');
  });
});

describe('turn structure', () => {
  it('a turn is either a move or a card, and the player draws on every 5th turn', () => {
    let g = newGame();
    const handAt = (c: 'white' | 'black') => g.players[c].hand.length;
    const w0 = handAt('white');
    // Turns 1..4 for white: no draw.
    g = move(g, 'a2', 'a3');
    g = move(g, 'a7', 'a6');
    g = move(g, 'b2', 'b3');
    g = move(g, 'b7', 'b6');
    g = move(g, 'c2', 'c3');
    g = move(g, 'c7', 'c6');
    g = move(g, 'd2', 'd3');
    expect(handAt('white')).toBe(w0);
    g = move(g, 'd7', 'd6'); // white now starts turn 5 -> draws
    expect(g.players.white.turnsTaken).toBe(5);
    expect(handAt('white')).toBe(w0 + 1);
    expect(g.events.some((e) => e.type === 'drew' && e.color === 'white')).toBe(true);
  });

  it('resigning ends the game', () => {
    const g = applyAction(newGame(), { type: 'resign' });
    expect(g.status).toEqual({ kind: 'resigned', winner: 'black' });
  });

  it('player views hide the opponent hand', () => {
    const g = newGame();
    const v = viewFor(g, 'black');
    expect(v.players.black.hand).toHaveLength(7);
    expect(v.players.white.hand).toBeNull();
    expect(v.players.white.handCount).toBe(7);
    expect(v.legalActions).toHaveLength(0); // white to move
    expect(viewFor(g, 'white').legalActions.length).toBeGreaterThan(20);
  });
});
