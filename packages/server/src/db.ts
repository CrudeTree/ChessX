// Persistence: a single SQLite file via Node's built-in `node:sqlite`.
// No native modules, no external database. Fine for a hobby server; the
// repository functions below are the only place SQL lives, so swapping in
// Postgres later is contained.

import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';

// Loaded at runtime rather than via a static import so test tooling (which does
// not yet know node:sqlite is a built-in) does not try to bundle it.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatMessage } from '@chessx/protocol';
import { pruneUnknownCards, upgradeState, type Color, type GameState } from '@chessx/engine';

export interface UserRow {
  id: string;
  email: string | null;
  name: string;
  password_hash: string | null;
  google_id: string | null;
  facebook_id: string | null;
  avatar_url: string | null;
  created_at: number;
  xp: number;
  games_played: number;
  wins: number;
  /** Short shareable code friends can add you by. */
  friend_code: string | null;
}

export interface FriendRow {
  user_id: string;
  friend_id: string;
  /** 'pending' = user_id asked friend_id; 'accepted' = mutual (two rows). */
  status: 'pending' | 'accepted';
  created_at: number;
}

export interface ChallengeRow {
  id: string;
  from_user: string;
  to_user: string;
  game_id: string;
  status: 'pending' | 'accepted' | 'declined';
  created_at: number;
}

export interface CollectionRow {
  user_id: string;
  card_id: string;
  count: number;
  seen: number;
}

export interface DeckRow {
  user_id: string;
  slot: number;
  name: string;
  cards_json: string;
}

export interface GameRow {
  id: string;
  code: string;
  solo: number;
  white_user_id: string | null;
  black_user_id: string | null;
  /** Serialised engine GameState, null until both seats are filled. */
  state_json: string | null;
  status_kind: string;
  turn: Color;
  clock_white_ms: number;
  clock_black_ms: number;
  /** When the current side's clock started ticking (null while waiting for an opponent). */
  turn_started_at: number | null;
  chat_json: string;
  /** Card lists each seat brought to the game (null until that seat is taken). */
  white_deck_json: string | null;
  black_deck_json: string | null;
  /** XP and card rewards were handed out for this finished game. */
  rewarded: number;
  created_at: number;
  updated_at: number;
}

export const newId = (bytes = 12): string => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export class Db {
  private db: DatabaseSyncT;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT,
        google_id TEXT UNIQUE,
        facebook_id TEXT UNIQUE,
        avatar_url TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        solo INTEGER NOT NULL DEFAULT 0,
        white_user_id TEXT REFERENCES users(id),
        black_user_id TEXT REFERENCES users(id),
        state_json TEXT,
        status_kind TEXT NOT NULL DEFAULT 'waiting',
        turn TEXT NOT NULL DEFAULT 'white',
        clock_white_ms INTEGER NOT NULL,
        clock_black_ms INTEGER NOT NULL,
        turn_started_at INTEGER,
        chat_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS games_white ON games(white_user_id);
      CREATE INDEX IF NOT EXISTS games_black ON games(black_user_id);
      CREATE TABLE IF NOT EXISTS collection (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        card_id TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        seen INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, card_id)
      );
      CREATE TABLE IF NOT EXISTS decks (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL,
        name TEXT NOT NULL,
        cards_json TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (user_id, slot)
      );
      CREATE TABLE IF NOT EXISTS friends (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, friend_id)
      );
      CREATE INDEX IF NOT EXISTS friends_target ON friends(friend_id);
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        from_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS challenges_to ON challenges(to_user, status);
      CREATE INDEX IF NOT EXISTS challenges_from ON challenges(from_user, status);
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);
    `);
    // Columns added after the first release; safe to run on an existing database.
    this.addColumn('users', 'xp', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('users', 'games_played', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('users', 'wins', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('games', 'white_deck_json', 'TEXT');
    this.addColumn('games', 'black_deck_json', 'TEXT');
    this.addColumn('games', 'rewarded', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('users', 'friend_code', 'TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_friend_code ON users(friend_code)');
  }

  private addColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  // ------------------------------------------------------------------ users

  createUser(u: Omit<UserRow, 'id' | 'created_at' | 'xp' | 'games_played' | 'wins' | 'friend_code'>): UserRow {
    const row: UserRow = { ...u, id: newId(), created_at: Date.now(), xp: 0, games_played: 0, wins: 0, friend_code: null };
    this.db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, google_id, facebook_id, avatar_url, created_at, xp, games_played, wins)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
      )
      .run(row.id, row.email, row.name, row.password_hash, row.google_id, row.facebook_id, row.avatar_url, row.created_at);
    return row;
  }

  addProgress(userId: string, xp: number, played: number, wins: number): void {
    this.db.prepare('UPDATE users SET xp = xp + ?, games_played = games_played + ?, wins = wins + ? WHERE id = ?').run(xp, played, wins, userId);
  }

  /** Every user gets a short code friends can add them by (created lazily for older accounts). */
  friendCodeFor(user: UserRow): string {
    if (user.friend_code) return user.friend_code;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) {
      const bytes = randomBytes(6);
      let code = '';
      for (let i = 0; i < 6; i++) code += alphabet[bytes[i]! % alphabet.length];
      try {
        this.db.prepare('UPDATE users SET friend_code = ? WHERE id = ? AND friend_code IS NULL').run(code, user.id);
        user.friend_code = code;
        return code;
      } catch {
        /* collision: try another */
      }
    }
  }

  userByFriendCode(code: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE friend_code = ?').get(code.toUpperCase()) as UserRow | undefined;
  }

  /** The earliest-registered account with exactly this name (case-insensitive). */
  oldestUserNamed(name: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE ORDER BY created_at ASC LIMIT 1').get(name) as UserRow | undefined;
  }

  /** Name search for the "add friend" box (case-insensitive substring). */
  searchUsersByName(q: string, limit = 10): UserRow[] {
    return this.db.prepare('SELECT * FROM users WHERE name LIKE ? COLLATE NOCASE ORDER BY name LIMIT ?').all(`%${q}%`, limit) as unknown as UserRow[];
  }

  // ---------------------------------------------------------------- friends

  friendRows(userId: string): FriendRow[] {
    return this.db.prepare('SELECT * FROM friends WHERE user_id = ? OR friend_id = ?').all(userId, userId) as unknown as FriendRow[];
  }

  friendRow(userId: string, friendId: string): FriendRow | undefined {
    return this.db.prepare('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?').get(userId, friendId) as FriendRow | undefined;
  }

  upsertFriend(userId: string, friendId: string, status: FriendRow['status']): void {
    this.db
      .prepare(
        `INSERT INTO friends (user_id, friend_id, status, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, friend_id) DO UPDATE SET status = excluded.status`,
      )
      .run(userId, friendId, status, Date.now());
  }

  deleteFriendPair(a: string, b: string): void {
    this.db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').run(a, b, b, a);
  }

  // ------------------------------------------------------------- challenges

  insertChallenge(c: ChallengeRow): void {
    this.db
      .prepare('INSERT INTO challenges (id, from_user, to_user, game_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.id, c.from_user, c.to_user, c.game_id, c.status, c.created_at);
  }

  challengeById(id: string): ChallengeRow | undefined {
    return this.db.prepare('SELECT * FROM challenges WHERE id = ?').get(id) as ChallengeRow | undefined;
  }

  pendingChallengeForGame(gameId: string): ChallengeRow | undefined {
    return this.db.prepare("SELECT * FROM challenges WHERE game_id = ? AND status = 'pending'").get(gameId) as ChallengeRow | undefined;
  }

  pendingChallengesFor(userId: string): ChallengeRow[] {
    return this.db
      .prepare("SELECT * FROM challenges WHERE status = 'pending' AND (to_user = ? OR from_user = ?) ORDER BY created_at DESC")
      .all(userId, userId) as unknown as ChallengeRow[];
  }

  setChallengeStatus(id: string, status: ChallengeRow['status']): void {
    this.db.prepare('UPDATE challenges SET status = ? WHERE id = ?').run(status, id);
  }

  deleteGame(id: string): void {
    this.db.prepare('DELETE FROM games WHERE id = ?').run(id);
  }

  // --------------------------------------------------------- kv + web push

  getKv(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  savePushSubscription(userId: string, endpoint: string, subscriptionJson: string): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, subscription_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription_json = excluded.subscription_json`,
      )
      .run(endpoint, userId, subscriptionJson, Date.now());
  }

  deletePushSubscription(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  pushSubscriptionsFor(userId: string): string[] {
    return (this.db.prepare('SELECT subscription_json FROM push_subscriptions WHERE user_id = ?').all(userId) as unknown as { subscription_json: string }[]).map(
      (r) => r.subscription_json,
    );
  }

  // ------------------------------------------------------------- collection

  collectionFor(userId: string): CollectionRow[] {
    return this.db.prepare('SELECT * FROM collection WHERE user_id = ? AND count > 0 ORDER BY card_id').all(userId) as unknown as CollectionRow[];
  }

  /** Add copies of a card. `seen = false` marks it as new in the binder. */
  grantCard(userId: string, cardId: string, count: number, seen: boolean): void {
    this.db
      .prepare(
        `INSERT INTO collection (user_id, card_id, count, seen) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, card_id) DO UPDATE SET count = count + excluded.count, seen = MIN(seen, excluded.seen)`,
      )
      .run(userId, cardId, count, seen ? 1 : 0);
  }

  markCollectionSeen(userId: string): void {
    this.db.prepare('UPDATE collection SET seen = 1 WHERE user_id = ?').run(userId);
  }

  // ------------------------------------------------------------------ decks

  decksFor(userId: string): DeckRow[] {
    return this.db.prepare('SELECT * FROM decks WHERE user_id = ? ORDER BY slot').all(userId) as unknown as DeckRow[];
  }

  /** An admin-created card was deleted: take it out of every collection and deck. */
  removeCardEverywhere(cardId: string): void {
    this.db.prepare('DELETE FROM collection WHERE card_id = ?').run(cardId);
    const rows = this.db.prepare(`SELECT * FROM decks WHERE cards_json LIKE ?`).all(`%"${cardId}"%`) as unknown as DeckRow[];
    const update = this.db.prepare('UPDATE decks SET cards_json = ? WHERE user_id = ? AND slot = ?');
    for (const r of rows) {
      const cards = (JSON.parse(r.cards_json) as string[]).filter((c) => c !== cardId);
      update.run(JSON.stringify(cards), r.user_id, r.slot);
    }
  }

  saveDeck(userId: string, slot: number, name: string, cards: string[]): void {
    this.db
      .prepare(
        `INSERT INTO decks (user_id, slot, name, cards_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, slot) DO UPDATE SET name = excluded.name, cards_json = excluded.cards_json`,
      )
      .run(userId, slot, name, JSON.stringify(cards));
  }

  userById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  userByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as UserRow | undefined;
  }

  userByProvider(provider: 'google' | 'facebook', providerId: string): UserRow | undefined {
    const col = provider === 'google' ? 'google_id' : 'facebook_id';
    return this.db.prepare(`SELECT * FROM users WHERE ${col} = ?`).get(providerId) as UserRow | undefined;
  }

  linkProvider(userId: string, provider: 'google' | 'facebook', providerId: string, avatarUrl: string | null): void {
    const col = provider === 'google' ? 'google_id' : 'facebook_id';
    this.db.prepare(`UPDATE users SET ${col} = ?, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?`).run(providerId, avatarUrl, userId);
  }

  // --------------------------------------------------------------- sessions

  createSession(userId: string, ttlMs: number): string {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + ttlMs);
    return token;
  }

  userBySession(token: string): UserRow | undefined {
    const row = this.db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
      .get(sha256(token), Date.now()) as UserRow | undefined;
    return row;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  purgeExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }

  // ------------------------------------------------------------------ games

  insertGame(g: GameRow): void {
    this.db
      .prepare(
        `INSERT INTO games (id, code, solo, white_user_id, black_user_id, state_json, status_kind, turn,
           clock_white_ms, clock_black_ms, turn_started_at, chat_json, white_deck_json, black_deck_json, rewarded,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        g.id, g.code, g.solo, g.white_user_id, g.black_user_id, g.state_json, g.status_kind, g.turn,
        g.clock_white_ms, g.clock_black_ms, g.turn_started_at, g.chat_json, g.white_deck_json, g.black_deck_json, g.rewarded,
        g.created_at, g.updated_at,
      );
  }

  updateGame(g: GameRow): void {
    this.db
      .prepare(
        `UPDATE games SET white_user_id = ?, black_user_id = ?, state_json = ?, status_kind = ?, turn = ?,
           clock_white_ms = ?, clock_black_ms = ?, turn_started_at = ?, chat_json = ?,
           white_deck_json = ?, black_deck_json = ?, rewarded = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        g.white_user_id, g.black_user_id, g.state_json, g.status_kind, g.turn,
        g.clock_white_ms, g.clock_black_ms, g.turn_started_at, g.chat_json,
        g.white_deck_json, g.black_deck_json, g.rewarded, g.updated_at, g.id,
      );
  }

  gameById(id: string): GameRow | undefined {
    return this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
  }

  gameByCode(code: string): GameRow | undefined {
    return this.db.prepare('SELECT * FROM games WHERE code = ?').get(code) as GameRow | undefined;
  }

  gamesForUser(userId: string): GameRow[] {
    return this.db
      .prepare('SELECT * FROM games WHERE white_user_id = ? OR black_user_id = ? ORDER BY updated_at DESC LIMIT 100')
      .all(userId, userId) as unknown as GameRow[];
  }

  /** Games where somebody's clock is running (candidates for timeout). */
  runningGames(): GameRow[] {
    return this.db.prepare("SELECT * FROM games WHERE status_kind = 'playing' AND turn_started_at IS NOT NULL").all() as unknown as GameRow[];
  }

  codeExists(code: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM games WHERE code = ?').get(code);
  }
}

// Helpers for the JSON columns.
/** Games saved before newer fields (e.g. mana) existed are upgraded on load; cards the admin has since deleted are dropped. */
export const parseState = (row: GameRow): GameState | null => {
  if (!row.state_json) return null;
  const state = upgradeState(JSON.parse(row.state_json) as GameState);
  pruneUnknownCards(state);
  return state;
};
export const parseChat = (row: GameRow): ChatMessage[] => JSON.parse(row.chat_json) as ChatMessage[];
