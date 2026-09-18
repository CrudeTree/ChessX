import type { Action, Color, GameStatus, Piece, PlayerView } from '@chessx/engine';

export const PROTOCOL_VERSION = 2;

/** 3 days per player, ticking only while it is their turn. */
export const TURN_CLOCK_MS = 3 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// HTTP (auth + profile). All under /api.

export interface UserInfo {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface AuthProviders {
  google: boolean;
  facebook: boolean;
}

// ---------------------------------------------------------------------------
// Progression: XP, level, card collection, decks.

export const DECK_SLOTS = 3;
export const XP_PER_MATCH = 20;
export const XP_PER_WIN = 30;

/** Total XP needed to *reach* `level` (level 1 = 0). Grows gently: 100, 300, 600, 1000... */
export const xpForLevel = (level: number): number => (50 * (level - 1) * level);
export function levelFor(xp: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return level;
}

export interface CollectionEntry {
  cardId: string;
  count: number;
  /** Not yet looked at in the binder. */
  isNew: boolean;
}

export interface DeckInfo {
  slot: number;
  name: string;
  cards: string[];
}

export interface Profile {
  user: UserInfo;
  xp: number;
  level: number;
  gamesPlayed: number;
  wins: number;
  collection: CollectionEntry[];
  decks: DeckInfo[];
}

/** What a player earned when a game finished. */
export interface RewardReport {
  gameId: string;
  xpGained: number;
  xp: number;
  level: number;
  leveledUp: boolean;
  /** Card ids granted (a brand-new card, or a spare copy of one already owned). */
  cards: { cardId: string; brandNew: boolean }[];
  reason: 'firstMatch' | 'checkmate' | 'none';
}

// ---------------------------------------------------------------------------
// Game summaries for the home page.

export interface Clocks {
  /** Remaining ms for each side, as of `asOf`. The side to move is still ticking. */
  white: number;
  black: number;
  asOf: number;
  turn: Color;
  running: boolean;
}

export interface GameSummary {
  id: string;
  code: string;
  solo: boolean;
  yourColor: Color;
  yourTurn: boolean;
  opponentName: string | null;
  /** No opponent has joined yet; share `code`. */
  waitingForOpponent: boolean;
  status: GameStatus;
  turn: Color;
  clocks: Clocks;
  /** Compact board for thumbnails. */
  pieces: Pick<Piece, 'kind' | 'owner' | 'square'>[];
  updatedAt: number;
  createdAt: number;
}

export interface RoomInfo {
  code: string;
  players: Record<Color, { name: string; connected: boolean } | null>;
}

export interface ChatMessage {
  from: Color;
  name: string;
  text: string;
  /** Unix ms. */
  at: number;
}

// ---------------------------------------------------------------------------
// WebSocket. The socket is authenticated by the session cookie.

/** Messages the browser sends to the server. */
export type ClientMessage =
  | { type: 'listGames' }
  /** Start a new game with one of your decks; you get an invite code for a friend. */
  | { type: 'createGame'; deckSlot: number }
  /** Practice game: you control both sides (the chosen deck is used for both). */
  | { type: 'createSolo'; deckSlot: number }
  | { type: 'joinGame'; code: string; deckSlot: number }
  /** Open one of your games in this tab. */
  | { type: 'openGame'; gameId: string }
  | { type: 'action'; action: Action }
  | { type: 'chat'; text: string }
  /** Detach this tab from its game (the game persists). */
  | { type: 'leave' };

/** Messages the server sends to the browser. */
export type ServerMessage =
  | { type: 'welcome'; version: number; user: UserInfo }
  | { type: 'games'; games: GameSummary[] }
  /** This tab is now attached to a game. */
  | { type: 'seated'; gameId: string; code: string; color: Color; room: RoomInfo; solo: boolean }
  | { type: 'room'; room: RoomInfo }
  | { type: 'state'; view: PlayerView; clocks: Clocks }
  /** One or more chat lines (the full history when opening a game). */
  | { type: 'chat'; messages: ChatMessage[] }
  /** A game you were in just finished and you earned something. */
  | { type: 'rewards'; report: RewardReport }
  | { type: 'error'; message: string }
  | { type: 'left' };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
