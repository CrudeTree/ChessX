import type { PieceDef } from '../types.js';

/** One physical card in a deck/hand. Two copies of the same card have different instanceIds. */
export interface CardInstance {
  instanceId: string;
  cardId: string;
}

export type TargetRule =
  /** No target; drop the card anywhere on the board. */
  | 'none'
  | 'ownPiece'
  | 'enemyPiece'
  | 'anyPiece'
  /** One of your pieces that is currently being sacrificed for a summon. */
  | 'ownSummoning'
  /** One of your pieces currently in Defense mode. */
  | 'ownDefending';

export type Effect =
  /** Permanent stat change. `hp` raises both current and max HP. */
  | { kind: 'modifyStats'; atk?: number; def?: number; hp?: number }
  /** Same, applied to every friendly piece (optionally only one kind, e.g. 'pawn'). Kings are skipped. */
  | { kind: 'modifyStatsAll'; pieceKind?: string; atk?: number; def?: number; hp?: number }
  | { kind: 'damage'; amount: number }
  | { kind: 'heal'; amount: number }
  /** Refill HP and DEF shield to their maximums. */
  | { kind: 'restore' }
  | { kind: 'draw'; count: number }
  /** Reduce a pending summon's timer. Resolves immediately if it hits 0. */
  | { kind: 'hastenSummon'; turns: number }
  /** Switch a piece to Attack mode without freezing it this turn. */
  | { kind: 'freeStance' };

interface CardBase {
  id: string;
  name: string;
  text: string;
  /**
   * Mana needed to play the card. Every piece generates mana equal to its tier
   * at the end of its owner's turn (a full army makes 32), so 150 is roughly
   * five turns of income at the start and much longer once the board thins.
   */
  cost: number;
  /** Glyph shown on the card art area. */
  glyph: string;
  /** Optional artwork (URL path served by the client), shown where there is room. */
  art?: string;
}

export interface SummonCardDef extends CardBase {
  type: 'summon';
  /** Tier of the summoned creature. Requires sacrificing a piece of tier - 1 unless `sacrificeTier` overrides. */
  tier: number;
  /** Override which tier of piece must be sacrificed. Defaults to tier - 1. */
  sacrificeTier?: number;
  /** Number of the owner's turn-starts before the creature appears. */
  summonTurns: number;
  piece: PieceDef;
}

export interface SpellCardDef extends CardBase {
  type: 'spell';
  target: TargetRule;
  /** Spells cannot target kings unless this is set. */
  allowKing?: boolean;
  /** Restrict targets to pieces of this tier (e.g. 1 = pawns and other Tier 1 units). */
  targetTier?: number;
  effects: Effect[];
}

export type CardDef = SummonCardDef | SpellCardDef;
