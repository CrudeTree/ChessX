// Persistent games. Each game lives in SQLite and, while anyone has it open,
// as a `LiveGame` in memory. Players are identified by account, not by
// connection, so any number of tabs can be attached and a player may be in
// many games at once.

import {
  applyAction,
  applyArenaOp,
  createArenaGame,
  createGame,
  IllegalActionError,
  opposite,
  pruneUnknownCards,
  rebasePieces,
  starterDeck,
  viewFor,
  type Action,
  type ArenaOp,
  type Color,
  type GameState,
} from '@chessx/engine';
import { TURN_CLOCK_MS, type ChatMessage, type Clocks, type GameSummary, type RoomInfo, type ServerMessage } from '@chessx/protocol';
import { randomBytes } from 'node:crypto';
import { newId, parseChat, parseState, type Db, type GameRow } from './db.js';

export interface Transport {
  readonly userId: string;
  send(msg: ServerMessage): void;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHAT_HISTORY = 100;
const CHAT_MAX_LEN = 240;
const CHAT_MIN_INTERVAL_MS = 400;

export class GameError extends Error {}

function randomCode(len = 5): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

// ---------------------------------------------------------------------------

/** Per card the opponent must watch being revealed, plus a beat for the move itself. */
const REVEAL_MS_PER_CARD = 2200;
const TURN_GRACE_BASE_MS = 1000;
const TURN_GRACE_MAX_MS = 15_000;

export class LiveGame {
  state: GameState | null;
  chat: ChatMessage[];
  private watchers = new Set<Transport>();
  private lastChatAt = new Map<string, number>();
  /** Cards played during the current turn (drives the opponent's clock grace). */
  private cardsThisTurn = 0;
  /** Testing arena: free setup, memory only (also `solo`). */
  arena = false;

  /** Fired after anything that changes how the game appears on the home page. */
  onChanged: (game: LiveGame) => void = () => {};
  /** Fired once when a two-player game reaches a final result (rewards are handed out here). */
  onFinished: (game: LiveGame) => void = () => {};
  /** Fired when the turn passes to `userId` in a two-player game. */
  onYourTurn: (game: LiveGame, userId: string) => void = () => {};
  /** Fired when the last viewer detaches (practice games are discarded then). */
  onEmpty: (game: LiveGame) => void = () => {};
  /** Fired when a chat line is posted; `toUserId` is the other seat. */
  onChat: (game: LiveGame, fromUserId: string, toUserId: string, text: string) => void = () => {};

  constructor(
    public row: GameRow,
    private db: Db,
    private userName: (id: string) => string,
  ) {
    this.state = parseState(row);
    this.chat = parseChat(row);
  }

  participants(): string[] {
    return [this.row.white_user_id, this.row.black_user_id].filter((x): x is string => !!x);
  }

  get id(): string {
    return this.row.id;
  }

  get solo(): boolean {
    return this.row.solo === 1;
  }

  get hasWatchers(): boolean {
    return this.watchers.size > 0;
  }

  watchersList(): Transport[] {
    return [...this.watchers];
  }

  isParticipant(userId: string): boolean {
    return this.row.white_user_id === userId || this.row.black_user_id === userId;
  }

  /** Which colour this user plays. In a practice game, whichever side is to move. */
  colorOf(userId: string): Color | null {
    if (this.solo) return this.isParticipant(userId) ? (this.state?.turn ?? 'white') : null;
    if (this.row.white_user_id === userId) return 'white';
    if (this.row.black_user_id === userId) return 'black';
    return null;
  }

  /** The colour used for "your" perspective in summaries (stable even in practice games). */
  seatOf(userId: string): Color | null {
    if (this.row.white_user_id === userId) return 'white';
    if (this.row.black_user_id === userId) return 'black';
    return null;
  }

  // ----------------------------------------------------------------- clocks

  /** Clocks only run in a started, unfinished, two-player game. */
  private clockRunning(): boolean {
    return !!this.state && this.state.status.kind === 'playing' && !this.solo && this.row.turn_started_at !== null;
  }

  clocks(now = Date.now()): Clocks {
    const running = this.clockRunning();
    const turn = this.state?.turn ?? 'white';
    const elapsed = running ? Math.max(0, now - this.row.turn_started_at!) : 0;
    return {
      white: this.row.clock_white_ms - (turn === 'white' ? elapsed : 0),
      black: this.row.clock_black_ms - (turn === 'black' ? elapsed : 0),
      asOf: now,
      turn,
      running,
    };
  }

  /**
   * Bank the elapsed time against the side to move (called when the turn passes
   * or the game ends). The next clock starts after a grace period long enough
   * for the opponent to watch the replay of what just happened.
   */
  private settleClock(now: number, graceMs = 0): void {
    if (!this.clockRunning() || !this.state) return;
    const elapsed = Math.max(0, now - this.row.turn_started_at!);
    if (this.state.turn === 'white') this.row.clock_white_ms -= elapsed;
    else this.row.clock_black_ms -= elapsed;
    this.row.turn_started_at = now + graceMs;
  }

  private replayGrace(): number {
    return Math.min(TURN_GRACE_MAX_MS, TURN_GRACE_BASE_MS + REVEAL_MS_PER_CARD * this.cardsThisTurn);
  }

  /** If the side to move has run out of time, end the game. Returns true if it did. */
  checkTimeout(now = Date.now()): boolean {
    if (!this.clockRunning() || !this.state) return false;
    const c = this.clocks(now);
    const remaining = c[this.state.turn];
    if (remaining > 0) return false;
    this.settleClock(now);
    if (this.state.turn === 'white') this.row.clock_white_ms = 0;
    else this.row.clock_black_ms = 0;
    this.state.status = { kind: 'timeout', winner: opposite(this.state.turn) };
    this.state.events = [{ type: 'gameOver', status: this.state.status }];
    this.state.seq++;
    this.save(now);
    this.broadcastState();
    this.finished();
    return true;
  }

  /** Called whenever the status leaves 'playing'. Rewards are granted exactly once per game. */
  private finished(): void {
    if (this.solo || this.row.rewarded || !this.state || this.state.status.kind === 'playing') return;
    this.row.rewarded = 1;
    this.save(Date.now(), false);
    this.onFinished(this);
  }

  // ------------------------------------------------------------------ seats

  /** Second player takes the open seat with their deck; the game starts. */
  join(userId: string, deck: string[]): Color {
    if (this.state) throw new GameError('That game already has two players.');
    if (this.isParticipant(userId)) throw new GameError("That's your own game — send the code to a friend.");
    const color: Color = this.row.white_user_id ? 'black' : 'white';
    if (color === 'white') {
      this.row.white_user_id = userId;
      this.row.white_deck_json = JSON.stringify(deck);
    } else {
      this.row.black_user_id = userId;
      this.row.black_deck_json = JSON.stringify(deck);
    }
    this.start();
    return color;
  }

  private start(): void {
    const white = this.row.white_deck_json ? (JSON.parse(this.row.white_deck_json) as string[]) : starterDeck();
    const black = this.row.black_deck_json ? (JSON.parse(this.row.black_deck_json) as string[]) : starterDeck();
    this.state = createGame({ decks: { white, black } });
    this.row.turn_started_at = Date.now();
    this.save();
    this.broadcastRoom();
    this.broadcastState();
  }

  info(): RoomInfo {
    const side = (c: Color) => {
      const uid = c === 'white' ? this.row.white_user_id : this.row.black_user_id;
      if (!uid) return null;
      const connected = [...this.watchers].some((w) => w.userId === uid);
      return { name: this.userName(uid), connected };
    };
    return { code: this.row.code, players: { white: side('white'), black: side('black') } };
  }

  // ---------------------------------------------------------------- watchers

  attach(t: Transport): void {
    this.watchers.add(t);
    this.checkTimeout();
    const color = this.colorOf(t.userId)!;
    t.send({ type: 'seated', gameId: this.id, code: this.row.code, color: this.seatOf(t.userId) ?? color, room: this.info(), solo: this.solo, arena: this.arena });
    this.broadcastRoom();
    this.sendState(t);
    t.send({ type: 'chat', messages: this.chat });
  }

  detach(t: Transport): void {
    if (!this.watchers.delete(t)) return;
    this.broadcastRoom();
    if (this.watchers.size === 0) this.onEmpty(this);
  }

  // ---------------------------------------------------------------- actions

  act(t: Transport, action: Action): void {
    if (!this.state) throw new GameError('Waiting for an opponent to join.');
    if (this.checkTimeout()) return;
    const color = this.colorOf(t.userId);
    if (!color) throw new GameError('You are not a player in this game.');
    const now = Date.now();

    if (action.type === 'resign') {
      // Resigning is allowed at any time, even off-turn.
      this.settleClock(now);
      const winner = opposite(this.solo ? this.state.turn : color);
      this.state = { ...this.state, status: { kind: 'resigned', winner }, events: [], seq: this.state.seq + 1 };
      this.state.events.push({ type: 'gameOver', status: this.state.status });
      this.save(now);
      this.broadcastState();
      this.finished();
      return;
    }

    if (this.state.turn !== color) throw new GameError('It is not your turn.');
    const before = this.state.turn;
    let next: GameState;
    try {
      next = applyAction(this.state, action);
    } catch (e) {
      if (e instanceof IllegalActionError) throw new GameError(e.message);
      throw e;
    }
    if (action.type === 'playCard') this.cardsThisTurn++;
    if (next.turn !== before || next.status.kind !== 'playing') {
      this.settleClock(now, next.turn !== before ? this.replayGrace() : 0);
      this.cardsThisTurn = 0;
    }
    this.state = next;
    this.save(now);
    this.broadcastState();
    this.finished();
    if (!this.solo && next.status.kind === 'playing' && next.turn !== before) {
      const nextUser = next.turn === 'white' ? this.row.white_user_id : this.row.black_user_id;
      if (nextUser) this.onYourTurn(this, nextUser);
    }
  }

  /** Testing-arena setup: grant a card, spawn/move/remove a piece, or set mana. */
  arenaOp(t: Transport, op: ArenaOp): void {
    if (!this.arena) throw new GameError('That only works in the testing arena.');
    if (!this.state) throw new GameError('Waiting for an opponent to join.');
    if (!this.isParticipant(t.userId)) throw new GameError('You are not a player in this game.');
    let next: GameState;
    try {
      next = applyArenaOp(this.state, op);
    } catch (e) {
      if (e instanceof IllegalActionError) throw new GameError(e.message);
      throw e;
    }
    this.state = next;
    this.broadcastState();
  }

  chatMessage(t: Transport, rawText: string): void {
    const color = this.seatOf(t.userId);
    if (!color) throw new GameError('You are not a player in this game.');
    const text = rawText.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
    if (!text) return;
    const now = Date.now();
    if (now - (this.lastChatAt.get(t.userId) ?? 0) < CHAT_MIN_INTERVAL_MS) return;
    this.lastChatAt.set(t.userId, now);
    const msg: ChatMessage = { from: color, name: this.userName(t.userId), text, at: now };
    this.chat.push(msg);
    if (this.chat.length > CHAT_HISTORY) this.chat.shift();
    this.save(now, false); // chat does not change the home-page card
    for (const w of this.watchers) w.send({ type: 'chat', messages: [msg] });
    if (!this.solo) {
      const other = color === 'white' ? this.row.black_user_id : this.row.white_user_id;
      if (other) this.onChat(this, t.userId, other, text);
    }
  }

  // ---------------------------------------------------------------- summary

  summaryFor(userId: string, now = Date.now()): GameSummary {
    const seat = this.seatOf(userId) ?? 'white';
    const oppId = seat === 'white' ? this.row.black_user_id : this.row.white_user_id;
    const status = this.state?.status ?? { kind: 'playing' as const };
    const turn = this.state?.turn ?? 'white';
    const invite = this.state ? undefined : this.db.pendingChallengeForGame(this.id);
    return {
      id: this.id,
      code: this.row.code,
      solo: this.solo,
      yourColor: seat,
      yourTurn: !!this.state && status.kind === 'playing' && (this.solo || turn === seat),
      opponentName: this.solo ? null : oppId ? this.userName(oppId) : null,
      waitingForOpponent: !this.state,
      invitedName: invite ? this.userName(invite.to_user) : null,
      status,
      turn,
      clocks: this.clocks(now),
      pieces: this.state ? Object.values(this.state.pieces).map((p) => ({ kind: p.kind, owner: p.owner, square: p.square })) : [],
      updatedAt: this.row.updated_at,
      createdAt: this.row.created_at,
    };
  }

  // -------------------------------------------------------------- internals

  private save(now = Date.now(), notify = true): void {
    this.row.state_json = this.state ? JSON.stringify(this.state) : null;
    this.row.status_kind = this.state ? this.state.status.kind : 'waiting';
    this.row.turn = this.state?.turn ?? 'white';
    this.row.chat_json = JSON.stringify(this.chat);
    this.row.updated_at = now;
    // Practice games live in memory only: nothing is written and the home page is not told.
    if (this.solo) return;
    this.db.updateGame(this.row);
    if (notify) this.onChanged(this);
  }

  private broadcastRoom(): void {
    const msg: ServerMessage = { type: 'room', room: this.info() };
    for (const w of this.watchers) w.send(msg);
  }

  /**
   * The admin changed card/piece numbers: bring pieces on the board in line and
   * resend the view (legal moves, playable cards and mana income are all derived
   * from the definitions, so they need a fresh state even if no piece changed).
   */
  rebalance(): void {
    if (!this.state) return;
    const pruned = pruneUnknownCards(this.state);
    if (rebasePieces(this.state) || pruned) {
      this.state.seq++;
      this.state.events = [];
      this.save(Date.now(), false);
    }
    this.broadcastState();
  }

  private broadcastState(): void {
    for (const w of this.watchers) this.sendState(w);
  }

  private sendState(t: Transport): void {
    if (!this.state) return;
    // Practice follows the side to move; arena stays white-at-bottom; otherwise your seat.
    const color = this.arena ? 'white' : this.solo ? this.state.turn : this.seatOf(t.userId)!;
    t.send({
      type: 'state',
      view: viewFor(this.state, color, this.arena ? { openHands: true, sandbox: true } : undefined),
      clocks: this.clocks(),
    });
  }
}

// ---------------------------------------------------------------------------

export class GameManager {
  private live = new Map<string, LiveGame>();
  /** Fired when a game's home-page summary may have changed (join, move, game over, timeout). */
  onChanged: (game: LiveGame) => void = () => {};
  /** Fired once per two-player game when it reaches a result. */
  onFinished: (game: LiveGame) => void = () => {};
  onYourTurn: (game: LiveGame, userId: string) => void = () => {};
  onChat: (game: LiveGame, fromUserId: string, toUserId: string, text: string) => void = () => {};

  constructor(
    private db: Db,
    private userName: (id: string) => string,
  ) {
    setInterval(() => this.sweep(), 30_000).unref();
  }

  private track(g: LiveGame): LiveGame {
    g.onChanged = (game) => this.onChanged(game);
    g.onFinished = (game) => this.onFinished(game);
    g.onYourTurn = (game, uid) => this.onYourTurn(game, uid);
    g.onChat = (game, from, to, text) => this.onChat(game, from, to, text);
    // A practice game vanishes as soon as its player leaves; it was never on disk.
    g.onEmpty = (game) => {
      if (game.solo) this.live.delete(game.id);
    };
    this.live.set(g.id, g);
    return g;
  }

  get(id: string): LiveGame | undefined {
    let g = this.live.get(id);
    if (!g) {
      const row = this.db.gameById(id);
      if (!row) return undefined;
      g = this.track(new LiveGame(row, this.db, this.userName));
    }
    return g;
  }

  byCode(code: string): LiveGame | undefined {
    const row = this.db.gameByCode(code.trim().toUpperCase());
    return row ? this.get(row.id) : undefined;
  }

  create(userId: string, solo: boolean, deck: string[], opts?: { arena?: boolean }): LiveGame {
    let code = randomCode();
    while (this.db.codeExists(code)) code = randomCode();
    const now = Date.now();
    const creatorIsWhite = solo || Math.random() < 0.5;
    const deckJson = JSON.stringify(deck);
    const row: GameRow = {
      id: newId(),
      code,
      solo: solo ? 1 : 0,
      white_user_id: solo || creatorIsWhite ? userId : null,
      black_user_id: solo || !creatorIsWhite ? userId : null,
      state_json: null,
      status_kind: 'waiting',
      turn: 'white',
      clock_white_ms: TURN_CLOCK_MS,
      clock_black_ms: TURN_CLOCK_MS,
      turn_started_at: null,
      chat_json: '[]',
      white_deck_json: solo || creatorIsWhite ? deckJson : null,
      black_deck_json: solo || !creatorIsWhite ? deckJson : null,
      rewarded: 0,
      created_at: now,
      updated_at: now,
    };
    if (solo) {
      // Practice / arena: both seats are the same user, starts immediately, memory only —
      // never saved, never listed, no rewards, gone when the player leaves.
      const game = this.track(new LiveGame(row, this.db, this.userName));
      game.arena = !!opts?.arena;
      game.state = game.arena
        ? createArenaGame()
        : createGame({ decks: { white: deck, black: deck.slice() } });
      row.turn_started_at = now;
      row.status_kind = 'playing';
      return game;
    }
    this.db.insertGame(row);
    return this.track(new LiveGame(row, this.db, this.userName));
  }

  /** An account was deleted: vacate its seats in games held in memory so a later save does not resurrect it. */
  forgetUser(userId: string): void {
    for (const [id, g] of this.live) {
      let touched = false;
      if (g.row.white_user_id === userId) {
        g.row.white_user_id = null;
        touched = true;
      }
      if (g.row.black_user_id === userId) {
        g.row.black_user_id = null;
        touched = true;
      }
      if (!touched) continue;
      if (!g.row.white_user_id && !g.row.black_user_id) this.live.delete(id);
    }
  }

  /** After a balance change: update every game in memory and resend its state. */
  rebalanceAll(): void {
    for (const g of this.live.values()) g.rebalance();
  }

  /**
   * Graceful shutdown (deploy/restart): practice games live only in memory and will
   * not survive, so send their players home with a note rather than leaving them
   * on a board that silently stops responding. Persistent games resume on reconnect.
   */
  shutdown(): void {
    for (const g of this.live.values()) {
      if (!g.solo) continue;
      for (const t of g.watchersList()) {
        t.send({ type: 'notice', message: 'The server is restarting for an update — practice games end here. Start a new one in a moment.' });
        g.detach(t);
        t.send({ type: 'left' });
      }
    }
  }

  /** Remove a game nobody has started playing (declined/cancelled challenge). Anyone viewing it is sent home. */
  discardUnstarted(gameId: string): void {
    const g = this.get(gameId);
    if (!g || g.state) return;
    for (const t of g.watchersList()) {
      g.detach(t);
      t.send({ type: 'left' });
    }
    this.live.delete(gameId);
    this.db.deleteGame(gameId);
    this.onChanged(g);
  }

  summariesFor(userId: string): GameSummary[] {
    const now = Date.now();
    return this.db
      .gamesForUser(userId)
      .filter((row) => !row.solo) // practice games from before they became memory-only
      .map((row) => {
        const g = this.get(row.id)!;
        g.checkTimeout(now);
        return g.summaryFor(userId, now);
      });
  }

  /** Periodic: end games whose side to move has run out of clock, and drop idle games from memory. */
  private sweep(): void {
    const now = Date.now();
    for (const row of this.db.runningGames()) {
      const g = this.get(row.id);
      g?.checkTimeout(now);
    }
    for (const [id, g] of this.live) {
      if (!g.hasWatchers && now - g.row.updated_at > 10 * 60_000) this.live.delete(id);
    }
  }
}
