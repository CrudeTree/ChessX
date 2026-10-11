// The home page's hero: a hand of real cards fanned beside the title, and embers rising off the board.

import { v2 } from '@chessx/engine';
import { fillFrame, tiltWithPointer } from './v2/cardFrame.js';
import { glyphFor } from './v2/GameScreen.js';

/** Left to right: the light cards on one side of the fan, the dark ones on the other. */
const SHOWCASE = ['wyrmling', 'dawn_paladin', 'eclipse_knight', 'duskfang'];

/** Each card's place in the fan: offset from the centre in em, drop in em, turn in degrees. */
const FAN = [
  { x: -10.4, y: 2.8, r: -14 },
  { x: -3.8, y: 0, r: -5 },
  { x: 3.8, y: 0, r: 5 },
  { x: 10.4, y: 2.8, r: 14 },
];

const EMBERS = 18;

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function buildFan(fan: HTMLElement): void {
  SHOWCASE.forEach((id, i) => {
    const card = v2.STARTER_CATALOG[id];
    const place = FAN[i];
    if (card?.type !== 'piece' || !place) return;
    const slot = el('div', 'hx-slot');
    slot.style.setProperty('--x', `${place.x}em`);
    slot.style.setProperty('--y', `${place.y}em`);
    slot.style.setProperty('--r', `${place.r}deg`);
    const float = el('div', 'hx-float');
    float.style.animationDelay = `${(-i * 1.9).toFixed(1)}s`;
    const frame = fillFrame(el('div', 'hx-card'), {
      kind: 'piece',
      id,
      name: card.name,
      cost: card.cost,
      sealTimer: card.sealTimer,
      text: v2.describeMovement(card.piece),
      art: card.art,
      glyph: glyphFor(id, card.name),
      owner: 'white',
      rules: card.piece.rules,
    });
    tiltWithPointer(frame);
    float.append(frame);
    slot.append(float);
    fan.append(slot);
  });
}

/** Fixed spreads rather than random ones, so the page looks the same on every visit. */
function buildEmbers(box: HTMLElement): void {
  for (let i = 0; i < EMBERS; i++) {
    const e = el('span', i % 3 === 0 ? 'hx-ember dusk' : 'hx-ember');
    e.style.setProperty('--x', `${(i * 37 + 11) % 100}%`);
    e.style.setProperty('--size', `${2 + (i % 3)}px`);
    e.style.setProperty('--drift', `${((i * 29) % 70) - 35}px`);
    e.style.animationDuration = `${7 + ((i * 13) % 7)}s`;
    e.style.animationDelay = `${(-i * 1.37).toFixed(2)}s`;
    box.append(e);
  }
}

export function initHome(): void {
  const fan = document.getElementById('hx-fan');
  if (fan && !fan.childElementCount) buildFan(fan);
  const embers = document.getElementById('hx-embers');
  if (embers && !embers.childElementCount) buildEmbers(embers);
}
