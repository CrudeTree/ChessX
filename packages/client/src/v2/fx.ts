// Board effects: summoning circles, pillars of light, bursts, sparks, breaking tokens, the spell reveal and
// banners. GameScreen says what happened (from the server's events) and where; this only draws. A 3D board
// can take over by offering the same calls.

import type { v2 } from '@chessx/engine';

type Color = v2.Color;

export type BannerTone = 'turn' | 'check' | 'win' | 'lose' | 'draw';

/** How a token that just left the board goes: captured, sealed away, or a seal destroyed. */
export type Vanish = 'capture' | 'consume' | 'shatter';

/** How long a summon's card takes to dive into its square before the circle opens. */
export const CARD_DIVE_MS = 320;
/** From the circle opening to the burst as the piece lands (the burst's delay in style.css). */
export const BURST_MS = 250;
/** How long a hatching seal cracks before its circle opens (--t0 of .g2-fx-spot.hatch). */
export const HATCH_T0_MS = 230;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const el = (tag: string, cls = '', text = ''): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** Two rings, a hexagram and twelve diamonds, drawn in the owner's colour. */
const RUNE = (() => {
  const diamonds = Array.from({ length: 12 }, (_, i) => `<path transform="rotate(${i * 30}) translate(0 -42)" d="M0 -3.4 L2.3 0 L0 3.4 L-2.3 0 Z"/>`).join('');
  return `<svg viewBox="-50 -50 100 100" aria-hidden="true"><circle class="r1" r="46"/><circle class="r2" r="37"/><path class="r3" d="M0 -37 L32 18.5 L-32 18.5 Z M0 37 L32 -18.5 L-32 -18.5 Z"/><g class="r4">${diamonds}</g></svg>`;
})();

function rune(): HTMLElement {
  const r = el('div', 'g2-fx-rune');
  r.innerHTML = RUNE;
  return r;
}

function sparks(count: number, cls = ''): HTMLElement {
  const group = el('div', `g2-fx-sparks${cls ? ` ${cls}` : ''}`);
  for (let i = 0; i < count; i++) {
    const s = el('i');
    s.style.setProperty('--a', `${Math.round((360 / count) * i + Math.random() * 24 - 12)}deg`);
    // How far it flies, in squares.
    s.style.setProperty('--d', (0.7 + Math.random() * 0.9).toFixed(2));
    s.style.setProperty('--s', (0.6 + Math.random() * 0.8).toFixed(2));
    group.append(s);
  }
  return group;
}

export class BoardFx {
  /** Lies on the board itself, so its effects sit on (and tilt with) the squares. */
  private readonly floor = el('div', 'g2-fx');
  /** Flat over the whole board: the spell reveal and banners. */
  private readonly overlay = el('div', 'g2-fx-overlay');
  private readonly timers = new Set<number>();

  constructor(
    private readonly board: HTMLElement,
    box: HTMLElement,
    private readonly cell: (square: v2.Square) => HTMLElement | undefined,
  ) {
    box.append(this.overlay);
  }

  /** False when the player asked their system for less motion. */
  get enabled(): boolean {
    return !reducedMotion.matches;
  }

  /** Put the floor back after the board's squares are rebuilt. */
  attach(): void {
    this.board.append(this.floor);
  }

  clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.floor.replaceChildren();
    this.overlay.replaceChildren();
  }

  private removeAfter(node: HTMLElement, ms: number): void {
    const t = window.setTimeout(() => {
      this.timers.delete(t);
      node.remove();
    }, ms);
    this.timers.add(t);
  }

  /** A box over the square's cell, on the floor, that starts after `delay` and is gone after `ms` more. */
  private spot(square: v2.Square, cls: string, ms: number, delay: number): HTMLElement | null {
    const cell = this.cell(square);
    if (!cell) return null;
    const box = el('div', `g2-fx-spot ${cls}`);
    box.style.left = `${cell.offsetLeft}px`;
    box.style.top = `${cell.offsetTop}px`;
    box.style.width = `${cell.offsetWidth}px`;
    box.style.height = `${cell.offsetHeight}px`;
    box.style.setProperty('--cell', `${cell.offsetWidth}px`);
    box.style.setProperty('--delay', `${delay}ms`);
    this.floor.append(box);
    this.removeAfter(box, delay + ms);
    return box;
  }

  /** The board jolts as something lands on it, `force` from 0 (a nudge) to 1 (a slam). */
  private quake(force: number, delay: number): void {
    const d = 1 + force * 4;
    this.board.animate(
      [
        { translate: '0 0' },
        { translate: `0 ${d}px` },
        { translate: `${-d * 0.6}px ${-d * 0.4}px` },
        { translate: `${d * 0.35}px ${d * 0.25}px` },
        { translate: '0 0' },
      ],
      { duration: 320, delay, easing: 'ease-out' },
    );
  }

  /**
   * A piece arrives: `card` (a drawn card face, or null when the player already dropped it there) dives into
   * the square, then a summoning circle opens, a pillar of light rises and the piece lands in a burst that
   * shakes the board as hard as `force` (0 to 1).
   */
  summon(square: v2.Square, owner: Color, card: HTMLElement | null, delay = 0, force = 0.3): void {
    const spot = this.spot(square, `summon ${owner}${card ? ' with-card' : ''}`, 1700, delay);
    if (!spot) return;
    if (card) {
      card.classList.add('g2-fx-card');
      spot.append(card);
    }
    spot.append(rune(), el('div', 'g2-fx-pillar'), el('div', 'g2-fx-burst'), el('div', 'g2-fx-shock'), sparks(14));
    this.quake(force, delay + (card ? CARD_DIVE_MS : 0) + BURST_MS);
  }

  /**
   * A card falls face down onto a piece in a swirl of runes and becomes a seal. `back` is null when the player
   * already dropped the card there.
   */
  seal(square: v2.Square, owner: Color, back: HTMLElement | null, delay = 0): void {
    const spot = this.spot(square, `seal ${owner}`, 1300, delay);
    if (!spot) return;
    spot.append(rune());
    if (back) {
      back.classList.add('g2-fx-card');
      spot.append(back);
    }
    spot.append(sparks(10, 'violet'));
  }

  /** A seal cracks open: the old seal token breaks and the piece rises in a pillar of light. */
  hatch(square: v2.Square, owner: Color, sealToken: HTMLElement | null, delay = 0): void {
    const spot = this.spot(square, `hatch ${owner}`, 1700, delay);
    if (!spot) return;
    if (sealToken) {
      sealToken.classList.add('g2-fx-ghost', 'crack');
      spot.append(sealToken);
    }
    spot.append(rune(), el('div', 'g2-fx-pillar'), el('div', 'g2-fx-burst'), el('div', 'g2-fx-shock'), sparks(16));
    this.quake(0.6, delay + HATCH_T0_MS + BURST_MS);
  }

  /** A token that just left the board (a copy of it) breaks apart, fades into its seal, or shatters. */
  vanish(square: v2.Square, token: HTMLElement, how: Vanish, delay = 0): void {
    const spot = this.spot(square, `vanish ${how}`, 900, delay);
    if (!spot) return;
    token.classList.add('g2-fx-ghost', how);
    spot.append(token, sparks(how === 'consume' ? 8 : 12, how === 'capture' ? 'red' : 'violet'));
  }

  /** A pulse on a seal whose timer just went down. */
  tick(square: v2.Square, delay = 0): void {
    const spot = this.spot(square, 'tick', 800, delay);
    spot?.append(el('div', 'g2-fx-ring'));
  }

  /** The spell just cast, shown big over the board before it dissolves. */
  spell(card: HTMLElement, owner: Color): void {
    const stage = el('div', `g2-fx-spell ${owner}`);
    stage.style.fontSize = `${Math.max(9, Math.round(this.overlay.offsetWidth / 30))}px`;
    const circle = rune();
    circle.classList.add('g2-fx-spellrune');
    card.classList.add('g2-fx-spellcard');
    stage.append(el('div', 'g2-fx-spellring'), circle, card);
    this.overlay.append(stage);
    this.removeAfter(stage, 1700);
  }

  /** A band across the middle of the board: whose turn it is, check, or how the game ended. */
  banner(text: string, tone: BannerTone, sub = '', delay = 0): void {
    const band = el('div', `g2-fx-banner ${tone}`);
    band.style.setProperty('--delay', `${delay}ms`);
    const inner = el('div', 'g2-fx-banner-text');
    inner.append(el('b', '', text));
    if (sub) inner.append(el('span', '', sub));
    band.append(inner);
    this.overlay.append(band);
    this.removeAfter(band, delay + (tone === 'win' || tone === 'lose' || tone === 'draw' ? 3600 : 1700));
  }
}
