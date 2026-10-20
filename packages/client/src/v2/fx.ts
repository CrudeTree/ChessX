// Board effects: summoning circles, pillars of light, bursts, sparks, breaking tokens, the spell reveal and
// banners. GameScreen says what happened (from the server's events) and where; this only draws. On the 3D board
// (board3d.ts) they play on its leaning floor, under the figures, and the pillars and bolts stand up off it.

import type { v2 } from '@chessx/engine';

type Color = v2.Color;

export type BannerTone = 'turn' | 'check' | 'win' | 'lose' | 'draw' | 'mana';

/** How a token that just left the board goes: captured, sealed away, or a seal destroyed. */
export type Vanish = 'capture' | 'consume' | 'shatter';

/** How long a summon's card takes to dive into its square before the circle opens. */
export const CARD_DIVE_MS = 320;
/** From the circle opening to the burst as the piece lands (the burst's delay in style.css). */
export const BURST_MS = 250;
/** How long a hatching seal cracks before its circle opens (--t0 of .g2-fx-spot.hatch). */
export const HATCH_T0_MS = 230;
/** How long a ball of lava flies before it lands (g2-lava-fly in style.css). */
export const LAVA_FLIGHT_MS = 460;
/** How long a cast spell's card covers the board (g2-spellcard in style.css) before it flies to the discard pile. */
export const SPELL_HOLD_MS = 780;
/** How long it takes to fly there. */
const SPELL_FLY_MS = 480;
/** When it lands. */
export const SPELL_LANDS_MS = SPELL_HOLD_MS + SPELL_FLY_MS;
/** The mana squares moving (`shiftShrines`): when the old ones have burst, when the new ones land, and when it is over. */
export const SHIFT_GONE_MS = 300;
export const SHIFT_LAND_MS = 1250;
export const SHIFT_MS = 2300;

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
  /** Cards on their way off the board to a discard pile, over the whole page. */
  private readonly flyers = new Set<HTMLElement>();
  /** Shakes with the board: the 3D board's figures. */
  private shaken: HTMLElement | null = null;

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

  shakeAlso(el: HTMLElement | null): void {
    this.shaken = el;
  }

  clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const f of this.flyers) f.remove();
    this.flyers.clear();
    this.floor.replaceChildren();
    this.overlay.replaceChildren();
  }

  private later(ms: number, run: () => void): void {
    const t = window.setTimeout(() => {
      this.timers.delete(t);
      run();
    }, ms);
    this.timers.add(t);
  }

  private removeAfter(node: HTMLElement, ms: number): void {
    this.later(ms, () => node.remove());
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
    for (const el of [this.board, this.shaken]) {
      el?.animate(
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

  /**
   * A piece evolves: the evolution `card` dives into its square (null when the player dropped it there), then the
   * old piece cracks like a hatching seal and the new one rises in a pillar of light, shaking the board as hard
   * as `force` (0 to 1).
   */
  evolve(square: v2.Square, owner: Color, oldToken: HTMLElement | null, card: HTMLElement | null, force: number): void {
    const spot = this.spot(square, `evolve ${owner}${card ? ' with-card' : ''}`, 1900, 0);
    if (!spot) return;
    if (card) {
      card.classList.add('g2-fx-card');
      spot.append(card);
    }
    if (oldToken) {
      oldToken.classList.add('g2-fx-ghost', 'crack');
      spot.append(oldToken);
    }
    spot.append(rune(), el('div', 'g2-fx-pillar'), el('div', 'g2-fx-burst'), el('div', 'g2-fx-shock'), sparks(18));
    this.quake(force, (card ? CARD_DIVE_MS : 0) + HATCH_T0_MS + BURST_MS);
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

  /**
   * A Dragon spits lava: a molten ball arcs from `from` onto `to` and splashes there in embers. The pool it leaves is
   * the board's own (the cell's lava), which wells up as the ball lands.
   */
  lava(from: v2.Square, to: v2.Square, delay = 0): void {
    const source = this.cell(from);
    const target = this.cell(to);
    if (!source || !target) return;
    const spot = this.spot(to, 'lava', LAVA_FLIGHT_MS + 1100, delay);
    if (!spot) return;
    spot.style.setProperty('--from-x', `${source.offsetLeft - target.offsetLeft}px`);
    spot.style.setProperty('--from-y', `${source.offsetTop - target.offsetTop}px`);
    const ball = el('div', 'g2-fx-lavaball');
    ball.append(el('i'));
    spot.append(ball, el('div', 'g2-fx-splash'), sparks(16, 'ember'));
    this.quake(0.35, delay + LAVA_FLIGHT_MS);
  }

  /** A piece learns an ability from a spell: a ring of fire and embers flying off it. */
  learn(square: v2.Square, delay = 0): void {
    const spot = this.spot(square, 'learn', 1300, delay);
    spot?.append(el('div', 'g2-fx-ring ember'), sparks(16, 'ember'));
  }

  /** Lava (gone from the board already) darkening into rock and rising off it as steam. */
  cool(square: v2.Square, delay = 0): void {
    const spot = this.spot(square, 'cool', 1400, delay);
    spot?.append(el('div', 'g2-lava cooling'), el('div', 'g2-fx-steam'), el('div', 'g2-fx-steam late'));
  }

  /**
   * The mana squares ran dry and move: the old ones' gems burst into blue sparks, then pillars of mana come down on the
   * new ones and land together, shaking the board. The squares' own marks change in step (`SHIFT_GONE_MS`).
   */
  shiftShrines(from: v2.Square[], to: v2.Square[], delay = 0): void {
    for (const square of from) {
      const spot = this.spot(square, 'drain mana', 1100, delay);
      spot?.append(el('div', 'g2-fx-gem'), el('div', 'g2-fx-ring ice'), sparks(12, 'ice'));
    }
    for (const square of to) {
      const spot = this.spot(square, 'summon mana', 1700, delay + SHIFT_LAND_MS - BURST_MS);
      spot?.append(rune(), el('div', 'g2-fx-pillar'), el('div', 'g2-fx-burst'), el('div', 'g2-fx-shock'), sparks(14, 'ice'));
    }
    this.quake(0.45, delay + SHIFT_LAND_MS);
  }

  /** Mana won on a square ("+2"), floating up from it. */
  gain(square: v2.Square, text: string, delay = 0): void {
    const spot = this.spot(square, 'gain', 1500, delay);
    spot?.append(el('div', 'g2-fx-gain', text));
  }

  /** A piece is shielded: a golden dome closes over it and rings once. */
  shield(square: v2.Square, delay = 0): void {
    const spot = this.spot(square, 'shield', 1400, delay);
    spot?.append(el('div', 'g2-fx-dome'), el('div', 'g2-fx-ring gold'), sparks(12, 'gold'));
  }

  /** A piece is frozen: frost spreads over its square and ice shards fly off it. */
  freeze(square: v2.Square, delay = 0): void {
    const spot = this.spot(square, 'freeze', 1400, delay);
    spot?.append(el('div', 'g2-fx-frost'), el('div', 'g2-fx-ring ice'), sparks(14, 'ice'));
  }

  /** A piece is smitten: a bolt from above, and the piece (a copy of its token) breaks apart. */
  smite(square: v2.Square, token: HTMLElement, delay = 0): void {
    const spot = this.spot(square, 'smite', 1100, delay);
    if (!spot) return;
    token.classList.add('g2-fx-ghost', 'capture');
    spot.append(el('div', 'g2-fx-bolt'), token, el('div', 'g2-fx-burst'), sparks(16, 'gold'));
    this.quake(0.7, delay + 90);
  }

  /**
   * The spell just cast covers the board for a moment so both players see what it was, then flies into its caster's
   * discard pile; `pile` finds that on screen as it leaves, and `landed` runs as it lands. With no pile to fly to, it
   * fades where it is.
   */
  spell(card: HTMLElement, owner: Color, pile: () => HTMLElement | null, landed?: () => void): void {
    const stage = el('div', `g2-fx-spell ${owner}`);
    // A card is 10em by 14em: as big as the board leaves room for.
    const size = Math.min((this.overlay.offsetWidth * 0.86) / 10, (this.overlay.offsetHeight * 0.9) / 14);
    stage.style.fontSize = `${Math.max(9, size).toFixed(1)}px`;
    const circle = rune();
    circle.classList.add('g2-fx-spellrune');
    card.classList.add('g2-fx-spellcard');
    stage.append(el('div', 'g2-fx-spellring'), circle, card);
    this.overlay.append(stage);
    this.removeAfter(stage, SPELL_HOLD_MS + SPELL_FLY_MS + 200);
    this.later(SPELL_HOLD_MS, () => this.toPile(card, pile, landed));
  }

  /** Lifts `card` off the board onto the page and flies it into the discard pile, which bumps as it lands. */
  private toPile(card: HTMLElement, pile: () => HTMLElement | null, landed?: () => void): void {
    const from = card.getBoundingClientRect();
    const to = pile()?.getBoundingClientRect();
    if (!to?.width || !from.width) {
      card.classList.add('fade');
      landed?.();
      return;
    }
    const flyer = el('div', 'g2-fx-flyer');
    flyer.style.left = `${from.left}px`;
    flyer.style.top = `${from.top}px`;
    flyer.style.width = `${from.width}px`;
    flyer.style.height = `${from.height}px`;
    flyer.style.fontSize = getComputedStyle(card).fontSize;
    card.classList.remove('g2-fx-spellcard');
    flyer.append(card);
    document.body.append(flyer);
    this.flyers.add(flyer);
    const scale = Math.min(to.width / from.width, to.height / from.height);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    flyer.animate(
      [
        { transform: 'none', opacity: 1 },
        { transform: `translate(${dx * 0.3}px, ${dy * 0.3 - from.height * 0.06}px) scale(${0.5 + scale * 0.5}) rotate(-5deg)`, opacity: 1, offset: 0.4 },
        { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(0deg)`, opacity: 0.85 },
      ],
      { duration: SPELL_FLY_MS, easing: 'cubic-bezier(0.5, 0, 0.6, 1)', fill: 'forwards' },
    );
    this.later(SPELL_FLY_MS, () => {
      flyer.remove();
      this.flyers.delete(flyer);
      landed?.();
      pile()?.animate([{ scale: '1' }, { scale: '1.25' }, { scale: '1' }], { duration: 280, easing: 'ease-out' });
    });
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
