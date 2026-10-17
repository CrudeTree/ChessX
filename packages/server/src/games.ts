// Persistent games. Each game lives in SQLite and, while anyone has it open,
// as a `LiveGame` in memory. Players are identified by account, not by
// connection, so any number of tabs can be attached and a player may be in
// many games at once.

import {
  applyAction,
  createGame,
  IllegalActionError,
  opposite,
  pruneUnknownCards,
  rebasePieces,
  starterDeck,
  v2,
  viewFor,
  type Action,
  type Color,
  type GameState,
  type GameStatus,
} from '@chessx/engine';
import {
  isKlipyMediaUrl,
  TURN_CLOCK_MS,
  type ChatGif,
  type ChatMessage,
  type Clocks,
  type GameSummary,
  type RoomInfo,
  type ServerMessage,
} from '@chessx/protocol';
import { randomBytes } from 'node:crypto';
import { inlineThinker, type BotThinker } from './bot.js';
import { newId, parseChat, parseRecord, parseState, type Db, type GameRow } from './db.js';

export interface Transport {
  readonly userId: string;
  send(msg: ServerMessage): void;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHAT_HISTORY = 100;
const CHAT_MAX_LEN = 240;
const CHAT_MIN_INTERVAL_MS = 400;
const GIF_URL_MAX_LEN = 600;
const GIF_TITLE_MAX_LEN = 120;
const GIF_MAX_SIDE = 4096;

export class GameError extends Error {}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Whitespace runs collapsed, then cut to `max` UTF-16 units without splitting an emoji or accented letter. */
export function clipText(raw: string, max: number): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  let out = '';
  for (const { segment } of graphemes.segment(text)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out.trimEnd();
}

/** A GIF from a chat message, or null when there is none. Anything that is not a KLIPY GIF is refused. */
export function parseChatGif(raw: unknown): ChatGif | null {
  if (raw === undefined || raw === null) return null;
  const g = raw as Partial<Record<keyof ChatGif, unknown>>;
  const side = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= GIF_MAX_SIDE;
  if (typeof raw !== 'object' || typeof g.url !== 'string' || g.url.length > GIF_URL_MAX_LEN || !isKlipyMediaUrl(g.url) || !side(g.width) || !side(g.height)) {
    throw new GameError('That GIF cannot be sent.');
  }
  return { url: g.url, width: g.width, height: g.height, title: typeof g.title === 'string' ? clipText(g.title, GIF_TITLE_MAX_LEN) : '' };
}

/** A fresh rules-2 game. Every game uses the starter deck for now: v2 deck building waits for the real cards. */
function newRecord(): v2.GameRecord {
  const seed = randomBytes(4).readInt32LE();
  return v2.newRecord(v2.newGame({ seed, decks: { white: v2.starterDeck(), black: v2.starterDeck() } }));
}

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

/** The least time from the start of the bot's turn to its first play, so it does not land on top of your move. */
const BOT_THINK_MS = 900;
/** The bot's pause after each kind of play, long enough to watch it land (a spell's reveal is the longest). */
const BOT_PAUSE_MS: Partial<Record<v2.Action['type'], number>> = { spell: 1500, summon: 1200, seal: 1200, evolve: 1300, pitch: 900, lava: 1000 };
/** Plans asked for in one bot turn before it plays any legal action to keep the game going. */
const BOT_MAX_PLANS = 8;
/** How many steps the arena's Undo goes back. */
const ARENA_UNDO_STEPS = 100;

export interface BotSeat {
  color: Color;
  level: v2.BotLevel;
}

export class LiveGame {
  /** State of a rules-1 game (the original 8x8 rules). Null for rules-2 games and before a game starts. */
  state: GameState | null;
  /** State of a rules-2 game. Null for rules-1 games and before a game starts. */
  record: v2.GameRecord | null;
  chat: ChatMessage[];
  private watchers = new Set<Transport>();
  private lastChatAt = new Map<string, number>();
  /** Cards played during the current turn (drives the opponent's clock grace). */
  private cardsThisTurn = 0;
  /** The arena: a sandbox where any card can be placed or given (`arenaOp`), played from both sides like practice. */
  arena = false;
  /** The arena's earlier positions, oldest first, for Undo. */
  private arenaPast: v2.GameState[] = [];
  /** The game after each of its steps, from the start, as far as players have looked back (`sendPast`). */
  private replayed: { start: object; states: v2.GameState[] } | null = null;
  /** The computer's seat, in a game against the bot. Such a game is memory only, like practice. */
  bot: BotSeat | null = null;
  /** Plans the bot's turns. */
  thinker: BotThinker = inlineThinker;
  /** Waits between the bot's plays. */
  botPause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  private botPlaying = false;
  private disposed = false;

  /** Fired after anything that changes how the game appears on the home page. */
  onChanged: (game: LiveGame) => void = () => {};
  /** Fired once when a two-player game reaches a final result (rewards are handed out here). */
  onFinished: (game: LiveGame) => void = () => {};
  /** Fired when the turn passes to `userId` in a two-player game. */
  onYourTurn: (game: LiveGame, userId: string) => void = () => {};
  /** Fired when the last viewer detaches (practice games are discarded then). */
  onEmpty: (game: LiveGame) => void = () => {};
  /** Fired when a chat line is posted; `toUserId` is the other seat. */
  onChat: (game: LiveGame, fromUserId: string, toUserId: string, msg: ChatMessage) => void = () => {};

  constructor(
    public row: GameRow,
    private db: Db,
    private userName: (id: string) => string,
  ) {
    this.state = parseState(row);
    this.record = parseRecord(row);
    // A game begun before steps were kept gets them worked out again where it can, to be looked back through too.
    if (this.record && !this.record.steps) this.record = v2.rebuildSteps(this.record, { white: v2.starterDeck(), black: v2.starterDeck() }) ?? this.record;
    this.chat = parseChat(row);
  }

  /** Which rules this game is played under. Fixed when the game is created. */
  get rules(): 1 | 2 {
    return this.row.rules_version === 2 ? 2 : 1;
  }

  /** Both seats are filled and the game has begun. */
  get started(): boolean {
    return !!(this.state || this.record);
  }

  /** The side to move (the side deploying, during v2 setup). */
  private turnColor(): Color {
    return this.record?.state.active ?? this.state?.turn ?? 'white';
  }

  /** Where the game stands, under either set of rules. */
  status(): GameStatus {
    return this.record?.state.status ?? this.state?.status ?? { kind: 'playing' };
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

  /** Practice and bot games: never saved, no clocks, no rewards. */
  get memoryOnly(): boolean {
    return this.solo || this.bot !== null;
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
    if (this.solo) return this.isParticipant(userId) ? this.turnColor() : null;
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

  /** Clocks only run in a started, unfinished game between two people. */
  private clockRunning(): boolean {
    return this.started && this.status().kind === 'playing' && !this.memoryOnly && this.row.turn_started_at !== null;
  }

  clocks(now = Date.now()): Clocks {
    const running = this.clockRunning();
    const turn = this.turnColor();
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
    if (!this.clockRunning()) return;
    const elapsed = Math.max(0, now - this.row.turn_started_at!);
    if (this.turnColor() === 'white') this.row.clock_white_ms -= elapsed;
    else this.row.clock_black_ms -= elapsed;
    this.row.turn_started_at = now + graceMs;
  }

  private replayGrace(): number {
    return Math.min(TURN_GRACE_MAX_MS, TURN_GRACE_BASE_MS + REVEAL_MS_PER_CARD * this.cardsThisTurn);
  }

  /** If the side to move has run out of time, end the game. Returns true if it did. */
  checkTimeout(now = Date.now()): boolean {
    if (!this.clockRunning()) return false;
    const mover = this.turnColor();
    const c = this.clocks(now);
    const remaining = c[mover];
    if (remaining > 0) return false;
    this.settleClock(now);
    if (mover === 'white') this.row.clock_white_ms = 0;
    else this.row.clock_black_ms = 0;
    const status: GameStatus = { kind: 'timeout', winner: opposite(mover) };
    if (this.record) {
      this.record = v2.nextRecord(this.record, { ...this.record.state, status }, [{ type: 'gameOver', status }], { type: 'end', status });
    } else if (this.state) {
      this.state.status = status;
      this.state.events = [{ type: 'gameOver', status }];
      this.state.seq++;
    }
    this.save(now);
    this.broadcastState();
    this.finished();
    return true;
  }

  /** Called whenever the status leaves 'playing'. Rewards are granted exactly once per game. */
  private finished(): void {
    if (this.memoryOnly || this.row.rewarded || !this.started || this.status().kind === 'playing') return;
    this.row.rewarded = 1;
    this.save(Date.now(), false);
    this.onFinished(this);
  }

  // ------------------------------------------------------------------ seats

  /** Second player takes the open seat with their deck; the game starts. */
  join(userId: string, deck: string[]): Color {
    if (this.started) throw new GameError('That game already has two players.');
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
    if (this.rules === 2) {
      this.record = newRecord();
    } else {
      const white = this.row.white_deck_json ? (JSON.parse(this.row.white_deck_json) as string[]) : starterDeck();
      const black = this.row.black_deck_json ? (JSON.parse(this.row.black_deck_json) as string[]) : starterDeck();
      this.state = createGame({ decks: { white, black } });
    }
    this.row.turn_started_at = Date.now();
    this.save();
    this.broadcastRoom();
    this.broadcastState();
  }

  info(): RoomInfo {
    const side = (c: Color) => {
      if (this.bot?.color === c) return { name: v2.BOT_NAMES[this.bot.level], connected: true };
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
    t.send({
      type: 'seated',
      gameId: this.id,
      code: this.row.code,
      color: this.seatOf(t.userId) ?? color,
      room: this.info(),
      solo: this.solo,
      arena: this.arena,
      ...(this.bot ? { bot: this.bot.level } : {}),
      rules: this.rules,
    });
    this.broadcastRoom();
    this.sendState(t, true);
    t.send({ type: 'chat', messages: this.chat });
  }

  detach(t: Transport): void {
    if (!this.watchers.delete(t)) return;
    this.broadcastRoom();
    if (this.watchers.size === 0) this.onEmpty(this);
  }

  // ---------------------------------------------------------------- actions

  /** An action in a rules-2 game (or a resignation, which is always allowed). */
  actV2(t: Transport, action: v2.Action | { type: 'resign' }): void {
    const record = this.record;
    if (!record) throw new GameError(this.rules === 2 ? 'Waiting for an opponent to join.' : 'That game is played under the original rules.');
    if (this.checkTimeout()) return;
    const color = this.colorOf(t.userId);
    if (!color) throw new GameError('You are not a player in this game.');
    const now = Date.now();
    const current = this.record!;

    if (action.type === 'resign') {
      if (current.state.status.kind !== 'playing') return;
      this.settleClock(now);
      const status: GameStatus = { kind: 'resigned', winner: opposite(this.solo ? current.state.active : color) };
      this.record = v2.nextRecord(current, { ...current.state, status }, [{ type: 'gameOver', status }], { type: 'end', status });
      this.save(now);
      this.broadcastState();
      this.finished();
      return;
    }

    if (current.state.status.kind !== 'playing') throw new GameError('The game is over.');
    if (current.state.active !== color) throw new GameError('It is not your turn.');
    this.playV2(action, now);
  }

  /** Plays an action for the side to move and tells everyone; the bot takes its turn if it is next. */
  private playV2(action: v2.Action, now: number): void {
    const current = this.record!;
    const before = current.state.active;
    let result: v2.ApplyResult;
    // The engine ends the turn with the move itself, or End turn when no move is left; cards keep it open.
    try {
      result = v2.applyLegalAction(current.state, action);
    } catch {
      throw new GameError('That is not a legal action.');
    }
    const next = result.state;
    if (action.type !== 'move' && action.type !== 'endTurn' && action.type !== 'deploy') this.cardsThisTurn++;
    if (next.active !== before || next.status.kind !== 'playing') {
      this.settleClock(now, next.active !== before ? this.replayGrace() : 0);
      this.cardsThisTurn = 0;
    }
    if (this.arena) this.rememberArena(current.state);
    this.record = v2.nextRecord(current, next, result.events, result.action);
    this.save(now);
    this.broadcastState();
    this.finished();
    if (!this.memoryOnly && next.status.kind === 'playing' && next.active !== before) {
      const nextUser = next.active === 'white' ? this.row.white_user_id : this.row.black_user_id;
      if (nextUser) this.onYourTurn(this, nextUser);
    }
    this.wakeBot();
  }

  // -------------------------------------------------------------------- bot

  private botToMove(): boolean {
    const state = this.record?.state;
    return !!this.bot && !this.disposed && state?.status.kind === 'playing' && state.active === this.bot.color;
  }

  /** Starts the bot's turn if it is the bot's move and it is not playing already. */
  wakeBot(): void {
    if (this.botPlaying || !this.botToMove()) return;
    this.botPlaying = true;
    void this.playBotTurn(this.bot!)
      .catch((error) => console.error(`[game ${this.row.code}] the bot's turn failed`, error))
      .finally(() => {
        this.botPlaying = false;
      });
  }

  /** The bot's whole turn at a pace you can watch. A plan that runs out, or stops being legal, is made again. */
  private async playBotTurn(bot: BotSeat): Promise<void> {
    const startedAt = Date.now();
    let lastPlay: v2.Action['type'] | null = null;
    const pause = (): Promise<void> =>
      this.botPause(lastPlay ? (BOT_PAUSE_MS[lastPlay] ?? 0) : Math.max(0, BOT_THINK_MS - (Date.now() - startedAt)));
    for (let round = 0; round < BOT_MAX_PLANS && this.botToMove(); round++) {
      let plan: v2.Action[] = [];
      try {
        plan = await this.thinker.plan(this.record!.state, bot.level, randomBytes(4).readInt32LE());
      } catch (error) {
        console.error(`[game ${this.row.code}] the bot could not plan`, error);
      }
      for (const action of plan) {
        await pause();
        if (!this.botToMove()) return;
        try {
          this.playV2(action, Date.now());
        } catch {
          break;
        }
        lastPlay = action.type;
        if (!this.botToMove()) return;
      }
    }
    // The planner never finished the turn: any legal play keeps the game going, a move first.
    while (this.botToMove()) {
      const options = v2.legalActions(this.record!.state);
      const fallback = options.find((a) => a.type === 'move' || a.type === 'endTurn') ?? options[0];
      if (!fallback) return;
      await pause();
      if (!this.botToMove()) return;
      this.playV2(fallback, Date.now());
      lastPlay = fallback.type;
    }
  }

  /** The game was dropped from memory: the bot stops. */
  dispose(): void {
    this.disposed = true;
  }

  act(t: Transport, action: Action): void {
    if (this.rules === 2) throw new GameError('That game is played under the new rules.');
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

  /** An arena edit (`v2.applyArenaEdit`), Undo or Reset. `raw` comes straight off the socket. */
  arenaOp(t: Transport, raw: unknown): void {
    const current = this.record;
    if (!this.arena || !current) throw new GameError('That only works in the arena.');
    if (!this.isParticipant(t.userId)) throw new GameError('You are not a player in this game.');
    let next: v2.ApplyResult;
    try {
      const op = v2.parseArenaOp(raw);
      if (op.type === 'undo') {
        const back = this.arenaPast.pop();
        if (!back) return;
        next = { state: back, events: [] };
      } else {
        next = op.type === 'reset' ? { state: v2.newArena(randomBytes(4).readInt32LE()), events: [] } : v2.applyArenaEdit(current.state, op);
        this.rememberArena(current.state);
      }
    } catch (e) {
      if (e instanceof v2.ArenaError) throw new GameError(e.message);
      throw e;
    }
    this.record = { state: next.state, seq: current.seq + 1, events: next.events };
    this.save();
    this.broadcastState();
  }

  private rememberArena(state: v2.GameState): void {
    this.arenaPast.push(state);
    if (this.arenaPast.length > ARENA_UNDO_STEPS) this.arenaPast.shift();
  }

  /** A chat line: text, a GIF, or both. `rawGif` comes straight off the socket. */
  chatMessage(t: Transport, rawText: string, rawGif?: unknown): void {
    const color = this.seatOf(t.userId);
    if (!color) throw new GameError('You are not a player in this game.');
    const text = clipText(rawText, CHAT_MAX_LEN);
    const gif = parseChatGif(rawGif);
    if (!text && !gif) return;
    const now = Date.now();
    if (now - (this.lastChatAt.get(t.userId) ?? 0) < CHAT_MIN_INTERVAL_MS) return;
    this.lastChatAt.set(t.userId, now);
    const msg: ChatMessage = { from: color, name: this.userName(t.userId), text, ...(gif ? { gif } : {}), at: now };
    this.chat.push(msg);
    if (this.chat.length > CHAT_HISTORY) this.chat.shift();
    this.save(now, false); // chat does not change the home-page card
    for (const w of this.watchers) w.send({ type: 'chat', messages: [msg] });
    if (!this.solo) {
      const other = color === 'white' ? this.row.black_user_id : this.row.white_user_id;
      if (other) this.onChat(this, t.userId, other, msg);
    }
  }

  // ---------------------------------------------------------------- summary

  summaryFor(userId: string, now = Date.now()): GameSummary {
    const seat = this.seatOf(userId) ?? 'white';
    const oppId = seat === 'white' ? this.row.black_user_id : this.row.white_user_id;
    const status = this.status();
    const turn = this.turnColor();
    const invite = this.started ? undefined : this.db.pendingChallengeForGame(this.id);
    return {
      id: this.id,
      code: this.row.code,
      rules: this.rules,
      solo: this.solo,
      yourColor: seat,
      yourTurn: this.started && status.kind === 'playing' && (this.solo || turn === seat),
      opponentName: this.solo ? null : oppId ? this.userName(oppId) : null,
      waitingForOpponent: !this.started,
      invitedName: invite ? this.userName(invite.to_user) : null,
      status,
      turn,
      clocks: this.clocks(now),
      pieces: this.record
        ? [
            ...this.record.state.pieces.map((p) => ({ kind: p.def.kind, owner: p.owner, square: p.square })),
            ...this.record.state.seals.map((s) => ({ kind: 'seal', owner: s.owner, square: s.square })),
          ]
        : this.state
          ? Object.values(this.state.pieces).map((p) => ({ kind: p.kind, owner: p.owner, square: p.square }))
          : [],
      updatedAt: this.row.updated_at,
      createdAt: this.row.created_at,
    };
  }

  // -------------------------------------------------------------- internals

  private save(now = Date.now(), notify = true): void {
    this.row.state_json = this.record ? JSON.stringify(this.record) : this.state ? JSON.stringify(this.state) : null;
    this.row.status_kind = this.started ? this.status().kind : 'waiting';
    this.row.turn = this.turnColor();
    this.row.chat_json = JSON.stringify(this.chat);
    this.row.updated_at = now;
    // Practice and bot games live in memory only: nothing is written and the home page is not told.
    if (this.memoryOnly) return;
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

  /** `history`: a player opening the game gets every event so far, to show the whole log. */
  private sendState(t: Transport, history = false): void {
    if (this.record) {
      // Practice follows the side to move (the view's own hotseat mode); otherwise your seat.
      const seat = this.seatOf(t.userId) ?? 'white';
      t.send({ type: 'stateV2', view: v2.viewFor(this.record, seat, { hotseat: this.solo, history }), clocks: this.clocks() });
      return;
    }
    if (!this.state) return;
    // Practice follows the side to move; otherwise your seat.
    const color = this.solo ? this.state.turn : this.seatOf(t.userId)!;
    t.send({ type: 'state', view: viewFor(this.state, color), clocks: this.clocks() });
  }

  /** A player looking back: the game as it stood after `rawStep` steps, as they saw it then. */
  sendPast(t: Transport, rawStep: unknown): void {
    const record = this.record;
    if (!record?.start || this.arena) return;
    const seat = this.seatOf(t.userId);
    if (!seat) throw new GameError('You are not a player in this game.');
    if (this.replayed?.start !== record.start) this.replayed = { start: record.start, states: [] };
    const step = Number(rawStep);
    const view = v2.viewAt(record, step, seat, this.solo, this.replayed.states);
    if (view) t.send({ type: 'pastV2', step, view });
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
  onChat: (game: LiveGame, fromUserId: string, toUserId: string, msg: ChatMessage) => void = () => {};
  /** Plans the bot's turns in every bot game. */
  thinker: BotThinker = inlineThinker;
  /** Waits between the bot's plays; undefined keeps each game's real-time pause. */
  botPause: ((ms: number) => Promise<void>) | undefined;

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
    g.onChat = (game, from, to, msg) => this.onChat(game, from, to, msg);
    // A practice game vanishes as soon as its player leaves; it was never on disk. The arena stays a while, like a bot game.
    g.onEmpty = (game) => {
      if (game.solo && !game.arena) this.live.delete(game.id);
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

  create(userId: string, solo: boolean, deck: string[]): LiveGame {
    let code = randomCode();
    while (this.db.codeExists(code)) code = randomCode();
    const now = Date.now();
    const creatorIsWhite = solo || Math.random() < 0.5;
    const deckJson = JSON.stringify(deck);
    // Live play is v2. v1 is deprecated: only games already saved under the original rules still use it.
    const row: GameRow = {
      id: newId(),
      code,
      rules_version: 2,
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
      // Practice: both seats are the same user, starts immediately, memory only —
      // never saved, never listed, no rewards, gone when the player leaves.
      const game = this.track(new LiveGame(row, this.db, this.userName));
      game.record = newRecord();
      row.turn_started_at = now;
      row.status_kind = 'playing';
      return game;
    }
    this.db.insertGame(row);
    return this.track(new LiveGame(row, this.db, this.userName));
  }

  /**
   * A game against the bot, which starts at once (with the bot's first turn if it plays White). Memory only, like
   * practice: no clock, no rewards, and nobody can join it by code. It stays in memory a while after you leave, so a
   * reload picks it up again.
   */
  createBot(userId: string, level: v2.BotLevel, side: Color | 'random'): LiveGame {
    this.dropLeft(userId, (g) => g.bot !== null);
    const now = Date.now();
    const color: Color = side === 'random' ? (randomBytes(1)[0]! < 128 ? 'white' : 'black') : side;
    const row: GameRow = {
      id: newId(),
      code: randomCode(),
      rules_version: 2,
      solo: 0,
      white_user_id: color === 'white' ? userId : null,
      black_user_id: color === 'black' ? userId : null,
      state_json: null,
      status_kind: 'playing',
      turn: 'white',
      clock_white_ms: TURN_CLOCK_MS,
      clock_black_ms: TURN_CLOCK_MS,
      turn_started_at: now,
      chat_json: '[]',
      white_deck_json: null,
      black_deck_json: null,
      rewarded: 0,
      created_at: now,
      updated_at: now,
    };
    const game = this.track(new LiveGame(row, this.db, this.userName));
    game.bot = { color: opposite(color), level };
    game.thinker = this.thinker;
    if (this.botPause) game.botPause = this.botPause;
    game.record = newRecord();
    game.wakeBot();
    return game;
  }

  /**
   * The arena: a sandbox where any card can be placed or given, played from both sides. Memory only, like practice,
   * but it stays a while after you leave, like a bot game, so a reload picks it up again.
   */
  createArena(userId: string): LiveGame {
    this.dropLeft(userId, (g) => g.arena);
    const now = Date.now();
    const row: GameRow = {
      id: newId(),
      code: randomCode(),
      rules_version: 2,
      solo: 1,
      white_user_id: userId,
      black_user_id: userId,
      state_json: null,
      status_kind: 'playing',
      turn: 'white',
      clock_white_ms: TURN_CLOCK_MS,
      clock_black_ms: TURN_CLOCK_MS,
      turn_started_at: now,
      chat_json: '[]',
      white_deck_json: null,
      black_deck_json: null,
      rewarded: 0,
      created_at: now,
      updated_at: now,
    };
    const game = this.track(new LiveGame(row, this.db, this.userName));
    game.arena = true;
    game.record = { state: v2.newArena(randomBytes(4).readInt32LE()), seq: 1, events: [] };
    return game;
  }

  /** Drops `userId`'s games of a kind that nobody has open when they start another, so they cannot pile up. */
  private dropLeft(userId: string, kind: (g: LiveGame) => boolean): void {
    for (const [id, g] of this.live) {
      if (!kind(g) || g.hasWatchers || !g.isParticipant(userId)) continue;
      g.dispose();
      this.live.delete(id);
    }
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
      if (!g.row.white_user_id && !g.row.black_user_id) {
        g.dispose();
        this.live.delete(id);
      }
    }
  }

  /** After a balance change: update every game in memory and resend its state. */
  rebalanceAll(): void {
    for (const g of this.live.values()) g.rebalance();
  }

  /**
   * Graceful shutdown (deploy/restart): practice and bot games live only in memory and will
   * not survive, so send their players home with a note rather than leaving them
   * on a board that silently stops responding. Persistent games resume on reconnect.
   */
  shutdown(): void {
    for (const g of this.live.values()) {
      if (!g.memoryOnly) continue;
      g.dispose();
      for (const t of g.watchersList()) {
        t.send({ type: 'notice', message: 'The server is restarting for an update — practice, bot and arena games end here. Start a new one in a moment.' });
        g.detach(t);
        t.send({ type: 'left' });
      }
    }
  }

  /** Remove a game nobody has started playing (declined/cancelled challenge). Anyone viewing it is sent home. */
  discardUnstarted(gameId: string): void {
    const g = this.get(gameId);
    if (!g || g.started) return;
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
      if (g.hasWatchers || now - g.row.updated_at <= 10 * 60_000) continue;
      g.dispose();
      this.live.delete(id);
    }
  }
}
