// Testing-arena palette: drag unlocked cards into a hand, or pieces onto the board.

import {
  STANDARD_KINDS,
  allCards,
  getPieceDef,
  type ArenaOp,
  type CardDef,
  type Color,
  type PieceDef,
} from '@chessx/engine';
import { cardElement } from './binder.js';
import type { GameView } from './game/GameView.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export class ArenaPalette {
  onOp: (op: ArenaOp) => void = () => {};
  /** Fired when a palette drag begins (close the mobile sheet so the board is free). */
  onDragStart: () => void = () => {};
  private color: Color = 'white';
  private tab: 'cards' | 'pieces' = 'cards';
  private filter = '';
  private cards: CardDef[] = [];
  private pieces: PieceDef[] = [];
  private ghost: HTMLElement | null = null;

  constructor(private gameView: GameView) {
    $('arena-white').onclick = () => this.setColor('white');
    $('arena-black').onclick = () => this.setColor('black');
    $('arena-tab-cards').onclick = () => this.setTab('cards');
    $('arena-tab-pieces').onclick = () => this.setTab('pieces');
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
    const kinds = new Set<string>(STANDARD_KINDS);
    for (const c of this.cards) {
      if (c.type === 'summon') kinds.add(c.piece.kind);
    }
    this.pieces = [...kinds].map((k) => getPieceDef(k)).sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
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

  private setTab(tab: 'cards' | 'pieces'): void {
    this.tab = tab;
    $('arena-tab-cards').classList.toggle('active', tab === 'cards');
    $('arena-tab-pieces').classList.toggle('active', tab === 'pieces');
    this.renderList();
  }

  private renderList(): void {
    const list = $('arena-list');
    list.innerHTML = '';
    if (this.tab === 'cards') {
      for (const card of this.cards) {
        if (this.filter && !card.name.toLowerCase().includes(this.filter) && !card.id.includes(this.filter)) continue;
        const el = cardElement(card);
        el.classList.add('arena-item');
        el.title = `Drag ${card.name} onto the board or into a hand`;
        this.bindDrag(el, { kind: 'card', card });
        list.appendChild(el);
      }
    } else {
      for (const def of this.pieces) {
        if (this.filter && !def.name.toLowerCase().includes(this.filter) && !def.kind.includes(this.filter)) continue;
        const el = document.createElement('div');
        el.className = 'arena-piece';
        const card = allCards().find((c) => c.type === 'summon' && c.piece.kind === def.kind);
        const art = card?.boardArt ?? card?.art;
        el.innerHTML = art
          ? `<img src="${art}" alt=""><span>${def.name}</span>`
          : `<span class="glyph">${def.glyph}</span><span>${def.name}</span>`;
        el.title = `Drag onto the board to place ${def.name} (${this.color})`;
        this.bindDrag(el, { kind: 'piece', def });
        list.appendChild(el);
      }
    }
  }

  private bindDrag(el: HTMLElement, item: { kind: 'card'; card: CardDef } | { kind: 'piece'; def: PieceDef }): void {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.onDragStart();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      const ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.add('arena-ghost');
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
      document.body.appendChild(ghost);
      this.ghost = ghost;
      const move = (ev: PointerEvent) => {
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
        this.gameView.previewDrop(this.gameView.dropTarget(ev.clientX, ev.clientY));
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.clearGhost();
        this.gameView.previewDrop({ zone: 'none' });
        this.drop(item, ev.clientX, ev.clientY);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  private drop(item: { kind: 'card'; card: CardDef } | { kind: 'piece'; def: PieceDef }, x: number, y: number): void {
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
