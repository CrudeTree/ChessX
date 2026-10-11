import type { Action, ArenaOp, Balance, Color, GameStatus, Piece, PlayerView, v2 } from '@chessx/engine';

export const PROTOCOL_VERSION = 3;

/** 3 days per player, ticking only while it is their turn. */
export const TURN_CLOCK_MS = 3 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// HTTP (auth + profile). All under /api.

export interface UserInfo {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  /** May edit card/piece balance from inside the app. */
  admin: boolean;
  /** The game's owner: may also choose who else is a developer. */
  owner: boolean;
}

/** A player with editor access, as listed for the owner. */
export interface DeveloperInfo {
  id: string;
  name: string;
  email: string | null;
}

/** One account as shown in the owner's Players panel. */
export interface PlayerInfo {
  id: string;
  name: string;
  email: string | null;
  /** How they sign in. */
  signIn: 'email' | 'google' | 'facebook' | 'unknown';
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
  level: number;
  xp: number;
  gamesPlayed: number;
  wins: number;
  gamesInProgress: number;
  developer: boolean;
  owner: boolean;
}

export interface SiteStats {
  accounts: number;
  newThisWeek: number;
  activeToday: number;
  onlineNow: number;
  gamesPlaying: number;
  gamesFinished: number;
  gamesTotal: number;
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
// Friends and challenges.

export interface FriendInfo {
  id: string;
  name: string;
  avatarUrl: string | null;
  online: boolean;
  level: number;
}

export interface ChallengeInfo {
  id: string;
  from: { id: string; name: string };
  to: { id: string; name: string };
  gameId: string;
  createdAt: number;
}

/** Everything the Friends panel shows. Pushed over the socket whenever it changes. */
export interface Social {
  myFriendCode: string;
  friends: FriendInfo[];
  /** People who asked to be your friend. */
  incomingRequests: FriendInfo[];
  /** People you asked. */
  outgoingRequests: FriendInfo[];
  incomingChallenges: ChallengeInfo[];
  outgoingChallenges: ChallengeInfo[];
}

export interface UserSearchResult {
  id: string;
  name: string;
  friendCode: string;
  level: number;
  /** Relationship with the searcher, so the UI can show the right button. */
  relation: 'none' | 'friend' | 'requested' | 'requestedYou' | 'you';
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
  /** Rules version: 1 = the original 8x8 game (kept for games already in progress), 2 = the mana/sealing game (also 8x8, but with its own square numbering and rules). */
  rules: 1 | 2;
  solo: boolean;
  yourColor: Color;
  yourTurn: boolean;
  opponentName: string | null;
  /** No opponent has joined yet; share `code`. */
  waitingForOpponent: boolean;
  /** If this game is a pending challenge, the friend it was sent to. */
  invitedName: string | null;
  status: GameStatus;
  turn: Color;
  clocks: Clocks;
  /**
   * Compact board for thumbnails. Square indexes follow the game's own board: rank * 8 + file for
   * rules 1, rank * 6 + file for rules 2 (where seals appear as pieces of kind `seal`).
   */
  pieces: Pick<Piece, 'kind' | 'owner' | 'square'>[];
  updatedAt: number;
  createdAt: number;
}

export interface RoomInfo {
  code: string;
  players: Record<Color, { name: string; connected: boolean } | null>;
}

/** A GIF picked in the chat's KLIPY search. Every player loads it straight from KLIPY. */
export interface ChatGif {
  /** A media URL exactly as KLIPY returned it (KLIPY's terms: never rewritten or re-hosted). */
  url: string;
  width: number;
  height: number;
  /** What it shows: alt text, and what is left if the GIF is gone. */
  title: string;
}

export interface ChatMessage {
  from: Color;
  name: string;
  /** May be empty when the message is a GIF. */
  text: string;
  gif?: ChatGif;
  /** Unix ms. */
  at: number;
}

/**
 * KLIPY's media hosts are static.klipy.com and its numbered siblings. The host must end at the first slash, so no
 * port, login or look-alike domain gets through; the rest is any printable ASCII but a backslash.
 */
const KLIPY_MEDIA_URL = /^https:\/\/static\d*\.klipy\.com\/[!-[\]-~]+$/;

/** True for a GIF hosted by KLIPY; a chat GIF must be one of those. */
export function isKlipyMediaUrl(url: string): boolean {
  return KLIPY_MEDIA_URL.test(url);
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
  /** Testing arena: empty sandbox board. Memory only, no rewards, no deck required. */
  | { type: 'createArena' }
  /** Place or grant something in the testing arena. */
  | { type: 'arenaSetup'; op: ArenaOp }
  | { type: 'joinGame'; code: string; deckSlot: number }
  /** Open one of your games in this tab. */
  | { type: 'openGame'; gameId: string }
  /** Withdraw an invite/challenge nobody has joined yet. Only the creator may do this. */
  | { type: 'cancelGame'; gameId: string }
  // ---- friends & challenges
  | { type: 'getSocial' }
  | { type: 'friendRequest'; userId: string }
  | { type: 'friendAccept'; userId: string }
  /** Decline an incoming request, cancel an outgoing one, or unfriend. */
  | { type: 'friendRemove'; userId: string }
  /** Challenge a friend: creates a game with you seated and invites them. */
  | { type: 'challenge'; friendId: string; deckSlot: number }
  | { type: 'acceptChallenge'; challengeId: string; deckSlot: number }
  /** Decline (as the invitee) or cancel (as the challenger). */
  | { type: 'declineChallenge'; challengeId: string }
  | { type: 'action'; action: Action }
  /** An action in a rules-2 game. Resigning is allowed at any time. */
  | { type: 'actionV2'; action: v2.Action | { type: 'resign' } }
  | { type: 'chat'; text: string; gif?: ChatGif }
  /** Detach this tab from its game (the game persists). */
  | { type: 'leave' };

/** Messages the server sends to the browser. */
export type ServerMessage =
  /** `gifKey`: the KLIPY app key the chat's GIF search uses from the browser; absent when GIFs are off. */
  | { type: 'welcome'; version: number; user: UserInfo; balance: Balance; gifKey?: string }
  /** The admin changed card/piece numbers: apply and redraw. */
  | { type: 'balance'; balance: Balance }
  /** Your account changed (e.g. you were made a developer). */
  | { type: 'user'; user: UserInfo }
  | { type: 'games'; games: GameSummary[] }
  /** This tab is now attached to a game. */
  | { type: 'seated'; gameId: string; code: string; color: Color; room: RoomInfo; solo: boolean; arena?: boolean; rules: 1 | 2 }
  | { type: 'room'; room: RoomInfo }
  | { type: 'state'; view: PlayerView; clocks: Clocks }
  /** The same, for a rules-2 game. */
  | { type: 'stateV2'; view: v2.PlayerView; clocks: Clocks }
  /** One or more chat lines (the full history when opening a game). */
  | { type: 'chat'; messages: ChatMessage[] }
  /** A game you were in just finished and you earned something. */
  | { type: 'rewards'; report: RewardReport }
  /** Friends panel data (sent on request and whenever it changes). */
  | { type: 'social'; social: Social }
  /** Short notice worth a toast: someone challenged you, accepted, declined... */
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string }
  | { type: 'left' };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
