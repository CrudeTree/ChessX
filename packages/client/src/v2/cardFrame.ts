// The one card frame every rules-2 card is drawn in: the name on top, the picture window, the mana cost and
// the seal timer in two corners, an 8x8 move diagram and the printed text. Spells have no timer or diagram.
// Every size is in em, so the hand and the inspect panel show the same frame at different font sizes.

import { v2 } from '@chessx/engine';

type Color = v2.Color;

export interface FrameCard {
  /** `king` is the King, which is not a card: no cost and no timer. */
  kind: 'piece' | 'spell' | 'king';
  name: string;
  cost?: number;
  sealTimer?: number;
  text: string;
  art?: string;
  glyph: string;
  owner: Color;
  rules?: ReadonlyArray<v2.MoveRule>;
}

const SIZE = 8;
/** Column and row of the piece on the diagram, counted from the bottom left as you see it. */
const AT = 3;

const TYPE_LINE: Record<FrameCard['kind'], string> = { piece: 'Piece', spell: 'Spell', king: 'King · not a card' };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/**
 * Draw `card` into `root`. `flipped` turns the diagram the way the board is turned for a player
 * sitting at the top, so it matches the piece on the board.
 */
export function fillFrame(root: HTMLElement, card: FrameCard, flipped: boolean): HTMLElement {
  root.classList.add('g2-frame', `g2-frame-${card.kind}`);
  const top = el('div', 'g2-frame-top');
  top.append(el('span', 'g2-frame-name', card.name));

  const window = el('div', 'g2-frame-window');
  if (card.art) {
    const img = el('img');
    img.src = card.art;
    img.alt = '';
    img.draggable = false;
    window.append(img);
  } else {
    window.append(el('span', 'g2-frame-glyph', card.glyph));
  }

  const body = el('div', 'g2-frame-body');
  if (card.kind !== 'spell' && card.rules) body.append(moveDiagram(card.rules, card.owner, card.glyph, flipped));
  body.append(el('div', 'g2-frame-text', card.text));

  root.append(top, window, el('div', 'g2-frame-type', TYPE_LINE[card.kind]), body);

  if (card.cost !== undefined) {
    const cost = el('span', 'g2-frame-cost', String(card.cost));
    cost.title = `Mana cost ${card.cost}`;
    root.append(cost);
  }
  if (card.kind === 'piece' && card.sealTimer !== undefined) {
    const timer = el('span', 'g2-frame-timer', `⧗${card.sealTimer}`);
    timer.title = `Seal timer ${card.sealTimer}: a seal of this card hatches after ${card.sealTimer} of its owner's turn${card.sealTimer === 1 ? '' : 's'}`;
    root.append(timer);
  }
  return root;
}

/** Where the piece can go from d4 of an empty board: green dot moves there, red ring captures there. */
function moveDiagram(rules: ReadonlyArray<v2.MoveRule>, owner: Color, glyph: string, flipped: boolean): HTMLElement {
  const flip = flipped ? -1 : 1;
  const marks = new Map<number, { move: boolean; capture: boolean }>();
  for (const r of rules) {
    const towardEnemy = r.relative && owner === 'black' ? -1 : 1;
    for (const [df, dr] of r.dirs) {
      const sx = df * flip;
      const sy = dr * towardEnemy * flip;
      for (let k = 1; k <= (r.leap ? 1 : r.range); k++) {
        const x = AT + sx * k;
        const y = AT + sy * k;
        if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) break;
        const m = marks.get(y * SIZE + x) ?? { move: false, capture: false };
        if (r.mode !== 'capture') m.move = true;
        if (r.mode !== 'move') m.capture = true;
        marks.set(y * SIZE + x, m);
      }
    }
  }
  const grid = el('div', 'g2-frame-diagram');
  grid.title = 'Green dot: moves there. Red ring: captures there.';
  for (let row = 0; row < SIZE; row++) {
    const y = SIZE - 1 - row;
    for (let x = 0; x < SIZE; x++) {
      const m = marks.get(y * SIZE + x);
      const cell = el('div', `g2-frame-sq ${(x + y) % 2 === 0 ? 'dark' : 'light'}${m?.move ? ' mv' : ''}${m?.capture ? ' cap' : ''}`);
      if (x === AT && y === AT) cell.append(el('span', `g2-frame-token ${owner}`, glyph));
      grid.append(cell);
    }
  }
  return grid;
}
