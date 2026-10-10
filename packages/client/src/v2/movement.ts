// How a piece moves, drawn beside its card: an 8x8 board with the piece on d4 as its owner sees it, a dot
// where it can move, a ring where it can capture, a line along every slide and an arc for every leap, plus
// a legend of just the marks this piece uses.

import { v2 } from '@chessx/engine';

const SIZE = 8;
/** Column and row of the piece, counted from the bottom left as you see it. */
const AT = 3;
const NS = 'http://www.w3.org/2000/svg';
/** Delay between one ring of marks and the next as the board appears. */
const STAGGER_MS = 55;

export interface MovingPiece {
  rules: ReadonlyArray<v2.MoveRule>;
  owner: v2.Color;
  glyph: string;
  art?: string;
}

interface Mark {
  move: boolean;
  capture: boolean;
  /** Squares from the piece (king steps), for the order the marks appear in. */
  dist: number;
}

interface Ray {
  x: number;
  y: number;
  mode: 'both' | 'move' | 'capture';
}

interface Reach {
  marks: Map<number, Mark>;
  rays: Ray[];
  /** Squares reached by a leap; each gets an arc from the piece. */
  hops: Array<{ x: number; y: number }>;
}

/** `flipped` turns the board the way it is turned for a player sitting at the top. */
function reach(piece: MovingPiece, flipped: boolean): Reach {
  const flip = flipped ? -1 : 1;
  const marks = new Map<number, Mark>();
  const rays: Ray[] = [];
  const hops: Reach['hops'] = [];
  for (const r of piece.rules) {
    const mode = r.mode ?? 'both';
    const towardEnemy = r.relative && piece.owner === 'black' ? -1 : 1;
    for (const [df, dr] of r.dirs) {
      const sx = df * flip;
      const sy = dr * towardEnemy * flip;
      let steps = 0;
      for (let k = 1; k <= (r.leap ? 1 : r.range); k++) {
        const x = AT + sx * k;
        const y = AT + sy * k;
        if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) break;
        const key = y * SIZE + x;
        const m = marks.get(key) ?? { move: false, capture: false, dist: Infinity };
        if (mode !== 'capture') m.move = true;
        if (mode !== 'move') m.capture = true;
        m.dist = Math.min(m.dist, Math.max(Math.abs(x - AT), Math.abs(y - AT)));
        marks.set(key, m);
        if (r.leap) hops.push({ x, y });
        steps = k;
      }
      if (!r.leap && steps > 1) rays.push({ x: AT + sx * steps, y: AT + sy * steps, mode });
    }
  }
  return { marks, rays, hops };
}

const svgEl = (tag: string, attrs: Record<string, string | number>, cls = ''): SVGElement => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (cls) e.setAttribute('class', cls);
  return e;
};

let clipIds = 0;

function boardSvg(piece: MovingPiece, { marks, rays, hops }: Reach): SVGElement {
  const svg = svgEl('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, role: 'img', 'aria-label': 'Where this piece can go' }, 'g2-move-board');
  const top = (y: number): number => SIZE - 1 - y;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const home = x === AT && y === AT ? ' home' : '';
      svg.append(svgEl('rect', { x, y: top(y), width: 1, height: 1 }, `sq ${(x + y) % 2 === 0 ? 'dark' : 'light'}${home}`));
    }
  }
  for (const ray of rays) {
    svg.append(svgEl('line', { x1: AT + 0.5, y1: top(AT) + 0.5, x2: ray.x + 0.5, y2: top(ray.y) + 0.5 }, `ray ${ray.mode}`));
  }
  const x1 = AT + 0.5;
  const y1 = top(AT) + 0.5;
  for (const hop of hops) {
    const x2 = hop.x + 0.5;
    const y2 = top(hop.y) + 0.5;
    const bx = (x1 + x2) / 2 + (y2 - y1) * 0.35;
    const by = (y1 + y2) / 2 - (x2 - x1) * 0.35;
    svg.append(svgEl('path', { d: `M${x1} ${y1} Q${bx} ${by} ${x2} ${y2}` }, 'hop'));
  }
  for (const [key, m] of marks) {
    const cx = (key % SIZE) + 0.5;
    const cy = top(Math.floor(key / SIZE)) + 0.5;
    const g = svgEl('g', {}, 'mark');
    g.style.animationDelay = `${120 + m.dist * STAGGER_MS}ms`;
    if (m.capture) g.append(svgEl('circle', { cx, cy, r: 0.36 }, 'cap'));
    if (m.move) g.append(svgEl('circle', { cx, cy, r: m.capture ? 0.13 : 0.17 }, 'mv'));
    svg.append(g);
  }

  const cx = AT + 0.5;
  const cy = top(AT) + 0.5;
  const tok = svgEl('g', {}, `tok ${piece.owner}`);
  tok.append(svgEl('circle', { cx, cy, r: 0.43 }, 'tok-face'));
  if (piece.art) {
    const id = `g2-move-clip-${++clipIds}`;
    const clip = svgEl('clipPath', { id });
    clip.append(svgEl('circle', { cx, cy, r: 0.38 }));
    const img = svgEl('image', { href: piece.art, x: cx - 0.6, y: cy - 0.58, width: 1.2, height: 1.2, preserveAspectRatio: 'xMidYMid slice', 'clip-path': `url(#${id})` });
    tok.append(clip, img);
  } else {
    const glyph = svgEl('text', { x: cx, y: cy + 0.02, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, 'tok-glyph');
    glyph.textContent = piece.glyph;
    tok.append(glyph);
  }
  tok.append(svgEl('circle', { cx, cy, r: 0.43 }, 'tok-rim'));
  svg.append(tok);
  return svg;
}

const LEGEND: Record<'both' | 'mv' | 'cap' | 'ray' | 'leap', string> = {
  both: 'Moves or captures there',
  mv: 'Moves there, cannot capture',
  cap: 'Captures there only',
  ray: 'Slides until a piece blocks it',
  leap: 'Leaps over pieces in between',
};

/** The board and its legend. */
export function movementPanel(piece: MovingPiece, flipped: boolean): HTMLElement {
  const found = reach(piece, flipped);
  const panel = document.createElement('div');
  panel.className = 'g2-move';
  panel.append(boardSvg(piece, found));

  const used = new Set<keyof typeof LEGEND>();
  for (const m of found.marks.values()) used.add(m.move && m.capture ? 'both' : m.move ? 'mv' : 'cap');
  if (found.rays.length) used.add('ray');
  if (found.hops.length) used.add('leap');
  const legend = document.createElement('ul');
  legend.className = 'g2-move-legend';
  for (const key of ['both', 'mv', 'cap', 'ray', 'leap'] as const) {
    if (!used.has(key)) continue;
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = `g2-move-key ${key}`;
    li.append(icon, LEGEND[key]);
    legend.append(li);
  }
  panel.append(legend);
  return panel;
}
