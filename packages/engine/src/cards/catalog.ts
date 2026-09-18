// Sample cards. These are placeholders to exercise the engine; replace or extend
// with the real card list. Adding a card = adding an entry here.

import { DIRS } from '../pieces.js';
import { registerCards } from './registry.js';
import type { CardDef } from './types.js';

export const CATALOG: CardDef[] = [
  // ---------------------------------------------------------------- Summons
  {
    id: 'the_ox',
    type: 'summon',
    name: 'The Ox',
    glyph: '🐂',
    tier: 2,
    summonTurns: 3,
    text: 'Sacrifice a Tier 1 piece. Summons in 3 turns. Moves up to 2 squares orthogonally. 2 ATK / 0 DEF / 2 HP.',
    piece: {
      kind: 'the_ox',
      name: 'The Ox',
      glyph: '🐂',
      tier: 2,
      movement: { slides: [{ dirs: DIRS.ORTHOGONAL, range: 2 }] },
      atk: 2,
      def: 0,
      hp: 2,
    },
  },
  {
    id: 'stone_sentinel',
    type: 'summon',
    name: 'Stone Sentinel',
    glyph: '🗿',
    tier: 2,
    summonTurns: 2,
    text: 'Sacrifice a Tier 1 piece. Summons in 2 turns. Moves 1 square in any direction. 1 ATK / 1 DEF / 3 HP.',
    piece: {
      kind: 'stone_sentinel',
      name: 'Stone Sentinel',
      glyph: '🗿',
      tier: 2,
      movement: { leaps: DIRS.ALL },
      atk: 1,
      def: 1,
      hp: 3,
    },
  },
  {
    id: 'war_chariot',
    type: 'summon',
    name: 'War Chariot',
    glyph: '🏇',
    tier: 3,
    summonTurns: 3,
    text: 'Sacrifice a Tier 2 piece. Summons in 3 turns. Moves like a Rook or a Knight. 2 ATK / 0 DEF / 2 HP.',
    piece: {
      kind: 'war_chariot',
      name: 'War Chariot',
      glyph: '🏇',
      tier: 3,
      movement: { leaps: DIRS.KNIGHT, slides: [{ dirs: DIRS.ORTHOGONAL }] },
      atk: 2,
      def: 0,
      hp: 2,
    },
  },
  {
    id: 'elder_wyrm',
    type: 'summon',
    name: 'Elder Wyrm',
    glyph: '🐉',
    tier: 4,
    summonTurns: 4,
    text: 'Sacrifice a Tier 3 piece. Summons in 4 turns. Moves up to 3 squares in any direction. 3 ATK / 1 DEF / 3 HP.',
    piece: {
      kind: 'elder_wyrm',
      name: 'Elder Wyrm',
      glyph: '🐉',
      tier: 4,
      movement: { slides: [{ dirs: DIRS.ALL, range: 3 }] },
      atk: 3,
      def: 1,
      hp: 3,
    },
  },

  // ----------------------------------------------------------------- Spells
  {
    id: 'iron_hide',
    type: 'spell',
    name: 'Iron Hide',
    glyph: '🛡️',
    target: 'ownPiece',
    text: 'Target friendly piece gains +2 HP.',
    effects: [{ kind: 'modifyStats', hp: 2 }],
  },
  {
    id: 'whetstone',
    type: 'spell',
    name: 'Whetstone',
    glyph: '⚔️',
    target: 'ownPiece',
    allowKing: true,
    text: 'Target friendly piece gains +1 ATK.',
    effects: [{ kind: 'modifyStats', atk: 1 }],
  },
  {
    id: 'shield_wall',
    type: 'spell',
    name: 'Shield Wall',
    glyph: '🧱',
    target: 'ownPiece',
    text: 'Target friendly piece gains +1 DEF.',
    effects: [{ kind: 'modifyStats', def: 1 }],
  },
  {
    id: 'foresight',
    type: 'spell',
    name: 'Foresight',
    glyph: '🔮',
    target: 'none',
    text: 'Draw 2 cards.',
    effects: [{ kind: 'draw', count: 2 }],
  },
  {
    id: 'hex',
    type: 'spell',
    name: 'Hex',
    glyph: '💀',
    target: 'enemyPiece',
    text: 'Deal 1 damage to target enemy piece (not the King).',
    effects: [{ kind: 'damage', amount: 1 }],
  },
  {
    id: 'dark_ritual',
    type: 'spell',
    name: 'Dark Ritual',
    glyph: '🕯️',
    target: 'ownSummoning',
    text: 'Target friendly piece being sacrificed: its summon timer drops by 2.',
    effects: [{ kind: 'hastenSummon', turns: 2 }],
  },
];

registerCards(CATALOG);

/** A legal 30-card deck: 3 copies of each of the 10 sample cards. */
export function starterDeck(): string[] {
  const deck: string[] = [];
  for (const card of CATALOG) for (let i = 0; i < 3; i++) deck.push(card.id);
  return deck;
}
