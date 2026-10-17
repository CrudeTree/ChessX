import { createGame, starterDeck, v2, type Action, type Color } from '@chessx/engine';
import type { ChatMessage, ServerMessage } from '@chessx/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Db, newId, type GameRow } from '../src/db.js';
import { GameError, GameManager, type Transport } from '../src/games.js';

function setup() {
  const db = new Db(':memory:');
  const games = new GameManager(db, (id) => db.userById(id)?.name ?? '?');
  const mk = (name: string) =>
    db.createUser({ email: `${name.toLowerCase()}@x.test`, name, password_hash: null, google_id: null, facebook_id: null, avatar_url: null });
  return { db, games, alice: mk('Alice'), bob: mk('Bob') };
}

/** Keeps a copy of each message, as a socket would, so later changes to the game cannot rewrite what was sent. */
function transport(userId: string): Transport & { messages: ServerMessage[] } {
  const messages: ServerMessage[] = [];
  return { userId, messages, send: (m) => void messages.push(structuredClone(m)) };
}

/** The first legal action matching `want`, taken for whoever is to move. */
function pick(state: v2.GameState, want: (a: v2.Action) => boolean): v2.Action {
  const found = v2.legalActions(state).find(want);
  if (!found) throw new Error('no such legal action');
  return found;
}

/** A two-player game on White's turn 1 with White's hand replaced by `hand` and the given mana. */
function seatedGame(hand: string[], mana = 3) {
  const { games, alice, bob } = setup();
  const game = games.create(alice.id, false, []);
  game.join(bob.id, []);
  const white = transport(game.row.white_user_id!);
  game.attach(white);
  const state = game.record!.state;
  state.hand.white = hand.map((cardId, i) => ({ uid: `h${i}`, cardId }));
  state.mana.white = mana;
  return { game, white };
}

describe('rules 2 games', () => {
  it('start on White\'s turn 1 when the second player joins, and send the v2 view', () => {
    const { games, alice, bob } = setup();
    const game = games.create(alice.id, false, []);
    expect(game.rules).toBe(2);
    expect(game.started).toBe(false);
    const ta = transport(alice.id);
    game.attach(ta);
    game.join(bob.id, []);
    const tb = transport(bob.id);
    game.attach(tb);

    expect(game.record?.state.phase).toBe('play');
    expect(game.record?.state.active).toBe('white');
    const seated = tb.messages.find((m) => m.type === 'seated');
    expect(seated).toMatchObject({ type: 'seated', rules: 2 });
    const stateMsg = tb.messages.find((m) => m.type === 'stateV2');
    expect(stateMsg?.type).toBe('stateV2');
    if (stateMsg?.type !== 'stateV2') throw new Error('unreachable');
    // Bob sees his own hand and only a count for Alice's. White has already drawn for turn 1.
    const bobColor: Color = game.row.white_user_id === bob.id ? 'white' : 'black';
    expect(stateMsg.view.you).toBe(bobColor);
    expect(stateMsg.view.hand).toHaveLength(bobColor === 'white' ? 4 : 3);
    expect(stateMsg.view.handCount).toEqual({ white: 4, black: 3 });
    expect(game.summaryFor(alice.id)).toMatchObject({ rules: 2, waitingForOpponent: false });
  });

  it('plays a move, enforcing turn order and legality, and survives a reload from the database', () => {
    const { db, games, alice, bob } = setup();
    const game = games.create(alice.id, false, []);
    game.join(bob.id, []);
    const whiteId = game.row.white_user_id!;
    const blackId = game.row.black_user_id!;
    const white = transport(whiteId);
    const black = transport(blackId);
    game.attach(white);
    game.attach(black);

    // White moves first; Black may not.
    expect(() => game.actV2(black, pick(game.record!.state, (a) => a.type === 'move'))).toThrow(GameError);
    expect(game.record!.state.phase).toBe('play');
    expect(game.record!.state.active).toBe('white');
    expect(() => game.actV2(white, { type: 'summon', cardUid: 'nope', to: 0 })).toThrow(GameError);
    expect(() => game.actV2(black, { type: 'endTurn' })).toThrow(GameError);

    game.actV2(white, pick(game.record!.state, (a) => a.type === 'move'));
    expect(game.record!.state.active).toBe('black');

    // A fresh manager (a server restart) loads the very same game from SQLite.
    const reloaded = new GameManager(db, (id) => db.userById(id)?.name ?? '?').get(game.id)!;
    expect(reloaded.rules).toBe(2);
    expect(reloaded.record?.seq).toBe(game.record!.seq);
    expect(reloaded.record?.state).toEqual(game.record!.state);
    expect(db.gameById(game.id)?.status_kind).toBe('playing');
  });

  it('resigning ends the game for the other side and is recorded', () => {
    const { db, games, alice, bob } = setup();
    const game = games.create(alice.id, false, []);
    game.join(bob.id, []);
    const loser: Color = game.row.white_user_id === alice.id ? 'white' : 'black';
    const t = transport(alice.id);
    game.attach(t);
    game.actV2(t, { type: 'resign' });
    expect(game.status()).toEqual({ kind: 'resigned', winner: loser === 'white' ? 'black' : 'white' });
    expect(db.gameById(game.id)?.status_kind).toBe('resigned');
    expect(() => game.actV2(t, { type: 'endTurn' })).toThrow(GameError);
  });

  it('keeps the whole log with the game and sends it to a player who opens it (Djabooty, 2026-10-11)', () => {
    const { db, games, alice, bob } = setup();
    const game = games.create(alice.id, false, []);
    game.join(bob.id, []);
    const white = transport(game.row.white_user_id!);
    const black = transport(game.row.black_user_id!);
    game.attach(white);
    game.attach(black);
    game.actV2(white, pick(game.record!.state, (a) => a.type === 'move'));
    game.actV2(black, pick(game.record!.state, (a) => a.type === 'move'));
    const history = game.record!.history!;
    expect(history).toHaveLength(2);
    expect(history[0]!.some((e) => e.type === 'moved')).toBe(true);
    expect(history[1]).toEqual(game.record!.events);

    // Updates during play carry only the latest events.
    const update = [...white.messages].reverse().find((m) => m.type === 'stateV2');
    if (update?.type !== 'stateV2') throw new Error('no state');
    expect(update.view.history).toBeUndefined();

    // After a server restart, opening the game brings the whole log.
    const reloaded = new GameManager(db, (id) => db.userById(id)?.name ?? '?').get(game.id)!;
    const again = transport(game.row.black_user_id!);
    reloaded.attach(again);
    const opened = again.messages.find((m) => m.type === 'stateV2');
    if (opened?.type !== 'stateV2') throw new Error('no state');
    expect(opened.view.history).toEqual(history);
  });

  it('a practice game is v2, memory-only, and follows the side to move', () => {
    const { db, games, alice } = setup();
    const game = games.create(alice.id, true, []);
    expect(game.rules).toBe(2);
    expect(game.started).toBe(true);
    const t = transport(alice.id);
    game.attach(t);
    const first = t.messages.find((m) => m.type === 'stateV2');
    if (first?.type !== 'stateV2') throw new Error('no state');
    expect(first.view.you).toBe('white');
    game.actV2(t, pick(game.record!.state, (a) => a.type === 'move'));
    const latest = [...t.messages].reverse().find((m) => m.type === 'stateV2');
    if (latest?.type !== 'stateV2') throw new Error('no state');
    expect(latest.view.you).toBe('black'); // Black is now to move
    expect(db.gameById(game.id)).toBeUndefined();
  });

  it('a player can look back at any earlier position, also after a restart (Djabooty, 2026-10-13)', () => {
    const { db, games, alice, bob } = setup();
    const game = games.create(alice.id, false, []);
    game.join(bob.id, []);
    const white = transport(game.row.white_user_id!);
    const black = transport(game.row.black_user_id!);
    game.attach(white);
    game.attach(black);
    const opening = game.record!.state.pieces.map((p) => p.square).sort();
    game.actV2(white, pick(game.record!.state, (a) => a.type === 'move'));
    game.actV2(black, pick(game.record!.state, (a) => a.type === 'move'));
    const latest = [...white.messages].reverse().find((m) => m.type === 'stateV2');
    expect(latest?.type === 'stateV2' && latest.view.steps).toBe(2);

    const reloaded = new GameManager(db, (id) => db.userById(id)?.name ?? '?').get(game.id)!;
    const again = transport(game.row.black_user_id!);
    reloaded.attach(again);
    reloaded.sendPast(again, 0);
    reloaded.sendPast(again, 1);
    const past = again.messages.filter((m) => m.type === 'pastV2');
    expect(past.map((m) => m.type === 'pastV2' && m.step)).toEqual([0, 1]);
    if (past[0]?.type !== 'pastV2' || past[1]?.type !== 'pastV2') throw new Error('no past');
    expect(past[0].view.pieces.map((p) => p.square).sort()).toEqual(opening);
    expect(past[0].view.you).toBe('black');
    expect(past[1].view.events).toEqual(game.record!.history![0]);
    expect(past[1].view.legalActions).toEqual([]);

    // A step the game has not reached gets no answer; someone outside the game is refused.
    reloaded.sendPast(again, 3);
    expect(again.messages.filter((m) => m.type === 'pastV2')).toHaveLength(2);
    const carol = db.createUser({ email: 'carol@x.test', name: 'Carol', password_hash: null, google_id: null, facebook_id: null, avatar_url: null });
    expect(() => reloaded.sendPast(transport(carol.id), 0)).toThrow(GameError);
  });

  it('a finished game saved before steps were kept gets them back when it is opened (Djabooty, 2026-10-15)', () => {
    const { db, games, alice, bob } = setup();
    const game = games.create(alice.id, false, []);
    game.join(bob.id, []);
    const white = transport(game.row.white_user_id!);
    const black = transport(game.row.black_user_id!);
    game.attach(white);
    game.attach(black);
    game.actV2(white, pick(game.record!.state, (a) => a.type === 'move'));
    game.actV2(black, pick(game.record!.state, (a) => a.type === 'move'));
    game.actV2(white, { type: 'resign' });
    const opening = game.record!.start!.pieces.map((p) => p.square).sort();

    // As such a game was saved: the history, but neither the start nor the steps.
    const row = db.gameById(game.id)!;
    const { start, steps, ...old } = JSON.parse(row.state_json!) as v2.GameRecord;
    expect(steps).toHaveLength(3);
    db.updateGame({ ...row, state_json: JSON.stringify(old) });

    const reloaded = new GameManager(db, (id) => db.userById(id)?.name ?? '?').get(game.id)!;
    const t = transport(game.row.white_user_id!);
    reloaded.attach(t);
    const opened = t.messages.find((m) => m.type === 'stateV2');
    expect(opened?.type === 'stateV2' && opened.view.steps).toBe(3);
    reloaded.sendPast(t, 0);
    const past = t.messages.find((m) => m.type === 'pastV2');
    if (past?.type !== 'pastV2') throw new Error('no past');
    expect(past.view.pieces.map((p) => p.square).sort()).toEqual(opening);
    expect(start).toBeDefined();
  });
});

describe('cards, then a move that ends the turn (Djabooty, 2026-10-10)', () => {
  it('passes to the opponent with the move, in the same update', () => {
    const { game, white } = seatedGame(['squire', 'tower']);
    game.actV2(white, pick(game.record!.state, (a) => a.type === 'move'));
    expect(game.record!.state.active).toBe('black');
    expect(game.record!.events.map((e) => e.type)).toEqual(expect.arrayContaining(['moved', 'turnStarted']));
  });

  it('an affordable spell in hand does not hold the turn open after the move', () => {
    const { game, white } = seatedGame(['insight']);
    game.actV2(white, pick(game.record!.state, (a) => a.type === 'move'));
    expect(game.record!.state.active).toBe('black');
    expect(game.record!.state.hand.white.map((c) => c.cardId)).toContain('insight');
  });

  it('cards played before the move do not end the turn; the move then does', () => {
    const { game, white } = seatedGame(['insight', 'squire']);
    game.actV2(white, { type: 'spell', cardUid: 'h0' });
    game.actV2(white, pick(game.record!.state, (a) => a.type === 'summon' && a.cardUid === 'h1'));
    expect(game.record!.state.active).toBe('white');
    game.actV2(white, pick(game.record!.state, (a) => a.type === 'move'));
    expect(game.record!.state.active).toBe('black');
  });

  it('End turn is refused while a move is left, even after a card', () => {
    const { game, white } = seatedGame(['insight']);
    expect(() => game.actV2(white, { type: 'endTurn' })).toThrow(GameError);
    game.actV2(white, { type: 'spell', cardUid: 'h0' });
    expect(() => game.actV2(white, { type: 'endTurn' })).toThrow(GameError);
  });

  it('a game saved while the turn stayed open after the action can still be closed', () => {
    const { game, white } = seatedGame(['insight']);
    game.record!.state.actionTaken = true;
    game.actV2(white, { type: 'endTurn' });
    expect(game.record!.state.active).toBe('black');
  });
});

describe('games against the bot', () => {
  /** A manager whose bot plays without pausing. */
  function botSetup() {
    const ctx = setup();
    ctx.games.botPause = () => Promise.resolve();
    return ctx;
  }

  it('start at once with the bot in the other seat, memory only and without a clock', () => {
    const { db, games, alice } = botSetup();
    const game = games.createBot(alice.id, 'medium', 'white');
    const t = transport(alice.id);
    game.attach(t);
    expect(game.started).toBe(true);
    expect(game.memoryOnly).toBe(true);
    expect(t.messages.find((m) => m.type === 'seated')).toMatchObject({
      color: 'white',
      solo: false,
      bot: 'medium',
      room: { players: { white: { name: 'Alice' }, black: { name: 'Medium bot', connected: true } } },
    });
    expect(game.clocks().running).toBe(false);
    expect(db.gameById(game.id)).toBeUndefined();
    expect(games.summariesFor(alice.id)).toEqual([]);
  });

  it('the bot answers your move with a whole turn of its own', async () => {
    const { games, alice } = botSetup();
    const game = games.createBot(alice.id, 'easy', 'white');
    const t = transport(alice.id);
    game.attach(t);
    game.actV2(t, pick(game.record!.state, (a) => a.type === 'move'));
    await vi.waitFor(() => expect(game.record!.state.active).toBe('white'));
    expect(game.record!.state.turns.black).toBe(1);
    const latest = [...t.messages].reverse().find((m) => m.type === 'stateV2');
    expect(latest?.type === 'stateV2' && latest.view.you).toBe('white');
  });

  it('the bot moves first when it plays White', async () => {
    const { games, alice } = botSetup();
    const game = games.createBot(alice.id, 'hard', 'black');
    expect(game.bot).toEqual({ color: 'white', level: 'hard' });
    await vi.waitFor(() => expect(game.record!.state.active).toBe('black'));
    expect(game.record!.state.turns.white).toBe(1);
  });

  it('you cannot move for the bot; resigning stops it, with no rewards', async () => {
    const { games, alice } = botSetup();
    const finished = vi.fn();
    games.onFinished = finished;
    let release: (() => void) | undefined;
    games.botPause = () => new Promise<void>((resolve) => (release = resolve));
    const game = games.createBot(alice.id, 'easy', 'black');
    const t = transport(alice.id);
    game.attach(t);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(() => game.actV2(t, pick(game.record!.state, (a) => a.type === 'move'))).toThrow(GameError);
    game.actV2(t, { type: 'resign' });
    const seq = game.record!.seq;
    release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(game.record!.state.status).toEqual({ kind: 'resigned', winner: 'white' });
    expect(game.record!.seq).toBe(seq);
    expect(finished).not.toHaveBeenCalled();
  });

  it('a planner that never finishes the turn cannot stall the game', async () => {
    const { games, alice } = botSetup();
    let asked = 0;
    games.thinker = {
      plan: async () => {
        asked += 1;
        return [];
      },
    };
    const game = games.createBot(alice.id, 'easy', 'black');
    await vi.waitFor(() => expect(game.record!.state.active).toBe('black'));
    expect(asked).toBe(8);
  });

  it('starting another drops the bot games you left, but not one still open', () => {
    const { games, alice, bob } = botSetup();
    const left = games.createBot(alice.id, 'easy', 'white');
    const open = games.createBot(alice.id, 'easy', 'white');
    open.attach(transport(alice.id));
    const bobs = games.createBot(bob.id, 'easy', 'white');
    games.createBot(alice.id, 'easy', 'white');
    expect(games.get(left.id)).toBeUndefined();
    expect(games.get(open.id)).toBe(open);
    expect(games.get(bobs.id)).toBe(bobs);
  });

  it('sends you home when the server restarts', () => {
    const { games, alice } = botSetup();
    const game = games.createBot(alice.id, 'easy', 'white');
    const t = transport(alice.id);
    game.attach(t);
    games.shutdown();
    expect(t.messages.some((m) => m.type === 'notice')).toBe(true);
    expect(t.messages.at(-1)).toEqual({ type: 'left' });
  });
});

describe('the arena', () => {
  const S = v2.parseSquare;

  function arena() {
    const ctx = setup();
    const game = ctx.games.createArena(ctx.alice.id);
    const t = transport(ctx.alice.id);
    game.attach(t);
    return { ...ctx, game, t };
  }

  function lastView(t: ReturnType<typeof transport>): v2.PlayerView {
    const m = [...t.messages].reverse().find((x) => x.type === 'stateV2');
    if (m?.type !== 'stateV2') throw new Error('no state');
    return m.view;
  }

  it('opens a v2 sandbox with just the Kings, memory only and played from both sides', () => {
    const { db, games, alice, game, t } = arena();
    expect(t.messages.find((m) => m.type === 'seated')).toMatchObject({ rules: 2, solo: true, arena: true });
    expect(lastView(t).pieces.map((p) => p.name)).toEqual(['King', 'King']);
    expect(Object.keys(lastView(t).cards)).toHaveLength(Object.keys(v2.STARTER_CATALOG).length);
    // Undo stands in for looking back here.
    expect(lastView(t).steps).toBeUndefined();
    expect(game.memoryOnly).toBe(true);
    expect(db.gameById(game.id)).toBeUndefined();
    expect(games.summariesFor(alice.id)).toEqual([]);
  });

  it('places and gives cards, and Undo steps back over edits and moves alike', () => {
    const { game, t } = arena();
    game.arenaOp(t, { type: 'place', cardId: 'warrior', color: 'white', square: S('a4') });
    game.arenaOp(t, { type: 'give', cardId: 'smite', color: 'black' });
    game.actV2(t, { type: 'move', from: S('a4'), to: S('a6') });
    expect(lastView(t).you).toBe('black');
    expect(lastView(t).hand?.map((c) => c.cardId)).toContain('smite');

    game.arenaOp(t, { type: 'undo' });
    expect(lastView(t).active).toBe('white');
    expect(lastView(t).pieces.find((p) => p.square === S('a4'))?.cardId).toBe('warrior');
    expect(lastView(t).events).toEqual([]);
    game.arenaOp(t, { type: 'undo' });
    expect(game.record!.state.hand.black).toEqual([]);
    game.arenaOp(t, { type: 'undo' });
    expect(game.record!.state.pieces).toHaveLength(2);
    const seq = game.record!.seq;
    game.arenaOp(t, { type: 'undo' });
    expect(game.record!.seq).toBe(seq);
  });

  it('resets to the empty board, which Undo can take back', () => {
    const { game, t } = arena();
    game.arenaOp(t, { type: 'place', cardId: 'mage', color: 'black', square: S('c5') });
    game.arenaOp(t, { type: 'pass' });
    game.arenaOp(t, { type: 'reset' });
    expect(game.record!.state.pieces).toHaveLength(2);
    expect(game.record!.state.active).toBe('white');
    game.arenaOp(t, { type: 'undo' });
    expect(game.record!.state.active).toBe('black');
    expect(v2.pieceAt(game.record!.state, S('c5'))?.cardId).toBe('mage');
  });

  it('refuses what it cannot do with a message, and works nowhere but the arena', () => {
    const { games, alice, bob, game, t } = arena();
    expect(() => game.arenaOp(t, { type: 'place', cardId: 'warrior', color: 'white', square: S('d1') })).toThrow(/King/);
    expect(() => game.arenaOp(t, { type: 'teleport' })).toThrow(GameError);
    expect(() => game.arenaOp(t, { type: 'give', cardId: 'pawn', color: 'white' })).toThrow(GameError);
    expect(() => game.arenaOp(transport(bob.id), { type: 'pass' })).toThrow(GameError);
    const practice = games.create(alice.id, true, []);
    expect(() => practice.arenaOp(t, { type: 'pass' })).toThrow('That only works in the arena.');
  });

  it('stays for a reload, and opening another drops the one you left', () => {
    const { games, alice, game, t } = arena();
    game.detach(t);
    expect(games.get(game.id)).toBe(game);
    const again = games.createArena(alice.id);
    expect(games.get(game.id)).toBeUndefined();
    expect(games.get(again.id)).toBe(again);

    const practice = games.create(alice.id, true, []);
    const p = transport(alice.id);
    practice.attach(p);
    practice.detach(p);
    expect(games.get(practice.id)).toBeUndefined();
  });
});

describe('chat', () => {
  const GIF = { url: 'https://static.klipy.com/ii/ffd4ac143e63/e8/3a/y1i7SXbN.webp', width: 220, height: 180, title: 'Happy dance' };

  function chatGame(solo = false) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const { db, games, alice, bob } = setup();
    const game = games.create(alice.id, solo, []);
    if (!solo) game.join(bob.id, []);
    const ta = transport(alice.id);
    const tb = transport(bob.id);
    game.attach(ta);
    if (!solo) game.attach(tb);
    const notified: ChatMessage[] = [];
    game.onChat = (_game, _from, _to, msg) => void notified.push(msg);
    /** The next line goes out after the per-player limit (400 ms). */
    const say = (t: Transport, text: string, gif?: unknown) => {
      vi.setSystemTime(Date.now() + 1000);
      game.chatMessage(t, text, gif);
    };
    return { db, game, ta, tb, notified, say };
  }
  const lines = (t: { messages: ServerMessage[] }): ChatMessage[] => t.messages.flatMap((m) => (m.type === 'chat' ? m.messages : []));

  afterEach(() => vi.useRealTimers());

  it('delivers text with emojis to both players, tidied up, and tells the other seat', () => {
    const { ta, tb, notified, say } = chatGame();
    say(ta, '  gg \n wp 🎉🔥  ');
    expect(lines(tb).at(-1)).toMatchObject({ name: 'Alice', text: 'gg wp 🎉🔥' });
    expect(lines(ta).at(-1)?.text).toBe('gg wp 🎉🔥');
    expect(notified.map((m) => m.text)).toEqual(['gg wp 🎉🔥']);
    say(ta, '   ');
    expect(lines(tb)).toHaveLength(1);
  });

  it('sends a KLIPY GIF on its own or with text, and keeps it in the saved history', () => {
    const { db, game, ta, tb, notified, say } = chatGame();
    say(ta, '', GIF);
    say(tb, 'lol', { ...GIF, url: 'https://static2.klipy.com/ii/x/y.gif' });
    expect(lines(tb).map((m) => [m.text, m.gif?.url])).toEqual([
      ['', GIF.url],
      ['lol', 'https://static2.klipy.com/ii/x/y.gif'],
    ]);
    expect(notified[0]?.gif).toEqual(GIF);
    expect(JSON.parse(db.gameById(game.id)!.chat_json)).toEqual(game.chat);
  });

  it('refuses GIFs that are not KLIPY media, and sends nothing for them', () => {
    const { tb, say } = chatGame();
    for (const url of [
      'http://static.klipy.com/ii/a.gif',
      'https://klipy.com/ii/a.gif',
      'https://static.klipy.com.evil.test/a.gif',
      'https://evil.test/static.klipy.com/a.gif',
      'https://static.klipy.com:8443/a.gif',
      'https://user@static.klipy.com/a.gif',
      'javascript:alert(1)',
      'x'.repeat(700),
    ]) {
      expect(() => say(tb, 'hi', { ...GIF, url }), url).toThrow(GameError);
    }
    for (const bad of [{ ...GIF, width: 0 }, { ...GIF, height: 1.5 }, { ...GIF, width: '220' }, { ...GIF, height: 99_999 }, 'gif', [GIF]]) {
      expect(() => say(tb, '', bad)).toThrow(GameError);
    }
    expect(lines(tb)).toHaveLength(0);
  });

  it('cuts long messages between characters, never through an emoji', () => {
    const { tb, say } = chatGame();
    say(tb, '😀'.repeat(200));
    const faces = lines(tb).at(-1)!.text;
    expect(faces).toBe('😀'.repeat(120));
    const family = '👨‍👩‍👧';
    say(tb, `a${family.repeat(40)}`);
    expect(lines(tb).at(-1)!.text).toBe(`a${family.repeat(29)}`);
  });

  it('practice games chat without notifying anyone', () => {
    const { ta, notified, say } = chatGame(true);
    say(ta, 'note to self', GIF);
    expect(lines(ta)).toHaveLength(1);
    expect(notified).toHaveLength(0);
  });
});

describe('games from before the v2 rules', () => {
  function legacyRow(whiteId: string, blackId: string): GameRow {
    const now = Date.now();
    return {
      id: newId(),
      code: 'OLDGM',
      rules_version: 1,
      solo: 0,
      white_user_id: whiteId,
      black_user_id: blackId,
      state_json: JSON.stringify(createGame({ decks: { white: starterDeck(), black: starterDeck() }, seed: 5 })),
      status_kind: 'playing',
      turn: 'white',
      clock_white_ms: 1_000_000,
      clock_black_ms: 1_000_000,
      turn_started_at: now,
      chat_json: '[]',
      white_deck_json: JSON.stringify(starterDeck()),
      black_deck_json: JSON.stringify(starterDeck()),
      rewarded: 0,
      created_at: now,
      updated_at: now,
    };
  }

  it('keep running under the original 8x8 rules and refuse v2 actions', () => {
    const { db, games, alice, bob } = setup();
    const row = legacyRow(alice.id, bob.id);
    db.insertGame(row);
    const game = games.get(row.id)!;
    expect(game.rules).toBe(1);
    expect(game.record).toBeNull();
    expect(game.state?.board).toHaveLength(64);

    const t = transport(alice.id);
    game.attach(t);
    expect(t.messages.find((m) => m.type === 'seated')).toMatchObject({ rules: 1 });
    expect(t.messages.some((m) => m.type === 'state')).toBe(true);
    expect(t.messages.some((m) => m.type === 'stateV2')).toBe(false);

    expect(() => game.actV2(t, { type: 'endTurn' })).toThrow(GameError);
    const e2e4: Action = { type: 'move', from: 12, to: 28 };
    game.act(t, e2e4);
    expect(game.state?.turn).toBe('black');
    expect(game.summaryFor(alice.id)).toMatchObject({ rules: 1, yourTurn: false });
  });

  it('an existing database without the rules column opens with every game on the original rules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chessx-db-'));
    const path = join(dir, 'old.sqlite');
    try {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL, password_hash TEXT, google_id TEXT UNIQUE, facebook_id TEXT UNIQUE, avatar_url TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE games (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, solo INTEGER NOT NULL DEFAULT 0, white_user_id TEXT, black_user_id TEXT, state_json TEXT,
          status_kind TEXT NOT NULL DEFAULT 'waiting', turn TEXT NOT NULL DEFAULT 'white', clock_white_ms INTEGER NOT NULL, clock_black_ms INTEGER NOT NULL,
          turn_started_at INTEGER, chat_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO games (id, code, state_json, status_kind, clock_white_ms, clock_black_ms, created_at, updated_at)
          VALUES ('g1', 'ABCDE', '${JSON.stringify(createGame({ decks: { white: starterDeck(), black: starterDeck() }, seed: 1 }))}', 'playing', 1, 1, 1, 1);
      `);
      old.close();
      const db = new Db(path);
      const row = db.gameById('g1')!;
      expect(row.rules_version).toBe(1);
      const game = new GameManager(db, () => '?').get('g1')!;
      expect(game.rules).toBe(1);
      expect(game.state).not.toBeNull();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the database file is still open (Windows keeps it locked); the OS cleans the temp dir */
      }
    }
  });
});
