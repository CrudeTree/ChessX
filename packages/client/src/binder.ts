// The Binder: browse your collection and build up to three named decks.

import { clampArtZoom, DEFAULT_RULES, getCardDef, type CardDef } from '@chessx/engine';
import { DECK_SLOTS, type DeckInfo, type Profile } from '@chessx/protocol';
import { ApiError, profileApi } from './net.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** DOM card used by the binder, deck editor and reward popup. */
export function cardElement(card: CardDef, opts: { count?: number; isNew?: boolean; disabled?: boolean } = {}): HTMLElement {
  const el = document.createElement('div');
  const isSummon = card.type === 'summon';
  el.className = `bcard ${isSummon ? 'summon' : 'spell'} ${opts.disabled ? 'disabled' : ''}`;
  const type = isSummon ? `Tier ${card.tier} creature · ${card.summonTurns} turns` : 'Spell';
  const art = card.art ? `<img src="${card.art}" alt="">` : `<span>${card.glyph}</span>`;
  el.innerHTML = `
    <div class="bname"><span>${card.name}</span></div>
    <div class="bart" style="--card-art-zoom: ${clampArtZoom(card.cardArtZoom)}">${art}<span class="bcost" title="Mana cost">${card.cost}</span></div>
    <div class="btype">${type}</div>
    <div class="btext">${card.text}</div>
  `;
  if (opts.count !== undefined) {
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = `×${opts.count}`;
    el.appendChild(c);
  }
  if (opts.isNew) {
    const n = document.createElement('span');
    n.className = 'newtag';
    n.textContent = 'NEW';
    el.appendChild(n);
  }
  return el;
}

export class Binder {
  onProfileChanged: (p: Profile) => void = () => {};
  private profile: Profile | null = null;
  private slot = 1;
  /** Working copies of the decks (unsaved edits live here). */
  private drafts = new Map<number, DeckInfo>();

  constructor(private onBack: () => void) {
    $('binder-back').onclick = () => this.back();
    $('deck-save').onclick = () => void this.save();
    $<HTMLInputElement>('deck-name').oninput = (e) => {
      const d = this.draft();
      d.name = (e.target as HTMLInputElement).value;
      this.renderTabs();
      this.syncSave();
    };
  }

  open(profile: Profile): void {
    this.profile = profile;
    this.drafts = new Map(profile.decks.map((d) => [d.slot, { ...d, cards: d.cards.slice() }]));
    this.render();
    // Looking at the binder clears the "new" badges (after this render so they show once).
    if (profile.collection.some((c) => c.isNew)) {
      void profileApi.markSeen().then(() => {
        if (this.profile) {
          this.profile = { ...this.profile, collection: this.profile.collection.map((c) => ({ ...c, isNew: false })) };
          this.onProfileChanged(this.profile);
        }
      });
    }
  }

  private back(): void {
    if (this.hasUnsaved() && !confirm('You have unsaved deck changes. Leave anyway?')) return;
    this.onBack();
  }

  private savedDeck(slot: number): DeckInfo | undefined {
    return this.profile?.decks.find((d) => d.slot === slot);
  }

  private slotChanged(slot: number): boolean {
    const draft = this.drafts.get(slot);
    if (!draft) return false;
    const saved = this.savedDeck(slot);
    const savedName = saved?.name ?? `Deck ${slot}`;
    const savedCards = saved?.cards ?? [];
    return draft.name !== savedName || draft.cards.join('\0') !== savedCards.join('\0');
  }

  private hasUnsaved(): boolean {
    return [...this.drafts.keys()].some((slot) => this.slotChanged(slot));
  }

  private draft(): DeckInfo {
    let d = this.drafts.get(this.slot);
    if (!d) this.drafts.set(this.slot, (d = { slot: this.slot, name: `Deck ${this.slot}`, cards: [] }));
    return d;
  }

  private owned(cardId: string): number {
    return this.profile?.collection.find((c) => c.cardId === cardId)?.count ?? 0;
  }

  private inDeck(cardId: string): number {
    return this.draft().cards.filter((c) => c === cardId).length;
  }

  private add(cardId: string): void {
    const d = this.draft();
    if (d.cards.length >= DEFAULT_RULES.deckMax) return this.msg(`A deck can have at most ${DEFAULT_RULES.deckMax} cards.`, true);
    if (this.inDeck(cardId) >= Math.min(DEFAULT_RULES.maxCopies, this.owned(cardId))) {
      return this.msg(this.inDeck(cardId) >= DEFAULT_RULES.maxCopies ? `Max ${DEFAULT_RULES.maxCopies} copies of a card per deck.` : 'You have no more copies of that card.', true);
    }
    d.cards.push(cardId);
    this.msg('');
    this.render();
  }

  private remove(cardId: string): void {
    const d = this.draft();
    const i = d.cards.indexOf(cardId);
    if (i >= 0) d.cards.splice(i, 1);
    this.msg('');
    this.render();
  }

  private syncSave(): void {
    $<HTMLButtonElement>('deck-save').disabled = !this.slotChanged(this.slot);
  }

  private msg(text: string, bad = false): void {
    const el = $('deck-msg');
    el.textContent = text;
    el.style.color = bad ? 'var(--danger)' : '';
  }

  private async save(): Promise<void> {
    if (!this.slotChanged(this.slot)) return;
    const d = this.draft();
    try {
      const saved = await profileApi.saveDeck(d.slot, d.name, d.cards);
      this.drafts.set(d.slot, { ...saved, cards: saved.cards.slice() });
      if (this.profile) {
        this.profile = { ...this.profile, decks: this.profile.decks.map((x) => (x.slot === saved.slot ? saved : x)) };
        this.onProfileChanged(this.profile);
      }
      this.msg(`${saved.name} saved.`);
      this.render();
    } catch (e) {
      this.msg(e instanceof ApiError ? e.message : 'Could not save.', true);
    }
  }

  // ------------------------------------------------------------- rendering

  private render(): void {
    if (!this.profile) return;
    const p = this.profile;
    const total = p.collection.reduce((n, c) => n + c.count, 0);
    $('binder-stats').textContent = `Level ${p.level} · ${p.gamesPlayed} match${p.gamesPlayed === 1 ? '' : 'es'} · ${p.wins} win${p.wins === 1 ? '' : 's'}`;
    $('collection-count').textContent = `— ${p.collection.length} different, ${total} total`;

    // Collection: click a card to add it to the current deck.
    const grid = $('collection-grid');
    grid.innerHTML = '';
    const sorted = [...p.collection].sort((a, b) => {
      const ca = getCardDef(a.cardId);
      const cb = getCardDef(b.cardId);
      if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
      if (ca.type !== cb.type) return ca.type === 'summon' ? -1 : 1;
      const ta = ca.type === 'summon' ? ca.tier : 0;
      const tb = cb.type === 'summon' ? cb.tier : 0;
      return ta - tb || ca.name.localeCompare(cb.name);
    });
    for (const entry of sorted) {
      const card = getCardDef(entry.cardId);
      const used = this.inDeck(entry.cardId);
      const left = entry.count - used;
      const el = cardElement(card, { count: left, isNew: entry.isNew, disabled: left <= 0 || used >= DEFAULT_RULES.maxCopies });
      el.title = left > 0 ? `Add to ${this.draft().name} (${used} in deck)` : 'All copies are in this deck';
      el.onclick = () => this.add(entry.cardId);
      grid.appendChild(el);
    }

    this.renderTabs();
    this.syncSave();

    const d = this.draft();
    $<HTMLInputElement>('deck-name').value = d.name;
    const countEl = $('deck-count');
    const ok = d.cards.length >= DEFAULT_RULES.deckMin && d.cards.length <= DEFAULT_RULES.deckMax;
    countEl.textContent = `${d.cards.length} / ${DEFAULT_RULES.deckMin}–${DEFAULT_RULES.deckMax}`;
    countEl.className = `deck-count ${ok || d.cards.length === 0 ? '' : 'bad'}`;

    // Deck list: grouped by card with counts and +/- controls.
    const list = $('deck-list');
    list.innerHTML = '';
    const groups = new Map<string, number>();
    for (const c of d.cards) groups.set(c, (groups.get(c) ?? 0) + 1);
    const rows = [...groups.entries()].sort(([a], [b]) => {
      const ca = getCardDef(a);
      const cb = getCardDef(b);
      if (ca.type !== cb.type) return ca.type === 'summon' ? -1 : 1;
      return ca.name.localeCompare(cb.name);
    });
    for (const [cardId, n] of rows) {
      const card = getCardDef(cardId);
      const row = document.createElement('div');
      row.className = 'deck-row';
      row.innerHTML = `<span class="g">${card.glyph}</span><span class="n">${card.name}</span><span class="t">${card.type === 'summon' ? `T${card.tier}` : 'Spell'}</span><span class="x">×${n}</span>`;
      const minus = document.createElement('button');
      minus.textContent = '−';
      minus.title = 'Remove one';
      minus.onclick = () => this.remove(cardId);
      const plus = document.createElement('button');
      plus.textContent = '+';
      plus.title = 'Add one';
      plus.disabled = n >= Math.min(DEFAULT_RULES.maxCopies, this.owned(cardId));
      plus.onclick = () => this.add(cardId);
      row.append(minus, plus);
      list.appendChild(row);
    }
  }

  private renderTabs(): void {
    const tabs = $('deck-tabs');
    tabs.innerHTML = '';
    for (let slot = 1; slot <= DECK_SLOTS; slot++) {
      const d = this.drafts.get(slot) ?? { slot, name: `Deck ${slot}`, cards: [] };
      const b = document.createElement('button');
      const valid = d.cards.length >= DEFAULT_RULES.deckMin && d.cards.length <= DEFAULT_RULES.deckMax;
      b.className = `${slot === this.slot ? 'active' : ''} ${d.cards.length && !valid ? 'invalid' : ''}`;
      b.textContent = `${d.name}${this.slotChanged(slot) ? ' *' : ''}`;
      b.title = valid ? `${d.cards.length} cards — ready to play` : d.cards.length ? `${d.cards.length} cards — needs ${DEFAULT_RULES.deckMin}` : 'Empty';
      b.onclick = () => {
        this.slot = slot;
        this.msg('');
        this.render();
      };
      tabs.appendChild(b);
    }
  }
}
