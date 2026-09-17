import type { Color, PlayerView } from '@chessx/engine';
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

nameInput.value = localStorage.getItem('chessx.name') ?? '';

const net = new Net();
const gameView = new GameView();
let you: Color | null = null;
let room: RoomInfo | null = null;
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
  lastPly = -1;
  logEl.innerHTML = '';
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
  }
}

// ---------------------------------------------------------------------------
// Side panel

function names(): Record<Color, string> {
  return {
    white: room?.players.white?.name ?? 'White',
    black: room?.players.black?.name ?? 'Black',
  };
}

function renderRoom(): void {
  if (!room || !you) return;
  roomCode.textContent = room.code;
  const opp: Color = you === 'white' ? 'black' : 'white';
  for (const [id, color] of [
    ['me', you],
    ['opp', opp],
  ] as const) {
    const el = $(id);
    const seat = room.players[color];
    el.classList.remove('white', 'black', 'offline');
    el.classList.add(color);
    if (seat && !seat.connected) el.classList.add('offline');
    el.querySelector('.pname')!.textContent = seat ? seat.name + (color === you ? ' (you)' : '') : 'Waiting for opponent…';
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
      s.kind === 'stalemate' ? 'Stalemate — draw.' : winner === view.you ? 'You win!' : 'You lose.';
    return;
  }
  if (mine) statusEl.classList.add('mine');
  if (view.inCheck) statusEl.classList.add('check');
  const turnNo = view.players[view.turn].turnsTaken;
  const drawIn = view.rules.drawEvery - (turnNo % view.rules.drawEvery);
  statusEl.textContent = mine
    ? `Your turn (${turnNo}). Move a piece or play a card.${view.inCheck ? ' You are in CHECK!' : ''}`
    : `Opponent's turn (${turnNo}).${view.inCheck ? ' They are in check.' : ''}`;
  statusEl.title = `Next draw in ${drawIn === view.rules.drawEvery ? 0 : drawIn} of your turns`;

  for (const color of ['white', 'black'] as Color[]) {
    const el = $(color === view.you ? 'me' : 'opp');
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
      saveSession({ code: msg.code, token: msg.token });
      await showGame();
      renderRoom();
      return;
    case 'room':
      room = msg.room;
      renderRoom();
      return;
    case 'state':
      if (!viewReady) await showGame();
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
