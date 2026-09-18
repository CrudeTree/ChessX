import {
  allCards,
  getCardDef,
  getPieceDef,
  movementPattern,
  STANDARD_PIECES,
  type Color,
  type MovementSpec,
  type Piece,
  type PlayerView,
  type SummonCardDef,
} from '@chessx/engine';
import type { ChatMessage, RoomInfo, ServerMessage } from '@chessx/protocol';
import { GameView, type InspectTarget } from './game/GameView.js';
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
const endTurnBtn = $<HTMLButtonElement>('end-turn');
const turnTrack = $('turn-track');
const trackMajor = $('track-major');
let currentView: PlayerView | null = null;

endTurnBtn.onclick = () => net.send({ type: 'action', action: { type: 'endTurn' } });

nameInput.value = localStorage.getItem('chessx.name') ?? '';

const net = new Net();
const gameView = new GameView();
let you: Color | null = null;
let room: RoomInfo | null = null;
let solo = false;
let lastSeq = -1;
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
  lastSeq = -1;
  currentView = null;
  logEl.innerHTML = '';
  if (viewReady) gameView.reset();
  game.classList.add('hidden');
  chatEl.classList.add('hidden');
  chatLog.innerHTML = '';
  lobby.classList.remove('hidden');
}

async function showGame(): Promise<void> {
  lobby.classList.add('hidden');
  game.classList.remove('hidden');
  chatEl.classList.remove('hidden');
  if (!viewReady) {
    viewReady = true;
    await gameView.init($('board-mount'));
    gameView.onAction = (action) => net.send({ type: 'action', action });
    gameView.onInspect = (target) => renderInspect(target);
    stanceBtn.onclick = () => gameView.toggleInspectedStance();
  }
}

// ---------------------------------------------------------------------------
// Inspect panel: zoomed card for the clicked piece + stance toggle

const summonCardFor = (kind: string): SummonCardDef | undefined =>
  allCards().find((c): c is SummonCardDef => c.type === 'summon' && c.piece.kind === kind);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function resetStanceButton(hint = ''): void {
  stanceBtn.disabled = true;
  stanceBtn.className = '';
  stanceBtn.textContent = 'Switch to Defense mode';
  stanceHint.textContent = hint;
}

function renderInspect(target: InspectTarget | null): void {
  if (!target) {
    zoomEl.className = 'zoom empty';
    zoomEl.innerHTML = '<div class="zoom-empty">Click any piece, or hover a card, to see it here.</div>';
    resetStanceButton();
    return;
  }
  if (target.kind === 'card') {
    renderCardZoom(target.cardId);
    return;
  }
  renderPieceZoom(target.piece);
}

/** Zoomed view of a card in hand. Summon cards also show the creature's stats. */
function renderCardZoom(cardId: string): void {
  const card = getCardDef(cardId);
  const isSummon = card.type === 'summon';
  const typeLine = isSummon
    ? `Summon · Tier ${card.tier} · arrives in ${card.summonTurns} turn${card.summonTurns === 1 ? '' : 's'}`
    : `Spell · ${describeTarget(card.target)}`;
  const stats = isSummon
    ? `<div class="zoom-stats">
        <div class="stat atk">ATK<b>${card.piece.atk}</b></div>
        <div class="stat def">DEF<b>${card.piece.def === 0 ? '—' : card.piece.def}</b></div>
        <div class="stat hp">HP<b>${card.piece.hp}</b></div>
      </div>`
    : '';
  const needs = isSummon ? `Sacrifice one of your Tier ${card.sacrificeTier ?? card.tier - 1} pieces to summon.` : '';

  zoomEl.className = `zoom ${isSummon ? 'summon' : 'basic'} card`;
  zoomEl.innerHTML = `
    <div class="zoom-head">
      <div class="zoom-name">${esc(card.name)}</div>
      <div class="zoom-owner">${isSummon ? 'CREATURE' : 'SPELL'}</div>
    </div>
    <div class="zoom-type">${esc(typeLine)}</div>
    ${isSummon ? movementMap(card.piece.movement, `<span class="glyph emoji">${card.piece.glyph}</span>`) : `<div class="zoom-art"><span class="glyph emoji">${card.glyph}</span></div>`}
    ${stats}
    <div class="zoom-text">${esc(card.text)}</div>
    <div class="zoom-status">${esc(needs)}</div>
  `;
  zoomEl.classList.add('fresh');
  setTimeout(() => zoomEl.classList.remove('fresh'), 180);
  resetStanceButton('Drag the card onto a highlighted target to play it.');
}

/**
 * 7x7 mini board with the piece in the middle and dots on every square it
 * could reach on an empty board. Black dot = move, red dot = attack-only.
 */
function movementMap(spec: MovementSpec, glyphHtml: string): string {
  const R = 3;
  const { moves, attacks, unbounded } = movementPattern(spec, R);
  const key = (df: number, dr: number) => `${df},${dr}`;
  const moveSet = new Set(moves.map(([f, r]) => key(f, r)));
  const attackSet = new Set(attacks.map(([f, r]) => key(f, r)));
  let cells = '';
  for (let dr = R; dr >= -R; dr--) {
    for (let df = -R; df <= R; df++) {
      const light = (df + dr + 2 * R) % 2 === 0;
      const isCenter = df === 0 && dr === 0;
      const k = key(df, dr);
      const dot = isCenter ? glyphHtml : moveSet.has(k) ? '<i class="dot"></i>' : attackSet.has(k) ? '<i class="dot atk"></i>' : '';
      cells += `<div class="cell ${light ? 'l' : 'd'}${isCenter ? ' c' : ''}">${dot}</div>`;
    }
  }
  const legend = `<div class="map-legend">${attacks.length ? '<span><i class="dot"></i> move</span><span><i class="dot atk"></i> attack</span>' : '<span><i class="dot"></i> move / attack</span>'}${unbounded ? '<span>… continues to the edge</span>' : ''}</div>`;
  return `<div class="minimap">${cells}</div>${legend}`;
}

function describeTarget(rule: string): string {
  switch (rule) {
    case 'none': return 'no target';
    case 'ownPiece': return 'targets a friendly piece';
    case 'enemyPiece': return 'targets an enemy piece';
    case 'anyPiece': return 'targets any piece';
    case 'ownSummoning': return 'targets a friendly piece being sacrificed';
    default: return rule;
  }
}

function renderPieceZoom(piece: Piece): void {
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
    status.push('Cannot move or attack while in Defense mode. Switch it back to Attack mode to free it (it can act from the following turn).');
    if (piece.maxDef === 0) status.push('No DEF to shield with — raise DEF (e.g. Shield Wall) to make Defense mode count.');
  }
  if (currentView?.turnInfo.stanceChanged.includes(piece.id)) {
    status.push('Changed stance this turn: cannot act or switch again until the turn ends.');
  }

  zoomEl.className = `zoom ${card ? 'summon' : 'basic'} owner-${piece.owner}`;
  zoomEl.innerHTML = `
    <div class="zoom-head">
      <div class="zoom-name">${esc(def.name)}</div>
      <div class="zoom-owner">${esc(ownerName)}</div>
    </div>
    <div class="zoom-type">${esc(typeLine)}</div>
    ${movementMap(def.movement, `<span class="glyph ${isBasic ? 'chess' : 'emoji'} ${piece.owner}">${def.glyph}</span>`)}
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
      ? 'Free action. The piece is frozen until you switch it back (from a later turn).'
      : 'Free action. The piece sits out the rest of this turn, then may act as normal.';
  } else if (isKing) {
    stanceHint.textContent = 'The King cannot change stance.';
  } else if (piece.summon) {
    stanceHint.textContent = 'A piece being sacrificed cannot change stance.';
  } else if (currentView?.turnInfo.stanceChanged.includes(piece.id)) {
    stanceHint.textContent = 'Already switched this turn.';
  } else if (currentView && currentView.turn !== piece.owner) {
    stanceHint.textContent = solo ? `It is not ${ownerName}'s turn.` : 'Not your piece or not your turn.';
  } else if (currentView && currentView.status.kind !== 'playing') {
    stanceHint.textContent = 'The game is over.';
  } else if (currentView && currentView.players[currentView.turn].pendingDraws > 0) {
    stanceHint.textContent = 'Draw a card first.';
  } else {
    stanceHint.textContent = '';
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
  const canEnd = view.legalActions.some((a) => a.type === 'endTurn');
  endTurnBtn.disabled = !canEnd;
  endTurnBtn.classList.toggle('ready', canEnd && view.turnInfo.majorAction !== null);
  turnTrack.classList.toggle('hidden', !mine || view.status.kind !== 'playing');

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

  const major = view.turnInfo.majorAction;
  trackMajor.className = `track ${major ? 'used' : 'ok'}`;
  trackMajor.textContent = major === 'move' ? 'Moved' : major === 'summon' ? 'Summoned' : 'Move / Summon';

  const turnNo = view.players[view.turn].turnsTaken;
  const drawIn = view.rules.drawEvery - (turnNo % view.rules.drawEvery);
  const mustDraw = view.players[view.turn].pendingDraws > 0;
  const side = view.turn === 'white' ? 'White' : 'Black';
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

const chatEl = $('chat');
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
    who.textContent = mine ? 'You' : solo ? (m.from === 'white' ? 'White' : 'Black') : m.name;
    const text = document.createElement('span');
    text.textContent = m.text;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    line.append(who, text, time);
    chatLog.appendChild(line);
  }
  while (chatLog.children.length > 80) chatLog.firstChild?.remove();
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
    case 'chat':
      appendChat(msg.messages);
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
