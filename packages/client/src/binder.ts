// The Binder: every card in the game, by type. A band in the type's colour runs its evolution line from level 1 to
// level 3, then its other cards; the spells close the page. The switch turns every card to its White or Black face.
// A card opens big: a click turns it over, and the arrows, the arrow keys or a swipe step through the rest.

import { v2 } from '@chessx/engine';
import { cardBack, fillFrame, tiltWithPointer, tribeClass } from './v2/cardFrame.js';
import { frameOfCard } from './v2/GameScreen.js';
import { movementPanel } from './v2/movement.js';
import { sound } from './v2/sound.js';

type Color = v2.Color;
type Card = v2.ViewCard;

const SPELLS = 'Spells';
/** Beside a type's name: the chess piece its line moves like, or the type's own mark. */
const TYPE_GLYPH: Record<string, string> = {
  Warrior: '♜',
  Mage: '♝',
  Paladin: '♞',
  Dragon: '♛',
  Zealot: '✚',
  Beast: '☾\uFE0E',
  [SPELLS]: '✦\uFE0E',
};
const LEVEL_MARK = ['', 'I', 'II', 'III'];
/** A sideways swipe at least this long steps to the next card. */
const SWIPE_PX = 50;

interface Band {
  name: string;
  /** The evolution line, level by level; a level holds two cards where the line forks (the Paladin's final forms). */
  line: Card[][];
  /** The type's cards outside its line, or the spells. */
  others: Card[];
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const calm = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The pieces by type, the types with a line first; the spells last. */
function sortIntoBands(cards: Card[]): Band[] {
  const byType = new Map<string, Card[]>();
  for (const card of cards) {
    if (card.type !== 'piece') continue;
    const type = card.tribe ?? card.line ?? 'Pieces';
    byType.set(type, [...(byType.get(type) ?? []), card]);
  }
  const bands: Band[] = [];
  for (const [name, members] of byType) {
    const line: Card[][] = [];
    let level = members.filter((c) => c.line && !c.evolvesFrom);
    while (level.length) {
      line.push(level);
      const ids = new Set(level.map((c) => c.id));
      level = members.filter((c) => c.evolvesFrom !== undefined && ids.has(c.evolvesFrom));
    }
    const inLine = new Set(line.flat().map((c) => c.id));
    bands.push({ name, line, others: members.filter((c) => !inLine.has(c.id)) });
  }
  bands.sort((a, b) => Number(b.line.length > 0) - Number(a.line.length > 0));
  bands.push({ name: SPELLS, line: [], others: cards.filter((c) => c.type === 'spell') });
  return bands;
}

export class Binder {
  private readonly cards = v2.viewCards(v2.STARTER_CATALOG);
  private readonly bands = sortIntoBands(Object.values(this.cards));
  /** Every card in the order the page shows them, to step through. */
  private readonly order = this.bands.flatMap((b) => [...b.line.flat(), ...b.others].map((c) => c.id));
  /** Copies of each card in the starter deck, which everyone plays. */
  private readonly copies = new Map<string, number>();
  private face: Color = 'white';

  private readonly bodyEl = el('div', 'bd-body');
  private readonly faceBtns: Record<Color, HTMLButtonElement> = { white: el('button', 'bd-face-btn white'), black: el('button', 'bd-face-btn black') };

  private readonly zoomEl = el('div', 'bd-zoom hidden');
  private readonly stageEl = el('div', 'bd-stage');
  private readonly flipEl = el('div', 'bd-flip');
  private readonly frontEl = el('div', 'bd-front');
  private readonly infoEl = el('div', 'bd-info');
  /** The card open big, if any. */
  private shown: string | null = null;
  private closing: Animation | null = null;
  private press: { x: number; y: number; id: number } | null = null;
  /** The press just ended in a swipe, so the click that follows it neither turns the card over nor closes it. */
  private swiped = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly onBack: () => void,
  ) {
    for (const id of v2.starterDeck()) this.copies.set(id, (this.copies.get(id) ?? 0) + 1);
    const head = el('header', 'bd-head');
    const back = el('button', 'bd-back', '← Back');
    back.type = 'button';
    back.onclick = () => this.onBack();
    const faces = el('div', 'bd-face');
    faces.setAttribute('role', 'group');
    faces.setAttribute('aria-label', 'Card faces');
    for (const color of ['white', 'black'] as const) {
      const btn = this.faceBtns[color];
      btn.type = 'button';
      btn.append(el('i'), color === 'white' ? 'White' : 'Black');
      btn.onclick = () => this.setFace(color);
      faces.append(btn);
    }
    head.append(back, el('h1', 'bd-title', 'Binder'), faces);
    const page = el('div', 'bd');
    page.append(head, this.bodyEl);
    this.buildZoom();
    root.replaceChildren(el('div', 'bd-aurora'), page, this.zoomEl);
    this.paintFaceButtons();
  }

  open(): void {
    this.closeZoom(false);
    this.root.scrollTop = 0;
    this.render();
  }

  // ------------------------------------------------------------------ the page

  private render(): void {
    const blocks: HTMLElement[] = [];
    let singles: HTMLElement | null = null;
    for (const [i, band] of this.bands.entries()) {
      const node = this.band(band, i);
      // Types of a single card share a row.
      if (band.line.length || band.name === SPELLS) {
        singles = null;
        blocks.push(node);
        continue;
      }
      if (!singles) {
        singles = el('div', 'bd-singles');
        blocks.push(singles);
      }
      singles.append(node);
    }
    this.bodyEl.replaceChildren(...blocks);
  }

  private band(band: Band, index: number): HTMLElement {
    const spells = band.name === SPELLS;
    const section = el('section', `bd-band ${spells ? 'bd-spells' : tribeClass(band.name)}`);
    section.style.setProperty('--b', String(index));
    // Behind the band glows the top of its line, or its first card.
    const glow = el('div', 'bd-band-glow');
    const hero = band.line.at(-1)?.[0] ?? band.others[0];
    if (hero) glow.dataset.card = hero.id;
    this.paintGlow(glow);
    const head = el('header', 'bd-band-head');
    head.append(el('span', 'bd-band-glyph', TYPE_GLYPH[band.name] ?? '◆'), el('h2', '', band.name));
    const row = el('div', 'bd-row');
    band.line.forEach((level, i) => {
      if (i) row.append(el('span', 'bd-link'));
      if (level.length === 1) {
        row.append(this.cardEl(level[0]!));
        return;
      }
      const fork = el('div', 'bd-fork');
      level.forEach((card, j) => {
        if (j) fork.append(el('span', 'bd-or', 'or'));
        fork.append(this.cardEl(card));
      });
      row.append(fork);
    });
    if (band.line.length && band.others.length) row.append(el('span', 'bd-sep'));
    for (const card of band.others) row.append(this.cardEl(card));
    section.append(glow, head, row);
    return section;
  }

  private paintGlow(glow: HTMLElement): void {
    const card = glow.dataset.card ? this.cards[glow.dataset.card] : undefined;
    const art = card ? v2.faceArt(card, this.face).art : undefined;
    glow.style.setProperty('--art', art ? `url("${art}")` : 'none');
  }

  private cardEl(card: Card): HTMLElement {
    const btn = el('button', 'bd-card');
    btn.type = 'button';
    btn.dataset.card = card.id;
    btn.style.setProperty('--i', String(this.order.indexOf(card.id)));
    btn.setAttribute('aria-label', card.name);
    btn.append(this.frame(card, 'bd-frame'));
    const copies = this.copies.get(card.id) ?? 0;
    if (copies > 1) {
      const badge = el('span', 'bd-copies', `×${copies}`);
      badge.title = `${copies} in the deck`;
      btn.append(badge);
    }
    tiltWithPointer(btn);
    btn.onclick = () => this.openZoom(card.id, btn);
    return btn;
  }

  private frame(card: Card, cls: string): HTMLElement {
    return fillFrame(el('div', cls), frameOfCard(card, this.face, this.cards));
  }

  private cardButton(id: string): HTMLElement | null {
    return this.bodyEl.querySelector<HTMLElement>(`.bd-card[data-card="${CSS.escape(id)}"]`);
  }

  /** Every card turns over to the other side's face, one after another. */
  private setFace(face: Color): void {
    if (face === this.face) return;
    this.face = face;
    this.paintFaceButtons();
    sound.sfx?.deal(6);
    const still = calm();
    this.bodyEl.querySelectorAll<HTMLElement>('.bd-card').forEach((btn, i) => {
      const card = this.cards[btn.dataset.card ?? ''];
      const old = btn.querySelector<HTMLElement>('.bd-frame');
      if (!card || !old) return;
      for (const a of old.getAnimations()) a.cancel();
      if (still) {
        old.replaceWith(this.frame(card, 'bd-frame'));
        return;
      }
      const away = old.animate([{ rotate: 'y 0deg' }, { rotate: 'y 90deg' }], { duration: 150, delay: i * 18, easing: 'ease-in', fill: 'forwards' });
      away.onfinish = () => {
        const next = this.frame(card, 'bd-frame');
        btn.querySelector('.bd-frame')?.replaceWith(next);
        next.animate([{ rotate: 'y -90deg' }, { rotate: 'y 0deg' }], { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1.25)' });
      };
    });
    for (const glow of this.bodyEl.querySelectorAll<HTMLElement>('.bd-band-glow')) this.paintGlow(glow);
    if (this.shown) this.paintZoom();
  }

  private paintFaceButtons(): void {
    for (const color of ['white', 'black'] as const) {
      const on = color === this.face;
      this.faceBtns[color].classList.toggle('on', on);
      this.faceBtns[color].setAttribute('aria-pressed', String(on));
    }
  }

  // ------------------------------------------------------------------ one card, big

  private buildZoom(): void {
    const zoom = this.zoomEl;
    zoom.setAttribute('role', 'dialog');
    zoom.setAttribute('aria-modal', 'true');
    const shade = el('div', 'bd-zoom-shade');
    shade.onclick = () => {
      if (!this.swiped) this.closeZoom();
    };
    const tilt = el('div', 'bd-tilt');
    const back = el('div', 'bd-backface');
    back.append(cardBack());
    this.flipEl.append(this.frontEl, back);
    tilt.append(this.flipEl);
    this.stageEl.append(tilt);
    tiltWithPointer(this.stageEl);
    this.stageEl.onclick = () => {
      if (this.swiped) return;
      this.flipEl.classList.toggle('flipped');
      sound.sfx?.cardLift();
    };
    const body = el('div', 'bd-zoom-body');
    body.append(this.stageEl, this.infoEl);
    const prev = el('button', 'bd-nav prev', '‹');
    const next = el('button', 'bd-nav next', '›');
    const close = el('button', 'bd-close', '×');
    for (const [btn, label] of [
      [prev, 'Previous card'],
      [next, 'Next card'],
      [close, 'Close'],
    ] as const) {
      btn.type = 'button';
      btn.setAttribute('aria-label', label);
    }
    prev.onclick = () => this.step(-1);
    next.onclick = () => this.step(1);
    close.onclick = () => this.closeZoom();
    zoom.append(shade, body, prev, next, close);

    zoom.addEventListener('pointerdown', (e) => {
      if (e.isPrimary) this.press = { x: e.clientX, y: e.clientY, id: e.pointerId };
    });
    zoom.addEventListener('pointerup', (e) => {
      const press = this.press;
      this.press = null;
      if (!press || press.id !== e.pointerId) return;
      const dx = e.clientX - press.x;
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(e.clientY - press.y) * 1.5) return;
      this.swiped = true;
      window.setTimeout(() => (this.swiped = false), 0);
      this.step(dx < 0 ? 1 : -1);
    });
  }

  private openZoom(id: string, from: HTMLElement): void {
    this.closing?.cancel();
    this.closing = null;
    if (!this.shown) window.addEventListener('keydown', this.onKey);
    this.shown = id;
    this.flipEl.classList.remove('flipped');
    this.zoomEl.classList.remove('hidden', 'closing');
    this.paintZoom();
    this.markAway();
    sound.sfx?.cardLift();
    if (calm()) return;
    this.stageEl.animate([{ transform: this.towards(from) }, { transform: 'none' }], { duration: 460, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }

  /** The transform that puts the big card over `card` in the page. */
  private towards(card: HTMLElement): string {
    const a = card.getBoundingClientRect();
    const b = this.stageEl.getBoundingClientRect();
    const dx = a.left + a.width / 2 - (b.left + b.width / 2);
    const dy = a.top + a.height / 2 - (b.top + b.height / 2);
    return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${(a.width / b.width).toFixed(3)})`;
  }

  /** Back into its place in the page, or just away when that is scrolled out of sight. */
  private closeZoom(animate = true): void {
    const id = this.shown;
    if (!id) return;
    this.shown = null;
    window.removeEventListener('keydown', this.onKey);
    const finish = (): void => {
      this.closing = null;
      this.zoomEl.classList.add('hidden');
      this.zoomEl.classList.remove('closing');
      this.markAway();
    };
    if (!animate || calm()) return finish();
    sound.sfx?.cardReturn();
    this.zoomEl.classList.add('closing');
    this.flipEl.classList.remove('flipped');
    const home = this.cardButton(id);
    const box = home?.getBoundingClientRect();
    const target = home && box && box.bottom > 0 && box.top < window.innerHeight ? home : null;
    const frames = target ? [{ transform: 'none' }, { transform: this.towards(target) }] : [{ opacity: 1 }, { opacity: 0, transform: 'scale(0.85)' }];
    const anim = this.stageEl.animate(frames, { duration: target ? 360 : 220, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' });
    this.closing = anim;
    anim.onfinish = () => {
      anim.cancel();
      finish();
    };
  }

  /** The card open big leaves an empty place in the page. */
  private markAway(): void {
    for (const btn of this.bodyEl.querySelectorAll<HTMLElement>('.bd-card')) btn.classList.toggle('away', btn.dataset.card === this.shown);
  }

  private step(by: 1 | -1): void {
    if (!this.shown) return;
    const at = this.order.indexOf(this.shown);
    this.jump(this.order[(at + by + this.order.length) % this.order.length]!, by);
  }

  private jump(id: string, by: 1 | -1): void {
    if (!this.shown || id === this.shown) return;
    this.shown = id;
    this.flipEl.classList.remove('flipped');
    this.paintZoom();
    this.markAway();
    sound.sfx?.select();
    if (calm()) return;
    this.stageEl.animate(
      [
        { transform: `perspective(60em) translateX(${by * 16}%) rotateY(${by * -28}deg)`, opacity: 0 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 340, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    );
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.root.classList.contains('hidden')) return this.closeZoom(false);
    if (e.key === 'Escape') this.closeZoom();
    else if (e.key === 'ArrowRight') this.step(1);
    else if (e.key === 'ArrowLeft') this.step(-1);
    else return;
    e.preventDefault();
  };

  private paintZoom(): void {
    const card = this.shown ? this.cards[this.shown] : undefined;
    if (!card) return;
    const frame = frameOfCard(card, this.face, this.cards);
    const tribe = tribeClass(card.tribe);
    this.stageEl.className = `bd-stage ${card.type}${tribe ? ` ${tribe}` : ''}`;
    this.frontEl.replaceChildren(fillFrame(el('div', 'bd-zoom-frame'), frame));
    const parts: HTMLElement[] = [el('h2', 'bd-name', card.name)];
    if (frame.rules) {
      const art = v2.faceArt(card, this.face).boardArt;
      parts.push(movementPanel({ rules: frame.rules, owner: this.face, glyph: frame.glyph, art }, this.face === 'black'));
    }
    if (card.detail) parts.push(el('p', 'bd-detail', card.detail));
    const chain = this.chain(card);
    if (chain) parts.push(chain);
    parts.forEach((part, k) => part.style.setProperty('--k', String(k)));
    this.infoEl.className = `bd-info${tribe ? ` ${tribe}` : ''}`;
    this.infoEl.replaceChildren(...parts);
  }

  /** The card's evolution line in small pictures, this card lit; a click opens another. */
  private chain(card: Card): HTMLElement | null {
    const band = this.bands.find((b) => b.line.some((level) => level.some((c) => c.id === card.id)));
    if (!band) return null;
    const row = el('div', 'bd-chain');
    band.line.forEach((level, i) => {
      if (i) row.append(el('span', 'bd-chain-arrow', '›'));
      const group = el('div', 'bd-chain-level');
      for (const c of level) {
        const thumb = el('button', `bd-thumb${c.id === card.id ? ' on' : ''}`);
        thumb.type = 'button';
        thumb.title = c.name;
        thumb.setAttribute('aria-label', c.name);
        const art = v2.faceArt(c, this.face).art;
        if (art) thumb.style.backgroundImage = `url("${art}")`;
        thumb.append(el('b', '', LEVEL_MARK[c.level ?? 0] ?? ''));
        thumb.onclick = () => this.jump(c.id, this.order.indexOf(c.id) > this.order.indexOf(card.id) ? 1 : -1);
        group.append(thumb);
      }
      row.append(group);
    });
    return row;
  }
}
