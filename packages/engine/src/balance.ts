// Balance patches: number tweaks to cards and pieces made by the game's admin
// from inside the app, stored in the server database and applied on top of the
// shipped catalog on both server and client. Code changes never overwrite them:
// a patch only carries the fields the admin actually changed, everything else
// keeps following the code.

import { allCards, baseCardDef, setCardDef } from './cards/registry.js';
import type { CardDef, Effect } from './cards/types.js';
import { basePieceDef, getPieceDef, setPieceDef, STANDARD_KINDS } from './pieces.js';
import { BASE_RULES, DEFAULT_RULES } from './state.js';
import type { MovementSpec, PieceDef } from './types.js';

export interface PiecePatch {
  atk?: number;
  def?: number;
  hp?: number;
  /** Mana produced per turn (default: the tier). */
  manaYield?: number;
  movement?: MovementSpec;
}

export interface CardPatch {
  cost?: number;
  /** Summons only. */
  tier?: number;
  sacrificeTier?: number;
  summonTurns?: number;
  piece?: PiecePatch;
  /** Spells only: the whole effect list (numbers inside are what usually changes). */
  effects?: Effect[];
  targetTier?: number;
  /** Rules text shown on the card. Regenerated from the numbers unless set explicitly. */
  text?: string;
}

/** Game-wide numbers (apply to games created after the change). */
export interface RulesPatch {
  startingMana?: number;
  openingHand?: number;
  drawEvery?: number;
}

export interface Balance {
  /** Patches keyed by card id. */
  cards: Record<string, CardPatch>;
  /** Patches for the six standard chess pieces, keyed by kind. */
  pieces: Record<string, PiecePatch>;
  rules?: RulesPatch;
}

export const EMPTY_BALANCE: Balance = { cards: {}, pieces: {} };

let current: Balance = EMPTY_BALANCE;

export function currentBalance(): Balance {
  return current;
}

/** Deep-ish copy of a movement spec so patches never alias catalog constants. */
export function cloneMovement(m: MovementSpec): MovementSpec {
  return {
    ...(m.pawn ? { pawn: true } : {}),
    ...(m.relative ? { relative: true } : {}),
    ...(m.leaps ? { leaps: m.leaps.map(([f, r]) => [f, r] as const) } : {}),
    ...(m.slides ? { slides: m.slides.map((s) => ({ dirs: s.dirs.map(([f, r]) => [f, r] as const), ...(s.range !== undefined ? { range: s.range } : {}) })) } : {}),
  };
}

function patchPiece(base: PieceDef, p: PiecePatch | undefined, tier?: number): PieceDef {
  const out: PieceDef = { ...base, movement: cloneMovement(base.movement) };
  if (tier !== undefined) out.tier = tier;
  if (!p) return out;
  if (p.atk !== undefined) out.atk = p.atk;
  if (p.def !== undefined) out.def = p.def;
  if (p.hp !== undefined) out.hp = p.hp;
  if (p.manaYield !== undefined) out.manaYield = p.manaYield;
  if (p.movement) out.movement = cloneMovement(p.movement);
  return out;
}

/** Build the live definition of a card from its shipped definition and a patch. */
export function patchedCard(id: string, patch: CardPatch | undefined): CardDef {
  const base = baseCardDef(id);
  if (base.type === 'summon') {
    const card = { ...base, piece: patchPiece(base.piece, patch?.piece, patch?.tier) };
    if (patch?.cost !== undefined) card.cost = patch.cost;
    if (patch?.tier !== undefined) card.tier = patch.tier;
    if (patch?.sacrificeTier !== undefined) card.sacrificeTier = patch.sacrificeTier;
    if (patch?.summonTurns !== undefined) card.summonTurns = patch.summonTurns;
    // Hand-written text stays until the numbers change; then it is regenerated (unless set explicitly).
    card.text = patch?.text ?? (patch && Object.keys(patch).length ? describeCard(card) : base.text);
    return card;
  }
  const card = { ...base, effects: (patch?.effects ?? base.effects).map((e) => ({ ...e })) };
  if (patch?.cost !== undefined) card.cost = patch.cost;
  if (patch?.targetTier !== undefined) card.targetTier = patch.targetTier;
  card.text = patch?.text ?? (patch && Object.keys(patch).length ? describeCard(card) : base.text);
  return card;
}

/**
 * Apply a full balance (replacing whatever was applied before). Cards and
 * pieces with no patch return to their shipped definitions.
 */
export function applyBalance(balance: Balance): void {
  current = { cards: { ...balance.cards }, pieces: { ...balance.pieces }, ...(balance.rules && Object.keys(balance.rules).length ? { rules: { ...balance.rules } } : {}) };
  for (const base of allCards()) setCardDef(patchedCard(base.id, current.cards[base.id]));
  for (const kind of STANDARD_KINDS) setPieceDef(patchPiece(basePieceDef(kind), current.pieces[kind]));
  // New games pick these up; games in progress keep the rules they started with.
  Object.assign(DEFAULT_RULES, BASE_RULES, current.rules ?? {});
}

// ---------------------------------------------------------------------------
// Validation (the server refuses bad patches; the client uses it for inline errors)

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function validateMovement(m: unknown, where: string, problems: string[]): void {
  if (typeof m !== 'object' || m === null) return void problems.push(`${where}: movement must be an object.`);
  const mv = m as MovementSpec;
  const offsetOk = (o: unknown) => Array.isArray(o) && o.length === 2 && isInt(o[0], -7, 7) && isInt(o[1], -7, 7) && (o[0] !== 0 || o[1] !== 0);
  if (mv.leaps !== undefined && (!Array.isArray(mv.leaps) || !mv.leaps.every(offsetOk))) problems.push(`${where}: leaps must be [file, rank] offsets within ±7.`);
  if (mv.slides !== undefined) {
    if (!Array.isArray(mv.slides)) problems.push(`${where}: slides must be a list.`);
    else {
      for (const s of mv.slides) {
        if (!s || !Array.isArray(s.dirs) || !s.dirs.every(offsetOk)) problems.push(`${where}: each slide needs direction offsets.`);
        if (s.range !== undefined && !isInt(s.range, 1, 7)) problems.push(`${where}: slide range must be 1–7 (or blank for unlimited).`);
      }
    }
  }
  const any = mv.pawn || (mv.leaps?.length ?? 0) > 0 || (mv.slides?.some((s) => s.dirs.length > 0) ?? false);
  if (!any) problems.push(`${where}: the piece would not be able to move at all.`);
}

function validatePiece(p: PiecePatch, where: string, problems: string[], isKing: boolean): void {
  if (p.atk !== undefined && !isInt(p.atk, 0, 99)) problems.push(`${where}: ATK must be 0–99.`);
  if (p.def !== undefined && !isInt(p.def, 0, 99)) problems.push(`${where}: DEF must be 0–99.`);
  if (p.hp !== undefined && !isInt(p.hp, 1, 99)) problems.push(`${where}: HP must be 1–99.`);
  if (p.manaYield !== undefined && !isInt(p.manaYield, 0, 999)) problems.push(`${where}: mana per turn must be 0–999.`);
  if (p.movement !== undefined) validateMovement(p.movement, where, problems);
  if (isKing && p.movement && (p.movement as MovementSpec).pawn) problems.push(`${where}: the King cannot use pawn movement.`);
}

function validateEffects(effects: unknown, where: string, problems: string[]): void {
  if (!Array.isArray(effects) || effects.length === 0) return void problems.push(`${where}: a spell needs at least one effect.`);
  for (const e of effects as Effect[]) {
    switch (e?.kind) {
      case 'modifyStats':
      case 'modifyStatsAll':
        for (const k of ['atk', 'def', 'hp'] as const) if (e[k] !== undefined && !isInt(e[k], -99, 99)) problems.push(`${where}: ${k} change must be -99–99.`);
        if (e.atk === undefined && e.def === undefined && e.hp === undefined) problems.push(`${where}: a stat effect needs at least one of ATK/DEF/HP.`);
        break;
      case 'damage':
      case 'heal':
        if (!isInt(e.amount, 1, 99)) problems.push(`${where}: amount must be 1–99.`);
        break;
      case 'draw':
        if (!isInt(e.count, 1, 10)) problems.push(`${where}: draw count must be 1–10.`);
        break;
      case 'hastenSummon':
        if (!isInt(e.turns, 1, 10)) problems.push(`${where}: turns must be 1–10.`);
        break;
      case 'restore':
      case 'freeStance':
        break;
      default:
        problems.push(`${where}: unknown effect.`);
    }
  }
}

/** Problems with a proposed balance, or [] if it is acceptable. */
export function validateBalance(b: unknown): string[] {
  const problems: string[] = [];
  if (typeof b !== 'object' || b === null) return ['Balance must be an object.'];
  const bal = b as Partial<Balance>;
  for (const [id, patch] of Object.entries(bal.cards ?? {})) {
    let base: CardDef;
    try {
      base = baseCardDef(id);
    } catch {
      problems.push(`Unknown card: ${id}`);
      continue;
    }
    const where = base.name;
    if (patch.cost !== undefined && !isInt(patch.cost, 0, 9999)) problems.push(`${where}: cost must be 0–9999.`);
    if (patch.text !== undefined && (typeof patch.text !== 'string' || patch.text.length > 300)) problems.push(`${where}: text too long.`);
    if (base.type === 'summon') {
      if (patch.tier !== undefined && !isInt(patch.tier, 1, 6)) problems.push(`${where}: tier must be 1–6.`);
      if (patch.sacrificeTier !== undefined && !isInt(patch.sacrificeTier, 1, 4)) problems.push(`${where}: sacrifice tier must be 1–4 (nothing above the Queen can be sacrificed).`);
      if (patch.summonTurns !== undefined && !isInt(patch.summonTurns, 1, 10)) problems.push(`${where}: summon turns must be 1–10.`);
      if (patch.piece) validatePiece(patch.piece, where, problems, false);
      if (patch.effects !== undefined) problems.push(`${where}: a summon has no spell effects.`);
    } else {
      if (patch.effects !== undefined) validateEffects(patch.effects, where, problems);
      if (patch.targetTier !== undefined && !isInt(patch.targetTier, 1, 6)) problems.push(`${where}: target tier must be 1–6.`);
      if (patch.piece || patch.tier !== undefined || patch.summonTurns !== undefined) problems.push(`${where}: a spell has no creature stats.`);
    }
  }
  for (const [kind, patch] of Object.entries(bal.pieces ?? {})) {
    if (!STANDARD_KINDS.includes(kind)) {
      problems.push(`Unknown piece: ${kind}`);
      continue;
    }
    validatePiece(patch, basePieceDef(kind).name, problems, kind === 'king');
  }
  const r = bal.rules ?? {};
  if (r.startingMana !== undefined && !isInt(r.startingMana, 0, 9999)) problems.push('Rules: starting mana must be 0–9999.');
  if (r.openingHand !== undefined && !isInt(r.openingHand, 0, 15)) problems.push('Rules: opening hand must be 0–15 cards.');
  if (r.drawEvery !== undefined && !isInt(r.drawEvery, 1, 20)) problems.push('Rules: draw every 1–20 turns.');
  return problems;
}

// ---------------------------------------------------------------------------
// Rules text generated from the numbers, so edited cards read correctly.

const tierWord = (t: number) => `Tier ${t}`;

export function describeMovement(m: MovementSpec): string {
  const parts: string[] = [];
  if (m.pawn) parts.push('moves like a Pawn');
  const dirName = (dirs: ReadonlyArray<readonly [number, number]>): string => {
    const set = new Set(dirs.map(([f, r]) => `${f},${r}`));
    const has = (...ds: string[]) => ds.every((d) => set.has(d));
    const ORTHO = ['1,0', '-1,0', '0,1', '0,-1'];
    const DIAG = ['1,1', '1,-1', '-1,1', '-1,-1'];
    if (set.size === 8 && has(...ORTHO, ...DIAG)) return 'in any direction';
    if (set.size === 4 && has(...ORTHO)) return 'orthogonally';
    if (set.size === 4 && has(...DIAG)) return 'diagonally';
    if (set.size === 1 && has('0,1')) return 'forward';
    if (set.size === 2 && has('1,0', '-1,0')) return 'sideways';
    return `along ${set.size} direction${set.size === 1 ? '' : 's'}`;
  };
  for (const s of m.slides ?? []) {
    if (!s.dirs.length) continue;
    parts.push(s.range === undefined ? `slides any distance ${dirName(s.dirs)}` : s.range === 1 ? `moves 1 square ${dirName(s.dirs)}` : `moves up to ${s.range} squares ${dirName(s.dirs)}`);
  }
  if (m.leaps?.length) {
    const set = new Set(m.leaps.map(([f, r]) => `${f},${r}`));
    const KNIGHT = ['1,2', '2,1', '2,-1', '1,-2', '-1,-2', '-2,-1', '-2,1', '-1,2'];
    const ALL1 = ['1,0', '-1,0', '0,1', '0,-1', '1,1', '1,-1', '-1,1', '-1,-1'];
    if (KNIGHT.every((k) => set.has(k)) && set.size === 8) parts.push('jumps like a Knight');
    else if (ALL1.every((k) => set.has(k)) && set.size === 8) parts.push('moves 1 square in any direction');
    else if (['1,0', '-1,0', '0,1', '0,-1'].every((k) => set.has(k)) && set.size === 4) parts.push('moves 1 square orthogonally');
    else if (['1,1', '1,-1', '-1,1', '-1,-1'].every((k) => set.has(k)) && set.size === 4) parts.push('moves 1 square diagonally');
    else if (set.size === 2 && set.has('1,0') && set.has('-1,0')) parts.push('steps 1 square sideways');
    else parts.push(`jumps to ${set.size} fixed square${set.size === 1 ? '' : 's'}`);
  }
  if (!parts.length) return 'Cannot move.';
  const text = parts.join(' or ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

function describeEffect(e: Effect, target: string): string {
  const stat = (x: { atk?: number; def?: number; hp?: number }) =>
    (['atk', 'def', 'hp'] as const)
      .filter((k) => x[k])
      .map((k) => `${x[k]! > 0 ? '+' : ''}${x[k]} ${k.toUpperCase()}`)
      .join(', ');
  const mid = target.charAt(0).toLowerCase() + target.slice(1); // mid-sentence form
  switch (e.kind) {
    case 'modifyStats':
      return `${target} gains ${stat(e)}.`;
    case 'modifyStatsAll':
      return `All your ${e.pieceKind ? getPieceDef(e.pieceKind).name + 's' : 'pieces'} gain ${stat(e)}.`;
    case 'damage':
      return `Deal ${e.amount} damage to ${mid}.`;
    case 'heal':
      return `${target} heals ${e.amount} HP.`;
    case 'restore':
      return `${target} fully restores its HP and DEF shield.`;
    case 'draw':
      return `Draw ${e.count} card${e.count === 1 ? '' : 's'}.`;
    case 'hastenSummon':
      return `${target}: its summon timer drops by ${e.turns}.`;
    case 'freeStance':
      return `${target} switches to Attack mode and may still act this turn.`;
  }
}

/** Rules text for a card from its current numbers. */
export function describeCard(card: CardDef): string {
  if (card.type === 'summon') {
    const p = card.piece;
    const mv = describeMovement(p.movement).replace(/\.$/, '');
    return `Sacrifice a ${tierWord(card.sacrificeTier ?? card.tier - 1)} piece. Summons in ${card.summonTurns} turn${card.summonTurns === 1 ? '' : 's'}. ${mv}. ${p.atk} ATK / ${p.def} DEF / ${p.hp} HP.`;
  }
  const targetWord =
    card.target === 'ownPiece' ? 'Target friendly piece'
    : card.target === 'enemyPiece' ? `Target enemy ${card.targetTier !== undefined ? tierWord(card.targetTier) + ' ' : ''}piece${card.targetTier === undefined && !card.allowKing ? ' (not the King)' : ''}`
    : card.target === 'anyPiece' ? 'Target piece'
    : card.target === 'ownSummoning' ? 'Target friendly piece being sacrificed'
    : card.target === 'ownDefending' ? 'Target friendly piece in Defense mode'
    : 'You';
  return card.effects.map((e) => describeEffect(e, targetWord)).join(' ');
}
