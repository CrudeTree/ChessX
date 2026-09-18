import { registerPieceDef, setPieceDef } from '../pieces.js';
import type { CardDef } from './types.js';

/** Cards as shipped in code. */
const base = new Map<string, CardDef>();
/** Cards as the game currently plays them (base + balance patches). */
const cards = new Map<string, CardDef>();

export function registerCard(card: CardDef): void {
  if (base.has(card.id)) throw new Error(`Duplicate card id: ${card.id}`);
  base.set(card.id, card);
  cards.set(card.id, card);
  if (card.type === 'summon') registerPieceDef(card.piece);
}

export function registerCards(list: CardDef[]): void {
  for (const c of list) registerCard(c);
}

/** Replace the live definition of a card (balance patches). The shipped one is kept. */
export function setCardDef(card: CardDef): void {
  if (!base.has(card.id)) throw new Error(`Unknown card: ${card.id}`);
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
