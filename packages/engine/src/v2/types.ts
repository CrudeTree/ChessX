// ChessX v2 rules (the live game): 8x8 board, Kings only at the start, mana-based summoning, sealing and evolving.
// Ported from the standalone `chessx-rules/` reference engine. Everything here is namespaced
// under `v2` when imported from `@chessx/engine`, so the original (v1) engine is untouched.
// Players know a seal as a "sacrifice" (Djabooty, 2026-10-11); the code keeps the old name, which saved games use.

export type Color = 'white' | 'black';
export const opposite = (c: Color): Color => (c === 'white' ? 'black' : 'white');

export const FILES = 8;
export const RANKS = 8;
export const FILE_NAMES = 'abcdefgh';

/** Square index = rank * FILES + file. a1 = 0, h1 = 7, a8 = 56, h8 = 63. */
export type Square = number;
export const sq = (file: number, rank: number): Square => rank * FILES + file;
export const fileOf = (s: Square): number => s % FILES;
export const rankOf = (s: Square): number => Math.floor(s / FILES);
export const inBounds = (file: number, rank: number): boolean =>
  file >= 0 && file < FILES && rank >= 0 && rank < RANKS;
export const squareName = (s: Square): string => FILE_NAMES[fileOf(s)]! + String(rankOf(s) + 1);
export function parseSquare(name: string): Square {
  const file = FILE_NAMES.indexOf(name[0] ?? '');
  const rank = Number(name.slice(1)) - 1;
  if (file < 0 || !Number.isInteger(rank) || !inBounds(file, rank)) throw new Error(`Bad square: ${name}`);
  return sq(file, rank);
}
/** Rank index of a player's back row. */
export const backRank = (c: Color): number => (c === 'white' ? 0 : RANKS - 1);
export const forward = (c: Color): number => (c === 'white' ? 1 : -1);

/**
 * One way a piece moves. Offsets are [dFile, dRank]. With `relative`, dRank is
 * flipped for Black so "forward" always points at the enemy.
 * `leap`: land exactly on the offset, ignoring pieces in between.
 * Otherwise the piece slides up to `range` squares and stops at the first piece.
 * `mode`: 'both' moves and captures, 'move' never captures, 'capture' only captures.
 * `firstRange`: how far it slides on the piece's first move instead, like a chess pawn's double step.
 */
export interface MoveRule {
  dirs: ReadonlyArray<readonly [number, number]>;
  range: number;
  leap?: boolean;
  relative?: boolean;
  mode?: 'both' | 'move' | 'capture';
  firstRange?: number;
}

export interface PieceDef {
  kind: string;
  name: string;
  rules: ReadonlyArray<MoveRule>;
  king?: boolean;
  /**
   * Like a chess pawn (the Initiate, Djabooty 2026-10-17): on the other side's back row it becomes any piece card from
   * its owner's hand, for free, as it arrives or on a later turn.
   */
  promotes?: boolean;
}

/** A piece card. `cost` is the mana to summon, seal or evolve into it. `sealTimer` is printed on the card. */
export interface PieceCard {
  type: 'piece';
  id: string;
  name: string;
  cost: number;
  sealTimer: number;
  piece: PieceDef;
  /**
   * The card this one evolves from. Such a card is only ever played onto one of your pieces of that card, which
   * changes into it on its square; it cannot be summoned or sealed.
   */
  evolvesFrom?: string;
  /** The evolution line it belongs to (e.g. "Dragon") and its level in it, 1 to 3. */
  line?: string;
  level?: number;
  /**
   * The card's type, printed on its type line (Djabooty, 2026-10-11): Warrior, Mage, Paladin, Dragon, Beast or
   * Zealot. A spell made for a type (`SpellCard.tribe`) only goes onto pieces of that type.
   */
  tribe?: string;
  /**
   * Counts as the first level of every line (the Initiate, Djabooty 2026-10-11): any level-2 card can be played
   * onto it, for that card's cost plus the cost of the first level it skips.
   */
  anyPath?: boolean;
  /** Printed under how it moves, for a piece that does more than move (the Initiate's any path). */
  abilityText?: string;
  /** The longer rules the card viewer shows beside the card. */
  detail?: string;
  /** Card face picture, a path under the client's public folder. */
  art?: string;
  /** Picture drawn inside the piece token on the board: the creature alone, on a transparent background. */
  boardArt?: string;
  /**
   * Black's face of the card (Djabooty, 2026-10-11): a card has a light face for White and a dark one for Black,
   * and owning it gives you both. Without these, both sides see `art` and `boardArt`.
   */
  darkArt?: string;
  darkBoardArt?: string;
}

/** What a piece can learn from a spell. `lavaBreath`: once a turn, for mana, it turns a square it reaches into lava. */
export type Ability = 'lavaBreath';

export type SpellEffect =
  | { kind: 'destroySeal' }
  /** `mana` is gained as well, for spells that pay back (Insight, Djabooty 2026-10-11). */
  | { kind: 'draw'; count: number; mana?: number }
  /** Teaches one of your pieces of the spell's `tribe` an ability it keeps, also when it evolves. */
  | { kind: 'grant'; ability: Ability }
  /** Gain `amount` mana (Mana Surge). */
  | { kind: 'mana'; amount: number }
  /**
   * Summon a piece card costing at most `maxCost` from your discard pile onto your first two rows (Resurrect). Pieces
   * you captured are in your pile too, so an enemy card can rise as yours.
   */
  | { kind: 'raise'; maxCost: number }
  /** One of your pieces (not the King) cannot be captured, nor targeted by enemy spells, until your next turn. */
  | { kind: 'shield' }
  /** An enemy piece (not the King) cannot move or capture on its owner's next turn. */
  | { kind: 'freeze' }
  /** Destroy an enemy piece (not the King) whose card costs at most `maxCost` (Smite). */
  | { kind: 'destroyPiece'; maxCost: number };

export interface SpellCard {
  type: 'spell';
  id: string;
  name: string;
  cost: number;
  effect: SpellEffect;
  /** Printed on the card; kept short enough to read in the hand. */
  text: string;
  /** The longer rules the card viewer shows beside the card. */
  detail?: string;
  /** The type of piece the spell is made for (e.g. "Dragon"), printed on its type line. */
  tribe?: string;
  art?: string;
  /** Black's face of the card, as for pieces. */
  darkArt?: string;
}

export type Card = PieceCard | SpellCard;

export interface CardInstance {
  uid: string;
  cardId: string;
}

export interface Piece {
  id: string;
  owner: Color;
  def: PieceDef;
  /** Card it came from, or null for Kings. */
  cardId: string | null;
  square: Square;
  /**
   * Owner turn number from which this piece may capture (it gives check from the start). A piece that
   * appears on owner turn N has activeFromTurn N + 1. Pieces deployed in setup use 0.
   */
  activeFromTurn: number;
  /** Owner turn on which the piece was summoned. Until the owner's next turn it cannot move either. */
  summonedOnTurn?: number;
  /** Abilities spells taught it. */
  abilities?: Ability[];
  /** Owner turn on which it last spat lava: Lava Breath works once a turn. */
  lavaOnTurn?: number;
  /** Owner turn a Shield was cast on it: until the owner's next turn it cannot be captured or targeted by enemy spells. */
  shieldOnTurn?: number;
  /** Owner turn a Freeze holds it through: it cannot move or capture during that turn. */
  frozenOnTurn?: number;
  /** It has moved. Kept only for pieces whose first move reaches further (`MoveRule.firstRange`). */
  moved?: boolean;
}

/**
 * A square of lava from Lava Breath (Djabooty, 2026-10-11). No piece can move onto it or be summoned onto it, though
 * pieces pass over it and attack across it. It cools when `by`'s opponent has taken turn `untilTurn`.
 */
export interface Lava {
  square: Square;
  by: Color;
  untilTurn: number;
}

export interface Seal {
  id: string;
  owner: Color;
  square: Square;
  card: PieceCard;
  /** Owner turns left. The piece hatches at the start of the owner's turn when this reaches 0. */
  timer: number;
}

/** `resigned` and `timeout` are set by the server (they are not decided by the rules). */
export type GameStatus =
  | { kind: 'playing' }
  | { kind: 'checkmate'; winner: Color }
  | { kind: 'stalemate' }
  | { kind: 'resigned'; winner: Color }
  | { kind: 'timeout'; winner: Color };

export interface GameState {
  catalog: Record<string, Card>;
  phase: 'setup' | 'play';
  active: Color;
  turns: Record<Color, number>;
  mana: Record<Color, number>;
  hand: Record<Color, CardInstance[]>;
  deck: Record<Color, CardInstance[]>;
  discard: Record<Color, CardInstance[]>;
  pieces: Piece[];
  seals: Seal[];
  /** Lava on the board; missing in games saved before Lava Breath. */
  lava?: Lava[];
  setupDeployed: Record<Color, number>;
  actionTaken: boolean;
  /**
   * A card (summon, seal, evolution, spell or pitch) or a lava breath was played this turn, so End turn may close it
   * once no move is left.
   */
  cardPlayed: boolean;
  /** A card was pitched for mana this turn: once a turn (Djabooty, 2026-10-11). */
  pitched?: boolean;
  /** The most mana a turn brings (see `incomeFor`); games begun before 2026-10-17 lack it and rise to 4. */
  maxIncome?: number;
  /**
   * The mana squares (Djabooty, 2026-10-20): at the start of each of your turns, 1 mana for each one a piece of yours
   * other than the King stands on, and no other income. Games begun before lack them and keep the turn income
   * (`maxIncome`).
   */
  shrines?: Square[];
  /**
   * Mana the mana squares have left to pay out; at 0 they move to new squares at the start of the next turn. Missing
   * in games begun that morning, whose squares stay on d4, e4, d5 and e5 and never run dry.
   */
  well?: number;
  status: GameStatus;
  nextId: number;
  rng: number;
}

export type Action =
  | { type: 'deploy'; cardUid: string; to: Square }
  /** `promote`: a piece that promotes, arriving on the far row, becomes this card from the hand (by uid). */
  | { type: 'move'; from: Square; to: Square; promote?: string }
  | { type: 'summon'; cardUid: string; to: Square }
  | { type: 'seal'; cardUid: string; target: Square }
  /** Play an evolution card onto the piece it evolves from, which changes into it on its square. */
  | { type: 'evolve'; cardUid: string; target: Square }
  /** `pick`: for Resurrect, the uid of the card it raises from a discard pile onto `target`. */
  | { type: 'spell'; cardUid: string; target?: Square; pick?: string }
  /** Discard a card from your hand for +1 mana, once a turn (Djabooty, 2026-10-11). */
  | { type: 'pitch'; cardUid: string }
  /** The piece on `from`, which knows Lava Breath, turns the empty square `to` into lava. */
  | { type: 'lava'; from: Square; to: Square }
  | { type: 'endTurn' };

/**
 * What an action did, for the log and the effects. The names, owners and cards in them are what the pieces were at
 * the time, so a log rebuilt from saved events can still name pieces that are gone; events saved before they were
 * added lack them.
 */
export type GameEvent =
  | { type: 'deployed'; color: Color; pieceId: string; square: Square; name?: string }
  /** `income` is the mana the turn brought (Djabooty, 2026-10-11: +1 a turn, rising to +4); `mana` the new total. */
  /** `held`: in a game with mana squares, the ones that paid `income`. */
  | { type: 'turnStarted'; color: Color; turn: number; mana: number; income?: number; held?: Square[] }
  /** The mana squares ran dry and moved, as a turn began. */
  | { type: 'shrinesMoved'; from: Square[]; to: Square[] }
  | { type: 'drew'; color: Color; count: number }
  | { type: 'moved'; pieceId: string; from: Square; to: Square; name?: string; owner?: Color }
  /** `bounty` is the mana the capturer got for it (Djabooty, 2026-10-11). */
  | { type: 'captured'; pieceId: string; by: string; square: Square; name?: string; owner?: Color; cardId?: string | null; bounty?: number }
  | { type: 'sealDestroyed'; sealId: string; by: string; square: Square; cardId: string }
  | { type: 'summoned'; color: Color; pieceId: string; square: Square; name?: string; cardId?: string }
  | { type: 'sealed'; color: Color; sealId: string; square: Square; consumedPieceId: string; timer: number; consumedName?: string; cardId?: string }
  | { type: 'sealTick'; sealId: string; timer: number }
  | { type: 'hatched'; color: Color; pieceId: string; square: Square; name?: string }
  /**
   * `fromPieceId` is the piece that evolved; `pieceId` is what it became; `cost` what it paid. `promoted`: it was a
   * piece promoting on the far row.
   */
  | { type: 'evolved'; color: Color; pieceId: string; fromPieceId: string; square: Square; name?: string; fromName?: string; cardId?: string; cost?: number; promoted?: boolean }
  | { type: 'spellPlayed'; color: Color; cardId: string; target?: Square }
  /** A spell taught `pieceId` (named `name`) an ability. */
  | { type: 'learned'; color: Color; pieceId: string; name: string; square: Square; ability: Ability }
  | { type: 'manaGained'; color: Color; mana: number }
  /** Resurrect raised `cardId` from `color`'s discard pile as their piece. */
  | { type: 'raised'; color: Color; pieceId: string; name: string; square: Square; cardId: string }
  | { type: 'shielded'; color: Color; pieceId: string; name: string; square: Square }
  /** `color` froze `owner`'s piece. */
  | { type: 'frozen'; color: Color; pieceId: string; name: string; square: Square; owner: Color }
  /** `color`'s spell destroyed `owner`'s piece. */
  | { type: 'destroyed'; color: Color; pieceId: string; name: string; square: Square; owner: Color; cardId: string | null }
  | { type: 'pitched'; color: Color; cardId: string; mana: number }
  /** `pieceId` (named `name`) spat lava from `from` onto `square`. */
  | { type: 'lava'; color: Color; pieceId: string; name: string; from: Square; square: Square }
  | { type: 'lavaCooled'; square: Square }
  | { type: 'check'; color: Color }
  | { type: 'gameOver'; status: GameStatus };
