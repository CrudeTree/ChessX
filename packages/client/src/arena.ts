// Testing-arena palette: the card-editor list, but names drag onto the board.

import {
  STANDARD_KINDS,
  allCards,
  getPieceDef,
  isCustomCard,
  type ArenaOp,
  type CardDef,
  type Color,
  type PieceDef,
} from '@chessx/engine';
import type { GameView } from './game/GameView.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

type DragItem = { kind: 'card'; card: CardDef } | { kind: 'piece'; def: PieceDef };

export class ArenaPalette {
  onOp: (op: ArenaOp) => void = () => {};
  /** Fired when a palette drag begins (close the mobile sheet so the board is free). */
  onDragStart: () => void = () => {};
  private color: Color = 'white';
  private filter = '';
  private cards: CardDef[] = [];
  private ghost: HTMLElement | null = null;

  constructor(private gameView: GameView) {
    $('arena-white').onclick = () => this.setColor('white');
    $('arena-black').onclick = () => this.setColor('black');
    $<HTMLInputElement>('arena-search').oninput = (e) => {
      this.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderList();
    };
  }

  /** `all` = developer catalog; otherwise only the given owned card ids. */
  setCatalog(ownedIds: Iterable<string>, all: boolean): void {
    const owned = new Set(ownedIds);
    this.cards = allCards()
      .filter((c) => all || owned.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.renderList();
  }

  setActive(on: boolean): void {
    $('arena').classList.toggle('hidden', !on);
    $('arena-tab').classList.toggle('hidden', !on);
    $('side').classList.toggle('arena-host', on);
    $('game').classList.toggle('arena-mode', on);
    document.querySelector<HTMLElement>('#mtabs [data-sheet="side"]')?.classList.toggle('hidden', on);
    if (!on) this.clearGhost();
  }

  private setColor(c: Color): void {
    this.color = c;
    $('arena-white').classList.toggle('active', c === 'white');
    $('arena-black').classList.toggle('active', c === 'black');
  }

  private matches(name: string, extra: string): boolean {
    if (!this.filter) return true;
    return name.toLowerCase().includes(this.filter) || extra.toLowerCase().includes(this.filter);
  }

  private renderList(): void {
    const list = $('arena-list');
    list.innerHTML = '';

    const section = (title: string) => {
      const h = document.createElement('div');
      h.className = 'editor-section';
      h.textContent = title;
      list.appendChild(h);
    };
    const row = (name: string, sub: string, item: DragItem) => {
      if (!this.matches(name, `${sub} ${item.kind === 'card' ? item.card.id : item.def.kind}`)) return false;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'editor-item';
      b.innerHTML = `<span class="n">${esc(name)}</span><span class="s">${esc(sub)}</span>`;
      b.title = item.kind === 'card'
        ? `Drag ${name} onto the board or into a hand`
        : `Drag onto the board to place ${name} (${this.color})`;
      this.bindDrag(b, item);
      list.appendChild(b);
      return true;
    };

    const addSection = (title: string, rows: () => void) => {
      const before = list.childElementCount;
      section(title);
      rows();
      if (list.childElementCount === before + 1) list.lastElementChild?.remove();
    };

    addSection('Chess pieces', () => {
      for (const kind of STANDARD_KINDS) {
        const def = getPieceDef(kind);
        row(def.name, `Tier ${def.tier}`, { kind: 'piece', def });
      }
    });

    const shipped = this.cards.filter((c) => !isCustomCard(c.id));
    const addCards = (title: string, cards: CardDef[], sub: (c: CardDef) => string) => {
      addSection(title, () => {
        for (const card of cards) row(card.name, sub(card), { kind: 'card', card });
      });
    };
    addCards(
      'Creatures',
      shipped.filter((c) => c.type === 'summon'),
      (c) => `Tier ${c.type === 'summon' ? c.tier : ''} · ${c.cost} mana`,
    );
    addCards(
      'Spells',
      shipped.filter((c) => c.type === 'spell'),
      (c) => `${c.cost} mana`,
    );
    addCards(
      'Your cards',
      this.cards.filter((c) => isCustomCard(c.id)),
      (c) => (c.type === 'summon' ? `Creature · Tier ${c.tier} · ${c.cost} mana` : `Spell · ${c.cost} mana`),
    );
  }

  private bindDrag(el: HTMLElement, item: DragItem): void {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const move = (ev: PointerEvent) => {
        if (!dragging) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (Math.hypot(dx, dy) < 8) return;
          // Vertical motion inside the list is a scroll, not a pickup.
          if (Math.abs(dy) > Math.abs(dx) * 1.15) return;
          dragging = true;
          this.onDragStart();
          const ghost = el.cloneNode(true) as HTMLElement;
          ghost.classList.add('arena-ghost');
          ghost.style.width = `${Math.max(el.getBoundingClientRect().width, 180)}px`;
          ghost.style.left = `${ev.clientX}px`;
          ghost.style.top = `${ev.clientY}px`;
          document.body.appendChild(ghost);
          this.ghost = ghost;
        }
        if (!this.ghost) return;
        this.ghost.style.left = `${ev.clientX}px`;
        this.ghost.style.top = `${ev.clientY}px`;
        this.gameView.previewDrop(this.gameView.dropTarget(ev.clientX, ev.clientY));
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.clearGhost();
        this.gameView.previewDrop({ zone: 'none' });
        if (dragging) this.drop(item, ev.clientX, ev.clientY);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  private drop(item: DragItem, x: number, y: number): void {
    if (this.gameView.hasPendingGrant()) return;
    const target = this.gameView.dropTarget(x, y);
    if (item.kind === 'card') {
      if (target.zone === 'hand') this.onOp({ type: 'giveCard', color: target.color, cardId: item.card.id });
      else if (target.zone === 'square') {
        this.onOp({ type: 'dropCard', cardId: item.card.id, color: this.color, square: target.square });
      }
      return;
    }
    if (target.zone === 'square') {
      this.onOp({ type: 'spawnPiece', kind: item.def.kind, color: this.color, square: target.square });
    }
  }

  private clearGhost(): void {
    this.ghost?.remove();
    this.ghost = null;
  }
}

/** Card ids a non-developer may use in the arena. */
export function ownedCardIds(collection: { cardId: string; count: number }[]): string[] {
  return collection.filter((c) => c.count > 0).map((c) => c.cardId);
}
