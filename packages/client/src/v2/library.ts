// The arena's card library: every card in the game as a small picture. Pull one out onto the board (a piece, ready
// to move), onto a player's bar or the hand (into that hand) or onto a discard pile; tap one to put it in the hand of
// the side the discs pick. The tools undo, pass the turn and set the board up again with just the Kings.

import { v2 } from '@chessx/engine';
import { tribeClass } from './cardFrame.js';
import { sound } from './sound.js';

type Color = v2.Color;
type Card = v2.ViewCard;

export type LibraryTool = 'undo' | 'pass' | 'reset';

export interface LibraryHooks {
  /** A tap on a card: it goes into `side`'s hand. */
  give(cardId: string, side: Color, tile: HTMLElement): void;
  /** The card that follows the pointer once one is pulled out. */
  ghost(cardId: string, side: Color): HTMLElement;
  /** The held card is over (`x`, `y`): whether letting go there puts it somewhere. */
  hover(cardId: string, x: number, y: number): boolean;
  /** Let go at `at` (null when the drag was called off); false sends the card back to the library. */
  drop(cardId: string, side: Color, at: { x: number; y: number } | null, ghost: HTMLElement): boolean;
  /** The mouse is over a card (null once it leaves), or a finger held one down (`pinned`). */
  preview(cardId: string | null, pinned: boolean): void;
  tool(tool: LibraryTool): void;
}

/** Cards in a row of the library on wide screens. */
const COLUMNS = 4;
/** Pixels the pointer must travel before a press on a card pulls it out. */
const DRAG_THRESHOLD = 6;
/** A finger held this long on a card shows it in the card viewer instead. */
const HOLD_MS = 450;
const LEVEL_MARK = ['', 'I', 'II', 'III'];

const TOOLS: ReadonlyArray<{ tool: LibraryTool; label: string; title: string; icon: string }> = [
  {
    tool: 'undo',
    label: 'Undo',
    title: 'Undo (Ctrl+Z)',
    icon: '<path d="M8.5 4.5 4 9l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 9h9a5.5 5.5 0 0 1 0 11H9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  },
  {
    tool: 'pass',
    label: 'Pass',
    title: 'End the turn as it stands',
    icon: '<path d="M5 5.5 13.5 12 5 18.5z" fill="currentColor"/><path d="M18 5.5v13" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  },
  {
    tool: 'reset',
    label: 'Reset',
    title: 'Start over with just the Kings',
    icon: '<path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19.5 4v4.5H15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
];

interface Press {
  cardId: string;
  tile: HTMLElement;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  /** The card pulled out, once the pointer has moved far enough. */
  ghost: HTMLElement | null;
  /** Held long enough to show the card instead. */
  held: boolean;
  holdTimer: number;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/**
 * The library's rows: each evolution line on a row of its own from level 1, the other pieces in the room left beside
 * their own type's line (or any line), then the spells.
 */
function libraryRows(cards: Card[]): Card[][] {
  const pieces = cards.filter((c) => c.type === 'piece');
  const rows: Card[][] = [];
  const placed = new Set<string>();
  // One row per line, however many cards begin it (the Squire and the Recruit are both the Warrior's first level).
  for (const line of [...new Set(pieces.map((c) => c.line).filter((l): l is string => !!l))]) {
    const row: Card[] = [];
    let level = pieces.filter((c) => c.line === line && !c.evolvesFrom);
    while (level.length) {
      row.push(...level);
      const ids = new Set(level.map((c) => c.id));
      level = pieces.filter((c) => c.evolvesFrom !== undefined && ids.has(c.evolvesFrom));
    }
    for (const c of row) placed.add(c.id);
    if (row.length) rows.push(row);
  }
  const loose: Card[] = [];
  for (const card of pieces.filter((c) => !placed.has(c.id))) {
    const own = rows.find((r) => r.length < COLUMNS && r[0]?.tribe === card.tribe);
    if (own) own.push(card);
    else loose.push(card);
  }
  for (const card of loose) {
    const room = rows.find((r) => r.length < COLUMNS);
    if (room) room.push(card);
    else rows.push([card]);
  }
  const spells = cards.filter((c) => c.type === 'spell');
  for (let i = 0; i < spells.length; i += COLUMNS) rows.push(spells.slice(i, i + COLUMNS));
  return rows;
}

export class CardLibrary {
  readonly el = el('div', 'side-block g2-lib hidden');
  private sideNow: Color = 'white';
  private cards: Record<string, Card> = {};
  private cardKey = '';
  private readonly grid = el('div', 'g2-lib-grid');
  private readonly sideBtns: Record<Color, HTMLButtonElement> = { white: el('button', 'g2-lib-side white'), black: el('button', 'g2-lib-side black') };
  private press: Press | null = null;
  /** A pull or a hold just ended, so the click that follows is not a tap. */
  private swallowClick = false;

  /** `strip`: the library is one sideways row (phones), so only a pull up takes a card out; a swipe scrolls it. */
  constructor(
    private readonly hooks: LibraryHooks,
    private readonly strip: () => boolean,
  ) {
    const head = el('div', 'g2-lib-head');
    const sides = el('div', 'g2-lib-sides');
    sides.setAttribute('role', 'group');
    sides.setAttribute('aria-label', 'Whose cards');
    for (const color of ['white', 'black'] as const) {
      const btn = this.sideBtns[color];
      btn.type = 'button';
      btn.title = color === 'white' ? "White's cards" : "Black's cards";
      btn.setAttribute('aria-label', btn.title);
      btn.onclick = () => this.setSide(color);
      sides.append(btn);
    }
    const tools = el('div', 'g2-lib-tools');
    for (const t of TOOLS) {
      const btn = el('button', `g2-lib-tool ${t.tool}`);
      btn.type = 'button';
      btn.title = t.title;
      btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${t.icon}</svg><span>${t.label}</span>`;
      btn.onclick = () => this.hooks.tool(t.tool);
      tools.append(btn);
    }
    head.append(sides, tools);
    this.el.append(head, this.grid, el('div', 'g2-lib-hint', 'Drag onto the board · tap for the hand'));
    this.paintSides();
  }

  get side(): Color {
    return this.sideNow;
  }

  get dragging(): boolean {
    return !!this.press?.ghost;
  }

  show(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
    if (!on) this.cancel();
  }

  /** The game's cards; the library is only rebuilt when they change. */
  setCards(cards: Record<string, Card>): void {
    this.cards = cards;
    const key = Object.keys(cards).sort().join();
    if (key === this.cardKey) return;
    this.cardKey = key;
    this.grid.replaceChildren(
      ...libraryRows(Object.values(cards)).map((row) => {
        const line = el('div', 'g2-lib-row');
        line.append(...row.map((card) => this.tile(card)));
        return line;
      }),
    );
  }

  /** Whose cards the library hands out: their faces, their hand, their pieces. */
  setSide(side: Color): void {
    if (side === this.sideNow) return;
    this.sideNow = side;
    this.paintSides();
    for (const tile of this.grid.querySelectorAll<HTMLElement>('.g2-lib-tile')) {
      const card = this.cards[tile.dataset.card ?? ''];
      if (card) this.paintTile(tile, card);
    }
  }

  /** Put a pulled-out card away without dropping it anywhere: the game closed. */
  cancel(): void {
    const press = this.press;
    if (!press) return;
    this.release();
    press.ghost?.remove();
    press.tile.classList.remove('lifted');
  }

  private paintSides(): void {
    for (const color of ['white', 'black'] as const) {
      const on = color === this.sideNow;
      this.sideBtns[color].classList.toggle('on', on);
      this.sideBtns[color].setAttribute('aria-pressed', String(on));
    }
  }

  private tile(card: Card): HTMLElement {
    const tribe = card.tribe ? ` ${tribeClass(card.tribe)}` : '';
    const tile = el('button', `g2-lib-tile ${card.type}${tribe}`);
    tile.type = 'button';
    tile.dataset.card = card.id;
    tile.title = card.name;
    tile.setAttribute('aria-label', `${card.name}, ${card.cost} mana`);
    tile.append(el('span', 'g2-lib-art'), el('b', 'g2-lib-cost', String(card.cost)));
    if (card.level) tile.append(el('span', 'g2-lib-level', LEVEL_MARK[card.level] ?? String(card.level)));
    this.paintTile(tile, card);
    tile.addEventListener('pointerdown', (e) => this.pressTile(e, card.id, tile));
    tile.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse' && !this.press?.ghost) this.hooks.preview(card.id, false);
    });
    tile.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') this.hooks.preview(null, false);
    });
    // A right click shows the card too, where the viewer floats over the board and hovering does not.
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.hooks.preview(card.id, true);
    });
    tile.onclick = () => {
      if (this.swallowClick) return;
      this.hooks.give(card.id, this.sideNow, tile);
    };
    return tile;
  }

  private paintTile(tile: HTMLElement, card: Card): void {
    const pic = tile.querySelector<HTMLElement>('.g2-lib-art');
    if (!pic) return;
    const art = v2.faceArt(card, this.sideNow).art;
    pic.style.backgroundImage = art ? `url("${art}")` : '';
    pic.textContent = art ? '' : card.name.charAt(0);
  }

  private pressTile(e: PointerEvent, cardId: string, tile: HTMLElement): void {
    if (e.button !== 0 || !e.isPrimary || this.press) return;
    // Stops the browser starting a text selection; the click still fires.
    if (e.pointerType === 'mouse') e.preventDefault();
    if (tile.hasPointerCapture(e.pointerId)) tile.releasePointerCapture(e.pointerId);
    const press: Press = { cardId, tile, pointerId: e.pointerId, pointerType: e.pointerType, startX: e.clientX, startY: e.clientY, ghost: null, held: false, holdTimer: 0 };
    if (e.pointerType !== 'mouse') {
      press.holdTimer = window.setTimeout(() => {
        if (this.press !== press || press.ghost) return;
        press.held = true;
        this.hooks.preview(cardId, true);
      }, HOLD_MS);
    }
    this.press = press;
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  }

  private readonly onMove = (e: PointerEvent): void => {
    const press = this.press;
    if (!press || e.pointerId !== press.pointerId) return;
    const dx = e.clientX - press.startX;
    const dy = e.clientY - press.startY;
    if (!press.ghost) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      clearTimeout(press.holdTimer);
      if (press.held || (this.strip() && press.pointerType !== 'mouse' && -dy < Math.abs(dx))) {
        this.release();
        return;
      }
      press.ghost = this.hooks.ghost(press.cardId, this.sideNow);
      document.body.append(press.ghost);
      press.tile.classList.add('lifted');
      sound.sfx?.cardLift();
      this.hooks.preview(null, false);
    }
    e.preventDefault();
    const ghost = press.ghost;
    // The card hangs above the pointer, like one from the hand, so the square it would land on stays in sight.
    ghost.style.left = `${e.clientX - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${e.clientY - ghost.offsetHeight - 6}px`;
    ghost.classList.toggle('over', this.hooks.hover(press.cardId, e.clientX, e.clientY));
  };

  private readonly onUp = (e: PointerEvent): void => {
    const press = this.press;
    if (!press || e.pointerId !== press.pointerId) return;
    this.release();
    if (press.held || press.ghost) {
      this.swallowClick = true;
      window.setTimeout(() => (this.swallowClick = false), 0);
    }
    const ghost = press.ghost;
    if (!ghost) return;
    press.tile.classList.remove('lifted');
    const at = e.type === 'pointerup' ? { x: e.clientX, y: e.clientY } : null;
    if (!this.hooks.drop(press.cardId, this.sideNow, at, ghost)) this.snapBack(ghost, press.tile);
  };

  private release(): void {
    const press = this.press;
    if (!press) return;
    clearTimeout(press.holdTimer);
    this.press = null;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
  }

  /** A card let go where it cannot go flies back into the library. */
  private snapBack(ghost: HTMLElement, tile: HTMLElement): void {
    const home = tile.getBoundingClientRect();
    sound.sfx?.cardReturn();
    ghost.classList.add('returning');
    ghost.style.left = `${home.left + home.width / 2 - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${home.top + home.height / 2 - ghost.offsetHeight / 2}px`;
    window.setTimeout(() => ghost.remove(), 220);
  }
}
