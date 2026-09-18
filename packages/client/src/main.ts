import { DEFAULT_RULES, getCardDef, type Color, type PlayerView } from '@chessx/engine';
import {
  levelFor,
  xpForLevel,
  type ChatMessage,
  type Clocks,
  type GameSummary,
  type Profile,
  type RewardReport,
  type RoomInfo,
  type ServerMessage,
  type UserInfo,
} from '@chessx/protocol';
import { Binder, cardElement } from './binder.js';
import { GameView } from './game/GameView.js';
import { InspectPanel } from './inspect.js';
import { describeEvents } from './log.js';
import { ApiError, authApi, Net, openGameId, profileApi, rememberOpenGame } from './net.js';
import { colorName, drawThumbnail } from './thumbnail.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// Screens
const authScreen = $('auth');
const homeScreen = $('home');
const binderScreen = $('binder');
const gameScreen = $('game');
const chatEl = $('chat');

type Screen = 'auth' | 'home' | 'binder' | 'game';
function show(screen: Screen): void {
  authScreen.classList.toggle('hidden', screen !== 'auth');
  homeScreen.classList.toggle('hidden', screen !== 'home');
  binderScreen.classList.toggle('hidden', screen !== 'binder');
  gameScreen.classList.toggle('hidden', screen !== 'game');
  chatEl.classList.toggle('hidden', screen !== 'game');
}

// ---------------------------------------------------------------------------
// State

const net = new Net();
const gameView = new GameView();
let user: UserInfo | null = null;
let you: Color | null = null;
let room: RoomInfo | null = null;
let solo = false;
let currentGameId: string | null = null;
let currentView: PlayerView | null = null;
let currentClocks: Clocks | null = null;
let lastSeq = -1;
let viewReady = false;
let games: GameSummary[] = [];
let profile: Profile | null = null;

const inspect = new InspectPanel({
  gameView,
  solo: () => solo,
  names: () => names(),
  view: () => currentView,
});

// ---------------------------------------------------------------------------
// Auth screen

const authForm = $<HTMLFormElement>('auth-form');
const emailInput = $<HTMLInputElement>('email');
const passwordInput = $<HTMLInputElement>('password');
const regNameInput = $<HTMLInputElement>('reg-name');
const nameRow = $('name-row');
const authSubmit = $<HTMLButtonElement>('auth-submit');
const authSwitch = $('auth-switch');
const authSwitchText = $('auth-switch-text');
const authError = $('auth-error');
const connLabel = $('conn');
let registering = false;

function setRegistering(on: boolean): void {
  registering = on;
  nameRow.classList.toggle('hidden', !on);
  regNameInput.required = on;
  authSubmit.textContent = on ? 'Create account' : 'Sign in';
  authSwitchText.textContent = on ? 'Already have an account?' : 'New here?';
  authSwitch.textContent = on ? 'Sign in' : 'Create an account';
  passwordInput.autocomplete = on ? 'new-password' : 'current-password';
  authError.textContent = '';
}

authSwitch.onclick = (e) => {
  e.preventDefault();
  setRegistering(!registering);
};

authForm.onsubmit = async (e) => {
  e.preventDefault();
  authError.textContent = '';
  authSubmit.disabled = true;
  try {
    const u = registering
      ? await authApi.register(emailInput.value, regNameInput.value, passwordInput.value)
      : await authApi.login(emailInput.value, passwordInput.value);
    passwordInput.value = '';
    await signedIn(u);
  } catch (err) {
    authError.textContent = err instanceof ApiError ? err.message : 'Something went wrong.';
  } finally {
    authSubmit.disabled = false;
  }
};

async function showAuth(): Promise<void> {
  const providers = await authApi.providers();
  $('google').classList.toggle('hidden', !providers.google);
  $('facebook').classList.toggle('hidden', !providers.facebook);
  $('providers-or').classList.toggle('hidden', !providers.google && !providers.facebook);
  const authErr = new URLSearchParams(location.search).get('authError');
  if (authErr) {
    authError.textContent = authErr;
    history.replaceState(null, '', '/');
  }
  connLabel.textContent = '';
  show('auth');
}

async function signedIn(u: UserInfo): Promise<void> {
  user = u;
  $('me-name').textContent = u.name;
  const avatar = $<HTMLImageElement>('avatar');
  avatar.classList.toggle('hidden', !u.avatarUrl);
  if (u.avatarUrl) avatar.src = u.avatarUrl;
  show('home');
  await refreshProfile();
  net.connect();
}

// ---------------------------------------------------------------------------
// Profile: level, XP, decks, binder

const deckSelect = $<HTMLSelectElement>('deck-select');

async function refreshProfile(): Promise<void> {
  try {
    setProfile(await profileApi.get());
  } catch {
    /* not signed in */
  }
}

function setProfile(p: Profile): void {
  profile = p;
  const level = levelFor(p.xp);
  const from = xpForLevel(level);
  const to = xpForLevel(level + 1);
  $('level-badge').textContent = `Lv ${level}`;
  $('xp-fill').style.width = `${Math.round(((p.xp - from) / (to - from)) * 100)}%`;
  $('xp-text').textContent = `${p.xp - from} / ${to - from} XP`;

  const fresh = p.collection.filter((c) => c.isNew).length;
  const pill = $('binder-new');
  pill.classList.toggle('hidden', fresh === 0);
  pill.textContent = `${fresh} new`;

  // Deck picker: only decks that are legal to play are selectable.
  const prev = deckSelect.value;
  deckSelect.innerHTML = '';
  for (const d of p.decks) {
    const opt = document.createElement('option');
    const ok = d.cards.length >= DEFAULT_RULES.deckMin && d.cards.length <= DEFAULT_RULES.deckMax;
    opt.value = String(d.slot);
    opt.textContent = ok ? `${d.name} (${d.cards.length})` : `${d.name} — ${d.cards.length ? 'incomplete' : 'empty'}`;
    opt.disabled = !ok;
    deckSelect.appendChild(opt);
  }
  const firstOk = p.decks.find((d) => d.cards.length >= DEFAULT_RULES.deckMin && d.cards.length <= DEFAULT_RULES.deckMax);
  deckSelect.value = [...deckSelect.options].some((o) => o.value === prev && !o.disabled) ? prev : String(firstOk?.slot ?? 1);
}

function chosenDeckSlot(): number | null {
  const opt = deckSelect.selectedOptions[0];
  if (!opt || opt.disabled) {
    homeError.textContent = 'Pick a deck with at least 25 cards first (build one in the Binder).';
    return null;
  }
  return Number(opt.value);
}

const binder = new Binder(() => {
  show('home');
  net.send({ type: 'listGames' });
});
binder.onProfileChanged = (p) => setProfile(p);

$('open-binder').onclick = async () => {
  await refreshProfile();
  if (!profile) return;
  show('binder');
  binder.open(profile);
};

// Reward popup
const rewardEl = $('reward');
$('reward-close').onclick = () => rewardEl.classList.add('hidden');

function showRewards(r: RewardReport): void {
  $('reward-title').textContent =
    r.reason === 'firstMatch' ? 'First match complete!' : r.leveledUp ? `Level ${r.level}!` : r.cards.length ? 'Victory spoils!' : 'Match complete';
  const parts = [`+${r.xpGained} XP`];
  if (r.leveledUp) parts.push(`you reached level ${r.level}`);
  if (r.reason === 'firstMatch') parts.push("here's a taste of what's out there — win by checkmate to unlock more");
  $('reward-xp').textContent = parts.join(' · ');
  const wrap = $('reward-cards');
  wrap.innerHTML = '';
  for (const c of r.cards) {
    const el = cardElement(getCardDef(c.cardId), { isNew: c.brandNew });
    if (!c.brandNew) {
      const tag = document.createElement('span');
      tag.className = 'count';
      tag.textContent = '+1 copy';
      el.appendChild(tag);
    }
    wrap.appendChild(el);
  }
  rewardEl.classList.remove('hidden');
  void refreshProfile();
}

$('logout').onclick = async () => {
  net.close();
  await authApi.logout();
  user = null;
  rememberOpenGame(null);
  leaveGameUi();
  await showAuth();
};

// ---------------------------------------------------------------------------
// Home screen

const homeError = $('home-error');

$('new-game').onclick = () => {
  const deckSlot = chosenDeckSlot();
  if (deckSlot !== null) net.send({ type: 'createGame', deckSlot });
};
$('practice').onclick = () => {
  const deckSlot = chosenDeckSlot();
  if (deckSlot !== null) net.send({ type: 'createSolo', deckSlot });
};
$<HTMLFormElement>('join-form').onsubmit = (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>('join-code').value.trim().toUpperCase();
  if (code.length < 4) {
    homeError.textContent = 'Enter the 5-letter invite code.';
    return;
  }
  const deckSlot = chosenDeckSlot();
  if (deckSlot === null) return;
  homeError.textContent = '';
  net.send({ type: 'joinGame', code, deckSlot });
  $<HTMLInputElement>('join-code').value = '';
};

function fmtClock(ms: number): string {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Remaining time for `color` right now, given clocks as of `asOf`. */
function remaining(clocks: Clocks, color: Color, now = Date.now()): number {
  const base = clocks[color];
  return clocks.running && clocks.turn === color ? base - (now - clocks.asOf) : base;
}

function renderHome(): void {
  const mine = $('games-mine');
  const theirs = $('games-theirs');
  const done = $('games-done');
  mine.innerHTML = theirs.innerHTML = done.innerHTML = '';
  $('home-empty').classList.toggle('hidden', games.length > 0);

  for (const g of games) {
    const card = document.createElement('div');
    const finished = g.status.kind !== 'playing';
    card.className = `game-card ${g.yourTurn && !finished ? 'your-turn' : ''}`;
    card.onclick = () => openGame(g.id);

    const opp = document.createElement('div');
    opp.className = 'opp';
    const oppName = document.createElement('span');
    oppName.textContent = g.solo ? 'Practice (both sides)' : g.opponentName ?? 'Waiting for an opponent';
    const badge = document.createElement('span');
    if (finished) {
      badge.className = 'badge done';
      const s = g.status;
      const winner = 'winner' in s ? s.winner : null;
      badge.textContent = s.kind === 'stalemate' ? 'Draw' : g.solo ? `${colorName(winner!)} won` : winner === g.yourColor ? 'You won' : 'You lost';
    } else if (g.waitingForOpponent) {
      badge.className = 'badge wait';
      badge.textContent = 'Waiting';
    } else if (g.yourTurn) {
      badge.className = 'badge';
      badge.textContent = g.solo ? `${colorName(g.turn)} to move` : 'Your move';
    } else {
      badge.className = 'badge wait';
      badge.textContent = 'Their move';
    }
    opp.append(oppName, badge);

    const canvas = document.createElement('canvas');
    drawThumbnail(canvas, g);

    const meta = document.createElement('div');
    meta.className = 'meta';
    if (g.waitingForOpponent) {
      meta.innerHTML = `<span class="code-line">Invite code <b>${g.code}</b></span><span>You play ${colorName(g.yourColor)}</span>`;
    } else if (g.solo) {
      meta.innerHTML = `<span>Turn ${g.turn === 'white' ? 'White' : 'Black'}</span><span>${new Date(g.updatedAt).toLocaleDateString()}</span>`;
    } else {
      const yours = remaining(g.clocks, g.yourColor);
      const theirsMs = remaining(g.clocks, g.yourColor === 'white' ? 'black' : 'white');
      const low = (ms: number) => (ms < 6 * 3600_000 ? 'low' : '');
      meta.innerHTML = `<span class="${low(yours)}">You: ${fmtClock(yours)}</span><span class="${low(theirsMs)}">Them: ${fmtClock(theirsMs)}</span>`;
    }

    card.append(opp, canvas, meta);
    (finished ? done : g.yourTurn || g.waitingForOpponent ? mine : theirs).appendChild(card);
  }
}

function openGame(id: string): void {
  net.send({ type: 'openGame', gameId: id });
}

// Keep the clocks on the cards current while the home page is open.
setInterval(() => {
  if (!homeScreen.classList.contains('hidden') && games.length) renderHome();
}, 30_000);

// ---------------------------------------------------------------------------
// Game screen

const roomCode = $('room-code');
const statusEl = $('status');
const logEl = $('log');
const toast = $('toast');
const endTurnBtn = $<HTMLButtonElement>('end-turn');
const turnTrack = $('turn-track');
const trackMajor = $('track-major');

endTurnBtn.onclick = () => net.send({ type: 'action', action: { type: 'endTurn' } });

$('resign').onclick = () => {
  if (confirm('Resign this game?')) net.send({ type: 'action', action: { type: 'resign' } });
};

$('leave').onclick = () => {
  net.send({ type: 'leave' });
  goHome();
};

function leaveGameUi(): void {
  you = null;
  room = null;
  solo = false;
  currentGameId = null;
  currentView = null;
  currentClocks = null;
  lastSeq = -1;
  logEl.innerHTML = '';
  $('chat-log').innerHTML = '';
  if (viewReady) gameView.reset();
}

function goHome(): void {
  leaveGameUi();
  rememberOpenGame(null);
  show('home');
  net.send({ type: 'listGames' });
}

async function showGame(): Promise<void> {
  show('game');
  if (!viewReady) {
    viewReady = true;
    await gameView.init($('board-mount'));
    gameView.onAction = (action) => net.send({ type: 'action', action });
    inspect.render(null);
  }
}

function names(): Record<Color, string> {
  if (solo) return { white: 'White', black: 'Black' };
  return {
    white: room?.players.white?.name ?? 'White',
    black: room?.players.black?.name ?? 'Black',
  };
}

/** Which colour each side-panel block shows. In practice mode: bottom = white, top = black. */
function panelColors(): { me: Color; opp: Color } {
  if (solo || !you) return { me: 'white', opp: 'black' };
  return { me: you, opp: you === 'white' ? 'black' : 'white' };
}

function renderRoom(): void {
  if (!room || !you) return;
  roomCode.textContent = solo ? 'PRACTICE' : room.code;
  $('room-hint').textContent = solo ? 'You control both sides. The hand shown is always the side to move.' : 'Send this to a friend. They enter it under "Join".';
  const { me, opp } = panelColors();
  for (const [id, color] of [
    ['me', me],
    ['opp', opp],
  ] as const) {
    const el = $(id);
    const seat = room.players[color];
    el.classList.remove('white', 'black', 'offline');
    el.classList.add(color);
    if (seat && !seat.connected) el.classList.add('offline');
    const label = solo ? colorName(color) : seat ? seat.name + (color === you ? ' (you)' : '') : 'Waiting for opponent…';
    el.querySelector('.pname')!.textContent = label;
  }
  if (!room.players[opp]) {
    statusEl.textContent = 'Waiting for an opponent to join. Share the invite code!';
    statusEl.className = 'status';
  }
}

function renderClocks(): void {
  const c = currentClocks;
  const { me, opp } = panelColors();
  for (const [id, color] of [
    ['me', me],
    ['opp', opp],
  ] as const) {
    const el = $(id).querySelector<HTMLElement>('.clock')!;
    if (!c || solo) {
      el.textContent = '';
      el.className = 'clock';
      continue;
    }
    const ms = remaining(c, color);
    const running = c.running && c.turn === color;
    el.textContent = `⏱ ${fmtClock(ms)}`;
    el.className = `clock ${running ? 'running' : ''} ${ms < 6 * 3600_000 ? 'low' : ''}`;
  }
}
setInterval(() => {
  if (currentClocks && !gameScreen.classList.contains('hidden')) renderClocks();
}, 1000);

function renderStatus(view: PlayerView): void {
  const mine = view.turn === view.you;
  statusEl.className = 'status';
  const canEnd = view.legalActions.some((a) => a.type === 'endTurn');
  endTurnBtn.disabled = !canEnd;
  endTurnBtn.classList.toggle('ready', canEnd && view.turnInfo.majorAction !== null);
  turnTrack.classList.toggle('hidden', !mine || view.status.kind !== 'playing');

  if (view.status.kind !== 'playing') {
    statusEl.classList.add('over');
    const s = view.status;
    const winner = 'winner' in s ? s.winner : null;
    const how = s.kind === 'timeout' ? ' (out of time)' : s.kind === 'resigned' ? ' (resignation)' : '';
    statusEl.textContent =
      s.kind === 'stalemate' ? 'Stalemate — draw.'
      : solo ? `${colorName(winner!)} wins!${how}`
      : winner === view.you ? `You win!${how}` : `You lose.${how}`;
    return;
  }
  if (mine) statusEl.classList.add('mine');
  if (view.inCheck) statusEl.classList.add('check');

  const major = view.turnInfo.majorAction;
  trackMajor.className = `track ${major ? 'used' : 'ok'}`;
  trackMajor.textContent = major === 'move' ? 'Moved' : major === 'summon' ? 'Summoned' : 'Move / Summon';

  const turnNo = view.players[view.turn].turnsTaken;
  const drawIn = view.rules.drawEvery - (turnNo % view.rules.drawEvery);
  const mustDraw = view.players[view.turn].pendingDraws > 0;
  const side = colorName(view.turn);
  const who = solo ? side : mine ? 'You' : 'Opponent';
  const whose = solo ? `${side}'s` : mine ? 'your' : "the opponent's";

  if (mustDraw) {
    statusEl.textContent = mine || solo ? `${who}: the draw timer is full — click ${whose} deck to draw a card.` : 'Opponent is drawing a card…';
  } else if (view.inCheck) {
    statusEl.textContent = mine || solo ? `${who} ${solo ? 'is' : 'are'} in CHECK! Get the King to safety before ending the turn.` : 'Opponent is in check.';
  } else if (mine || solo) {
    statusEl.textContent = major
      ? `${who} ${major === 'move' ? 'moved' : 'summoned'} (turn ${turnNo}). Play spells or switch stances, then End Turn.`
      : `${who}: turn ${turnNo}. Move or summon, play spells, switch stances — then End Turn.`;
  } else {
    statusEl.textContent = `Opponent's turn (${turnNo}).`;
  }
  statusEl.title = `Next draw in ${drawIn === view.rules.drawEvery ? 0 : drawIn} turns`;

  const { me } = panelColors();
  for (const color of ['white', 'black'] as Color[]) {
    const el = $(color === me ? 'me' : 'opp');
    el.querySelector('.hand')!.textContent = `Hand: ${view.players[color].handCount}`;
    el.querySelector('.deck')!.textContent = `Deck: ${view.players[color].deckCount}`;
  }
}

function appendLog(view: PlayerView): void {
  if (view.seq === lastSeq) return;
  lastSeq = view.seq;
  for (const line of describeEvents(view, names())) {
    const div = document.createElement('div');
    div.className = `entry ${line.color ?? ''} ${line.important ? 'important' : ''}`;
    div.textContent = line.text;
    logEl.appendChild(div);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Chat: faded by default (older lines dissolve upward); click the message area
// to expand; clicking the input keeps the compact look so it stays out of the way.

const chatLog = $('chat-log');
const chatForm = $<HTMLFormElement>('chat-form');
const chatInput = $<HTMLInputElement>('chat-input');

function setChatExpanded(expanded: boolean): void {
  chatEl.classList.toggle('expanded', expanded);
  chatEl.classList.toggle('faded', !expanded);
  if (expanded) chatLog.scrollTop = chatLog.scrollHeight;
}

chatLog.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  setChatExpanded(true);
});
chatInput.addEventListener('pointerdown', (e) => e.stopPropagation());
document.addEventListener('pointerdown', () => setChatExpanded(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setChatExpanded(false);
    chatInput.blur();
  }
});

chatForm.onsubmit = (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  net.send({ type: 'chat', text });
  chatInput.value = '';
};

function appendChat(messages: ChatMessage[]): void {
  for (const m of messages) {
    const line = document.createElement('div');
    const mine = solo ? false : m.from === you;
    line.className = `chat-line ${m.from} ${mine ? 'me' : ''}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = mine ? 'You' : solo ? colorName(m.from) : m.name;
    const text = document.createElement('span');
    text.textContent = m.text;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    line.append(who, text, time);
    chatLog.appendChild(line);
  }
  while (chatLog.children.length > 120) chatLog.firstChild?.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}

let toastTimer = 0;
function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add('hidden'), 2800);
}

// ---------------------------------------------------------------------------
// Network

net.onStatus = (connected) => {
  connLabel.textContent = connected ? 'connected' : 'reconnecting…';
};

net.onUnauthorized = () => {
  user = null;
  void showAuth();
};

net.onMessage = async (msg: ServerMessage) => {
  switch (msg.type) {
    case 'welcome': {
      // Fresh socket (first connect or reconnect): reopen this tab's game, or list games.
      const reopen = currentGameId ?? openGameId();
      if (reopen) net.send({ type: 'openGame', gameId: reopen });
      else net.send({ type: 'listGames' });
      return;
    }
    case 'games':
      games = msg.games;
      renderHome();
      return;
    case 'seated':
      leaveGameUi();
      you = msg.color;
      room = msg.room;
      solo = msg.solo;
      currentGameId = msg.gameId;
      rememberOpenGame(msg.gameId);
      await showGame();
      gameView.hotseat = solo;
      renderRoom();
      renderClocks();
      return;
    case 'room':
      room = msg.room;
      renderRoom();
      return;
    case 'state':
      if (!viewReady) await showGame();
      currentView = msg.view;
      currentClocks = msg.clocks;
      gameView.sync(msg.view);
      renderStatus(msg.view);
      renderClocks();
      appendLog(msg.view);
      return;
    case 'chat':
      appendChat(msg.messages);
      return;
    case 'rewards':
      // Let the game-over banner land first, then celebrate.
      setTimeout(() => showRewards(msg.report), gameScreen.classList.contains('hidden') ? 0 : 1200);
      return;
    case 'error':
      if (!homeScreen.classList.contains('hidden')) {
        homeError.textContent = msg.message;
        // The remembered game is gone or not ours: fall back to the list.
        if (/not yours|No game/i.test(msg.message)) {
          rememberOpenGame(null);
          net.send({ type: 'listGames' });
        }
      } else {
        showToast(msg.message);
      }
      return;
    case 'left':
      return;
  }
};

// ---------------------------------------------------------------------------
// Boot: are we signed in?

(async () => {
  const u = await authApi.me();
  if (u) await signedIn(u);
  else await showAuth();
})();
