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
