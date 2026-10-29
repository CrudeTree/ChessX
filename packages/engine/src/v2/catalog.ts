import type { Card, MoveRule, PieceDef } from './types.js';

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
const ALL8 = [...ORTHO, ...DIAG] as const;
const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]] as const;
/** The four knight jumps that end further up the board (flipped for Black by `relative`). */
const KNIGHT_FORWARD = [[1, 2], [-1, 2], [2, 1], [-2, 1]] as const;

const rule = (r: MoveRule): MoveRule => r;

export const KING: PieceDef = {
  kind: 'king',
  name: 'King',
  king: true,
  rules: [rule({ dirs: ALL8, range: 1 })],
};

/**
 * The Initiate is the pawn and the Squire steps straight (Djabooty, 2026-10-17; they had it the other way round): it
 * moves forward, 2 squares on its first move, captures diagonally forward, and promotes on the far row.
 */
const INITIATE: PieceDef = {
  kind: 'initiate',
  name: 'Initiate',
  rules: [
    rule({ dirs: [[0, 1]], range: 1, firstRange: 2, relative: true, mode: 'move' }),
    rule({ dirs: [[1, 1], [-1, 1]], range: 1, relative: true, mode: 'capture' }),
  ],
  promotes: true,
};

const SQUIRE: PieceDef = { kind: 'squire', name: 'Squire', rules: [rule({ dirs: ORTHO, range: 1 })] };

// Warrior line: the rook.
const RECRUIT: PieceDef = { kind: 'recruit', name: 'Recruit', rules: [rule({ dirs: ORTHO, range: 1 })] };
const WARRIOR: PieceDef = { kind: 'warrior', name: 'Warrior', rules: [rule({ dirs: ORTHO, range: 3 })] };
const WARLORD: PieceDef = { kind: 'warlord', name: 'Warlord', rules: [rule({ dirs: ORTHO, range: 8 })] };

// Mage line: the bishop.
const APPRENTICE: PieceDef = { kind: 'apprentice', name: 'Apprentice', rules: [rule({ dirs: DIAG, range: 1 })] };
const MAGE: PieceDef = { kind: 'mage', name: 'Mage', rules: [rule({ dirs: DIAG, range: 3 })] };
const ARCHMAGE: PieceDef = { kind: 'archmage', name: 'Archmage', rules: [rule({ dirs: DIAG, range: 8 })] };

// Paladin line: the knight. It ends in one of two final forms.
const COLT: PieceDef = {
  kind: 'colt',
  name: 'Colt',
  rules: [rule({ dirs: KNIGHT_FORWARD, range: 1, leap: true, relative: true })],
};
const PALADIN: PieceDef = { kind: 'paladin', name: 'Paladin', rules: [rule({ dirs: KNIGHT, range: 1, leap: true })] };
const DAWN_PALADIN: PieceDef = {
  kind: 'dawn_paladin',
  name: 'Dawn Paladin',
  rules: [rule({ dirs: KNIGHT, range: 1, leap: true }), rule({ dirs: ORTHO, range: 1 })],
};
const ECLIPSE_KNIGHT: PieceDef = {
  kind: 'eclipse_knight',
  name: 'Eclipse Knight',
  rules: [rule({ dirs: KNIGHT, range: 1, leap: true }), rule({ dirs: DIAG, range: 1 })],
};

// Dragon line: the queen. The weakest first level grows into the strongest piece (Djabooty, 2026-10-11).
const WYRMLING: PieceDef = {
  kind: 'wyrmling',
  name: 'Wyrmling',
  rules: [rule({ dirs: [[2, 0], [-2, 0], [0, 2], [0, -2]], range: 1, leap: true })],
};
// The Mystic Dragon reaches 2, not 3, so it is not a queen too early (Djabooty, 2026-10-11).
const MYSTIC_DRAGON: PieceDef = { kind: 'mystic_dragon', name: 'Mystic Dragon', rules: [rule({ dirs: ALL8, range: 2 })] };
const ANCIENT_MYSTIC_DRAGON: PieceDef = {
  kind: 'ancient_mystic_dragon',
  name: 'Ancient Mystic Dragon',
  rules: [rule({ dirs: ALL8, range: 8 })],
};

// In no line: summoned or sealed like any other piece, and priced high for it.
const DUSKFANG: PieceDef = {
  kind: 'duskfang',
  name: 'Duskfang',
  rules: [rule({ dirs: DIAG, range: 1, mode: 'move' }), rule({ dirs: KNIGHT, range: 1, leap: true, mode: 'capture' })],
};

/**
 * Every card has two faces (Djabooty, 2026-10-11): `<id>_white.png` for White and `<id>_dark.png` for Black. The
 * pictures also show how strong a card is, from a humble Initiate up to the Ancient Mystic Dragon.
 */
const faces = (id: string) => ({ art: `/art/${id}_white.png`, darkArt: `/art/${id}_dark.png` });
/**
 * On the board a piece shows the creature of its face alone, cut out of the card's picture (Djabooty, 2026-10-17):
 * `/figures/<id>_<face>.webp`, the cut-outs tools/figures makes, which the 3D board stands up too.
 */
const pieceFaces = (id: string) => ({ ...faces(id), boardArt: `/figures/${id}_white.webp`, darkBoardArt: `/figures/${id}_dark.webp` });

/**
 * Starter cards. Costs and timers are PLACEHOLDERS to playtest, not final balance.
 *
 * Evolution lines (Djabooty, 2026-10-11): the chess pieces are the end of a line, never a card you summon. Level 1
 * is summoned or sealed like any piece; levels 2 and 3 are only played onto the level below, which changes into them
 * on its square. Sliders reach 1 square, then up to 3, then any distance. Evolution cards are never sealed, so their
 * `sealTimer` is 0. Page, Tower, Cathedral Runner and Hopper became the Recruit, Warlord, Archmage and Paladin;
 * Dawnfang moved exactly like Eclipse Knight and was folded into it.
 *
 * A line may begin with more than one card (Djabooty, 2026-10-29): the Squire and the Recruit are both the first-level
 * Warrior, so a Warrior goes onto either (`evolvesFromAlso`). Before that the Squire was in no line at all, and a
 * player who dragged a Warrior onto one got nothing.
 *
 * Costs raised so strong pieces come later (Djabooty, 2026-10-11): a Paladin costs at least 4. Every level costs
 * more than the one below it, and a first level that leaps off the back row (Colt, Wyrmling) costs 2, not 1.
 *
 * Every card has a type (Djabooty, 2026-10-11): a line's cards are of that line's type, the Squire is a Warrior, the
 * Duskfang a Beast and the Initiate a Zealot. A spell made for a type only goes onto pieces of that type.
 */
export const STARTER_CATALOG: Record<string, Card> = {
  initiate: {
    type: 'piece',
    id: 'initiate',
    name: 'Initiate',
    cost: 0,
    sealTimer: 1,
    piece: INITIATE,
    tribe: 'Zealot',
    anyPath: true,
    abilityText: 'Any path: evolves into any level 2.\nPromotes: on the far row.',
    detail:
      'Moves like a chess pawn: 1 square forward, or 2 on its first move if both squares are empty, and captures 1 square diagonally forward. ' +
      'Any path: an Initiate counts as the first level of every line, so any level-2 card can be played onto it. It costs that card\'s mana plus the mana of the first level it skips. ' +
      'Promotes: when it reaches the far row, pick any piece card in your hand and it becomes that piece, for free. Keep it as it is if you like, and drop a piece card on it on a later turn to promote it then.',
    ...pieceFaces('initiate'),
  },
  // The Squire and the Recruit are the same first-level Warrior (Djabooty, 2026-10-29: a Squire could never become a
  // Warrior, because only the Recruit was in the line). Either one goes on to the Warrior.
  squire: { type: 'piece', id: 'squire', name: 'Squire', cost: 1, sealTimer: 1, piece: SQUIRE, line: 'Warrior', level: 1, tribe: 'Warrior', ...pieceFaces('squire') },

  recruit: { type: 'piece', id: 'recruit', name: 'Recruit', cost: 1, sealTimer: 1, piece: RECRUIT, line: 'Warrior', level: 1, tribe: 'Warrior', ...pieceFaces('recruit') },
  warrior: {
    type: 'piece',
    id: 'warrior',
    name: 'Warrior',
    cost: 4,
    sealTimer: 0,
    piece: WARRIOR,
    line: 'Warrior',
    level: 2,
    evolvesFrom: 'recruit',
    // The Squire is the same first level, so the Warrior grows from either (Djabooty, 2026-10-29).
    evolvesFromAlso: ['squire'],
    tribe: 'Warrior',
    ...pieceFaces('warrior'),
  },
  warlord: {
    type: 'piece',
    id: 'warlord',
    name: 'Warlord',
    cost: 6,
    sealTimer: 0,
    piece: WARLORD,
    line: 'Warrior',
    level: 3,
    evolvesFrom: 'warrior',
    tribe: 'Warrior',
    ...pieceFaces('warlord'),
  },

  apprentice: { type: 'piece', id: 'apprentice', name: 'Apprentice', cost: 1, sealTimer: 1, piece: APPRENTICE, line: 'Mage', level: 1, tribe: 'Mage', ...pieceFaces('apprentice') },
  mage: {
    type: 'piece',
    id: 'mage',
    name: 'Mage',
    cost: 3,
    sealTimer: 0,
    piece: MAGE,
    line: 'Mage',
    level: 2,
    evolvesFrom: 'apprentice',
    tribe: 'Mage',
    ...pieceFaces('mage'),
  },
  archmage: {
    type: 'piece',
    id: 'archmage',
    name: 'Archmage',
    cost: 4,
    sealTimer: 0,
    piece: ARCHMAGE,
    line: 'Mage',
    level: 3,
    evolvesFrom: 'mage',
    tribe: 'Mage',
    ...pieceFaces('archmage'),
  },

  colt: { type: 'piece', id: 'colt', name: 'Colt', cost: 2, sealTimer: 1, piece: COLT, line: 'Paladin', level: 1, tribe: 'Paladin', ...pieceFaces('colt') },
  paladin: {
    type: 'piece',
    id: 'paladin',
    name: 'Paladin',
    cost: 4,
    sealTimer: 0,
    piece: PALADIN,
    line: 'Paladin',
    level: 2,
    evolvesFrom: 'colt',
    tribe: 'Paladin',
    ...pieceFaces('paladin'),
  },
  dawn_paladin: {
    type: 'piece',
    id: 'dawn_paladin',
    name: 'Dawn Paladin',
    cost: 7,
    sealTimer: 0,
    piece: DAWN_PALADIN,
    line: 'Paladin',
    level: 3,
    evolvesFrom: 'paladin',
    tribe: 'Paladin',
    ...pieceFaces('dawn_paladin'),
  },
  eclipse_knight: {
    type: 'piece',
    id: 'eclipse_knight',
    name: 'Eclipse Knight',
    cost: 7,
    sealTimer: 0,
    piece: ECLIPSE_KNIGHT,
    line: 'Paladin',
    level: 3,
    evolvesFrom: 'paladin',
    tribe: 'Paladin',
    ...pieceFaces('eclipse_knight'),
  },

  wyrmling: { type: 'piece', id: 'wyrmling', name: 'Wyrmling', cost: 2, sealTimer: 1, piece: WYRMLING, line: 'Dragon', level: 1, tribe: 'Dragon', ...pieceFaces('wyrmling') },
  mystic_dragon: {
    type: 'piece',
    id: 'mystic_dragon',
    name: 'Mystic Dragon',
    cost: 6,
    sealTimer: 0,
    piece: MYSTIC_DRAGON,
    line: 'Dragon',
    level: 2,
    evolvesFrom: 'wyrmling',
    tribe: 'Dragon',
    ...pieceFaces('mystic_dragon'),
  },
  ancient_mystic_dragon: {
    type: 'piece',
    id: 'ancient_mystic_dragon',
    name: 'Ancient Mystic Dragon',
    cost: 10,
    sealTimer: 0,
    piece: ANCIENT_MYSTIC_DRAGON,
    line: 'Dragon',
    level: 3,
    evolvesFrom: 'mystic_dragon',
    tribe: 'Dragon',
    // The eldest thing in the deck: the board dims and its sigil opens when it arrives (Djabooty, 2026-10-29).
    elder: true,
    ...pieceFaces('ancient_mystic_dragon'),
  },

  // 15 mana made it a card nobody could play (Djabooty, 2026-10-11).
  duskfang: { type: 'piece', id: 'duskfang', name: 'Duskfang', cost: 9, sealTimer: 3, piece: DUSKFANG, tribe: 'Beast', ...pieceFaces('duskfang') },

  // Draws 1 and pays 1 back, so it no longer costs a turn's mana to dig (Djabooty, 2026-10-11).
  insight: {
    type: 'spell',
    id: 'insight',
    name: 'Insight',
    cost: 2,
    effect: { kind: 'draw', count: 1, mana: 1 },
    text: 'Draw 1 card and gain 1 mana.',
    ...faces('insight'),
  },
  dispel: {
    type: 'spell',
    id: 'dispel',
    name: 'Dispel',
    cost: 3,
    effect: { kind: 'destroySeal' },
    text: 'Destroy a sacrifice before its piece arrives.',
    detail: 'Drop it on any sacrifice on the board. The sacrifice is destroyed before its piece arrives, and its card goes to its owner\'s discard pile.',
    ...faces('dispel'),
  },
  lava_breath: {
    type: 'spell',
    id: 'lava_breath',
    name: 'Lava Breath',
    cost: 2,
    effect: { kind: 'grant', ability: 'lavaBreath' },
    tribe: 'Dragon',
    text: 'Your Dragon learns to spit lava: 1 mana, once a turn.',
    detail:
      'Drop it on one of your Dragons. From then on, once a turn, that Dragon can spend 1 mana to spit lava onto an empty square it could move to. No piece can move onto lava or be summoned onto it until the other player has taken 2 more turns; pieces still pass over it. The Dragon keeps Lava Breath when it evolves.',
    ...faces('lava_breath'),
  },

  // Five plain spells (Djabooty, 2026-10-12): mana, a piece back from the dead, a shield, a freeze and a smite.
  mana_surge: {
    type: 'spell',
    id: 'mana_surge',
    name: 'Mana Surge',
    cost: 1,
    effect: { kind: 'mana', amount: 3 },
    text: 'Gain 3 mana.',
    detail: 'Drop it anywhere on the board. You pay 1 and get 3 back at once, so you end up 2 mana ahead, to spend now or save.',
    ...faces('mana_surge'),
  },
  resurrect: {
    type: 'spell',
    id: 'resurrect',
    name: 'Resurrect',
    cost: 4,
    effect: { kind: 'raise', maxCost: 4 },
    text: 'Summon a piece that costs 4 or less from your discard pile.',
    detail:
      'Drop it on a free square of your first two rows, then pick a piece card that costs 4 or less from your discard pile: one of your own that left play, or an enemy piece you captured. It rises there as your piece and waits like a summoned one: no move or capture until your next turn.',
    ...faces('resurrect'),
  },
  shield: {
    type: 'spell',
    id: 'shield',
    name: 'Shield',
    cost: 2,
    effect: { kind: 'shield' },
    text: 'Your piece can\'t be captured until your next turn.',
    detail: 'Drop it on one of your pieces (not the King). Until your next turn it cannot be captured, and your opponent\'s spells cannot touch it. It still moves and captures as usual.',
    ...faces('shield'),
  },
  freeze: {
    type: 'spell',
    id: 'freeze',
    name: 'Freeze',
    cost: 2,
    effect: { kind: 'freeze' },
    text: 'An enemy piece can\'t move on its next turn.',
    detail: 'Drop it on an enemy piece (not the King). On its owner\'s next turn it cannot move or capture. It still blocks squares, and still gives check.',
    ...faces('freeze'),
  },
  smite: {
    type: 'spell',
    id: 'smite',
    name: 'Smite',
    cost: 3,
    effect: { kind: 'destroyPiece', maxCost: 2 },
    text: 'Destroy an enemy piece that costs 2 or less.',
    detail:
      'Drop it on an enemy piece (not the King) whose card costs 2 or less: an Initiate, Squire, Recruit, Apprentice, Colt or Wyrmling. The piece is destroyed and its card goes to its owner\'s discard pile. It is not a capture, so it pays no bounty.',
    ...faces('smite'),
  },
};

/**
 * A saved game keeps the costs, moves and rules its cards had when it began, but shows today's pictures and type
 * lines. Which card a piece evolves from is a fact about the card rather than a number of the game's balance, so it is
 * taken from today too: a game begun before the Squire was put in the Warrior line (Djabooty, 2026-10-29) can evolve
 * one, where before it could not.
 */
export function withCurrentArt(catalog: Record<string, Card>): Record<string, Card> {
  const out: Record<string, Card> = {};
  for (const [id, card] of Object.entries(catalog)) {
    const now = STARTER_CATALOG[id];
    if (card.type === 'piece' && now?.type === 'piece') {
      out[id] = {
        ...card,
        art: now.art,
        darkArt: now.darkArt,
        boardArt: now.boardArt,
        darkBoardArt: now.darkBoardArt,
        tribe: card.tribe ?? now.tribe,
        // A card's place in its line: its level, and the first levels it evolves from.
        ...(card.line === undefined ? { line: now.line } : {}),
        ...(card.level === undefined ? { level: now.level } : {}),
        ...(now.evolvesFromAlso ? { evolvesFromAlso: now.evolvesFromAlso } : {}),
      };
    } else if (card.type === 'spell' && now?.type === 'spell') {
      out[id] = { ...card, art: now.art, darkArt: now.darkArt };
    } else {
      out[id] = card;
    }
  }
  return out;
}

/**
 * A 30-card starter deck: 2 Initiates and 1 Squire; per line two level-1 cards and one of each higher level
 * (both Paladin final forms); 1 Duskfang; 2 Insight and one of every other spell. Four cost-2 pieces at most (msg-026).
 */
export function starterDeck(): string[] {
  const counts: Record<string, number> = {
    initiate: 2,
    squire: 1,
    recruit: 2,
    warrior: 1,
    warlord: 1,
    apprentice: 2,
    mage: 1,
    archmage: 1,
    colt: 2,
    paladin: 1,
    dawn_paladin: 1,
    eclipse_knight: 1,
    wyrmling: 2,
    mystic_dragon: 1,
    ancient_mystic_dragon: 1,
    duskfang: 1,
    insight: 2,
    dispel: 1,
    lava_breath: 1,
    mana_surge: 1,
    resurrect: 1,
    shield: 1,
    freeze: 1,
    smite: 1,
  };
  return Object.entries(counts).flatMap(([id, n]) => Array.from({ length: n }, () => id));
}
