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
  /** Destroy the target outright (spells; Defense does not absorb this). */
  | { kind: 'destroy' }
  | { kind: 'draw'; count: number }
  /** Reduce a pending summon's timer. Resolves immediately if it hits 0. */
  | { kind: 'hastenSummon'; turns: number }
  /** Drop Defense to 0 and let the piece act this turn. */
  | { kind: 'freeStance' }
  /** Add mana to the caster's pool right away. */
  | { kind: 'gainMana'; amount: number }
  /** Shuffle the opponent's pieces on their back rank (empties move with them). */
  | { kind: 'scrambleBackRank' }
  /** Rooks become Regents, the King becomes a Sovereign; that player leaves check. */
  | { kind: 'schism' };

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
  /**
   * How large the picture looks in the card window (hand, binder, inspect).
   * 1 is the default; above 1 crops in, below 1 shows more of the picture.
   * Does not change the piece on the board.
   */
  cardArtZoom?: number;
  /** Optional separate picture for the piece on the board (summons). Defaults to `art`. */
  boardArt?: string;
  /**
   * How large the creature looks on the board. 1 is the default; above 1
   * makes the figure larger (it may overflow the square), below 1 smaller.
   */
  boardArtZoom?: number;
}

export const ART_ZOOM_DEFAULT = 1;
export const ART_ZOOM_MIN = 0.5;
export const ART_ZOOM_MAX = 2;
export const BOARD_ART_ZOOM_DEFAULT = ART_ZOOM_DEFAULT;
export const BOARD_ART_ZOOM_MIN = ART_ZOOM_MIN;
export const BOARD_ART_ZOOM_MAX = ART_ZOOM_MAX;

export function clampArtZoom(z: number | undefined): number {
  if (typeof z !== 'number' || !Number.isFinite(z)) return ART_ZOOM_DEFAULT;
  return Math.min(ART_ZOOM_MAX, Math.max(ART_ZOOM_MIN, Math.round(z * 20) / 20));
}

export const clampBoardArtZoom = clampArtZoom;

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
  /** Only legal while this player is still on their first turn. */
  firstTurnOnly?: boolean;
  effects: Effect[];
}

export type CardDef = SummonCardDef | SpellCardDef;
