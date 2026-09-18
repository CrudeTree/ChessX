// Player progression: card collection, decks, XP/levels and end-of-game rewards.
//
//  - New players own 3 copies of every starter card; Deck 1 is the starter deck.
//  - Finishing a match (not practice) gives XP; winning gives more.
//  - The first finished match always unlocks a brand-new reward card.
//  - Every checkmate (or king capture) rolls a reward: a new card you don't own
//    yet, or a spare copy of a card you already have.

import { DEFAULT_RULES, hasCard, REWARD_CARDS, STARTER_CARDS, starterDeck, validateDeck } from '@chessx/engine';
import { DECK_SLOTS, levelFor, XP_PER_MATCH, XP_PER_WIN, type CollectionEntry, type DeckInfo, type Profile, type RewardReport } from '@chessx/protocol';
import { toUserInfo } from './auth.js';
import type { Db, UserRow } from './db.js';

export class ProgressionError extends Error {}

export class Progression {
  constructor(private db: Db) {}

  /** Give a fresh account its starter collection and Deck 1 (idempotent). */
  ensureStarter(userId: string): void {
    if (this.db.collectionFor(userId).length > 0) return;
    for (const id of STARTER_CARDS) this.db.grantCard(userId, id, 3, true);
    this.db.saveDeck(userId, 1, 'Deck 1', starterDeck());
  }

  collection(userId: string): CollectionEntry[] {
    return this.db.collectionFor(userId).map((r) => ({ cardId: r.card_id, count: r.count, isNew: r.seen === 0 }));
  }

  decks(userId: string): DeckInfo[] {
    const rows = new Map(this.db.decksFor(userId).map((r) => [r.slot, r]));
    const out: DeckInfo[] = [];
    for (let slot = 1; slot <= DECK_SLOTS; slot++) {
      const r = rows.get(slot);
      out.push({ slot, name: r?.name ?? `Deck ${slot}`, cards: r ? (JSON.parse(r.cards_json) as string[]) : [] });
    }
    return out;
  }

  profile(user: UserRow): Profile {
    this.ensureStarter(user.id);
    return {
      user: toUserInfo(user),
      xp: user.xp,
      level: levelFor(user.xp),
      gamesPlayed: user.games_played,
      wins: user.wins,
      collection: this.collection(user.id),
      decks: this.decks(user.id),
    };
  }

  /** Validate and store a deck. A deck must be legal *and* built only from cards the player owns. */
  saveDeck(userId: string, slot: number, name: string, cards: string[]): DeckInfo {
    if (!Number.isInteger(slot) || slot < 1 || slot > DECK_SLOTS) throw new ProgressionError('Bad deck slot.');
    name = name.trim().slice(0, 24) || `Deck ${slot}`;
    if (!Array.isArray(cards) || cards.some((c) => typeof c !== 'string' || !hasCard(c))) throw new ProgressionError('Unknown card in deck.');
    // Empty is allowed (an unused slot); anything else must be a legal deck.
    if (cards.length > 0) {
      const problems = validateDeck(cards, DEFAULT_RULES);
      if (problems.length) throw new ProgressionError(problems.join(' '));
      const owned = new Map(this.db.collectionFor(userId).map((r) => [r.card_id, r.count]));
      const used = new Map<string, number>();
      for (const c of cards) used.set(c, (used.get(c) ?? 0) + 1);
      for (const [c, n] of used) {
        if (n > (owned.get(c) ?? 0)) throw new ProgressionError(`You only own ${owned.get(c) ?? 0} cop${(owned.get(c) ?? 0) === 1 ? 'y' : 'ies'} of that card.`);
      }
    }
    this.db.saveDeck(userId, slot, name, cards);
    return { slot, name, cards };
  }

  /** The card list for a slot, ready to play with. Throws if the slot is not a legal deck. */
  deckForPlay(userId: string, slot: number): string[] {
    this.ensureStarter(userId);
    const deck = this.decks(userId).find((d) => d.slot === slot);
    if (!deck) throw new ProgressionError('Bad deck slot.');
    const problems = validateDeck(deck.cards, DEFAULT_RULES);
    if (problems.length) throw new ProgressionError(`${deck.name} is not ready: ${problems.join(' ')}`);
    return deck.cards.slice();
  }

  markSeen(userId: string): void {
    this.db.markCollectionSeen(userId);
  }

  /**
   * Hand out XP and cards to one participant of a finished match.
   * `won` = the game ended in their favour; `checkmate` = it ended by checkmate/king capture.
   */
  award(userId: string, gameId: string, won: boolean, checkmate: boolean): RewardReport {
    const before = this.db.userById(userId)!;
    this.ensureStarter(userId);
    const firstMatch = before.games_played === 0;
    const xpGained = XP_PER_MATCH + (won ? XP_PER_WIN : 0);
    this.db.addProgress(userId, xpGained, 1, won ? 1 : 0);

    const cards: RewardReport['cards'] = [];
    let reason: RewardReport['reason'] = 'none';
    if (firstMatch) {
      const c = this.rollNewCard(userId);
      if (c) cards.push({ cardId: c, brandNew: true });
      reason = 'firstMatch';
    } else if (won && checkmate) {
      // Coin flip between a brand-new card (if any remain) and a spare copy of something owned.
      const wantNew = Math.random() < 0.5;
      const fresh = wantNew ? this.rollNewCard(userId) : null;
      if (fresh) cards.push({ cardId: fresh, brandNew: true });
      else {
        const owned = this.db.collectionFor(userId);
        const pick = owned[Math.floor(Math.random() * owned.length)];
        if (pick) {
          this.db.grantCard(userId, pick.card_id, 1, false);
          cards.push({ cardId: pick.card_id, brandNew: false });
        }
      }
      reason = 'checkmate';
    }

    const xp = before.xp + xpGained;
    return {
      gameId,
      xpGained,
      xp,
      level: levelFor(xp),
      leveledUp: levelFor(xp) > levelFor(before.xp),
      cards,
      reason,
    };
  }

  /** Grant a random reward card the player does not own yet; null if they have them all. */
  private rollNewCard(userId: string): string | null {
    const owned = new Set(this.db.collectionFor(userId).map((r) => r.card_id));
    const pool = REWARD_CARDS.filter((id) => !owned.has(id));
    if (pool.length === 0) return null;
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    this.db.grantCard(userId, pick, 1, false);
    return pick;
  }
}
