import type { Card, MoveRule, PieceDef } from './types.js';

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
const ALL8 = [...ORTHO, ...DIAG] as const;
const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]] as const;

const rule = (r: MoveRule): MoveRule => r;

export const KING: PieceDef = {
  kind: 'king',
  name: 'King',
  king: true,
  rules: [rule({ dirs: ALL8, range: 1 })],
};

const INITIATE: PieceDef = {
  kind: 'initiate',
  name: 'Initiate',
  rules: [rule({ dirs: ORTHO, range: 1 })],
};

const SQUIRE: PieceDef = {
  kind: 'squire',
  name: 'Squire',
  rules: [
    rule({ dirs: [[0, 1]], range: 1, relative: true, mode: 'move' }),
    rule({ dirs: [[1, 1], [-1, 1]], range: 1, relative: true, mode: 'capture' }),
  ],
};

const PAGE: PieceDef = {
  kind: 'page',
  name: 'Page',
  rules: [rule({ dirs: ORTHO, range: 1 })],
};

const HOPPER: PieceDef = {
  kind: 'hopper',
  name: 'Hopper',
  rules: [rule({ dirs: KNIGHT, range: 1, leap: true })],
};

const RUNNER: PieceDef = {
  kind: 'cathedral_runner',
  name: 'Cathedral Runner',
  rules: [rule({ dirs: DIAG, range: 8 })],
};

const DAWN_PALADIN: PieceDef = {
  kind: 'dawn_paladin',
  name: 'Dawn Paladin',
  rules: [rule({ dirs: KNIGHT, range: 1, leap: true }), rule({ dirs: ORTHO, range: 1 })],
};

const DUSKFANG: PieceDef = {
  kind: 'duskfang',
  name: 'Duskfang',
  rules: [rule({ dirs: DIAG, range: 1, mode: 'move' }), rule({ dirs: KNIGHT, range: 1, leap: true, mode: 'capture' })],
};

const DAWNFANG: PieceDef = {
  kind: 'dawnfang',
  name: 'Dawnfang',
  rules: [rule({ dirs: KNIGHT, range: 1, leap: true }), rule({ dirs: DIAG, range: 1 })],
};

const ECLIPSE_KNIGHT: PieceDef = {
  kind: 'eclipse_knight',
  name: 'Eclipse Knight',
  rules: [rule({ dirs: KNIGHT, range: 1, leap: true }), rule({ dirs: DIAG, range: 1 })],
};

const WYRMLING: PieceDef = {
  kind: 'wyrmling',
  name: 'Wyrmling',
  rules: [rule({ dirs: [[2, 0], [-2, 0], [0, 2], [0, -2]], range: 1, leap: true })],
};

const TOWER: PieceDef = {
  kind: 'tower',
  name: 'Tower',
  rules: [rule({ dirs: ORTHO, range: 8 })],
};

/**
 * Starter cards. Costs, timers, and movement are PLACEHOLDERS drawn from the villagers' paper
 * draft (message board, msg-013). They exist to exercise the engine, not to be final balance.
 */
export const STARTER_CATALOG: Record<string, Card> = {
  initiate: { type: 'piece', id: 'initiate', name: 'Initiate', cost: 0, sealTimer: 1, piece: INITIATE },
  squire: { type: 'piece', id: 'squire', name: 'Squire', cost: 1, sealTimer: 1, piece: SQUIRE },
  page: { type: 'piece', id: 'page', name: 'Page', cost: 1, sealTimer: 1, piece: PAGE },
  hopper: { type: 'piece', id: 'hopper', name: 'Hopper', cost: 3, sealTimer: 2, piece: HOPPER },
  cathedral_runner: { type: 'piece', id: 'cathedral_runner', name: 'Cathedral Runner', cost: 3, sealTimer: 2, piece: RUNNER },
  dawn_paladin: { type: 'piece', id: 'dawn_paladin', name: 'Dawn Paladin', cost: 4, sealTimer: 3, piece: DAWN_PALADIN, art: '/art/pic-003.png', boardArt: '/art/pic-003.png' },
  duskfang: { type: 'piece', id: 'duskfang', name: 'Duskfang', cost: 2, sealTimer: 3, piece: DUSKFANG, art: '/art/pic-001.png', boardArt: '/art/pic-001.png' },
  dawnfang: { type: 'piece', id: 'dawnfang', name: 'Dawnfang', cost: 2, sealTimer: 2, piece: DAWNFANG },
  eclipse_knight: { type: 'piece', id: 'eclipse_knight', name: 'Eclipse Knight', cost: 4, sealTimer: 3, piece: ECLIPSE_KNIGHT, art: '/art/pic-004.png', boardArt: '/art/pic-004.png' },
  wyrmling: { type: 'piece', id: 'wyrmling', name: 'Wyrmling', cost: 2, sealTimer: 1, piece: WYRMLING, art: '/art/pic-002.png', boardArt: '/art/pic-002.png' },
  tower: { type: 'piece', id: 'tower', name: 'Tower', cost: 5, sealTimer: 3, piece: TOWER },
  insight: { type: 'spell', id: 'insight', name: 'Insight', cost: 2, effect: { kind: 'draw', count: 2 }, text: 'Draw 2 cards.' },
  dispel: { type: 'spell', id: 'dispel', name: 'Dispel', cost: 3, effect: { kind: 'destroySeal' }, text: 'Destroy a seal. Both the seal and its card go to the discard pile.' },
};

/**
 * A 24-card starter deck: 2 Initiates, 3 Squires, 2 Pages, 2 Hoppers, 2 Runners, 2 Towers, 3 Dawn Paladins, 2 Insight,
 * 2 Dispel, 2 Wyrmlings, 1 Duskfang, 1 Dawnfang. Four cost-2 cards at most (msg-026). Pages replaced two Squires
 * (msg-032). Dawnfang took the second Duskfang seat (msg-037).
 */
export function starterDeck(): string[] {
  const counts: Record<string, number> = {
    initiate: 2,
    squire: 3,
    page: 2,
    hopper: 2,
    cathedral_runner: 2,
    tower: 2,
    dawn_paladin: 3,
    insight: 2,
    dispel: 2,
    wyrmling: 2,
    duskfang: 1,
    dawnfang: 1,
  };
  return Object.entries(counts).flatMap(([id, n]) => Array.from({ length: n }, () => id));
}
