// The title screen of the home and sign-in pages: a hand of real cards fanned beside the title, and embers rising
// off the board.

import { v2 } from '@chessx/engine';
import { fillEmbers } from './embers.js';
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
    const from = card.evolvesFrom ? v2.STARTER_CATALOG[card.evolvesFrom] : undefined;
    const frame = fillFrame(el('div', 'hx-card'), {
      kind: 'piece',
      id,
      name: card.name,
      cost: card.cost,
      // Evolution cards are never sacrificed, so they print no timer.
      sealTimer: card.evolvesFrom ? undefined : card.sealTimer,
      line: card.line,
      level: card.level,
      evolvesFrom: from?.name,
      tribe: card.tribe,
      text: v2.describeMovement(card.piece),
      ability: card.abilityText,
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

/** The home page and the sign-in page share the title screen: each has a fan and embers. */
export function initHome(): void {
  for (const fan of document.querySelectorAll<HTMLElement>('.hx-fan')) if (!fan.childElementCount) buildFan(fan);
  for (const box of document.querySelectorAll<HTMLElement>('.hx-bg .hx-embers')) {
    if (!box.childElementCount) fillEmbers(box, EMBERS);
  }
}
