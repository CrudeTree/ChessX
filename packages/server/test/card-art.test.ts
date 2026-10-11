import { v2 } from '@chessx/engine';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRecord, type GameRow } from '../src/db.js';

/** The client's public folder is served at the site root, so `/art/x.png` is `public/art/x.png`. */
const publicFolder = new URL('../../client/public/', import.meta.url);

describe('card pictures', () => {
  it('every picture a starter card names is in the client', () => {
    for (const card of Object.values(v2.STARTER_CATALOG)) {
      const files = card.type === 'piece' ? [card.art, card.darkArt, card.boardArt, card.darkBoardArt] : [card.art, card.darkArt];
      for (const file of files) if (file) expect(existsSync(new URL(`.${file}`, publicFolder)), `${card.id}: ${file}`).toBe(true);
    }
  });

  it('a game saved with older pictures loads with today\'s', () => {
    const state = v2.newGame({ seed: 1, decks: { white: v2.starterDeck(), black: v2.starterDeck() } });
    const wyrmling = { ...state.catalog.wyrmling!, art: '/art/pic-002.png', darkArt: undefined };
    const saved: v2.GameRecord = { state: { ...state, catalog: { ...state.catalog, wyrmling } }, seq: 3, events: [] };
    const record = parseRecord({ rules_version: 2, state_json: JSON.stringify(saved) } as GameRow);
    expect(record!.state.catalog.wyrmling).toMatchObject({ art: '/art/wyrmling_white.png', darkArt: '/art/wyrmling_dark.png' });
    expect(record!.seq).toBe(3);
  });
});
