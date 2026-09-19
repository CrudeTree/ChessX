import { registerPieceDef, removePieceDef, setPieceDef } from '../pieces.js';
import type { CardDef, SummonCardDef } from './types.js';

/** Cards as shipped in code (plus admin-created cards, which are their own base). */
const base = new Map<string, CardDef>();
/** Cards as the game currently plays them (base + balance patches). */
const cards = new Map<string, CardDef>();
/** Ids of admin-created cards currently registered. */
const custom = new Set<string>();

/** Board sprites look up `piece.art`; keep that in sync with the card picture. */
function bindSummonArt(card: SummonCardDef): void {
  if (card.piece.art) return;
  const url = card.boardArt ?? card.art;
  if (url) card.piece.art = url;
}

export function registerCard(card: CardDef): void {
  if (base.has(card.id)) throw new Error(`Duplicate card id: ${card.id}`);
  if (card.type === 'summon') bindSummonArt(card);
  base.set(card.id, card);
  cards.set(card.id, card);
  if (card.type === 'summon') registerPieceDef(card.piece);
}

/**
 * Replace the set of admin-created cards. Ones no longer listed are removed
 * (along with their creature definitions); the rest are (re)registered as base.
 */
export function setCustomCards(list: CardDef[]): void {
  const keep = new Set(list.map((c) => c.id));
  for (const id of custom) {
    if (keep.has(id)) continue;
    const old = base.get(id);
    base.delete(id);
    cards.delete(id);
    custom.delete(id);
    if (old?.type === 'summon') removePieceDef(old.piece.kind);
  }
  for (const card of list) {
    if (card.type === 'summon') bindSummonArt(card);
    base.set(card.id, card);
    cards.set(card.id, card);
    custom.add(card.id);
    if (card.type === 'summon') registerPieceDef(card.piece);
  }
}

export function isCustomCard(id: string): boolean {
  return custom.has(id);
}

export function registerCards(list: CardDef[]): void {
  for (const c of list) registerCard(c);
}

/** Replace the live definition of a card (balance patches). The shipped one is kept. */
export function setCardDef(card: CardDef): void {
  if (!base.has(card.id)) throw new Error(`Unknown card: ${card.id}`);
  if (card.type === 'summon') bindSummonArt(card);
  cards.set(card.id, card);
  if (card.type === 'summon') setPieceDef(card.piece);
}

export function getCardDef(id: string): CardDef {
  const c = cards.get(id);
  if (!c) throw new Error(`Unknown card: ${id}`);
  return c;
}

/** The card as shipped in code, before any balance patch. */
export function baseCardDef(id: string): CardDef {
  const c = base.get(id);
  if (!c) throw new Error(`Unknown card: ${id}`);
  return c;
}

export function hasCard(id: string): boolean {
  return cards.has(id);
}

export function allCards(): CardDef[] {
  return [...cards.values()];
}
