// The one card frame every rules-2 card is drawn in: the mana cost gem, the name plate, the picture window,
// the type line, the printed text and the seal timer. Every size is in em, so the hand, the card viewer and
// the board effects draw the same card at different font sizes. How a piece moves is drawn beside the card
// (movement.ts), never on it.

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
  text: string;
  art?: string;
  glyph: string;
  owner: Color;
  rules?: ReadonlyArray<v2.MoveRule>;
}

const TYPE_LINE: Record<FrameCard['kind'], string> = { piece: 'Piece', spell: 'Spell', king: 'King · not a card' };

/** Hue of the sigil for cards without a picture; any other card gets one from its id. */
const SIGIL_HUE: Record<string, number> = {
  king: 44,
  initiate: 36,
  squire: 212,
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

/** The picture window: the card's picture, or a glowing sigil of its glyph until it has one. */
export function cardArt(card: Pick<FrameCard, 'id' | 'art' | 'glyph'>, cls = 'g2-frame-art'): HTMLElement {
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
    art.append(el('span', 'g2-frame-glyph', card.glyph));
  }
  return art;
}

/** Draw `card` into `root`. */
export function fillFrame(root: HTMLElement, card: FrameCard): HTMLElement {
  root.classList.add('g2-frame', `g2-frame-${card.kind}`);
  const inner = el('div', 'g2-frame-inner');
  const name = el('div', card.name.length > 11 ? 'g2-frame-name long' : 'g2-frame-name');
  name.append(el('span', '', card.name));
  inner.append(name, cardArt(card), el('div', 'g2-frame-type', TYPE_LINE[card.kind]), el('div', 'g2-frame-text', card.text));
  root.append(inner);

  if (card.cost !== undefined) {
    const cost = el('span', 'g2-frame-cost');
    cost.append(el('b', '', String(card.cost)));
    cost.title = `Mana cost ${card.cost}`;
    root.append(cost);
  }
  if (card.kind === 'piece' && card.sealTimer !== undefined) {
    const timer = el('span', 'g2-frame-timer', `⧗${card.sealTimer}`);
    timer.title = `Seal timer ${card.sealTimer}: a seal of this card hatches after ${card.sealTimer} of its owner's turn${card.sealTimer === 1 ? '' : 's'}`;
    root.append(timer);
  }
  root.append(el('span', 'g2-frame-shine'));
  return root;
}

/** The back of a card: seals, the opponent's hand and the empty card viewer. */
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
