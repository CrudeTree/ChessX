// The rules-2 game screen: a plain-DOM board (8x8), your hand, mana, seals, and the turn controls.
// The original (rules 1) game keeps its own Pixi renderer in ../game/GameView.ts.

import { v2 } from '@chessx/engine';
import type { RoomInfo } from '@chessx/protocol';
import { describeEvents, type PieceMemory } from './log.js';

type Color = v2.Color;
type Action = v2.Action;

export interface ClockText {
  text: string;
  running: boolean;
  low: boolean;
}

export interface GameScreenHooks {
  /** Send a rules-2 action to the server. */
  act(action: Action): void;
  /** Resign (or cancel the invite, if nobody has joined). Main decides which. */
  resign(): void;
  leave(): void;
  names(): Record<Color, string>;
  /** Clock for a side, or null in practice games. */
  clock(color: Color): ClockText | null;
}

/** Glyphs for the placeholder cards; any other piece falls back to its initial. */
const GLYPHS: Record<string, string> = {
  king: '♚',
  initiate: '✚',
  squire: '♟',
  hopper: '♞',
  cathedral_runner: '♝',
  tower: '♜',
};
export const glyphFor = (kind: string, name: string): string => GLYPHS[kind] ?? (name[0] ?? '?').toUpperCase();

type Mode = 'deploy' | 'summon' | 'seal' | 'spell';

/** A card being dragged from the hand. `ghost` is null until the pointer has moved past the threshold. */
interface CardDrag {
  uid: string;
  pointerId: number;
  startX: number;
  startY: number;
  ghost: HTMLElement | null;
  hover: v2.Square | null;
}

/** Pixels the pointer must travel before a press on a card becomes a drag rather than a click. */
const DRAG_THRESHOLD = 6;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export class GameScreen {
  private view: v2.PlayerView | null = null;
  private room: RoomInfo | null = null;
  private solo = false;
  private code = '';
  /** Which colour sits at the bottom of the board. */
  private seat: Color = 'white';

  private selectedSquare: v2.Square | null = null;
  private selectedCard: string | null = null;
  private mode: Mode | null = null;
  private drag: CardDrag | null = null;
  private suppressClick = false;

  private readonly memory: PieceMemory = new Map();
  private lastSeq = -1;

  // DOM
  private readonly boardEl = el('div', 'g2-board');
  private readonly handEl = el('div', 'g2-hand');
  private readonly actionsEl = el('div', 'g2-actions');
  private readonly statusEl = el('div', 'status g2-status');
  private readonly logEl = el('div', 'g2-log');
  private readonly endBtn = el('button', 'primary g2-end', 'End turn');
  private readonly codeEl = el('div', 'code', '-----');
  private readonly hintEl = el('div', 'hint');
  private readonly oppEl = el('div', 'g2-player');
  private readonly meEl = el('div', 'g2-player');
  private readonly oppHandEl = el('div', 'g2-oppcards');
  private readonly resignBtn = el('button', 'danger', 'Resign');
  /** Chat is moved in here so it sits with the rest of the screen. */
  readonly chatSlot = el('div', 'g2-chat-slot');
  private readonly cells: HTMLElement[] = [];

  constructor(
    readonly root: HTMLElement,
    private hooks: GameScreenHooks,
  ) {
    const main = el('div', 'g2-main');
    const boardWrap = el('div', 'g2-boardwrap');
    boardWrap.append(this.oppEl, this.boardEl, this.meEl);
    main.append(boardWrap, this.handEl, this.actionsEl);

    const side = el('aside', 'g2-side');
    const codeBlock = el('div', 'side-block');
    codeBlock.append(el('div', 'label', 'Invite code'), this.codeEl, this.hintEl);
    const statusBlock = el('div', 'side-block g2-statusblock');
    statusBlock.append(this.statusEl, this.endBtn);
    const logBlock = el('div', 'side-block grow');
    logBlock.append(el('div', 'label', 'Log'), this.logEl);
    const buttons = el('div', 'side-block actions');
    const leave = el('button', '', 'Back to games');
    leave.onclick = () => this.hooks.leave();
    this.resignBtn.onclick = () => this.hooks.resign();
    buttons.append(this.resignBtn, leave);
    side.append(codeBlock, statusBlock, logBlock, buttons, this.chatSlot);

    root.append(main, side);

    this.endBtn.onclick = () => this.hooks.act({ type: 'endTurn' });
    this.buildBoard();
    this.boardEl.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-sq]');
      if (cell) this.onSquare(Number(cell.dataset.sq));
    });
  }

  // ------------------------------------------------------------------ lifecycle

  open(opts: { code: string; solo: boolean; you: Color }): void {
    this.reset();
    this.code = opts.code;
    this.solo = opts.solo;
    this.seat = opts.solo ? 'white' : opts.you;
    this.codeEl.textContent = opts.solo ? 'PRACTICE' : opts.code;
    this.hintEl.textContent = opts.solo ? 'You play both sides.' : 'Send this to a friend. They enter it under "Join".';
    this.hintEl.classList.toggle('hidden', opts.solo);
    this.buildBoard();
    this.renderPlayers();
  }

  reset(): void {
    this.cancelDrag();
    this.view = null;
    this.room = null;
    this.selectedSquare = null;
    this.selectedCard = null;
    this.mode = null;
    this.memory.clear();
    this.lastSeq = -1;
    this.logEl.innerHTML = '';
    this.handEl.innerHTML = '';
    this.actionsEl.innerHTML = '';
    this.statusEl.textContent = 'Setting up the board…';
    this.statusEl.className = 'status g2-status';
    this.endBtn.classList.add('hidden');
  }

  setRoom(room: RoomInfo): void {
    this.room = room;
    this.renderPlayers();
    const waiting = !this.solo && !(room.players.white && room.players.black);
    this.resignBtn.textContent = waiting ? 'Cancel invite' : 'Resign';
    if (waiting && !this.view) this.statusEl.textContent = 'Waiting for an opponent to join. Share the invite code!';
  }

  /** The newest game state. */
  sync(view: v2.PlayerView): void {
    const first = this.view === null;
    this.view = view;
    for (const p of view.pieces) this.memory.set(p.id, { name: p.name, owner: p.owner });
    // A move or card choice only makes sense against the position it was made in.
    if (!first && view.seq !== this.lastSeq) {
      this.clearSelection();
      this.cancelDrag();
    }
    if (this.selectedCard && !view.hand?.some((c) => c.uid === this.selectedCard)) this.clearSelection();
    this.appendLog(view);
    this.render();
  }

  /** Refresh clocks (called every second by the host). */
  tick(): void {
    this.renderPlayers();
  }

  // --------------------------------------------------------------------- board

  private buildBoard(): void {
    this.boardEl.innerHTML = '';
    this.cells.length = 0;
    const flipped = this.seat === 'black';
    // Rows top to bottom: the far side first.
    for (let row = 0; row < v2.RANKS; row++) {
      const rank = flipped ? row : v2.RANKS - 1 - row;
      for (let col = 0; col < v2.FILES; col++) {
        const file = flipped ? v2.FILES - 1 - col : col;
        const square = v2.sq(file, rank);
        const cell = el('div', `g2-cell ${(file + rank) % 2 === 0 ? 'dark' : 'light'}`);
        cell.dataset.sq = String(square);
        if (col === 0) cell.append(el('span', 'g2-coord rank', String(rank + 1)));
        if (row === v2.RANKS - 1) cell.append(el('span', 'g2-coord file', v2.FILE_NAMES[file]!));
        this.boardEl.appendChild(cell);
        this.cells[square] = cell;
      }
    }
  }

  private legal(): Action[] {
    return this.view?.legalActions ?? [];
  }

  /** Squares the current selection can act on, with the action each leads to. */
  private targets(): Map<v2.Square, Action> {
    const out = new Map<v2.Square, Action>();
    if (this.selectedSquare !== null) {
      for (const a of this.legal()) if (a.type === 'move' && a.from === this.selectedSquare) out.set(a.to, a);
    } else if (this.selectedCard && this.mode) {
      for (const a of this.legal()) {
        if (!('cardUid' in a) || a.cardUid !== this.selectedCard || a.type !== this.mode) continue;
        if (a.type === 'deploy' || a.type === 'summon') out.set(a.to, a);
        else if (a.type === 'seal') out.set(a.target, a);
        else if (a.type === 'spell' && a.target !== undefined) out.set(a.target, a);
      }
    }
    return out;
  }

  private onSquare(square: v2.Square): void {
    const view = this.view;
    if (!view || view.status.kind !== 'playing') return;
    const target = this.targets().get(square);
    if (target) {
      this.hooks.act(target);
      this.clearSelection();
      this.render();
      return;
    }
    const mine = view.pieces.find((p) => p.square === square && p.owner === view.you);
    const hasMoves = mine && this.legal().some((a) => a.type === 'move' && a.from === square);
    if (mine && hasMoves && this.selectedSquare !== square) {
      this.selectedSquare = square;
      this.selectedCard = null;
      this.mode = null;
    } else {
      this.clearSelection();
    }
    this.render();
  }

  private clearSelection(): void {
    this.selectedSquare = null;
    this.selectedCard = null;
    this.mode = null;
  }

  // ---------------------------------------------------------------------- hand

  /** What a card can do right now, according to the server's list of legal actions. */
  private optionsFor(uid: string): Mode[] {
    const kinds = new Set<Mode>();
    for (const a of this.legal()) {
      if ('cardUid' in a && a.cardUid === uid) kinds.add(a.type as Mode);
    }
    return (['deploy', 'summon', 'seal', 'spell'] as Mode[]).filter((m) => kinds.has(m));
  }

  private selectCard(uid: string): void {
    if (this.selectedCard === uid) {
      this.clearSelection();
      this.render();
      return;
    }
    this.selectedSquare = null;
    this.selectedCard = uid;
    const options = this.optionsFor(uid);
    this.mode = options.length === 1 ? options[0]! : null;
    // A spell that needs no target is played straight away.
    if (this.mode === 'spell') {
      const spell = this.legal().filter((a) => a.type === 'spell' && a.cardUid === uid);
      if (spell.length === 1 && spell[0]!.type === 'spell' && spell[0]!.target === undefined) {
        this.hooks.act(spell[0]!);
        this.clearSelection();
      }
    }
    this.render();
  }

  private cardTile(uid: string, cardId: string, view: v2.PlayerView): HTMLElement {
    const card = view.cards[cardId];
    const options = this.optionsFor(uid);
    const liftable = this.canLift(view, cardId);
    const lifted = this.drag?.ghost && this.drag.uid === uid;
    const tile = el(
      'button',
      `g2-card ${card?.type ?? ''}${options.length ? ' playable' : ''}${this.selectedCard === uid ? ' selected' : ''}${liftable ? ' draggable' : ''}${lifted ? ' lifted' : ''}`,
    );
    tile.type = 'button';
    tile.dataset.uid = uid;
    tile.disabled = !options.length && !liftable;
    if (liftable) tile.addEventListener('pointerdown', (e) => this.pressCard(e, uid, tile));
    tile.append(el('span', 'g2-cost', String(card?.cost ?? '?')), el('span', 'g2-cardname', card?.name ?? cardId));
    tile.append(el('span', 'g2-cardtype', card?.type === 'spell' ? 'Spell' : 'Piece'));
    tile.append(el('span', 'g2-cardtext', card?.text ?? ''));
    if (card?.type === 'piece') tile.append(el('span', 'g2-cardseal', `Seal: hatches in ${card.sealTimer} turn${card.sealTimer === 1 ? '' : 's'}`));
    tile.title = `${card?.name}: ${card?.text}`;
    tile.onclick = () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      if (options.length) this.selectCard(uid);
    };
    return tile;
  }

  // ---------------------------------------------------------------------- drag

  /** Piece cards can be picked up on your own turn, even when no drop is legal (they then snap back). */
  private canLift(view: v2.PlayerView, cardId: string): boolean {
    return view.cards[cardId]?.type === 'piece' && view.status.kind === 'playing' && (this.solo || view.active === view.you);
  }

  /** Squares a held card can be dropped on: a free back-row square summons (or deploys), an own piece seals. */
  private dropTargets(uid: string): Map<v2.Square, Action> {
    const out = new Map<v2.Square, Action>();
    for (const a of this.legal()) {
      if (!('cardUid' in a) || a.cardUid !== uid) continue;
      if (a.type === 'deploy' || a.type === 'summon') out.set(a.to, a);
      else if (a.type === 'seal') out.set(a.target, a);
    }
    return out;
  }

  private pressCard(e: PointerEvent, uid: string, tile: HTMLElement): void {
    if (e.button !== 0 || this.drag) return;
    // Stops the browser starting a text selection; the click still fires.
    if (e.pointerType === 'mouse') e.preventDefault();
    this.drag = {
      uid,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      ghost: null,
      hover: null,
    };
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragEnd);
    window.addEventListener('pointercancel', this.onDragEnd);
  }

  private readonly onDragMove = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.ghost) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      const tile = this.tileFor(drag.uid);
      if (!tile) return this.cancelDrag();
      const ghost = tile.cloneNode(true) as HTMLElement;
      ghost.classList.remove('selected', 'lifted');
      ghost.classList.add('g2-drag-ghost');
      if (!this.dropTargets(drag.uid).size) ghost.classList.add('nowhere');
      ghost.style.width = `${tile.offsetWidth}px`;
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      this.clearSelection();
      this.render();
    }
    e.preventDefault();
    // The card hangs above the pointer so the square it would land on stays visible.
    drag.ghost.style.left = `${e.clientX - drag.ghost.offsetWidth / 2}px`;
    drag.ghost.style.top = `${e.clientY - drag.ghost.offsetHeight - 6}px`;
    const square = this.squareAt(e.clientX, e.clientY);
    const hover = square !== null && this.dropTargets(drag.uid).has(square) ? square : null;
    if (hover !== drag.hover) {
      if (drag.hover !== null) this.cells[drag.hover]?.classList.remove('drop-hover');
      if (hover !== null) this.cells[hover]?.classList.add('drop-hover');
      drag.hover = hover;
    }
  };

  private readonly onDragEnd = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.removeDragListeners();
    const ghost = drag.ghost;
    if (!ghost) {
      this.drag = null;
      return;
    }
    // The click that follows a drag must not also select the card.
    this.suppressClick = true;
    setTimeout(() => (this.suppressClick = false), 0);
    const square = e.type === 'pointerup' ? this.squareAt(e.clientX, e.clientY) : null;
    const action = square !== null ? this.dropTargets(drag.uid).get(square) : undefined;
    this.drag = null;
    if (action) {
      ghost.remove();
      this.hooks.act(action);
      this.clearSelection();
      this.render();
      return;
    }
    this.render();
    this.snapBack(ghost, drag.uid);
  };

  /** Slide an illegally dropped card back to its place in the hand. */
  private snapBack(ghost: HTMLElement, uid: string): void {
    const home = this.tileFor(uid)?.getBoundingClientRect();
    if (!home) return ghost.remove();
    ghost.classList.add('returning');
    ghost.style.left = `${home.left}px`;
    ghost.style.top = `${home.top}px`;
    setTimeout(() => ghost.remove(), 220);
  }

  private cancelDrag(): void {
    if (!this.drag) return;
    this.removeDragListeners();
    this.drag.ghost?.remove();
    this.drag = null;
    if (this.view) this.render();
  }

  private removeDragListeners(): void {
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
    window.removeEventListener('pointercancel', this.onDragEnd);
  }

  private tileFor(uid: string): HTMLElement | null {
    return this.handEl.querySelector<HTMLElement>(`[data-uid="${CSS.escape(uid)}"]`);
  }

  private squareAt(x: number, y: number): v2.Square | null {
    const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-sq]');
    return cell && this.boardEl.contains(cell) ? Number(cell.dataset.sq) : null;
  }

  private renderHand(view: v2.PlayerView): void {
    this.handEl.innerHTML = '';
    const label = el('div', 'g2-handlabel');
    label.textContent = this.solo ? `${this.name(view.you)}'s hand` : 'Your hand';
    if (view.hand?.some((c) => this.canLift(view, c.cardId))) {
      label.append(el('span', 'g2-handtip', ' · drag a piece card to your back row to summon it, or onto one of your pieces to seal'));
    }
    this.handEl.appendChild(label);
    const row = el('div', 'g2-handrow');
    for (const c of view.hand ?? []) row.appendChild(this.cardTile(c.uid, c.cardId, view));
    if (!view.hand?.length) row.appendChild(el('span', 'hint', 'No cards in hand.'));
    this.handEl.appendChild(row);
  }

  private renderActions(view: v2.PlayerView): void {
    this.actionsEl.innerHTML = '';
    const uid = this.selectedCard;
    if (!uid) return;
    const card = view.hand?.find((c) => c.uid === uid);
    const info = card ? view.cards[card.cardId] : undefined;
    const options = this.optionsFor(uid);
    const bar = el('div', 'g2-choose');
    bar.append(el('b', '', info?.name ?? 'Card'));
    const labels: Record<Mode, string> = {
      deploy: 'Deploy',
      summon: `Summon (${info?.cost ?? 0} mana)`,
      seal: `Seal onto one of your pieces (${info?.cost ?? 0} mana)`,
      spell: `Cast (${info?.cost ?? 0} mana)`,
    };
    for (const m of options) {
      const b = el('button', this.mode === m ? 'primary' : '', labels[m]);
      b.onclick = () => {
        this.mode = m;
        this.render();
      };
      bar.appendChild(b);
    }
    const cancel = el('button', '', 'Cancel');
    cancel.onclick = () => {
      this.clearSelection();
      this.render();
    };
    bar.appendChild(cancel);
    if (this.mode) {
      bar.appendChild(
        el(
          'span',
          'hint',
          this.mode === 'deploy' || this.mode === 'summon' ? 'Pick a free square on your back row.' : this.mode === 'seal' ? 'Pick one of your own pieces (not the King). It is consumed.' : 'Pick a seal.',
        ),
      );
    } else if (options.length > 1) {
      bar.appendChild(el('span', 'hint', 'Choose what to do with it.'));
    }
    this.actionsEl.appendChild(bar);
  }

  // -------------------------------------------------------------------- render

  private name(color: Color): string {
    return this.hooks.names()[color];
  }

  private render(): void {
    const view = this.view;
    if (!view) return;
    const held = this.drag?.ghost ? this.drag : null;
    const targets = held ? new Map<v2.Square, Action>() : this.targets();
    const drops = held ? this.dropTargets(held.uid) : new Map<v2.Square, Action>();
    const lastMove = view.events.find((e): e is Extract<v2.GameEvent, { type: 'moved' }> => e.type === 'moved');

    for (let square = 0; square < v2.FILES * v2.RANKS; square++) {
      const cell = this.cells[square]!;
      const piece = view.pieces.find((p) => p.square === square);
      const seal = view.seals.find((s) => s.square === square);
      const classes = ['g2-cell', (v2.fileOf(square) + v2.rankOf(square)) % 2 === 0 ? 'dark' : 'light'];
      if (targets.has(square)) classes.push(piece || seal ? 'target capture' : 'target');
      const drop = drops.get(square);
      if (drop) classes.push(drop.type === 'seal' ? 'drop drop-seal' : 'drop');
      if (held && held.hover === square) classes.push('drop-hover');
      if (this.selectedSquare === square) classes.push('selected');
      if (lastMove && (lastMove.from === square || lastMove.to === square)) classes.push('last');
      if (piece?.king && piece.owner === view.active && view.inCheck) classes.push('check');
      cell.className = classes.join(' ');
      // Keep the coordinate labels, replace the rest.
      for (const child of [...cell.children]) if (!child.classList.contains('g2-coord')) child.remove();
      if (piece) {
        const tok = el('div', `g2-piece ${piece.owner}${piece.active ? '' : ' sick'}`, glyphFor(piece.kind, piece.name));
        tok.title = `${piece.name}${piece.active ? '' : ' (summoning sickness: cannot capture or give check yet)'}`;
        cell.appendChild(tok);
      } else if (seal) {
        const tok = el('div', `g2-seal ${seal.owner}`);
        const name = view.cards[seal.cardId]?.name ?? seal.cardId;
        tok.append(el('span', 'g2-seal-timer', `⧗${seal.timer}`), el('span', 'g2-seal-name', name));
        tok.title = `Seal: ${name} hatches in ${seal.timer} of ${seal.owner === view.you ? 'your' : "its owner's"} turn${seal.timer === 1 ? '' : 's'}`;
        cell.appendChild(tok);
      }
    }

    this.renderHand(view);
    this.renderActions(view);
    this.renderPlayers();
    this.renderStatus(view);
  }

  private renderPlayers(): void {
    const view = this.view;
    const top: Color = this.seat === 'white' ? 'black' : 'white';
    for (const [elx, color] of [
      [this.oppEl, top],
      [this.meEl, this.seat],
    ] as const) {
      elx.innerHTML = '';
      elx.className = `g2-player ${color}`;
      const seat = this.room?.players[color];
      const label = this.solo ? (color === 'white' ? 'White' : 'Black') : seat ? seat.name + (color === this.seat ? ' (you)' : '') : 'Waiting for opponent…';
      if (seat && !seat.connected && !this.solo) elx.classList.add('offline');
      const who = el('div', 'g2-who');
      who.append(el('span', 'dot'), el('span', 'pname', label));
      const clock = this.hooks.clock(color);
      if (clock) {
        who.append(el('span', `clock ${clock.running ? 'running' : ''} ${clock.low ? 'low' : ''}`, `⏱ ${clock.text}`));
      }
      elx.appendChild(who);
      if (view) {
        const stats = el('div', 'g2-stats');
        const turn = view.status.kind === 'playing' && view.active === color;
        if (turn) elx.classList.add('turn');
        stats.append(
          el('span', 'g2-mana', `◆ ${view.mana[color]} mana`),
          el('span', '', `Hand ${view.handCount[color]}`),
          el('span', '', `Deck ${view.deckCount[color]}`),
          el('span', '', `Discard ${view.discard[color].length}`),
        );
        if (view.discard[color].length) {
          stats.lastElementChild!.setAttribute('title', view.discard[color].map((c) => view.cards[c.cardId]?.name ?? c.cardId).join(', '));
        }
        elx.appendChild(stats);
      }
    }
  }

  private renderStatus(view: v2.PlayerView): void {
    const s = this.statusEl;
    s.className = 'status g2-status';
    const playing = view.status.kind === 'playing';
    const mine = this.solo || view.active === view.you;
    const who = this.solo ? this.name(view.active) : 'You';
    const canEnd = view.legalActions.some((a) => a.type === 'endTurn');
    this.endBtn.classList.toggle('hidden', !playing || !canEnd);
    this.endBtn.classList.toggle('ready', canEnd);

    if (!playing) {
      s.classList.add('over');
      const st = view.status;
      const winner = 'winner' in st ? st.winner : null;
      const how = st.kind === 'timeout' ? ' (out of time)' : st.kind === 'resigned' ? ' (resignation)' : '';
      s.textContent =
        st.kind === 'stalemate' ? 'Stalemate — draw.'
        : this.solo ? `${this.name(winner!)} wins!${how}`
        : winner === view.you ? `You win!${how}` : `You lose.${how}`;
      return;
    }
    if (mine) s.classList.add('mine');
    if (view.inCheck) s.classList.add('check');

    if (view.phase === 'setup') {
      const n = view.setupDeployed[view.active];
      s.textContent = mine
        ? `${who}: deploy a zero-cost piece to your back row (${n} of ${view.setupTotal} placed).`
        : `Opponent is deploying their starting pieces (${n} of ${view.setupTotal}).`;
      return;
    }
    const turn = view.turns[view.active];
    if (!mine) {
      s.textContent = `Opponent's turn (${turn}).`;
      return;
    }
    const check = view.inCheck ? ' You are in CHECK — get your King out of it.' : '';
    s.textContent = view.actionTaken
      ? `${who}: action done.${view.spellPlayed ? '' : ' You may still play one spell.'} End the turn when ready.`
      : `${who}: turn ${turn}, ${view.mana[view.active]} mana. Move, summon or seal${view.spellPlayed ? '' : ' (and play one spell)'}.${check}`;
  }

  private appendLog(view: v2.PlayerView): void {
    if (view.seq === this.lastSeq) return;
    this.lastSeq = view.seq;
    const names = this.hooks.names();
    for (const line of describeEvents(view, names, this.memory)) {
      const div = el('div', `entry ${line.color ?? ''} ${line.important ? 'important' : ''}`, line.text);
      this.logEl.appendChild(div);
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** Whose turn it is, for the host's "your move" alerts. */
  get myTurn(): boolean {
    return !!this.view && this.view.status.kind === 'playing' && !this.solo && this.view.active === this.view.you;
  }

  get currentView(): v2.PlayerView | null {
    return this.view;
  }

  get statusText(): string {
    return this.statusEl.textContent ?? '';
  }
}
