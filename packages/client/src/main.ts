import { applyBalance, DEFAULT_RULES, EMPTY_BALANCE, getCardDef, type Balance, type Color, type PlayerView } from '@chessx/engine';
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
import { initAttention, notice as attention } from './attention.js';
import { Binder, cardElement } from './binder.js';
import { BalanceEditor } from './editor.js';
import { FriendsPanel } from './friends.js';
import { initPush, onServiceWorkerMessage } from './push.js';
import { GameView } from './game/GameView.js';
import { configureLayout, MOBILE } from './game/layout.js';
import { InspectPanel } from './inspect.js';
import { describeEvents } from './log.js';
import { ApiError, authApi, balanceApi, Net, openGameId, profileApi, rememberOpenGame } from './net.js';
import { colorName, drawThumbnail } from './thumbnail.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// Screens
const authScreen = $('auth');
const homeScreen = $('home');
const binderScreen = $('binder');
const editorScreen = $('editor');
const gameScreen = $('game');
const chatEl = $('chat');

type Screen = 'auth' | 'home' | 'binder' | 'editor' | 'game';
function show(screen: Screen): void {
  authScreen.classList.toggle('hidden', screen !== 'auth');
  homeScreen.classList.toggle('hidden', screen !== 'home');
  binderScreen.classList.toggle('hidden', screen !== 'binder');
  editorScreen.classList.toggle('hidden', screen !== 'editor');
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
let lastSocialCounts: { challenges: number; requests: number } | null = null;
let wasMyTurn = false;
let booted = false;

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
  $('open-editor').classList.toggle('hidden', !u.admin);
  const avatar = $<HTMLImageElement>('avatar');
  avatar.classList.toggle('hidden', !u.avatarUrl);
  if (u.avatarUrl) avatar.src = u.avatarUrl;
  show('home');
  await refreshProfile();
  net.connect();
  void initPush($('push-banner'), $('push-enable'), $('push-dismiss'));
}

// ---------------------------------------------------------------------------
// Routing: the browser's back button moves within the app (game -> home,
// binder -> home) instead of leaving the site. Screens push history entries;
// popstate applies whatever entry we land on.

type Route = { screen: 'home' } | { screen: 'binder' } | { screen: 'editor' } | { screen: 'game'; id: string };

function routeFromLocation(): Route {
  const m = location.pathname.match(/^\/game\/([A-Za-z0-9_-]+)/);
  if (m) return { screen: 'game', id: m[1]! };
  const q = new URLSearchParams(location.search).get('game'); // notification deep links
  if (q) return { screen: 'game', id: q };
  if (location.pathname === '/binder') return { screen: 'binder' };
  if (location.pathname === '/editor') return { screen: 'editor' };
  return { screen: 'home' };
}

const routePath = (r: Route): string => (r.screen === 'game' ? `/game/${r.id}` : r.screen === 'binder' ? '/binder' : r.screen === 'editor' ? '/editor' : '/');

/** Record that we are now on `route` (no-op if history already says so). */
function pushRoute(route: Route): void {
  const cur = history.state as Route | null;
  if (cur && cur.screen === route.screen && (cur.screen !== 'game' || cur.id === (route as { id: string }).id)) return;
  history.pushState(route, '', routePath(route));
}

let applyingRoute = false;
function applyRoute(route: Route): void {
  applyingRoute = true;
  try {
    if (route.screen === 'game') openGame(route.id);
    else if (route.screen === 'binder') void openBinder();
    else if (route.screen === 'editor') openEditor();
    else goHome();
  } finally {
    applyingRoute = false;
  }
}

window.addEventListener('popstate', () => {
  if (!user) return;
  applyRoute((history.state as Route | null) ?? routeFromLocation());
});

/** Leave the current screen the way the back button would. */
function goBack(): void {
  const cur = history.state as Route | null;
  if (cur && cur.screen !== 'home') history.back();
  else {
    goHome();
    history.replaceState({ screen: 'home' } satisfies Route, '', '/');
  }
}

/** On first load: make sure there is a home entry beneath any deep link, then return the target. */
function initialRoute(): Route {
  const route = routeFromLocation();
  history.replaceState({ screen: 'home' } satisfies Route, '', '/');
  if (route.screen !== 'home') history.pushState(route, '', routePath(route));
  return route;
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

const binder = new Binder(() => goBack());
binder.onProfileChanged = (p) => setProfile(p);

const friends = new FriendsPanel((m) => net.send(m), () => chosenDeckSlot());

async function openBinder(): Promise<void> {
  await refreshProfile();
  if (!profile) return;
  show('binder');
  binder.open(profile);
  if (!applyingRoute) pushRoute({ screen: 'binder' });
}

$('open-binder').onclick = () => void openBinder();

// ---------------------------------------------------------------------------
// Card editor (admin only). Balance patches arrive with `welcome` and whenever
// they change; applying them re-skins every card and piece definition in place.

const editor = new BalanceEditor(() => goBack());
editor.onApplied = () => rerenderAfterBalance();
editor.isOwner = () => !!user?.owner;

function openEditor(): void {
  if (!user?.admin) return;
  show('editor');
  editor.open();
  if (!applyingRoute) pushRoute({ screen: 'editor' });
}
$('open-editor').onclick = () => openEditor();

let balanceJson = '';
function takeBalance(b: Balance): void {
  const json = JSON.stringify(b);
  if (json === balanceJson) return;
  balanceJson = json;
  applyBalance(b);
  rerenderAfterBalance();
}

/** Redraw whatever is on screen with the new numbers and pictures (no animations: the events are already spent). */
function rerenderAfterBalance(): void {
  if (currentView && viewReady) {
    currentView = { ...currentView, events: [] };
    renderStatus(currentView);
    void gameView.refreshArt(); // loads any new images, then rebuilds pieces and hand
  }
  if (!binderScreen.classList.contains('hidden') && profile) void refreshProfile().then(() => profile && binder.open(profile));
  if (!discardEl.classList.contains('hidden')) renderDiscard();
}

// ---------------------------------------------------------------------------
// Discard pile browser: newest card first; arrows, keyboard or swipe to go deeper.

const discardEl = $('discard');
const discardView = $('discard-view');
let discardPile: string[] = []; // card ids, newest first
let discardIndex = 0;
let discardColor: Color | null = null;

function openDiscard(color: Color, keepIndex = false): void {
  if (!currentView) return;
  const pile = currentView.players[color].graveyard.map((c) => c.cardId).reverse();
  const owner = solo ? colorName(color) : color === currentView.you ? 'Your' : `${names()[color]}'s`;
  $('discard-title').textContent = `${owner} discard pile`;
  discardColor = color;
  discardPile = pile;
  discardIndex = keepIndex ? Math.min(discardIndex, Math.max(0, pile.length - 1)) : 0;
  renderDiscard();
  discardEl.classList.remove('hidden');
}

/** Called after each state change: keep an open viewer in step with the pile. */
function refreshDiscardIfOpen(): void {
  if (discardColor && !discardEl.classList.contains('hidden')) openDiscard(discardColor, true);
}

function renderDiscard(): void {
  discardView.innerHTML = '';
  if (!discardPile.length) {
    $('discard-pos').textContent = '';
    discardView.innerHTML = '<div class="empty">Nothing played yet.</div>';
  } else {
    $('discard-pos').textContent = `${discardIndex + 1} of ${discardPile.length}${discardIndex === 0 ? ' (top)' : ''}`;
    discardView.appendChild(cardElement(getCardDef(discardPile[discardIndex]!)));
  }
  $<HTMLButtonElement>('discard-next').disabled = discardIndex <= 0;
  $<HTMLButtonElement>('discard-prev').disabled = discardIndex >= discardPile.length - 1;
}

function stepDiscard(delta: number): void {
  const next = Math.max(0, Math.min(discardPile.length - 1, discardIndex + delta));
  if (next === discardIndex) return;
  discardIndex = next;
  renderDiscard();
}

$('discard-prev').onclick = () => stepDiscard(1); // older = deeper
$('discard-next').onclick = () => stepDiscard(-1);
$('discard-close').onclick = () => discardEl.classList.add('hidden');
discardEl.addEventListener('pointerdown', (e) => {
  if (e.target === discardEl) discardEl.classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (discardEl.classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') stepDiscard(1);
  else if (e.key === 'ArrowRight') stepDiscard(-1);
  else if (e.key === 'Escape') discardEl.classList.add('hidden');
});
// Swipe / drag through the pile.
{
  let startX: number | null = null;
  discardView.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
  });
  discardView.addEventListener('pointerup', (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 30) stepDiscard(dx < 0 ? 1 : -1);
  });
}

// Reward popup
const rewardEl = $('reward');
$('reward-close').onclick = () => rewardEl.classList.add('hidden');

function showRewards(r: RewardReport): void {
  $('reward-title').textContent = r.cards.length ? 'Reward' : r.leveledUp ? `Level ${r.level}!` : 'Match complete';
  const parts = [`+${r.xpGained} XP`];
  if (r.leveledUp) parts.push(`Level ${r.level}`);
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
  booted = false;
  rememberOpenGame(null);
  leaveGameUi();
  history.replaceState({ screen: 'home' } satisfies Route, '', '/');
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

let homeTab: 'active' | 'finished' = 'active';
$('tab-active').onclick = () => setHomeTab('active');
$('tab-finished').onclick = () => setHomeTab('finished');

function setHomeTab(tab: 'active' | 'finished'): void {
  homeTab = tab;
  $('tab-active').classList.toggle('active', tab === 'active');
  $('tab-finished').classList.toggle('active', tab === 'finished');
  $('games-active').classList.toggle('hidden', tab !== 'active');
  $('games-finished').classList.toggle('hidden', tab !== 'finished');
}

function renderHome(): void {
  const activeEl = $('games-active');
  const finishedEl = $('games-finished');
  activeEl.innerHTML = finishedEl.innerHTML = '';
  $('home-empty').classList.toggle('hidden', games.length > 0);

  const active = games.filter((g) => g.status.kind === 'playing');
  const finished = games.filter((g) => g.status.kind !== 'playing');
  $('active-count').textContent = active.length ? `${active.length}` : '';
  $('finished-count').textContent = finished.length ? `${finished.length}` : '';

  // Your move first, then games waiting on the other player, then invites without an opponent yet.
  const rank = (g: GameSummary) => (g.yourTurn && !g.waitingForOpponent ? 0 : g.waitingForOpponent ? 2 : 1);
  active.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);

  for (const g of active) {
    const card = document.createElement('div');
    const yours = g.yourTurn && !g.waitingForOpponent;
    card.className = `game-card ${yours ? 'your-turn' : 'waiting'}`;
    card.onclick = () => openGame(g.id);

    const opp = document.createElement('div');
    opp.className = 'opp';
    const oppName = document.createElement('span');
    oppName.textContent = g.solo
      ? 'Practice (both sides)'
      : g.opponentName ?? (g.invitedName ? `Challenged ${g.invitedName}` : 'Open invite');
    const badge = document.createElement('span');
    if (g.waitingForOpponent) {
      badge.className = 'badge wait';
      badge.textContent = g.invitedName ? 'Awaiting reply' : 'Code sent';
    } else if (yours) {
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
      meta.innerHTML = g.invitedName
        ? `<span>Waiting for ${g.invitedName} to accept</span><span>You play ${colorName(g.yourColor)}</span>`
        : `<span class="code-line">Invite code <b>${g.code}</b></span><span>You play ${colorName(g.yourColor)}</span>`;
    } else if (g.solo) {
      meta.innerHTML = `<span>Turn ${g.turn === 'white' ? 'White' : 'Black'}</span><span>${new Date(g.updatedAt).toLocaleDateString()}</span>`;
    } else {
      const yoursMs = remaining(g.clocks, g.yourColor);
      const theirsMs = remaining(g.clocks, g.yourColor === 'white' ? 'black' : 'white');
      const low = (ms: number) => (ms < 6 * 3600_000 ? 'low' : '');
      meta.innerHTML = `<span class="${low(yoursMs)}">You: ${fmtClock(yoursMs)}</span><span class="${low(theirsMs)}">Them: ${fmtClock(theirsMs)}</span>`;
    }

    card.append(opp, canvas, meta);
    if (g.waitingForOpponent) {
      const cancel = document.createElement('button');
      cancel.className = 'card-cancel';
      cancel.textContent = g.invitedName ? 'Withdraw challenge' : 'Cancel invite';
      cancel.onclick = (e) => {
        e.stopPropagation();
        cancelInvite(g);
      };
      card.appendChild(cancel);
    }
    activeEl.appendChild(card);
  }

  // Finished: a compact list, newest first.
  finished.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const g of finished) {
    const row = document.createElement('div');
    row.className = 'finished-row';
    row.onclick = () => openGame(g.id);
    const s = g.status;
    const winner = 'winner' in s ? s.winner : null;
    const how = s.kind === 'timeout' ? 'on time' : s.kind === 'resigned' ? 'by resignation' : s.kind === 'kingCaptured' ? 'king captured' : s.kind === 'checkmate' ? 'checkmate' : 'draw';
    let result: string;
    let cls = '';
    if (s.kind === 'stalemate') result = 'Draw';
    else if (g.solo) result = `${colorName(winner!)} won · ${how}`;
    else if (winner === g.yourColor) {
      result = `Won · ${how}`;
      cls = 'won';
    } else {
      result = `Lost · ${how}`;
      cls = 'lost';
    }
    const oppName = g.solo ? 'Practice (both sides)' : g.opponentName ?? 'Unknown';
    row.innerHTML = `<span class="fr-opp">vs ${oppName}</span><span class="fr-result ${cls}">${result}</span><span class="fr-when">${new Date(g.updatedAt).toLocaleDateString()}</span>`;
    finishedEl.appendChild(row);
  }

  setHomeTab(homeTab);
}

function openGame(id: string): void {
  net.send({ type: 'openGame', gameId: id });
}

function cancelInvite(g: { id: string; invitedName?: string | null }): void {
  const what = g.invitedName ? `Withdraw your challenge to ${g.invitedName}?` : 'Cancel this invite? The code will stop working.';
  if (confirm(what)) net.send({ type: 'cancelGame', gameId: g.id });
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
const trackDraw = $('track-draw');
const trackCards = $('track-cards');
const trackMove = $('track-move');

endTurnBtn.onclick = () => net.send({ type: 'action', action: { type: 'endTurn' } });

$('resign').onclick = () => {
  const { opp } = panelColors();
  if (room && currentGameId && !solo && !room.players[opp]) {
    // Nobody has joined: withdraw the invite instead of resigning. The server sends us home.
    cancelInvite({ id: currentGameId, invitedName: games.find((g) => g.id === currentGameId)?.invitedName });
    return;
  }
  if (confirm('Resign this game?')) net.send({ type: 'action', action: { type: 'resign' } });
};

$('leave').onclick = () => goBack();
$('m-back').onclick = () => goBack();

function leaveGameUi(): void {
  you = null;
  room = null;
  solo = false;
  currentGameId = null;
  currentView = null;
  currentClocks = null;
  lastSeq = -1;
  wasMyTurn = false;
  stateQueue.length = 0;
  gameGeneration++;
  statusEl.textContent = 'Setting up the board…';
  statusEl.className = 'status';
  logEl.innerHTML = '';
  $('chat-log').innerHTML = '';
  if (viewReady) gameView.reset();
}

function goHome(): void {
  setSheet(null);
  if (currentGameId) net.send({ type: 'leave' });
  leaveGameUi();
  rememberOpenGame(null);
  show('home');
  net.send({ type: 'listGames' });
}

let gameInit: Promise<void> | null = null;

/** Show the game screen, initialising the board renderer the first time. Safe to call concurrently. */
function showGame(): Promise<void> {
  show('game');
  if (!gameInit) {
    gameInit = (async () => {
      configureLayout(window.innerWidth);
      // Desktop: park the chat under the card panel so it never overlaps anything.
      if (!MOBILE) $('inspect').appendChild(chatEl);
      const mount = $('board-mount');
      try {
        await gameView.init(mount);
      } catch (err) {
        // Starting the renderer failed (no WebGL, a stalled asset...). Say so where the
        // board should be, and let the next attempt try again instead of staying broken.
        console.error('board renderer failed to start', err);
        const message = err instanceof Error ? err.message : String(err);
        mount.innerHTML = `<div class="board-error"><b>Couldn't start the board.</b><span>${message.replace(/[<>&]/g, '')}</span><button id="board-retry">Try again</button></div>`;
        $('board-retry').onclick = () => {
          mount.innerHTML = '';
          gameInit = null;
          if (currentGameId) net.send({ type: 'openGame', gameId: currentGameId });
        };
        statusEl.textContent = 'The board could not be drawn. Press "Try again" or reload the page.';
        throw err;
      }
      viewReady = true;
      gameView.onAction = (action) => net.send({ type: 'action', action });
      gameView.onOpenDiscard = (color) => openDiscard(color);
      inspect.render(null);
      setupMobileChrome();
    })();
    gameInit.catch(() => {
      gameInit = null; // allow a retry on the next open
    });
  }
  return gameInit;
}

// ---------------------------------------------------------------------------
// Phone chrome: top bar mirrors + bottom sheets. No-ops on desktop.

const mStatus = $('m-status');
const mEnd = $<HTMLButtonElement>('m-end');
const mOpp = $('m-opp');
const mMe = $('m-me');
let openSheet: string | null = null;

/**
 * Show one bottom sheet (or none). `peek` is the compact, undimmed variant used
 * when a piece is tapped: the board stays live and any tap on it dismisses.
 */
function setSheet(id: string | null, opts: { peek?: boolean } = {}): void {
  const peek = !!opts.peek && id === 'inspect';
  for (const s of ['inspect', 'side', 'chat']) $(s).classList.toggle('open', MOBILE && id === s);
  $('inspect').classList.toggle('peek', MOBILE && peek);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#mtabs button')) b.classList.toggle('active', b.dataset.sheet === id);
  $('sheet-backdrop').classList.toggle('hidden', !MOBILE || id === null || peek);
  openSheet = id;
  if (id === 'chat') $('m-chat-badge').textContent = '';
}

function setupMobileChrome(): void {
  if (!MOBILE) return;
  mEnd.onclick = () => endTurnBtn.click();
  for (const b of document.querySelectorAll<HTMLButtonElement>('#mtabs button')) {
    b.onclick = () => setSheet(openSheet === b.dataset.sheet ? null : b.dataset.sheet!);
  }
  $('sheet-backdrop').onclick = () => setSheet(null);
  // Tapping a hand card opens its full text; tapping a piece peeks its card while keeping the board live.
  gameView.onCardTap = () => setSheet('inspect');
  gameView.onPieceTap = () => setSheet('inspect', { peek: true });
  // Any touch on the board dismisses a peek (the same touch still selects/moves as usual).
  $('board-mount').addEventListener('pointerdown', () => {
    if (openSheet === 'inspect' && $('inspect').classList.contains('peek')) setSheet(null);
  }, { capture: true });
  const origInspect = gameView.onInspect;
  gameView.onInspect = (t) => {
    origInspect(t);
    $('m-card-name').textContent = !t ? '' : t.kind === 'card' ? getCardDef(t.cardId).name : t.piece.kind.replace(/_/g, ' ');
  };
  // Acting on the board closes whatever sheet is open so the result is visible.
  const origAction = gameView.onAction;
  gameView.onAction = (a) => {
    setSheet(null);
    origAction(a);
  };
}

function renderMobileBar(view: PlayerView | null): void {
  if (!MOBILE) return;
  mStatus.textContent = statusEl.textContent;
  mStatus.className = `mstatus ${statusEl.classList.contains('check') ? 'check' : ''}`;
  mEnd.classList.toggle('hidden', endTurnBtn.classList.contains('hidden'));
  mEnd.disabled = endTurnBtn.disabled;
  mEnd.textContent = endTurnBtn.textContent;
  mEnd.classList.toggle('ready', endTurnBtn.classList.contains('ready'));
  const { me, opp } = panelColors();
  const who = (id: 'me' | 'opp', color: Color) => {
    const el = $(id);
    const name = el.querySelector('.pname')?.textContent ?? '';
    const clock = el.querySelector('.clock')?.textContent ?? '';
    const turn = !!view && view.status.kind === 'playing' && view.turn === color;
    return { html: `<b>${name}</b>${clock ? ` · ${clock}` : ''}`, turn };
  };
  const o = who('opp', opp);
  const m = who('me', me);
  mOpp.innerHTML = o.html;
  mMe.innerHTML = m.html;
  mOpp.classList.toggle('turn', o.turn);
  mMe.classList.toggle('turn', m.turn);
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
  const hint = $('room-hint');
  hint.textContent = solo ? '' : 'Send this to a friend. They enter it under "Join".';
  hint.classList.toggle('hidden', solo);
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
  const waiting = !room.players[opp];
  if (waiting) {
    statusEl.textContent = 'Waiting for an opponent to join. Share the invite code!';
    statusEl.className = 'status';
  }
  // Before anyone joins there is nothing to resign — offer to cancel the invite instead.
  $('resign').textContent = waiting ? 'Cancel invite' : 'Resign';
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
  if (currentClocks && !gameScreen.classList.contains('hidden')) {
    renderClocks();
    renderMobileBar(currentView);
  }
}, 1000);

function renderStatus(view: PlayerView): void {
  const mine = view.turn === view.you;
  statusEl.className = 'status';
  // The move ends the turn by itself; the button only appears as a Pass when no move exists.
  const canPass = view.legalActions.some((a) => a.type === 'endTurn');
  endTurnBtn.classList.toggle('hidden', !mine || view.status.kind !== 'playing' || !canPass);
  endTurnBtn.disabled = !canPass;
  endTurnBtn.textContent = 'Pass (no legal moves)';
  endTurnBtn.classList.toggle('ready', canPass);
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

  const turnNo = view.players[view.turn].turnsTaken;
  const drawIn = view.rules.drawEvery - (turnNo % view.rules.drawEvery);
  const mustDraw = view.phase === 'draw';
  const mover = view.players[view.turn];
  const playable = new Set(view.legalActions.filter((a) => a.type === 'playCard').map((a) => (a as { cardInstanceId: string }).cardInstanceId)).size;
  const side = colorName(view.turn);
  const who = solo ? side : mine ? 'You' : 'Opponent';
  const whose = solo ? `${side}'s` : mine ? 'your' : "the opponent's";

  // Phase track: Draw → Cards → Move. The current phase is highlighted, finished ones ticked.
  const drawOwedThisTurn = turnNo % view.rules.drawEvery === 0 && (mustDraw || mover.deckCount > 0);
  trackDraw.className = `track ${mustDraw ? 'now' : drawOwedThisTurn ? 'used' : 'skip'}`;
  trackDraw.textContent = mustDraw ? 'Draw ▸ click deck' : drawOwedThisTurn ? 'Drew ✓' : `Draw in ${drawIn === view.rules.drawEvery ? view.rules.drawEvery : drawIn}`;
  trackCards.className = `track ${mustDraw ? 'skip' : 'now'}`;
  trackCards.textContent = view.turnInfo.cardsPlayed
    ? `Cards: ${view.turnInfo.cardsPlayed} played${playable ? `, ${playable} more` : ''}`
    : playable
      ? `Cards: ${playable} playable`
      : `Cards: none affordable (${mover.mana} mana)`;
  trackMove.className = `track ${mustDraw ? 'skip' : 'now'}`;
  trackMove.textContent = view.inCheck ? 'Move: escape check!' : 'Move a piece → ends turn';

  if (mustDraw) {
    statusEl.textContent = mine || solo ? `${who}: the draw timer is full — click ${whose} deck to draw a card.` : 'Opponent is drawing a card…';
  } else if (view.inCheck) {
    statusEl.textContent = mine || solo ? `${who} ${solo ? 'is' : 'are'} in CHECK! Play cards if you like, then move the King to safety.` : 'Opponent is in check.';
  } else if (mine || solo) {
    statusEl.textContent = playable
      ? `${who}: turn ${turnNo}. Play cards (${mover.mana} mana), then move a piece — the move ends ${whose} turn.`
      : `${who}: turn ${turnNo}. Move a piece to end ${whose} turn. (${mover.mana} mana — no card is affordable yet.)`;
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

// ---------------------------------------------------------------------------
// State queue. Your own actions apply instantly. The opponent's arrive one per
// action and are replayed with pacing: a card play shows the reveal animation
// first, then the effect; moves get a beat so they can be followed.

const stateQueue: { view: PlayerView; clocks: Clocks }[] = [];
let draining = false;
/** Bumped whenever we leave a game, so an in-flight replay never applies to the next game. */
let gameGeneration = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Never let an animation hold up the game: whichever finishes first wins. */
const withTimeout = (p: Promise<void>, ms: number) => Promise.race([p.catch(() => undefined), sleep(ms)]);

function enqueueState(view: PlayerView, clocks: Clocks): void {
  stateQueue.push({ view, clocks });
  if (!draining) void drainStates();
}

async function drainStates(): Promise<void> {
  draining = true;
  try {
    while (stateQueue.length) {
      const gen = gameGeneration;
      const { view, clocks } = stateQueue.shift()!;
      const opponentPlayed = !solo && view.events.find((e) => e.type === 'cardPlayed' && e.color !== view.you);
      const opponentActed = !solo && view.events.some((e) => (e.type === 'moved' || e.type === 'attacked') && view.turn !== view.you);
      if (opponentPlayed && opponentPlayed.type === 'cardPlayed') {
        await withTimeout(gameView.revealCard(opponentPlayed.cardId, false, opponentPlayed.target), 4000);
        if (gen !== gameGeneration) continue; // we left this game while the card was being shown
      }
      try {
        applyState(view, clocks);
      } catch (err) {
        console.error('applyState failed', err);
      }
      // Give a move a moment to be seen before the next queued action lands.
      if (stateQueue.length && (opponentActed || opponentPlayed)) await sleep(opponentPlayed ? 500 : 700);
    }
  } finally {
    draining = false;
    if (stateQueue.length) void drainStates(); // arrived during the final await
  }
}

function applyState(view: PlayerView, clocks: Clocks): void {
  currentView = view;
  currentClocks = clocks;
  gameView.sync(view);
  renderStatus(view);
  renderClocks();
  appendLog(view);
  renderMobileBar(view);
  refreshDiscardIfOpen();
  const myTurn = !solo && view.turn === view.you && view.status.kind === 'playing';
  if (myTurn && !wasMyTurn && view.ply > 0) attention('Your move');
  wasMyTurn = myTurn;
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
function showToast(message: string, kind: 'error' | 'info' = 'error'): void {
  toast.textContent = message;
  toast.className = kind;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add('hidden'), kind === 'info' ? 4500 : 2800);
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
    case 'balance':
      takeBalance(msg.balance);
      if (!user?.admin) showToast('Card values were updated by the game admin.', 'info');
      return;
    case 'user':
      // Roles changed (made a developer, or removed): show/hide the editor button.
      user = msg.user;
      $('open-editor').classList.toggle('hidden', !msg.user.admin);
      if (!msg.user.admin && !editorScreen.classList.contains('hidden')) goHome();
      return;
    case 'welcome': {
      takeBalance(msg.balance);
      // Fresh socket (first connect or reconnect). On first connect the URL decides
      // (deep link / bookmarked game / binder); on reconnect, whatever was open.
      if (!booted) {
        booted = true;
        const route = initialRoute();
        if (route.screen === 'game') net.send({ type: 'openGame', gameId: route.id });
        else {
          const remembered = openGameId();
          if (remembered) {
            // Refresh while in a game: stay there and give it a history entry.
            pushRoute({ screen: 'game', id: remembered });
            net.send({ type: 'openGame', gameId: remembered });
          } else {
            net.send({ type: 'listGames' });
            if (route.screen === 'binder') void openBinder();
            else if (route.screen === 'editor') openEditor();
          }
        }
      } else if (currentGameId && !net.hasPending) {
        net.send({ type: 'openGame', gameId: currentGameId });
      } else {
        net.send({ type: 'listGames' });
      }
      net.send({ type: 'getSocial' });
      // Anything the player asked for while we were reconnecting (e.g. clicking Practice
      // during a server restart) goes out now instead of being lost.
      net.flushPending();
      return;
    }
    case 'social': {
      const before = lastSocialCounts;
      lastSocialCounts = { challenges: msg.social.incomingChallenges.length, requests: msg.social.incomingRequests.length };
      friends.update(msg.social);
      if (before && msg.social.incomingChallenges.length > before.challenges) attention('New challenge');
      else if (before && msg.social.incomingRequests.length > before.requests) attention('Friend request');
      return;
    }
    case 'notice':
      showToast(msg.message, 'info');
      return;
    case 'games': {
      const beforeMine = games.filter((g) => g.yourTurn && !g.solo && !g.waitingForOpponent).length;
      games = msg.games;
      renderHome();
      const nowMine = games.filter((g) => g.yourTurn && !g.solo && !g.waitingForOpponent).length;
      if (nowMine > beforeMine) attention('Your move');
      return;
    }
    case 'seated':
      leaveGameUi();
      you = msg.color;
      room = msg.room;
      solo = msg.solo;
      currentGameId = msg.gameId;
      rememberOpenGame(msg.gameId);
      if (!applyingRoute) pushRoute({ screen: 'game', id: msg.gameId });
      gameView.hotseat = solo;
      renderRoom();
      renderClocks();
      renderMobileBar(currentView);
      setSheet(null);
      try {
        await showGame();
      } catch {
        /* reported by showGame() */
      }
      return;
    case 'room':
      room = msg.room;
      renderRoom();
      renderMobileBar(currentView);
      return;
    case 'state':
      try {
        await showGame(); // waits for the renderer if it is still starting up
      } catch {
        return; // the board could not start; showGame() has put a message and a retry button in its place
      }
      enqueueState(msg.view, msg.clocks);
      return;
    case 'chat':
      appendChat(msg.messages);
      if (MOBILE && openSheet !== 'chat' && msg.messages.length === 1) $('m-chat-badge').textContent = 'new';
      if (msg.messages.length === 1 && msg.messages[0]!.from !== you && !solo) attention(`${msg.messages[0]!.name}: ${msg.messages[0]!.text}`);
      return;
    case 'rewards':
      // Let the game-over banner land first, then celebrate.
      setTimeout(() => showRewards(msg.report), gameScreen.classList.contains('hidden') ? 0 : 1200);
      return;
    case 'error': {
      const gameGone = /not yours|No game|no longer available/i.test(msg.message);
      if (!homeScreen.classList.contains('hidden')) {
        homeError.textContent = msg.message;
        // The remembered game is gone or not ours: fall back to the list.
        if (gameGone) {
          rememberOpenGame(null);
          history.replaceState({ screen: 'home' } satisfies Route, '', '/');
          net.send({ type: 'listGames' });
        }
      } else if (gameGone && currentGameId && !gameScreen.classList.contains('hidden')) {
        // We were in a game that no longer exists (a practice game after a server restart, a
        // cancelled invite...). Don't leave a dead board on screen: back to the list, with a note.
        const wasPractice = solo;
        currentGameId = null;
        goHome();
        history.replaceState({ screen: 'home' } satisfies Route, '', '/');
        showToast(wasPractice ? 'That practice game ended (the server restarted). Start a new one any time.' : msg.message, 'info');
      } else {
        showToast(msg.message);
      }
      return;
    }
    case 'left':
      // The server closed our view (e.g. a pending challenge was declined): back to the list.
      if (currentGameId) {
        currentGameId = null;
        goHome();
        history.replaceState({ screen: 'home' } satisfies Route, '', '/');
      }
      return;
  }
};

// ---------------------------------------------------------------------------
// Boot: are we signed in?

initAttention();
onServiceWorkerMessage((m) => {
  // A notification was tapped while this tab was already open: go where it points.
  if (m.type === 'open' && m.url) {
    const id = new URL(m.url).searchParams.get('game');
    if (id && user) openGame(id);
  }
});

(async () => {
  // Card/piece numbers first, so nothing is ever drawn with stale values.
  takeBalance(await balanceApi.get().catch(() => EMPTY_BALANCE));
  const u = await authApi.me();
  if (u) await signedIn(u);
  else await showAuth();
})();
