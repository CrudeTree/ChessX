// The one card frame every rules-2 card is drawn in: the mana cost gem, the name plate, the picture window,
// the type line, the printed text and the sacrifice (seal) timer. Every size is in em, so the hand, the card viewer and
// the board effects draw the same card at different font sizes. How a piece moves is drawn beside the card
// (movement.ts), never on it.

import '@fontsource/cinzel/latin-700.css';
import '@fontsource/alegreya/latin-400.css';
import '@fontsource/alegreya/latin-400-italic.css';
import '@fontsource/alegreya/latin-700.css';
import { v2 } from '@chessx/engine';

type Color = v2.Color;

export interface FrameCard {
  /** `king` is the King, which is not a card: no cost and no timer. */
  kind: 'piece' | 'spell' | 'king';
  /** Card id, or `king`. Picks the colour of the sigil drawn while a card has no picture. */
  id: string;
  name: string;
  cost?: number;
  sealTimer?: number;
  /** Pieces in an evolution line: the line, the level in it, and the name of the card it evolves from. */
  line?: string;
  level?: number;
  evolvesFrom?: string;
  /** The card's type (Warrior, Dragon...); a spell's is the type of piece it is made for. */
  tribe?: string;
  text: string;
  /** Printed under the text, as "Keyword: what it does" (the Initiate's any path). */
  ability?: string;
  /** Abilities a piece on the board was taught by spells, by name (Lava Breath). */
  learned?: string[];
  art?: string;
  glyph: string;
  owner: Color;
  rules?: ReadonlyArray<v2.MoveRule>;
}

/**
 * Every type has its own colour (Djabooty, 2026-10-12), set by this class on a card and on a piece's token:
 * `tribe-warrior`, `tribe-dragon`... so pieces tell apart from across the board.
 */
export const tribeClass = (tribe: string | undefined): string => (tribe ? `tribe-${tribe.toLowerCase()}` : '');

/** "Dragon · Level 2", "Beast", "Dragon Spell": every card shows its type (Djabooty, 2026-10-11). */
function typeLine(card: FrameCard): string {
  if (card.kind === 'king') return 'King · not a card';
  if (card.kind === 'spell') return card.tribe ? `${card.tribe} Spell` : 'Spell';
  const type = card.tribe ?? card.line ?? 'Piece';
  return card.level ? `${type} · Level ${card.level}` : type;
}

/** Hue of the sigil for cards without a picture; any other card gets one from its id. A line shares one hue. */
const SIGIL_HUE: Record<string, number> = {
  king: 44,
  initiate: 36,
  squire: 212,
  recruit: 12,
  warrior: 12,
  warlord: 12,
  apprentice: 268,
  mage: 268,
  archmage: 268,
  colt: 52,
  paladin: 52,
  mystic_dragon: 152,
  ancient_mystic_dragon: 152,
  page: 172,
  hopper: 138,
  cathedral_runner: 348,
  tower: 226,
  dawnfang: 22,
  insight: 200,
  dispel: 288,
};

export function sigilHue(id: string): number {
  const known = SIGIL_HUE[id];
  if (known !== undefined) return known;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** The picture window: the card's picture, or a glowing sigil of its glyph until it has one (bigger at higher levels). */
export function cardArt(card: Pick<FrameCard, 'id' | 'art' | 'glyph' | 'level'>, cls = 'g2-frame-art'): HTMLElement {
  const art = el('div', cls);
  if (card.art) {
    const img = el('img');
    img.src = card.art;
    img.alt = '';
    img.draggable = false;
    art.append(img);
  } else {
    art.classList.add('sigil');
    art.style.setProperty('--hue', String(sigilHue(card.id)));
    if (card.level) art.dataset.level = String(card.level);
    art.append(el('span', 'g2-frame-glyph', card.glyph));
  }
  return art;
}

/** Words the rules text leads with, set as keywords so a card reads at a glance. */
const KEYWORDS = /\b(Steps|Slides|Leaps|Moves|Captures|Draw|Destroy|gain)\b|(\d+)/g;

/** `text` with its keywords and numbers marked up, for the printed text. */
function richText(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  let at = 0;
  for (const m of text.matchAll(KEYWORDS)) {
    const index = m.index ?? 0;
    if (index > at) out.append(text.slice(at, index));
    out.append(m[1] ? el('span', 'g2-kw', m[1]) : el('b', 'g2-num', m[2] ?? ''));
    at = index + m[0].length;
  }
  if (at < text.length) out.append(text.slice(at));
  return out;
}

/** "Keyword: what it does", with the keyword set apart. */
function abilityLine(text: string, cls: string): HTMLElement {
  const line = el('p', `g2-frame-ability ${cls}`);
  const colon = text.indexOf(':');
  if (colon < 0) {
    line.append(el('span', 'g2-kw', text));
    return line;
  }
  line.append(el('span', 'g2-kw', text.slice(0, colon)), richText(text.slice(colon)));
  return line;
}

/**
 * The printed text: what an evolution card evolves from, how a piece moves (or what a spell does), and any ability
 * printed on the card or taught to the piece. It sits in `.g2-frame-copy`, which `fitFrame` measures.
 */
function frameText(card: FrameCard): HTMLElement {
  const box = el('div', 'g2-frame-text');
  const copy = el('div', 'g2-frame-copy');
  if (card.evolvesFrom) {
    const from = el('p', 'g2-frame-evolves', 'Evolves from ');
    from.append(el('span', '', card.evolvesFrom));
    copy.append(from);
  }
  if (card.text) {
    const rules = el('p', 'g2-frame-rules');
    rules.append(richText(card.text));
    copy.append(rules);
  }
  if (card.ability) copy.append(abilityLine(card.ability, 'printed'));
  for (const name of card.learned ?? []) copy.append(abilityLine(name, 'learned'));
  box.append(copy);
  return box;
}

/** An hourglass for sacrifice timers (the ⧗ character draws like an X in many fonts). */
export function hourglass(cls = 'g2-hourglass'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 10 14');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M1.5 1h7M1.5 13h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '<path d="M2.5 1.5c0 3.2 5 3.6 5 5.5s-5 2.3-5 5.5h5c0-3.2-5-3.6-5-5.5s5-2.3 5-5.5z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>' +
    '<path d="M3.6 12.2c.4-1.3 2.4-1.9 2.8-.1z" fill="currentColor"/>';
  return svg;
}

// ---------------------------------------------------------------------------------------------------- fitting

/** Smallest scale the printed text may shrink to, and the name before it wraps onto two lines. */
const MIN_TEXT_FIT = 0.66;
const MIN_NAME_FIT = 0.7;

interface Fit {
  text: number;
  name: number;
  /** The name does not fit on one line even at its smallest: it wraps onto two. */
  wrap: boolean;
}

/** Fits by card face. Every size in a frame is in em, so one measurement holds at every size the card is drawn. */
const fits = new Map<string, Fit>();
let probe: HTMLElement | null = null;

const faceKey = (card: FrameCard): string =>
  [card.kind, card.name, card.evolvesFrom ?? '', card.text, card.ability ?? '', ...(card.learned ?? [])].join('|');

/** How far the text and the name of a frame must shrink to fit, measured on a hidden copy of it. */
function measure(root: HTMLElement): Fit {
  if (!probe) {
    probe = el('div', 'g2-frame-probe');
    probe.setAttribute('aria-hidden', 'true');
  }
  if (!probe.isConnected) document.body.append(probe);
  const copy = root.cloneNode(true) as HTMLElement;
  copy.className = root.className.split(' ').filter((c) => c.startsWith('g2-frame')).join(' ');
  copy.removeAttribute('style');
  probe.replaceChildren(copy);

  const fit: Fit = { text: 1, name: 1, wrap: false };
  const box = copy.querySelector<HTMLElement>('.g2-frame-text');
  const body = copy.querySelector<HTMLElement>('.g2-frame-copy');
  if (box && body) {
    const room = (): number => {
      const style = getComputedStyle(box);
      return box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    };
    while (fit.text > MIN_TEXT_FIT && body.offsetHeight > room() + 0.5) {
      fit.text = Math.round((fit.text - 0.03) * 100) / 100;
      box.style.setProperty('--fit', String(fit.text));
    }
  }
  const plate = copy.querySelector<HTMLElement>('.g2-frame-name');
  const name = plate?.querySelector<HTMLElement>('span');
  if (plate && name) {
    const over = () => name.scrollWidth > name.clientWidth + 0.5;
    while (fit.name > MIN_NAME_FIT && over()) {
      fit.name = Math.round((fit.name - 0.03) * 100) / 100;
      plate.style.setProperty('--name-fit', String(fit.name));
    }
    fit.wrap = over();
  }
  probe.replaceChildren();
  return fit;
}

function applyFit(root: HTMLElement, fit: Fit): void {
  const box = root.querySelector<HTMLElement>('.g2-frame-text');
  const plate = root.querySelector<HTMLElement>('.g2-frame-name');
  box?.style.setProperty('--fit', String(fit.text));
  plate?.style.setProperty('--name-fit', fit.wrap ? '1' : String(fit.name));
  plate?.classList.toggle('wrap', fit.wrap);
}

/** Shrinks a frame's printed text and name until they fit their boxes. */
function fitFrame(root: HTMLElement, key: string): void {
  root.dataset.face = key;
  let fit = fits.get(key);
  if (!fit) {
    fit = measure(root);
    fits.set(key, fit);
  }
  applyFit(root, fit);
}

/** The card fonts load on first use, and text measured before that was measured in the fallback font. */
function refitAll(): void {
  fits.clear();
  for (const root of document.querySelectorAll<HTMLElement>('.g2-frame[data-face]')) fitFrame(root, root.dataset.face!);
}
document.fonts?.addEventListener('loadingdone', refitAll);

/** Draw `card` into `root`. */
export function fillFrame(root: HTMLElement, card: FrameCard): HTMLElement {
  root.classList.add('g2-frame', `g2-frame-${card.kind}`);
  if (card.tribe) root.classList.add(tribeClass(card.tribe));
  const inner = el('div', 'g2-frame-inner');
  const name = el('div', 'g2-frame-name');
  name.append(el('span', '', card.name));
  inner.append(name, cardArt(card), el('div', 'g2-frame-type', typeLine(card)), frameText(card));
  root.append(inner);

  if (card.cost !== undefined) {
    const cost = el('span', 'g2-frame-cost');
    cost.append(el('b', '', String(card.cost)));
    cost.title = `Mana cost ${card.cost}`;
    root.append(cost);
  }
  if (card.kind === 'piece' && card.sealTimer !== undefined) {
    const timer = el('span', 'g2-frame-timer');
    timer.append(hourglass(), el('b', '', String(card.sealTimer)));
    timer.title = `Sacrifice timer ${card.sealTimer}: sacrifice one of your pieces for this card and it arrives after ${card.sealTimer} of your turn${card.sealTimer === 1 ? '' : 's'}`;
    root.append(timer);
  }
  root.append(el('span', 'g2-frame-shine'));
  fitFrame(root, faceKey(card));
  return root;
}

/** The back of a card: sacrifices, the opponent's hand and the empty card viewer. */
export function cardBack(cls = ''): HTMLElement {
  const back = el('div', `g2-back${cls ? ` ${cls}` : ''}`);
  back.append(el('span', 'g2-back-mark', 'X'));
  return back;
}

/**
 * Tilt a card towards the pointer and move its shine with it. The tilt is written to CSS variables, so a
 * card's own transforms (its place in the fan, a lift) still apply.
 */
export function tiltWithPointer(card: HTMLElement): void {
  card.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const box = card.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    card.style.setProperty('--tilt-x', `${((0.5 - y) * 14).toFixed(2)}deg`);
    card.style.setProperty('--tilt-y', `${((x - 0.5) * 16).toFixed(2)}deg`);
    card.style.setProperty('--shine-x', `${(x * 100).toFixed(1)}%`);
    card.style.setProperty('--shine-y', `${(y * 100).toFixed(1)}%`);
  });
  card.addEventListener('pointerleave', () => {
    for (const v of ['--tilt-x', '--tilt-y', '--shine-x', '--shine-y']) card.style.removeProperty(v);
  });
}
