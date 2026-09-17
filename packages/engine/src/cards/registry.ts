import { registerPieceDef } from '../pieces.js';
import type { CardDef } from './types.js';

const cards = new Map<string, CardDef>();

export function registerCard(card: CardDef): void {
  if (cards.has(card.id)) throw new Error(`Duplicate card id: ${card.id}`);
  cards.set(card.id, card);
  if (card.type === 'summon') registerPieceDef(card.piece);
}

export function registerCards(list: CardDef[]): void {
  for (const c of list) registerCard(c);
}

export function getCardDef(id: string): CardDef {
  const c = cards.get(id);
  if (!c) throw new Error(`Unknown card: ${id}`);
  return c;
}

export function hasCard(id: string): boolean {
  return cards.has(id);
}

export function allCards(): CardDef[] {
  return [...cards.values()];
}
