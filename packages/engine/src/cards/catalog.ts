// Card catalog. Every card is pure data; adding one is adding an entry here.
//
//  STARTER_CARDS — what every new player owns (3 copies each) and Deck 1 is built from.
//  REWARD_CARDS  — unlocked one at a time: the first finished match always grants one,
//                  and each checkmate has a chance to grant another (or a spare starter copy).

import { DIRS } from '../pieces.js';
import { registerCards } from './registry.js';
import type { CardDef } from './types.js';

const FORWARD = [[0, 1]] as const;
const SIDEWAYS = [
  [1, 0],
  [-1, 0],
] as const;

export const CATALOG: CardDef[] = [
  // ======================================================== STARTER SUMMONS
  {
    id: 'the_ox',
    type: 'summon',
    cost: 200,
    name: 'The Ox',
    glyph: '🐂',
    art: '/art/the_ox.png',
    tier: 2,
    summonTurns: 3,
    text: 'Sacrifice a Tier 1 piece. Summons in 3 turns. Moves up to 2 squares orthogonally.',
    piece: {
      kind: 'the_ox',
      name: 'The Ox',
      glyph: '🐂',
      tier: 2,
      movement: { slides: [{ dirs: DIRS.ORTHOGONAL, range: 2 }] },
    },
  },
  {
    id: 'stone_sentinel',
    type: 'summon',
    cost: 200,
    name: 'Stone Sentinel',
    glyph: '🗿',
    art: '/art/stone_sentinel.png',
    tier: 2,
    summonTurns: 2,
    text: 'Sacrifice a Tier 1 piece. Summons in 2 turns. Moves 1 square in any direction. Starts in Defense.',
    piece: {
      kind: 'stone_sentinel',
      name: 'Stone Sentinel',
      glyph: '🗿',
      tier: 2,
      movement: { leaps: DIRS.ALL },
      defense: 1,
    },
  },
  {
    id: 'war_chariot',
    type: 'summon',
    cost: 300,
    name: 'War Chariot',
    glyph: '🏇',
    art: '/art/war_chariot.png',
    tier: 3,
    summonTurns: 3,
    text: 'Sacrifice a Tier 2 piece. Summons in 3 turns. Moves like a Rook or a Knight.',
    piece: {
      kind: 'war_chariot',
      name: 'War Chariot',
      glyph: '🏇',
      tier: 3,
      movement: { leaps: DIRS.KNIGHT, slides: [{ dirs: DIRS.ORTHOGONAL }] },
    },
  },
  {
    id: 'elder_wyrm',
    type: 'summon',
    cost: 450,
    name: 'Elder Wyrm',
    glyph: '🐉',
    art: '/art/elder_wyrm.png',
    tier: 4,
    sacrificeTier: 4,
    summonTurns: 4,
    text: 'Sacrifice a Tier 4 piece. Summons in 4 turns. Moves up to 3 squares in any direction.',
    piece: {
      kind: 'elder_wyrm',
      name: 'Elder Wyrm',
      glyph: '🐉',
      tier: 4,
      movement: { slides: [{ dirs: DIRS.ALL, range: 3 }] },
    },
  },

  // ========================================================= STARTER SPELLS
  {
    id: 'foresight',
    type: 'spell',
    cost: 200,
    name: 'Foresight',
    glyph: '🔮',
    art: '/art/foresight.png',
    target: 'none',
    text: 'Draw 2 cards.',
    effects: [{ kind: 'draw', count: 2 }],
  },
  {
    id: 'hex',
    type: 'spell',
    cost: 150,
    name: 'Hex',
    glyph: '💀',
    art: '/art/hex.png',
    target: 'enemyPiece',
    targetTier: 1,
    text: 'Destroy target enemy Tier 1 piece.',
    effects: [{ kind: 'destroy' }],
  },
  {
    id: 'dark_ritual',
    type: 'spell',
    cost: 175,
    name: 'Dark Ritual',
    glyph: '🕯️',
    art: '/art/dark_ritual.png',
    target: 'ownSummoning',
    text: 'Target friendly piece being sacrificed: its summon timer drops by 2.',
    effects: [{ kind: 'hastenSummon', turns: 2 }],
  },

  // ========================================================= REWARD SUMMONS
  {
    id: 'ziglet',
    type: 'summon',
    cost: 150,
    name: 'Ziglet',
    glyph: '🦎',
    art: '/art/ziglet.png',
    tier: 1,
    sacrificeTier: 1,
    summonTurns: 1,
    text: 'Sacrifice a Tier 1 piece. Summons in 1 turn. Hops one square diagonally forward, or one square back.',
    piece: {
      kind: 'ziglet',
      name: 'Ziglet',
      glyph: '🦎',
      tier: 1,
      movement: { leaps: [[-1, 1], [1, 1], [0, -1]], relative: true },
    },
  },
  {
    id: 'greedpot',
    type: 'summon',
    cost: 200,
    name: 'Greedpot',
    glyph: '🏺',
    art: '/art/greedpot.png',
    tier: 1,
    sacrificeTier: 1,
    summonTurns: 2,
    text: 'Sacrifice a Tier 1 piece. Summons in 2 turns. Cannot move or attack. Generates 10 mana per turn.',
    piece: {
      kind: 'greedpot',
      name: 'Greedpot',
      glyph: '🏺',
      tier: 1,
      manaYield: 10,
      movement: { immobile: true },
    },
  },
  {
    id: 'thornback_boar',
    type: 'summon',
    cost: 200,
    name: 'Thornback Boar',
    glyph: '🐗',
    art: '/art/thornback_boar.png',
    tier: 2,
    summonTurns: 2,
    text: 'Sacrifice a Tier 1 piece. Summons in 2 turns. Charges up to 2 squares forward or 1 square sideways.',
    piece: {
      kind: 'thornback_boar',
      name: 'Thornback Boar',
      glyph: '🐗',
      tier: 2,
      movement: { slides: [{ dirs: FORWARD, range: 2 }], leaps: SIDEWAYS, relative: true },
    },
  },
  {
    id: 'frost_owl',
    type: 'summon',
    cost: 200,
    name: 'Frost Owl',
    glyph: '🦉',
    art: '/art/frost_owl.png',
    tier: 2,
    summonTurns: 2,
    text: 'Sacrifice a Tier 1 piece. Summons in 2 turns. Moves like a Knight or 1 square diagonally.',
    piece: {
      kind: 'frost_owl',
      name: 'Frost Owl',
      glyph: '🦉',
      tier: 2,
      movement: { leaps: [...DIRS.KNIGHT, ...DIRS.DIAGONAL] },
    },
  },
  {
    id: 'iron_golem',
    type: 'summon',
    cost: 325,
    name: 'Iron Golem',
    glyph: '🤖',
    art: '/art/iron_golem.png',
    tier: 3,
    summonTurns: 3,
    text: 'Sacrifice a Tier 2 piece. Summons in 3 turns. Moves 1 square orthogonally. Starts in Defense.',
    piece: {
      kind: 'iron_golem',
      name: 'Iron Golem',
      glyph: '🤖',
      tier: 3,
      movement: { leaps: DIRS.ORTHOGONAL },
      defense: 1,
    },
  },
  {
    id: 'shadow_panther',
    type: 'summon',
    cost: 325,
    name: 'Shadow Panther',
    glyph: '🐆',
    art: '/art/shadow_panther.png',
    tier: 3,
    summonTurns: 2,
    text: 'Sacrifice a Tier 2 piece. Summons in 2 turns. Slides up to 3 squares diagonally or 1 square orthogonally.',
    piece: {
      kind: 'shadow_panther',
      name: 'Shadow Panther',
      glyph: '🐆',
      tier: 3,
      movement: { slides: [{ dirs: DIRS.DIAGONAL, range: 3 }], leaps: DIRS.ORTHOGONAL },
    },
  },
  {
    id: 'ancient_treant',
    type: 'summon',
    cost: 325,
    name: 'Ancient Treant',
    glyph: '🌳',
    art: '/art/ancient_treant.png',
    tier: 3,
    summonTurns: 3,
    text: 'Sacrifice a Tier 2 piece. Summons in 3 turns. Moves 1 square in any direction. Starts in Defense.',
    piece: {
      kind: 'ancient_treant',
      name: 'Ancient Treant',
      glyph: '🌳',
      tier: 3,
      movement: { leaps: DIRS.ALL },
      defense: 1,
    },
  },
  {
    id: 'storm_drake',
    type: 'summon',
    cost: 450,
    name: 'Storm Drake',
    glyph: '🐲',
    art: '/art/storm_drake.png',
    tier: 4,
    summonTurns: 4,
    text: 'Sacrifice a Tier 3 piece. Summons in 4 turns. Moves like a Knight or up to 2 squares orthogonally.',
    piece: {
      kind: 'storm_drake',
      name: 'Storm Drake',
      glyph: '🐲',
      tier: 4,
      movement: { leaps: DIRS.KNIGHT, slides: [{ dirs: DIRS.ORTHOGONAL, range: 2 }] },
    },
  },

  // ========================================================== REWARD SPELLS
  {
    id: 'battle_trance',
    type: 'spell',
    cost: 150,
    name: 'Battle Trance',
    glyph: '🔥',
    art: '/art/battle_trance.png',
    target: 'ownDefending',
    text: 'Target friendly piece in Defense mode switches to Attack mode and may still act this turn.',
    effects: [{ kind: 'freeStance' }],
  },
];

registerCards(CATALOG);

/** Stat-only cards removed from the game. Purged from collections on deploy. */
export const RETIRED_CARDS: readonly string[] = [
  'iron_hide',
  'whetstone',
  'shield_wall',
  'battle_cry',
  'second_wind',
  'smite',
];

export const STARTER_CARDS: string[] = [
  'the_ox', 'stone_sentinel', 'war_chariot', 'elder_wyrm',
  'foresight', 'hex', 'dark_ritual',
];

export const REWARD_CARDS: string[] = [
  'ziglet', 'greedpot',
  'thornback_boar', 'frost_owl', 'iron_golem', 'shadow_panther', 'ancient_treant', 'storm_drake',
  'battle_trance',
];

/** The deck every new player starts with: 3 copies of each starter card. */
export function starterDeck(): string[] {
  const deck: string[] = [];
  for (const id of STARTER_CARDS) for (let i = 0; i < 3; i++) deck.push(id);
  return deck;
}
