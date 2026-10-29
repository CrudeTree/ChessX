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
/**
 * An elder piece arriving (the Ancient Mystic Dragon): the world dims, its sigil turns above the square, and the piece
 * comes down inside a column of light. `ELDER_T0_MS` is from the card's dive to the ritual starting, `ELDER_LAND_MS`
 * from the start of the ritual to the piece setting down, and `ELDER_MS` how long the ritual runs in all.
 */
export const ELDER_T0_MS = 260;
export const ELDER_LAND_MS = 1750;
export const ELDER_MS = 3400;

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

/** A jagged bolt `height` px tall, from straight above down to (0, 0), each turn up to `jag` px aside. */
function boltPath(height: number, jag: number, turns: number): string {
  let d = `M${((Math.random() - 0.5) * jag).toFixed(1)} ${-height}`;
  for (let i = 1; i < turns; i++) d += ` L${((Math.random() - 0.5) * 2 * jag).toFixed(1)} ${(-height + (height * i) / turns).toFixed(1)}`;
  return `${d} L0 0`;
}

/**
 * Where a held card, a ball of static, shoots down into a square (centred at `x`, `y` on the page, `size` px across): a
 * bolt of lightning from above, a flash, two rings and sparks, in `owner`'s colours. It takes itself away when done.
 */
export function strikeBurst(x: number, y: number, size: number, owner: Color): HTMLElement {
  const burst = el('div', `g2-strike ${owner}`);
  burst.style.left = `${x}px`;
  burst.style.top = `${y}px`;
  burst.style.setProperty('--size', `${size}px`);
  const tall = size * 2.6;
  const wide = size * 0.9;
  const bolts = [boltPath(tall, size * 0.18, 7), boltPath(tall * 0.7, size * 0.14, 5)];
  burst.insertAdjacentHTML(
    'beforeend',
    `<svg class="g2-strike-bolt" viewBox="${-wide / 2} ${-tall} ${wide} ${tall}" style="width:${wide}px;height:${tall}px" aria-hidden="true">` +
      bolts.map((d, i) => `<path class="glow${i ? ' thin' : ''}" d="${d}"/><path class="line${i ? ' thin' : ''}" d="${d}"/>`).join('') +
      '</svg>',
  );
  burst.append(el('i', 'g2-strike-flash'), el('i', 'g2-strike-ring'), el('i', 'g2-strike-ring late'));
  for (let i = 0; i < 14; i++) {
    const spark = el('i', 'g2-strike-spark');
    const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
    const reach = size * (0.7 + Math.random() * 0.8);
    spark.style.setProperty('--dx', `${(Math.cos(angle) * reach).toFixed(1)}px`);
    spark.style.setProperty('--dy', `${(Math.sin(angle) * reach * 0.75).toFixed(1)}px`);
    burst.append(spark);
  }
  window.setTimeout(() => burst.remove(), 900);
  return burst;
}

/**
 * An elder's sigil: a wide ritual circle with a second, counter-turning ring and long rays, drawn in the owner's
 * colour. Only used for the pieces that bring a whole ceremony with them (`elderSummon`).
 */
const ELDER_SIGIL = (() => {
  const rays = Array.from({ length: 24 }, (_, i) => `<path transform="rotate(${i * 15}) translate(0 -47)" d="M0 0 L0 -6"/>`).join('');
  const ticks = Array.from({ length: 36 }, (_, i) => `<path transform="rotate(${i * 10}) translate(0 -28.5)" d="M0 0 L0 2.2"/>`).join('');
  return (
    '<svg viewBox="-50 -50 100 100" aria-hidden="true">' +
    '<circle class="e1" r="49"/><circle class="e2" r="41"/><circle class="e3" r="24"/>' +
    '<path class="e4" d="M0 -41 L35.5 20.5 L-35.5 20.5 Z M0 41 L35.5 -20.5 L-35.5 -20.5 Z"/>' +
    '<path class="e5" d="M0 -24 L20.8 12 L-20.8 12 Z M0 24 L20.8 -12 L-20.8 -12 Z"/>' +
    `<g class="e6">${ticks}</g><g class="e7">${rays}</g>` +
    '</svg>'
  );
})();

function elderSigil(cls = ''): HTMLElement {
  const s = el('div', `g2-elder-sigil${cls ? ` ${cls}` : ''}`);
  s.innerHTML = ELDER_SIGIL;
  return s;
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
  quake(force: number, delay = 0): void {
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
   * An elder piece arrives: the Ancient Mystic Dragon, and anything else the cards mark as `elder`. The world dims to
   * a cold blue, its sigil turns above the square, a column of light opens and the piece comes down inside it, in a
   * burst that rings across the board twice. It takes `ELDER_MS` — a few seconds longer than any other summon, on
   * purpose: this is meant to be watched.
   *
   * It is built as one stage in the overlay rather than a spot on the floor. The floor lies inside the board, and on
   * the 3D board the board is a leaning, transformed box under a canvas holding the figures, so a floor child would be
   * painted beneath the pieces and the dark would not read as the world dimming at all. The overlay sits over both, so
   * the dark really does fall across the board and the dragon, and the ritual is drawn on top of it in turn.
   */
  elderSummon(square: v2.Square, owner: Color, card: HTMLElement | null, delay = 0): void {
    const cell = this.cell(square);
    if (!cell) return;
    const box = this.overlay.getBoundingClientRect();
    const at = cell.getBoundingClientRect();
    const w = at.width || box.width / 8;
    const h = at.height || box.height / 8;

    const stage = el('div', `g2-elder ${owner}${card ? ' with-card' : ''}`);
    stage.style.left = `${at.left - box.left}px`;
    stage.style.top = `${at.top - box.top}px`;
    stage.style.width = `${w}px`;
    stage.style.height = `${h}px`;
    stage.style.setProperty('--cell', `${w}px`);
    stage.style.setProperty('--delay', `${delay}ms`);
    /*
     * The dark has to cover the whole board, so it is placed in board coordinates rather than the square's. Its glow is
     * centred on the square the dragon is landing on — both axes, from that square's own offset in the board. Taking
     * the horizontal centre from the board instead left the spotlight in the middle column whatever column the dragon
     * was actually summoned to, while the vertical one tracked the piece correctly.
     */
    const board = this.board.getBoundingClientRect();
    stage.style.setProperty('--bx', `${board.left - at.left}px`);
    stage.style.setProperty('--by', `${board.top - at.top}px`);
    stage.style.setProperty('--bw', `${board.width}px`);
    stage.style.setProperty('--bh', `${board.height}px`);
    stage.style.setProperty('--hx', `${at.left - board.left + w / 2}px`);
    stage.style.setProperty('--hy', `${at.top - board.top + h / 2}px`);
    // Half the diagonal, so the dark still reaches the far corners from any square on the board.
    stage.style.setProperty('--glow', `${Math.hypot(board.width, board.height) / 2}px`);
    // The board's own lean, so the beam rises square with it instead of straight up out of a tilted floor.
    const tilt = getComputedStyle(this.board).getPropertyValue('--tilt').trim();
    if (tilt) stage.style.setProperty('--tilt', tilt);

    const dark = el('div', 'g2-elder-dark');
    const ritual = el('div', 'g2-elder-ritual');
    if (card) {
      card.classList.add('g2-fx-card');
      ritual.append(card);
    }
    ritual.append(rune(), elderSigil('outer'), elderSigil('inner'));
    ritual.append(el('div', 'g2-elder-beam'), el('div', 'g2-elder-glow'), el('div', 'g2-fx-burst'));
    ritual.append(el('div', 'g2-fx-shock'), el('div', 'g2-fx-shock late'));
    ritual.append(sparks(26, 'gold'), sparks(14));

    stage.append(dark, ritual);
    this.overlay.append(stage);
    this.removeAfter(stage, delay + ELDER_MS + 60);

    const t0 = delay + (card ? CARD_DIVE_MS : 0) + ELDER_T0_MS;
    this.quake(1, t0 + ELDER_LAND_MS);
    this.quake(0.45, t0 + ELDER_LAND_MS + 620);
  }

  /** A piece arrives: `card` (a drawn card face, or null when the player already dropped it there) dives into
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
