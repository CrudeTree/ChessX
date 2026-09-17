import { allCards, getPieceDef, STANDARD_PIECES, type Color, type Piece, type PlayerView, type SummonCardDef } from '@chessx/engine';
import type { RoomInfo, ServerMessage } from '@chessx/protocol';
import { GameView } from './game/GameView.js';
import { describeEvents } from './log.js';
import { Net, saveSession } from './net.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const lobby = $('lobby');
const game = $('game');
const nameInput = $<HTMLInputElement>('name');
const codeInput = $<HTMLInputElement>('code');
const lobbyError = $('lobby-error');
const connLabel = $('conn');
const roomCode = $('room-code');
const statusEl = $('status');
const logEl = $('log');
const toast = $('toast');
const zoomEl = $('zoom');
const stanceBtn = $<HTMLButtonElement>('stance');
const stanceHint = $('stance-hint');
let currentView: PlayerView | null = null;

nameInput.value = localStorage.getItem('chessx.name') ?? '';

const net = new Net();
const gameView = new GameView();
let you: Color | null = null;
let room: RoomInfo | null = null;
let solo = false;
let lastPly = -1;
let viewReady = false;

// ---------------------------------------------------------------------------
// Lobby

function playerName(): string {
  const n = nameInput.value.trim() || 'Player';
  localStorage.setItem('chessx.name', n);
  return n;
}

$('create').onclick = () => {
  lobbyError.textContent = '';
  net.send({ type: 'createRoom', name: playerName() });
};

$('solo').onclick = () => {
  lobbyError.textContent = '';
  net.send({ type: 'createSolo', name: playerName() });
};

$('join').onclick = () => {
  lobbyError.textContent = '';
  const code = codeInput.value.trim().toUpperCase();
  if (code.length < 4) {
    lobbyError.textContent = 'Enter the 5-letter invite code.';
    return;
  }
  net.send({ type: 'joinRoom', code, name: playerName() });
};
codeInput.onkeydown = (e) => {
  if (e.key === 'Enter') $('join').click();
};

$('resign').onclick = () => {
  if (confirm('Resign this game?')) net.send({ type: 'action', action: { type: 'resign' } });
};

$('leave').onclick = () => {
  net.send({ type: 'leave' });
  saveSession(null);
  showLobby();
};

function showLobby(): void {
  you = null;
  room = null;
  solo = false;
  lastPly = -1;
  currentView = null;
  logEl.innerHTML = '';
  if (viewReady) gameView.reset();
  game.classList.add('hidden');
  lobby.classList.remove('hidden');
}

async function showGame(): Promise<void> {
  lobby.classList.add('hidden');
  game.classList.remove('hidden');
  if (!viewReady) {
    viewReady = true;
    await gameView.init($('board-mount'));
    gameView.onAction = (action) => net.send({ type: 'action', action });
    gameView.onInspect = (piece) => renderInspect(piece);
    stanceBtn.onclick = () => gameView.toggleInspectedStance();
  }
}

// ---------------------------------------------------------------------------
// Inspect panel: zoomed card for the clicked piece + stance toggle

const summonCardFor = (kind: string): SummonCardDef | undefined =>
  allCards().find((c): c is SummonCardDef => c.type === 'summon' && c.piece.kind === kind);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function renderInspect(piece: Piece | null): void {
  if (!piece) {
    zoomEl.className = 'zoom empty';
    zoomEl.innerHTML = '<div class="zoom-empty">Click any piece to see its card.</div>';
    stanceBtn.disabled = true;
    stanceBtn.className = '';
    stanceBtn.textContent = 'Switch to Defense mode';
    stanceHint.textContent = '';
    return;
  }

  const def = getPieceDef(piece.kind);
  const isBasic = piece.kind in STANDARD_PIECES;
  const card = isBasic ? undefined : summonCardFor(piece.kind);
  const isKing = piece.kind === 'king';
  const ownerName = solo ? (piece.owner === 'white' ? 'White' : 'Black') : names()[piece.owner];

  const typeLine = isKing
    ? 'Royal piece'
    : card
      ? `Tier ${def.tier} creature · summoned by ${card.name}`
      : `Tier ${def.tier} · basic piece`;

  const status: string[] = [];
  if (piece.summon) {
    const c = summonCardFor(piece.summon.cardId) ?? allCards().find((x) => x.id === piece.summon!.cardId);
    status.push(`Being sacrificed: ${c?.name ?? 'summon'} arrives in ${piece.summon.turnsRemaining} turn${piece.summon.turnsRemaining === 1 ? '' : 's'}.`);
  } else if (piece.stance === 'defense') {
    status.push('Cannot move or attack while in Defense mode. Switching back to Attack mode uses a turn.');
    if (piece.maxDef === 0) status.push('No DEF to shield with — raise DEF (e.g. Shield Wall) to make Defense mode count.');
  }

  zoomEl.className = `zoom ${card ? 'summon' : 'basic'} owner-${piece.owner}`;
  zoomEl.innerHTML = `
    <div class="zoom-head">
      <div class="zoom-name">${esc(def.name)}</div>
      <div class="zoom-owner">${esc(ownerName)}</div>
    </div>
    <div class="zoom-type">${esc(typeLine)}</div>
    <div class="zoom-art"><span class="glyph ${isBasic ? 'chess' : 'emoji'} ${piece.owner}">${def.glyph}</span></div>
    <div class="zoom-stats">
      <div class="stat atk">ATK<b>${piece.atk}</b></div>
      <div class="stat def">DEF<b>${piece.maxDef === 0 ? '—' : `${piece.def}/${piece.maxDef}`}</b></div>
      <div class="stat hp">HP<b>${isKing ? '—' : `${piece.hp}/${piece.maxHp}`}</b></div>
    </div>
    ${isKing ? '' : `<div class="zoom-stance ${piece.stance}">${piece.stance === 'defense' ? '🛡 Defense mode — DEF shields HP' : '⚔ Attack mode'}</div>`}
    <div class="zoom-text">${esc(card?.text ?? def.description ?? '')}</div>
    <div class="zoom-status">${status.map(esc).join('<br>')}</div>
  `;
  zoomEl.classList.add('fresh');
  setTimeout(() => zoomEl.classList.remove('fresh'), 180);

  const action = gameView.stanceActionFor(piece.id);
  const toDefense = piece.stance === 'attack';
  stanceBtn.textContent = toDefense ? 'Switch to Defense mode' : 'Switch to Attack mode';
  stanceBtn.className = toDefense ? 'to-defense' : 'to-attack';
  stanceBtn.disabled = !action;
  if (action) {
    stanceHint.textContent = toDefense
      ? 'Uses your turn. The piece cannot move or attack until switched back.'
      : 'Uses your turn. The piece can move again from your next turn.';
  } else if (isKing) {
    stanceHint.textContent = 'The King cannot change stance.';
  } else if (piece.summon) {
    stanceHint.textContent = 'A piece being sacrificed cannot change stance.';
  } else if (currentView && currentView.turn !== piece.owner) {
    stanceHint.textContent = solo ? `It is not ${ownerName}'s turn.` : 'Not your piece or not your turn.';
  } else if (currentView && currentView.status.kind !== 'playing') {
    stanceHint.textContent = 'The game is over.';
  } else {
    stanceHint.textContent = currentView?.inCheck ? 'You must answer the check first.' : '';
  }
}

// ---------------------------------------------------------------------------
// Side panel

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
    const label = solo ? (color === 'white' ? 'White' : 'Black') : seat ? seat.name + (color === you ? ' (you)' : '') : 'Waiting for opponent…';
    el.querySelector('.pname')!.textContent = label;
  }
  if (!room.players[opp]) {
    statusEl.textContent = 'Waiting for an opponent to join. Share the invite code!';
    statusEl.className = 'status';
  }
}

function renderStatus(view: PlayerView): void {
  const mine = view.turn === view.you;
  statusEl.className = 'status';
  if (view.status.kind !== 'playing') {
    statusEl.classList.add('over');
    const s = view.status;
    const winner = 'winner' in s ? s.winner : null;
    statusEl.textContent =
      s.kind === 'stalemate' ? 'Stalemate — draw.'
      : solo ? `${winner === 'white' ? 'White' : 'Black'} wins!`
      : winner === view.you ? 'You win!' : 'You lose.';
    return;
  }
  if (mine) statusEl.classList.add('mine');
  if (view.inCheck) statusEl.classList.add('check');
  const turnNo = view.players[view.turn].turnsTaken;
  const drawIn = view.rules.drawEvery - (turnNo % view.rules.drawEvery);
  if (solo) {
    const side = view.turn === 'white' ? 'White' : 'Black';
    statusEl.textContent = `${side} to move (turn ${turnNo}). Move a piece or play a card.${view.inCheck ? ` ${side} is in CHECK!` : ''}`;
  } else {
    statusEl.textContent = mine
      ? `Your turn (${turnNo}). Move a piece or play a card.${view.inCheck ? ' You are in CHECK!' : ''}`
      : `Opponent's turn (${turnNo}).${view.inCheck ? ' They are in check.' : ''}`;
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
  if (view.ply === lastPly) return;
  lastPly = view.ply;
  for (const line of describeEvents(view, names())) {
    const div = document.createElement('div');
    div.className = `entry ${line.color ?? ''} ${line.important ? 'important' : ''}`;
    div.textContent = line.text;
    logEl.appendChild(div);
  }
  logEl.scrollTop = logEl.scrollHeight;
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

net.onMessage = async (msg: ServerMessage) => {
  switch (msg.type) {
    case 'welcome':
      return;
    case 'seated':
      you = msg.color;
      room = msg.room;
      solo = !!msg.solo;
      saveSession({ code: msg.code, token: msg.token });
      await showGame();
      gameView.hotseat = solo;
      renderRoom();
      return;
    case 'room':
      room = msg.room;
      renderRoom();
      return;
    case 'state':
      if (!viewReady) await showGame();
      currentView = msg.view;
      gameView.sync(msg.view);
      renderStatus(msg.view);
      appendLog(msg.view);
      return;
    case 'error':
      if (!lobby.classList.contains('hidden')) {
        lobbyError.textContent = msg.message;
        // A failed rejoin means the saved session is dead.
        if (/no longer exists|Invalid rejoin/i.test(msg.message)) {
          saveSession(null);
          lobbyError.textContent = '';
        }
      } else {
        showToast(msg.message);
      }
      return;
    case 'left':
      showLobby();
      return;
  }
};

net.connect();
