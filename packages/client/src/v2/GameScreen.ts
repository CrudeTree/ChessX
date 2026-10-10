// The rules-2 game screen: a plain-DOM board (8x8), your hand, mana, seals, and the turn controls.
// The original (rules 1) game keeps its own Pixi renderer in ../game/GameView.ts.

import { v2 } from '@chessx/engine';
import type { RoomInfo } from '@chessx/protocol';
import { fillFrame, type FrameCard } from './cardFrame.js';
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
  page: '¶',
  hopper: '♞',
  cathedral_runner: '♝',
  dawn_paladin: '☀\uFE0E',
  duskfang: '☾\uFE0E',
  wyrmling: '§',
  eclipse_knight: '◐\uFE0E',
  tower: '♜',
};
export const glyphFor = (kind: string, name: string): string => GLYPHS[kind] ?? (name[0] ?? '?').toUpperCase();
/** Picture window of a spell card that has no picture yet. */
const SPELL_GLYPH = '✦\uFE0E';

type Mode = 'deploy' | 'summon' | 'seal' | 'spell';

/**
 * A press on a card in the hand. `ghost` is null until the pointer has moved past the threshold.
 * A mostly sideways mouse drag scrolls the hand instead (`scrollFrom`); touch swipes scroll natively.
 */
interface CardDrag {
  uid: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  scrollFrom: number | null;
  ghost: HTMLElement | null;
  hover: v2.Square | null;
}

/** Pixels the pointer must travel before a press on a card becomes a drag rather than a click. */
const DRAG_THRESHOLD = 6;

/** A press on the board only counts as a tap if it stays within TAP_SLOP pixels; only a quick one opens a card. */
const TAP_SLOP = 10;
const TAP_MS = 450;

/**
 * Whose card the inspect panel over the board shows: a piece or seal (followed as it moves),
 * or a card in your hand (tapped on a touch screen).
 */
interface Inspected {
  kind: 'piece' | 'seal' | 'card';
  id: string;
}

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
  private inspected: Inspected | null = null;
  /** Hand card under the mouse; it is shown in the inspect panel until the mouse leaves. */
  private hoverCard: string | null = null;
  private boardPress: { x: number; y: number; at: number } | null = null;
  /** Pointer type of the last press on a hand card: a mouse previews cards by hovering, a finger by tapping. */
  private tilePointer = 'mouse';

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
  /** Under a thumb the hovered square is hidden, so a touch drag repeats its seal warning here. */
  private readonly dropNoteEl = el('div', 'g2-dropnote hidden');
  private readonly dropTagEl = el('div', 'g2-droptag');
  private readonly oppEl = el('div', 'g2-player');
  private readonly meEl = el('div', 'g2-player');
  private readonly oppHandEl = el('div', 'g2-oppcards');
  private readonly resignBtn = el('button', 'danger', 'Resign');
  private readonly inspectEl = el('div', 'g2-inspect hidden');
  /** "Spell, then one action" on the board's top edge during your turn. */
  private readonly cueEl = el('div', 'g2-cue hidden');
  private readonly sideEl = el('aside', 'g2-side');
  private readonly codeBlock = el('div', 'side-block');
  private readonly statusBlock = el('div', 'side-block g2-statusblock');
  private readonly menuBtn = el('button', 'g2-menu', '☰');
  private readonly sheetShade = el('div', 'g2-sheet-shade hidden');
  /**
   * Phones fit the whole game on one screen, so a pull on a card never fights a page scroll: the status and
   * End turn sit under the hand, and the rest of the side column becomes a sheet behind the ☰ button.
   */
  private readonly narrow = window.matchMedia('(max-width: 899px)');
  /** Chat is moved in here so it sits with the rest of the screen. */
  readonly chatSlot = el('div', 'g2-chat-slot');
  private readonly cells: HTMLElement[] = [];

  constructor(
    readonly root: HTMLElement,
    private hooks: GameScreenHooks,
  ) {
    const main = el('div', 'g2-main');
    const boardWrap = el('div', 'g2-boardwrap');
    const boardBox = el('div', 'g2-boardbox');
    boardBox.append(this.boardEl, this.inspectEl, this.cueEl);
    boardWrap.append(this.oppEl, boardBox, this.meEl);
    main.append(boardWrap, this.handEl, this.actionsEl);

    const side = this.sideEl;
    const sheetClose = el('button', 'g2-sheet-close', 'Close');
    sheetClose.type = 'button';
    sheetClose.onclick = () => this.toggleSheet(false);
    this.codeBlock.append(el('div', 'label', 'Invite code'), this.codeEl, this.hintEl);
    this.menuBtn.type = 'button';
    this.menuBtn.title = 'Log, chat, invite code and resign';
    this.menuBtn.onclick = () => this.toggleSheet();
    this.statusBlock.append(this.statusEl, this.endBtn, this.menuBtn);
    const logBlock = el('div', 'side-block grow');
    logBlock.append(el('div', 'label', 'Log'), this.logEl);
    const buttons = el('div', 'side-block actions');
    const leave = el('button', '', 'Back to games');
    leave.onclick = () => this.hooks.leave();
    this.resignBtn.onclick = () => this.hooks.resign();
    buttons.append(this.resignBtn, leave);
    side.append(sheetClose, this.codeBlock, this.statusBlock, logBlock, buttons, this.chatSlot);
    this.sheetShade.onclick = () => this.toggleSheet(false);

    root.append(main, side, this.sheetShade);
    this.placeStatus();
    this.narrow.addEventListener('change', () => this.placeStatus());

    this.endBtn.onclick = () => this.hooks.act({ type: 'endTurn' });
    this.buildBoard();
    boardBox.addEventListener('pointerdown', (e) => {
      this.boardPress = { x: e.clientX, y: e.clientY, at: performance.now() };
    });
    this.boardEl.addEventListener('click', (e) => {
      const tap = this.boardTap(e);
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-sq]');
      if (tap && cell) this.onSquare(Number(cell.dataset.sq), tap === 'quick');
    });
    this.inspectEl.addEventListener('click', (e) => {
      if (!this.boardTap(e)) return;
      this.inspected = null;
      this.hoverCard = null;
      this.render();
    });
  }

  /** A press that wandered off is a drag, and a drag on the board does nothing; only a quick tap opens a card. */
  private boardTap(e: MouseEvent): 'quick' | 'slow' | null {
    const press = this.boardPress;
    this.boardPress = null;
    if (!press) return 'quick';
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP) return null;
    return performance.now() - press.at < TAP_MS ? 'quick' : 'slow';
  }

  private placeStatus(): void {
    if (this.narrow.matches) this.handEl.after(this.statusBlock);
    else {
      this.codeBlock.after(this.statusBlock);
      this.toggleSheet(false);
    }
  }

  private toggleSheet(open = !this.sideEl.classList.contains('open')): void {
    this.sideEl.classList.toggle('open', open);
    this.sheetShade.classList.toggle('hidden', !open);
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
    this.inspected = null;
    this.hoverCard = null;
    this.inspectEl.classList.add('hidden');
    this.cueEl.classList.add('hidden');
    this.handEl.classList.remove('spent');
    this.memory.clear();
    this.lastSeq = -1;
    this.logEl.innerHTML = '';
    this.handEl.innerHTML = '';
    this.actionsEl.innerHTML = '';
    this.statusEl.textContent = 'Setting up the board…';
    this.statusEl.className = 'status g2-status';
    this.endBtn.classList.add('hidden');
    this.toggleSheet(false);
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

  private onSquare(square: v2.Square, quick = true): void {
    const view = this.view;
    if (!view) return;
    const playing = view.status.kind === 'playing';
    const target = playing ? this.targets().get(square) : undefined;
    if (target) {
      this.hooks.act(target);
      this.clearSelection();
      this.inspected = null;
      this.render();
      return;
    }
    if (quick) this.toggleInspect(view, square);
    if (!playing) {
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

  /** A tap on a piece or seal opens its card; tapping the same one again, or an empty square, closes it. */
  private toggleInspect(view: v2.PlayerView, square: v2.Square): void {
    const piece = view.pieces.find((p) => p.square === square);
    const seal = piece ? undefined : view.seals.find((s) => s.square === square);
    const next: Inspected | null = piece ? { kind: 'piece', id: piece.id } : seal ? { kind: 'seal', id: seal.id } : null;
    const same = next && this.inspected?.kind === next.kind && this.inspected.id === next.id;
    this.inspected = same ? null : next;
  }

  // ------------------------------------------------------------------- inspect

  private inspectedSquare(view: v2.PlayerView): v2.Square | null {
    const it = this.inspected;
    if (!it || it.kind === 'card') return null;
    const found = it.kind === 'piece' ? view.pieces.find((p) => p.id === it.id) : view.seals.find((s) => s.id === it.id);
    return found ? found.square : null;
  }

  private renderInspect(view: v2.PlayerView): void {
    const box = this.inspectEl;
    box.innerHTML = '';
    if (this.hoverCard && !view.hand?.some((c) => c.uid === this.hoverCard)) this.hoverCard = null;
    const it = this.inspected;
    const handUid = this.hoverCard ?? (it?.kind === 'card' ? it.id : null);
    const handCard = handUid ? view.hand?.find((c) => c.uid === handUid) : undefined;
    const piece = !handCard && it?.kind === 'piece' ? view.pieces.find((p) => p.id === it.id) : undefined;
    const seal = !handCard && it?.kind === 'seal' ? view.seals.find((s) => s.id === it.id) : undefined;
    if (it && !piece && !seal && !(it.kind === 'card' && handCard)) this.inspected = null;

    let frame: FrameCard;
    let card: v2.ViewCard | undefined;
    let owner: Color = view.you;
    const notes: string[] = [];
    if (handCard) {
      card = view.cards[handCard.cardId];
      frame = this.frameFor(card, handCard.cardId, owner);
      notes.push('In your hand.');
    } else if (piece) {
      card = piece.cardId ? view.cards[piece.cardId] : undefined;
      owner = piece.owner;
      if (piece.king) {
        frame = { kind: 'king', name: piece.name, text: v2.describeMovement(v2.KING), glyph: glyphFor(piece.kind, piece.name), owner, rules: v2.KING.rules };
        notes.push('No card: the King cannot be summoned or sealed.');
      } else {
        frame = this.frameFor(card, piece.kind, owner, piece.name);
      }
      if (!piece.active) notes.push('Summoning sickness: cannot capture yet, but still gives check.');
    } else if (seal) {
      card = view.cards[seal.cardId];
      owner = seal.owner;
      frame = this.frameFor(card, seal.cardId, owner);
      const whose = this.solo ? `${this.ownerLabel(owner, view)}'s` : owner === view.you ? 'your' : "your opponent's";
      const when = seal.timer <= 1 ? `at the start of ${whose} next turn` : `in ${seal.timer} of ${whose} turns`;
      notes.push(`Sealed. Hatches into this piece ${when}.`);
    } else {
      box.className = 'g2-inspect hidden';
      return;
    }
    // Over the half of the board away from the piece; a hand card goes up top, clear of your back row.
    const at = piece ?? seal;
    const atBottom = at !== undefined && this.screenRow(at.square) < v2.RANKS / 2;
    box.className = `g2-inspect ${atBottom ? 'at-bottom' : 'at-top'}${this.drag?.ghost ? ' hidden' : ''}`;
    box.title = 'Tap to close';

    box.append(fillFrame(el('div', 'g2-inspect-card'), frame, this.seat === 'black'));

    const side = el('div', 'g2-inspect-side');
    const close = el('button', 'g2-inspect-close', '×');
    close.type = 'button';
    close.title = 'Close';
    side.append(close);
    if (seal) side.append(el('b', 'g2-inspect-name', `Seal: ${frame.name}`));
    const facts: string[] = [];
    if (!handCard) facts.push(this.ownerLabel(owner, view));
    if (card) facts.push(`${card.cost} mana`);
    if (card?.type === 'piece') facts.push(`seal timer ${card.sealTimer}`);
    if (facts.length) side.append(el('div', 'g2-inspect-facts', facts.join(' · ')));
    for (const n of notes) side.append(el('div', 'g2-inspect-note', n));
    if (frame.rules) side.append(el('div', 'g2-inspect-legend', 'Green dot: moves there. Red ring: captures there.'));
    box.append(side);
  }

  /** The frame for a card, or for a piece whose card is missing from the view (name only). */
  private frameFor(card: v2.ViewCard | undefined, kind: string, owner: Color, name = card?.name ?? kind): FrameCard {
    if (!card) return { kind: 'piece', name, text: '', glyph: glyphFor(kind, name), owner };
    return {
      kind: card.type,
      name: card.name,
      cost: card.cost,
      sealTimer: card.sealTimer,
      text: card.text,
      art: card.art,
      glyph: card.type === 'spell' ? SPELL_GLYPH : glyphFor(card.id, card.name),
      owner,
      rules: card.rules,
    };
  }

  /** 0 for the top row of the board as this player sees it. */
  private screenRow(square: v2.Square): number {
    const rank = v2.rankOf(square);
    return this.seat === 'black' ? rank : v2.RANKS - 1 - rank;
  }

  private ownerLabel(owner: Color, view: v2.PlayerView): string {
    const side = owner === 'white' ? 'White' : 'Black';
    if (this.solo) return side;
    return `${side} (${owner === view.you ? 'yours' : 'opponent'})`;
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
    // A click on a spell that needs no target plays it straight away. A tap only opens it, because a
    // finger cannot hover to read a card first; it is then cast with the Cast button.
    if (this.mode === 'spell' && this.untargetedSpell(uid)) {
      if (this.tilePointer === 'mouse') this.castNow(uid);
      else this.mode = null;
    }
    this.render();
  }

  private untargetedSpell(uid: string): Action | null {
    const spell = this.legal().filter((a) => a.type === 'spell' && a.cardUid === uid);
    return spell.length === 1 && spell[0]!.type === 'spell' && spell[0]!.target === undefined ? spell[0]! : null;
  }

  private castNow(uid: string): void {
    const spell = this.untargetedSpell(uid);
    if (!spell) return;
    this.hooks.act(spell);
    this.clearSelection();
    if (this.inspected?.kind === 'card' && this.inspected.id === uid) this.inspected = null;
  }

  private cardTile(uid: string, cardId: string, view: v2.PlayerView): HTMLElement {
    const card = view.cards[cardId];
    const options = this.optionsFor(uid);
    const liftable = this.canLift(view, cardId);
    const lifted = this.drag?.ghost && this.drag.uid === uid;
    const tile = el(
      'button',
      `g2-card ${card?.type ?? ''}${options.length ? ' playable' : ''}${this.selectedCard === uid ? ' selected' : ''}${liftable ? ' draggable' : ''}${lifted ? ' lifted' : ''}${this.inspected?.kind === 'card' && this.inspected.id === uid ? ' inspected' : ''}`,
    );
    tile.type = 'button';
    tile.dataset.uid = uid;
    // Not `disabled`: a card you cannot play right now can still be tapped to read it.
    if (!options.length && !liftable) tile.setAttribute('aria-disabled', 'true');
    tile.addEventListener('pointerdown', (e) => {
      this.tilePointer = e.pointerType;
      if (liftable) this.pressCard(e, uid, tile);
    });
    if (card?.art) {
      // Phones shrink the frame to name and corners over the picture.
      tile.classList.add('has-art');
      tile.style.setProperty('--art', `url("${card.art}")`);
    }
    fillFrame(tile, this.frameFor(card, cardId, view.you), this.seat === 'black');
    tile.title = `${card?.name}: ${card?.text}`;
    tile.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || this.drag || this.hoverCard === uid) return;
      this.hoverCard = uid;
      this.renderInspect(view);
    });
    tile.addEventListener('pointerleave', () => {
      if (this.hoverCard !== uid) return;
      this.hoverCard = null;
      if (this.view) this.renderInspect(this.view);
    });
    tile.onclick = () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      if (this.tilePointer !== 'mouse') {
        const open = this.inspected?.kind === 'card' && this.inspected.id === uid;
        this.inspected = open ? null : { kind: 'card', id: uid };
      }
      if (options.length) this.selectCard(uid);
      else this.render();
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
    // Touch pointers are captured by the pressed tile, which is rebuilt when the drag starts;
    // released, the later events reach the window listeners.
    if (tile.hasPointerCapture(e.pointerId)) tile.releasePointerCapture(e.pointerId);
    this.drag = {
      uid,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      scrollFrom: null,
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
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const row = this.handEl.querySelector<HTMLElement>('.g2-handrow');
    if (drag.scrollFrom !== null) {
      if (row) row.scrollLeft = drag.scrollFrom - dx;
      return;
    }
    if (!drag.ghost) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      // Only a pull up towards the board picks the card up; a sideways swipe scrolls the hand.
      if (-dy < Math.abs(dx)) {
        if (e.pointerType === 'mouse' && row) {
          drag.scrollFrom = row.scrollLeft;
          return;
        }
        this.removeDragListeners();
        this.drag = null;
        return;
      }
      const tile = this.tileFor(drag.uid);
      if (!tile) return this.cancelDrag();
      const ghost = tile.cloneNode(true) as HTMLElement;
      ghost.classList.remove('selected', 'lifted');
      ghost.classList.add('g2-drag-ghost');
      if (!this.dropTargets(drag.uid).size) ghost.classList.add('nowhere');
      ghost.style.width = `${tile.offsetWidth}px`;
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      this.hoverCard = null;
      if (this.inspected?.kind === 'card') this.inspected = null;
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
      this.showSealWarning(drag);
    }
  };

  /** "seals Squire, gone for good" when the held card hovers one of your pieces; nothing for a summon. */
  private sealWarning(action: Action | undefined): string | null {
    if (action?.type !== 'seal') return null;
    const target = this.view?.pieces.find((p) => p.square === action.target);
    return `seals ${target?.name ?? 'this piece'}, gone for good`;
  }

  private showSealWarning(drag: CardDrag): void {
    const text = drag.hover === null ? null : this.sealWarning(this.dropTargets(drag.uid).get(drag.hover));
    const mouse = drag.pointerType === 'mouse';
    this.dropNoteEl.textContent = text ?? '';
    this.dropNoteEl.classList.toggle('hidden', !text || mouse);
    const cell = drag.hover === null ? undefined : this.cells[drag.hover];
    if (!text || !mouse || !cell) return this.dropTagEl.remove();
    // Below the square: the held card hangs above the pointer and would cover a tag placed there.
    this.dropTagEl.textContent = text;
    document.body.appendChild(this.dropTagEl);
    const box = cell.getBoundingClientRect();
    const half = this.dropTagEl.offsetWidth / 2;
    const x = Math.min(Math.max(box.left + box.width / 2, half + 4), window.innerWidth - half - 4);
    const y = Math.min(box.bottom + 4, window.innerHeight - this.dropTagEl.offsetHeight - 4);
    this.dropTagEl.style.left = `${x - half}px`;
    this.dropTagEl.style.top = `${y}px`;
  }

  private hideSealWarning(): void {
    this.dropNoteEl.classList.add('hidden');
    this.dropTagEl.remove();
  }

  private readonly onDragEnd = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.removeDragListeners();
    this.hideSealWarning();
    const ghost = drag.ghost;
    if (ghost || drag.scrollFrom !== null) {
      // The click that follows a drag must not also select the card.
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 0);
    }
    if (!ghost) {
      this.drag = null;
      return;
    }
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
    this.hideSealWarning();
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
    const scroll = this.handEl.querySelector('.g2-handrow')?.scrollLeft ?? 0;
    this.handEl.innerHTML = '';
    // The action ends the turn, so once it is taken the hand rests until the next turn.
    const spent = view.phase === 'play' && view.status.kind === 'playing' && !this.solo && view.active !== view.you;
    this.handEl.classList.toggle('spent', spent);
    const label = el('div', 'g2-handlabel');
    label.textContent = this.solo ? `${this.name(view.you)}'s hand` : spent ? 'Your hand · opponent\'s turn' : 'Your hand';
    if (view.hand?.some((c) => this.canLift(view, c.cardId))) {
      label.append(el('span', 'g2-handtip', ' · drag a piece card up to your back row to summon it, or onto your piece to seal · tap any card or piece to read it'));
    }
    this.handEl.append(label, this.dropNoteEl);
    const row = el('div', 'g2-handrow');
    for (const c of view.hand ?? []) row.appendChild(this.cardTile(c.uid, c.cardId, view));
    if (!view.hand?.length) row.appendChild(el('span', 'hint', 'No cards in hand.'));
    this.handEl.appendChild(row);
    row.scrollLeft = scroll;
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
        if (m === 'spell' && this.untargetedSpell(uid)) this.castNow(uid);
        else this.mode = m;
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
    const inspectedAt = this.inspectedSquare(view);

    for (let square = 0; square < v2.FILES * v2.RANKS; square++) {
      const cell = this.cells[square]!;
      const piece = view.pieces.find((p) => p.square === square);
      const seal = view.seals.find((s) => s.square === square);
      const classes = ['g2-cell', (v2.fileOf(square) + v2.rankOf(square)) % 2 === 0 ? 'dark' : 'light'];
      const target = targets.get(square);
      if (target) classes.push(target.type === 'seal' ? 'target seal' : piece || seal ? 'target capture' : 'target');
      const drop = drops.get(square);
      if (drop) classes.push(drop.type === 'seal' ? 'drop drop-seal' : 'drop');
      if (held && held.hover === square) classes.push('drop-hover');
      const warning = this.sealWarning(drop ?? target);
      if (warning) cell.title = warning;
      else cell.removeAttribute('title');
      if (this.selectedSquare === square) classes.push('selected');
      if (inspectedAt === square) classes.push('inspected');
      if (lastMove && (lastMove.from === square || lastMove.to === square)) classes.push('last');
      if (piece?.king && piece.owner === view.active && view.inCheck) classes.push('check');
      cell.className = classes.join(' ');
      // Keep the coordinate labels, replace the rest.
      for (const child of [...cell.children]) if (!child.classList.contains('g2-coord')) child.remove();
      if (piece) {
        const boardArt = piece.cardId ? view.cards[piece.cardId]?.boardArt : undefined;
        const tok = el('div', `g2-piece ${piece.owner}${piece.active ? '' : ' sick'}${boardArt ? ' art' : ''}`, boardArt ? '' : glyphFor(piece.kind, piece.name));
        if (boardArt) tok.style.backgroundImage = `url("${boardArt}")`;
        tok.title = `${piece.name}${piece.active ? '' : ' (summoning sickness: cannot capture yet, but still gives check)'}`;
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
    this.renderInspect(view);
    this.renderActions(view);
    this.renderPlayers();
    this.renderStatus(view);
    this.renderCue(view);
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
    if (view.actionTaken) {
      s.textContent = `${who}: action done. End the turn.`;
      return;
    }
    const mana = `${view.mana[view.active]} mana`;
    s.textContent = view.spellPlayed
      ? `${who}: spell played, ${mana} left. Now move, summon or seal.${check}`
      : view.inCheck
        ? `${who}: turn ${turn}, ${mana}. No spell while in check: move, summon or seal to answer it.${check}`
        : `${who}: turn ${turn}, ${mana}. Play a spell first if you want one, then move, summon or seal.${check}`;
    s.append(el('span', 'g2-status-more', ' Your action ends the turn.'));
  }

  private renderCue(view: v2.PlayerView): void {
    const cue = this.cueEl;
    const mine = this.solo || view.active === view.you;
    const show = mine && view.status.kind === 'playing' && view.phase === 'play' && !view.actionTaken;
    cue.classList.toggle('hidden', !show);
    if (!show) return;
    const canCast = !view.spellPlayed && view.legalActions.some((a) => a.type === 'spell');
    const spell = el('span', `g2-cue-step${view.spellPlayed ? ' done' : canCast ? '' : ' off'}`, view.spellPlayed ? '✓ Spell' : 'Spell');
    const action = el('span', 'g2-cue-step now', 'one action');
    spell.title = view.spellPlayed
      ? 'Spell played'
      : canCast ? 'Optional: play one spell before you act'
      : view.inCheck ? 'No spell while your King is in check' : 'No spell you can play now';
    action.title = 'Move, summon or seal. It ends your turn.';
    cue.replaceChildren(spell, el('span', 'g2-cue-then', ', then '), action);
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
