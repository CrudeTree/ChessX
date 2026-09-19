// Balance patches: number tweaks to cards and pieces made by the game's admin
// from inside the app, stored in the server database and applied on top of the
// shipped catalog on both server and client. Code changes never overwrite them:
// a patch only carries the fields the admin actually changed, everything else
// keeps following the code.

import { RETIRED_CARDS } from './cards/catalog.js';
import { allCards, baseCardDef, hasCard, setCardDef, setCustomCards } from './cards/registry.js';
import { BOARD_ART_ZOOM_MAX, BOARD_ART_ZOOM_MIN, type CardDef, type Effect, type TargetRule } from './cards/types.js';
import { basePieceDef, hasPieceDef, setPieceDef, STANDARD_KINDS } from './pieces.js';
import { BASE_RULES, DEFAULT_RULES, type GameState } from './state.js';
import type { AbilityTarget, Color, MovementSpec, PieceAbility, PieceDef } from './types.js';

export interface PiecePatch {
  /** Starting Defense charges. */
  defense?: number;
  /** Mana produced per turn (default: the tier). */
  manaYield?: number;
  movement?: MovementSpec;
  abilities?: PieceAbility[];
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
  /** Replacement card picture (an uploaded image URL). */
  art?: string;
  /** How large the picture looks in the card window (0.5–2, default 1). */
  cardArtZoom?: number;
  /** Replacement board sprite for the creature (an uploaded image URL). */
  boardArt?: string;
  /** How large the creature looks on the board (0.5–2, default 1). */
  boardArtZoom?: number;
}

/** Game-wide numbers (apply to games created after the change). */
export interface RulesPatch {
  startingMana?: number;
  openingHand?: number;
  drawEvery?: number;
}

/** Who gets an admin-created card: three copies for everyone, the reward pool, or nobody yet. */
export type CardGive = 'everyone' | 'reward' | 'none';

/** An admin-created card: a complete definition plus how it is handed out. */
export type CustomCard = CardDef & { give: CardGive };

export interface Balance {
  /** Patches keyed by card id. */
  cards: Record<string, CardPatch>;
  /** Patches for the six standard chess pieces, keyed by kind. */
  pieces: Record<string, PiecePatch>;
  rules?: RulesPatch;
  /** Cards created in the editor. Their ids start with `custom_`. */
  customCards?: CustomCard[];
}

export const CUSTOM_ID = /^custom_[a-z0-9_]{1,40}$/;
export const ART_URL = /^\/(uploads|art)\/[a-z0-9_.-]+\.(png|webp|jpg|jpeg)$/i;

export const EMPTY_BALANCE: Balance = { cards: {}, pieces: {} };

const RETIRED = new Set(RETIRED_CARDS);

const LIVE_EFFECTS = new Set<Effect['kind']>(['destroy', 'draw', 'hastenSummon', 'freeStance']);

function sanitizeAbility(a: PieceAbility): PieceAbility {
  const old = a as PieceAbility & { atk?: number; def?: number; hp?: number };
  const defense = old.defense ?? (old.def || old.atk || old.hp ? 1 : 1);
  return {
    kind: 'grantAdjacent',
    defense,
    ...(old.target ? { target: old.target } : {}),
    ...(old.oncePerTurn !== undefined ? { oncePerTurn: old.oncePerTurn } : {}),
  };
}

function sanitizePieceDef(p: PieceDef): PieceDef {
  const leftover = p as PieceDef & { atk?: number; def?: number; hp?: number };
  const { atk: _a, def: _d, hp: _h, ...rest } = leftover;
  const abilities = (p.abilities ?? []).map(sanitizeAbility);
  const defense = typeof leftover.defense === 'number' ? leftover.defense : 0;
  return {
    ...rest,
    ...(defense ? { defense } : {}),
    ...(abilities.length ? { abilities } : {}),
  };
}

function sanitizeEffects(effects: Effect[] | undefined): Effect[] {
  const out: Effect[] = [];
  for (const e of effects ?? []) {
    if (!e || typeof e !== 'object') continue;
    if ((e as { kind?: string }).kind === 'damage') out.push({ kind: 'destroy' });
    else if (LIVE_EFFECTS.has(e.kind)) out.push(e);
  }
  return out.length ? out : [{ kind: 'draw', count: 1 }];
}

function sanitizePiecePatch(p: PiecePatch): PiecePatch {
  const old = p as PiecePatch & { atk?: number; def?: number; hp?: number };
  const out: PiecePatch = {};
  if (old.defense !== undefined) out.defense = old.defense;
  else if (typeof old.def === 'number' && old.def > 0) out.defense = 1;
  if (old.manaYield !== undefined) out.manaYield = old.manaYield;
  if (old.movement) out.movement = old.movement;
  if (old.abilities) out.abilities = old.abilities.map(sanitizeAbility);
  return out;
}

function sanitizeCardPatch(p: CardPatch): CardPatch {
  const out: CardPatch = { ...p };
  if (p.piece) out.piece = sanitizePiecePatch(p.piece);
  if (p.effects) out.effects = sanitizeEffects(p.effects);
  return out;
}

function sanitizeCustomCard(c: CustomCard): CustomCard {
  if (c.type === 'summon') {
    return { ...c, piece: sanitizePieceDef(c.piece) };
  }
  return { ...c, effects: sanitizeEffects(c.effects) };
}

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
  if (p.defense !== undefined) out.defense = p.defense || undefined;
  if (p.manaYield !== undefined) out.manaYield = p.manaYield;
  if (p.movement) out.movement = cloneMovement(p.movement);
  if (p.abilities !== undefined) out.abilities = p.abilities.map(sanitizeAbility);
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
    if (patch?.art !== undefined) card.art = patch.art;
    if (patch?.cardArtZoom !== undefined) card.cardArtZoom = patch.cardArtZoom;
    if (patch?.boardArt !== undefined) card.boardArt = patch.boardArt;
    if (patch?.boardArtZoom !== undefined) card.boardArtZoom = patch.boardArtZoom;
    // Hand-written text stays until the numbers change; then it is regenerated (unless set explicitly).
    card.text = patch?.text ?? (numbersChanged(patch) ? describeCard(card) : base.text);
    return card;
  }
  const card = { ...base, effects: (patch?.effects ?? base.effects).map((e) => ({ ...e })) };
  if (patch?.cost !== undefined) card.cost = patch.cost;
  if (patch?.targetTier !== undefined) card.targetTier = patch.targetTier;
  if (patch?.art !== undefined) card.art = patch.art;
  if (patch?.cardArtZoom !== undefined) card.cardArtZoom = patch.cardArtZoom;
  card.text = patch?.text ?? (numbersChanged(patch) ? describeCard(card) : base.text);
  return card;
}

/** Did the patch touch anything the rules text describes? (Pictures and cost do not.) */
function numbersChanged(patch: CardPatch | undefined): boolean {
  if (!patch) return false;
  return Object.keys(patch).some((k) => k !== 'art' && k !== 'cardArtZoom' && k !== 'boardArt' && k !== 'boardArtZoom' && k !== 'text' && k !== 'cost');
}

/**
 * Apply a full balance (replacing whatever was applied before). Cards and
 * pieces with no patch return to their shipped definitions.
 */
export function applyBalance(balance: Balance): void {
  const cards: Record<string, CardPatch> = {};
  for (const [id, patch] of Object.entries(balance.cards ?? {})) {
    if (RETIRED.has(id) || !patch) continue;
    cards[id] = sanitizeCardPatch(patch);
  }
  const pieces: Record<string, PiecePatch> = {};
  for (const [kind, patch] of Object.entries(balance.pieces ?? {})) {
    if (!patch) continue;
    pieces[kind] = sanitizePiecePatch(patch);
  }
  current = {
    cards,
    pieces,
    ...(balance.rules && Object.keys(balance.rules).length ? { rules: { ...balance.rules } } : {}),
    ...(balance.customCards?.length ? { customCards: balance.customCards.map(sanitizeCustomCard) } : {}),
  };
  // Admin-created cards become part of the base catalog first (patches may then apply to them too).
  if (current.customCards) awakenNamedCreatureAbilities(current.customCards);
  setCustomCards((current.customCards ?? []).map(({ give: _give, ...card }) => card as CardDef));
  for (const base of allCards()) setCardDef(patchedCard(base.id, current.cards[base.id]));
  for (const kind of STANDARD_KINDS) setPieceDef(patchPiece(basePieceDef(kind), current.pieces[kind]));
  // New games pick these up; games in progress keep the rules they started with.
  Object.assign(DEFAULT_RULES, BASE_RULES, current.rules ?? {});
}

/** Custom cards handed out in a given way (for the server's collection logic). */
export function customCardsGiven(give: CardGive): string[] {
  return (current.customCards ?? []).filter((c) => c.give === give).map((c) => c.id);
}

/**
 * A card the admin deleted may still be in a saved game's hand, deck, graveyard
 * or on the board as a creature. Drop those so the game can go on. Returns true
 * if anything was removed.
 */
export function pruneUnknownCards(state: GameState): boolean {
  let changed = false;
  for (const color of ['white', 'black'] as Color[]) {
    const p = state.players[color];
    for (const key of ['hand', 'deck', 'graveyard'] as const) {
      const kept = p[key].filter((c) => hasCard(c.cardId));
      if (kept.length !== p[key].length) {
        p[key] = kept;
        changed = true;
      }
    }
  }
  for (const piece of Object.values(state.pieces)) {
    if (piece.summon && !hasCard(piece.summon.cardId)) {
      delete piece.summon; // the pending summon simply fizzles
      changed = true;
    }
    if (!hasPieceDef(piece.kind)) {
      state.board[piece.square] = null;
      delete state.pieces[piece.id];
      changed = true;
    }
  }
  return changed;
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
  if (p.defense !== undefined && !isInt(p.defense, 0, 9)) problems.push(`${where}: Defense must be 0–9.`);
  if (p.manaYield !== undefined && !isInt(p.manaYield, 0, 999)) problems.push(`${where}: mana per turn must be 0–999.`);
  if (p.movement !== undefined) validateMovement(p.movement, where, problems);
  if (p.abilities !== undefined) validateAbilities(p.abilities, where, problems);
  if (isKing && p.movement && (p.movement as MovementSpec).pawn) problems.push(`${where}: the King cannot use pawn movement.`);
  if (isKing && p.abilities?.length) problems.push(`${where}: the King cannot have board abilities.`);
  if (isKing && p.defense) problems.push(`${where}: the King cannot have Defense.`);
}

const ABILITY_TARGETS: AbilityTarget[] = ['ownAdjacent', 'enemyAdjacent', 'anyAdjacent'];

function validateAbilities(list: unknown, where: string, problems: string[]): void {
  if (!Array.isArray(list)) return void problems.push(`${where}: abilities must be a list.`);
  for (const a of list as PieceAbility[]) {
    if (a?.kind !== 'grantAdjacent') {
      problems.push(`${where}: unknown ability.`);
      continue;
    }
    if (a.defense !== undefined && !isInt(a.defense, 1, 9)) problems.push(`${where}: grant Defense must be 1–9.`);
    if (a.target !== undefined && !ABILITY_TARGETS.includes(a.target)) problems.push(`${where}: bad ability target.`);
    if (a.oncePerTurn !== undefined && typeof a.oncePerTurn !== 'boolean') problems.push(`${where}: oncePerTurn must be true or false.`);
  }
}

function validateEffects(effects: unknown, where: string, problems: string[]): void {
  if (!Array.isArray(effects) || effects.length === 0) return void problems.push(`${where}: a spell needs at least one effect.`);
  for (const e of effects as Effect[]) {
    switch (e?.kind) {
      case 'destroy':
      case 'freeStance':
        break;
      case 'draw':
        if (!isInt(e.count, 1, 10)) problems.push(`${where}: draw count must be 1–10.`);
        break;
      case 'hastenSummon':
        if (!isInt(e.turns, 1, 10)) problems.push(`${where}: turns must be 1–10.`);
        break;
      default:
        problems.push(`${where}: unknown effect.`);
    }
  }
}

const TARGET_RULES: TargetRule[] = ['none', 'ownPiece', 'enemyPiece', 'anyPiece', 'ownSummoning', 'ownDefending'];
const GIVES: CardGive[] = ['everyone', 'reward', 'none'];
const artOk = (u: unknown) => typeof u === 'string' && ART_URL.test(u);
const zoomOk = (z: unknown) => typeof z === 'number' && Number.isFinite(z) && z >= BOARD_ART_ZOOM_MIN && z <= BOARD_ART_ZOOM_MAX;

/** Check an admin-created card is complete and sane. */
function validateCustomCard(c: unknown, problems: string[]): void {
  if (typeof c !== 'object' || c === null) return void problems.push('Custom card must be an object.');
  const card = c as CustomCard;
  const where = typeof card.name === 'string' && card.name ? card.name : String(card.id);
  if (typeof card.id !== 'string' || !CUSTOM_ID.test(card.id)) problems.push(`${where}: bad id.`);
  if (typeof card.name !== 'string' || !card.name.trim() || card.name.length > 24) problems.push(`${where}: name must be 1–24 characters.`);
  if (typeof card.glyph !== 'string' || card.glyph.length > 8) problems.push(`${where}: glyph must be a short emoji or symbol.`);
  if (typeof card.text !== 'string' || card.text.length > 300) problems.push(`${where}: text must be 0–300 characters.`);
  if (card.art !== undefined && !artOk(card.art)) problems.push(`${where}: card image must be an uploaded image.`);
  if (card.cardArtZoom !== undefined && !zoomOk(card.cardArtZoom)) problems.push(`${where}: card zoom must be ${BOARD_ART_ZOOM_MIN}–${BOARD_ART_ZOOM_MAX}.`);
  if (card.boardArt !== undefined && !artOk(card.boardArt)) problems.push(`${where}: board sprite must be an uploaded image.`);
  if (card.boardArtZoom !== undefined && !zoomOk(card.boardArtZoom)) problems.push(`${where}: board zoom must be ${BOARD_ART_ZOOM_MIN}–${BOARD_ART_ZOOM_MAX}.`);
  if (!isInt(card.cost, 0, 9999)) problems.push(`${where}: cost must be 0–9999.`);
  if (!GIVES.includes(card.give)) problems.push(`${where}: choose who receives the card.`);
  if (card.type === 'summon') {
    if (!isInt(card.tier, 1, 6)) problems.push(`${where}: tier must be 1–6.`);
    if (card.sacrificeTier !== undefined && !isInt(card.sacrificeTier, 1, 4)) problems.push(`${where}: sacrifice tier must be 1–4.`);
    if (!isInt(card.summonTurns, 1, 10)) problems.push(`${where}: summon turns must be 1–10.`);
    const p = card.piece;
    if (typeof p !== 'object' || p === null) problems.push(`${where}: creature stats missing.`);
    else {
      if (p.kind !== card.id) problems.push(`${where}: creature kind must match the card id.`);
      if (!isInt(p.tier, 1, 6)) problems.push(`${where}: creature tier must be 1–6.`);
      validatePiece({ defense: p.defense, manaYield: p.manaYield, movement: p.movement, abilities: p.abilities }, where, problems, false);
      if (!p.movement) problems.push(`${where}: creature needs movement.`);
    }
  } else if (card.type === 'spell') {
    if (!TARGET_RULES.includes(card.target)) problems.push(`${where}: bad target rule.`);
    if (card.targetTier !== undefined && !isInt(card.targetTier, 1, 6)) problems.push(`${where}: target tier must be 1–6.`);
    validateEffects(card.effects, where, problems);
  } else {
    problems.push(`${where}: type must be summon or spell.`);
  }
}

/** Problems with a proposed balance, or [] if it is acceptable. */
export function validateBalance(b: unknown): string[] {
  const problems: string[] = [];
  if (typeof b !== 'object' || b === null) return ['Balance must be an object.'];
  const bal = b as Partial<Balance>;
  const customIds = new Set<string>();
  if (bal.customCards !== undefined) {
    if (!Array.isArray(bal.customCards)) problems.push('customCards must be a list.');
    else {
      for (const c of bal.customCards) {
        validateCustomCard(c, problems);
        const id = (c as CustomCard)?.id;
        if (typeof id === 'string') {
          if (customIds.has(id)) problems.push(`Duplicate custom card id: ${id}`);
          customIds.add(id);
        }
      }
    }
  }
  for (const [id, patch] of Object.entries(bal.cards ?? {})) {
    let base: CardDef;
    try {
      base = baseCardDef(id);
    } catch {
      if (customIds.has(id) || RETIRED.has(id)) continue;
      problems.push(`Unknown card: ${id}`);
      continue;
    }
    const where = base.name;
    if (patch.cost !== undefined && !isInt(patch.cost, 0, 9999)) problems.push(`${where}: cost must be 0–9999.`);
    if (patch.text !== undefined && (typeof patch.text !== 'string' || patch.text.length > 300)) problems.push(`${where}: text too long.`);
    if (patch.art !== undefined && !artOk(patch.art)) problems.push(`${where}: card image must be an uploaded image.`);
    if (patch.cardArtZoom !== undefined && !zoomOk(patch.cardArtZoom)) problems.push(`${where}: card zoom must be ${BOARD_ART_ZOOM_MIN}–${BOARD_ART_ZOOM_MAX}.`);
    if (patch.boardArt !== undefined && !artOk(patch.boardArt)) problems.push(`${where}: board sprite must be an uploaded image.`);
    if (patch.boardArtZoom !== undefined && !zoomOk(patch.boardArtZoom)) problems.push(`${where}: board zoom must be ${BOARD_ART_ZOOM_MIN}–${BOARD_ART_ZOOM_MAX}.`);
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
    else if (set.size === 3 && set.has('-1,1') && set.has('1,1') && set.has('0,-1')) parts.push('hops 1 square diagonally forward or 1 square back');
    else parts.push(`jumps to ${set.size} fixed square${set.size === 1 ? '' : 's'}`);
  }
  if (!parts.length) return 'Cannot move.';
  const text = parts.join(' or ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

function describeEffect(e: Effect, target: string): string {
  const mid = target.charAt(0).toLowerCase() + target.slice(1); // mid-sentence form
  switch (e.kind) {
    case 'destroy':
      return `Destroy ${mid}.`;
    case 'draw':
      return `Draw ${e.count} card${e.count === 1 ? '' : 's'}.`;
    case 'hastenSummon':
      return `${target}: its summon timer drops by ${e.turns}.`;
    case 'freeStance':
      return `${target} switches to Attack mode and may still act this turn.`;
  }
}

/** Rules text for a creature's activated board ability. */
export function describeAbility(a: PieceAbility): string {
  if (a.kind !== 'grantAdjacent') return '';
  const who =
    a.target === 'enemyAdjacent' ? 'an adjacent enemy piece'
    : a.target === 'anyAdjacent' ? 'an adjacent piece'
    : 'an adjacent friendly piece';
  const n = a.defense ?? 1;
  return `On summon, grant ${who} +${n} Defense. If several are adjacent, choose one.`;
}

/**
 * Older custom cards described a board ability in free text only. Wire the
 * matching creature so that text actually does something. Never overwrites an
 * abilities list the admin already set (including an empty one).
 */
function awakenNamedCreatureAbilities(cards: CustomCard[]): void {
  for (const card of cards) {
    if (card.type !== 'summon') continue;
    if (card.piece.abilities?.length) continue;
    if (!/null\s*glass\s*knight/i.test(card.name)) continue; // "Nullglass Knight" and close spellings
    card.piece.abilities = [{ kind: 'grantAdjacent', defense: 1 }];
  }
}

/** Rules text for a card from its current numbers. */
export function describeCard(card: CardDef): string {
  if (card.type === 'summon') {
    const p = card.piece;
    const mv = describeMovement(p.movement).replace(/\.$/, '');
    const ability = (p.abilities ?? []).map(describeAbility).filter(Boolean).join(' ');
    const defense = p.defense ? ` Starts with ${p.defense} Defense.` : '';
    return `Sacrifice a ${tierWord(card.sacrificeTier ?? card.tier - 1)} piece. Summons in ${card.summonTurns} turn${card.summonTurns === 1 ? '' : 's'}. ${mv}.${defense}${ability ? ` ${ability.charAt(0).toUpperCase()}${ability.slice(1)}` : ''}`;
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
