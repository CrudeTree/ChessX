import { createGame, starterDeck, v2, type Action, type Color } from '@chessx/engine';
import type { ServerMessage } from '@chessx/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db, newId, type GameRow } from '../src/db.js';
import { GameError, GameManager, type Transport } from '../src/games.js';

function setup() {
  const db = new Db(':memory:');
  const games = new GameManager(db, (id) => db.userById(id)?.name ?? '?');
  const mk = (name: string) =>
    db.createUser({ email: `${name.toLowerCase()}@x.test`, name, password_hash: null, google_id: null, facebook_id: null, avatar_url: null });
  return { db, games, alice: mk('Alice'), bob: mk('Bob') };
}

function transport(userId: string): Transport & { messages: ServerMessage[] } {
  const messages: ServerMessage[] = [];
  return { userId, messages, send: (m) => void messages.push(m) };
}

/** The first legal action matching `want`, taken for whoever is to move. */
function pick(state: v2.GameState, want: (a: v2.Action) => boolean): v2.Action {
  const found = v2.legalActions(state).find(want);
  if (!found) throw new Error('no such legal action');
  return found;
}

describe('rules 2 games', () => {
  it('start in setup when the second player joins, and send the v2 view', () => {
    const { games, alice, bob } = setup();
    const game = games.create(alice.id, false, []);
    expect(game.rules).toBe(2);
    expect(game.started).toBe(false);
    const ta = transport(alice.id);
    game.attach(ta);
    game.join(bob.id, []);
    const tb = transport(bob.id);
    game.attach(tb);

    expect(game.record?.state.phase).toBe('setup');
    const seated = tb.messages.find((m) => m.type === 'seated');
    expect(seated).toMatchObject({ type: 'seated', rules: 2 });
    const stateMsg = tb.messages.find((m) => m.type === 'stateV2');
    expect(stateMsg?.type).toBe('stateV2');
    if (stateMsg?.type !== 'stateV2') throw new Error('unreachable');
    // Bob sees his own hand and only a count for Alice's.
    expect(stateMsg.view.hand).toHaveLength(7);
    expect(stateMsg.view.handCount.white).toBe(7);
    expect(game.summaryFor(alice.id)).toMatchObject({ rules: 2, waitingForOpponent: false });
  });

  it('plays setup then a move, enforcing turn order and legality, and survives a reload from the database', () => {
    const { db, games, alice, bob } = setup();
    const game = games.create(alice.id, false, []);
    game.join(bob.id, []);
    const whiteId = game.row.white_user_id!;
    const blackId = game.row.black_user_id!;
    const white = transport(whiteId);
    const black = transport(blackId);
    game.attach(white);
    game.attach(black);

    // White deploys first; Black may not.
    expect(() => game.actV2(black, pick(game.record!.state, (a) => a.type === 'deploy'))).toThrow(GameError);
    for (let i = 0; i < 6; i++) {
      const mover = game.record!.state.active === 'white' ? white : black;
      game.actV2(mover, pick(game.record!.state, (a) => a.type === 'deploy'));
    }
    expect(game.record!.state.phase).toBe('play');
    expect(game.record!.state.active).toBe('white');
    expect(() => game.actV2(white, { type: 'summon', cardUid: 'nope', to: 0 })).toThrow(GameError);
    expect(() => game.actV2(black, { type: 'endTurn' })).toThrow(GameError);

    game.actV2(white, pick(game.record!.state, (a) => a.type === 'move'));
    game.actV2(white, { type: 'endTurn' });
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
    game.actV2(t, pick(game.record!.state, (a) => a.type === 'deploy'));
    const latest = [...t.messages].reverse().find((m) => m.type === 'stateV2');
    if (latest?.type !== 'stateV2') throw new Error('no state');
    expect(latest.view.you).toBe('black'); // Black is now deploying
    expect(db.gameById(game.id)).toBeUndefined();
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
