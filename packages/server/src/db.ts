// Persistence: a single SQLite file via Node's built-in `node:sqlite`.
// No native modules, no external database. Fine for a hobby server; the
// repository functions below are the only place SQL lives, so swapping in
// Postgres later is contained.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatMessage } from '@chessx/protocol';
import type { Color, GameState } from '@chessx/engine';

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
  private db: DatabaseSync;

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
    `);
    // Columns added after the first release; safe to run on an existing database.
    this.addColumn('users', 'xp', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('users', 'games_played', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('users', 'wins', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumn('games', 'white_deck_json', 'TEXT');
    this.addColumn('games', 'black_deck_json', 'TEXT');
    this.addColumn('games', 'rewarded', 'INTEGER NOT NULL DEFAULT 0');
  }

  private addColumn(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  // ------------------------------------------------------------------ users

  createUser(u: Omit<UserRow, 'id' | 'created_at' | 'xp' | 'games_played' | 'wins'>): UserRow {
    const row: UserRow = { ...u, id: newId(), created_at: Date.now(), xp: 0, games_played: 0, wins: 0 };
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
export const parseState = (row: GameRow): GameState | null => (row.state_json ? (JSON.parse(row.state_json) as GameState) : null);
export const parseChat = (row: GameRow): ChatMessage[] => JSON.parse(row.chat_json) as ChatMessage[];
