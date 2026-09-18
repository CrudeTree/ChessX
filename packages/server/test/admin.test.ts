import { applyBalance, EMPTY_BALANCE, getCardDef, DIRS } from '@chessx/engine';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Admin, AdminError } from '../src/admin.js';
import { Db } from '../src/db.js';
import { Progression } from '../src/progression.js';

const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'chessx-admin-'));
  dirs.push(dir);
  const db = new Db(':memory:');
  const admin = new Admin(db, dir, { ADMIN_NAME: 'Djabooty' });
  const progression = new Progression(db);
  let n = 0;
  const mk = (name: string) =>
    db.createUser({ email: `user${++n}@x.test`, name, password_hash: null, google_id: null, facebook_id: null, avatar_url: null });
  return { db, admin, progression, mk };
}
afterEach(() => {
  applyBalance(EMPTY_BALANCE);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const wolf = {
  id: 'custom_wolf',
  type: 'summon' as const,
  name: 'Dire Wolf',
  glyph: '🐺',
  cost: 150,
  tier: 2,
  summonTurns: 1,
  text: 'A wolf.',
  piece: { kind: 'custom_wolf', name: 'Dire Wolf', glyph: '🐺', tier: 2, movement: { leaps: DIRS.KNIGHT }, atk: 2, def: 0, hp: 2 },
  give: 'everyone' as const,
};

describe('admin', () => {
  it('pins admin to the earliest account with the name; later namesakes get nothing', () => {
    const { admin, mk } = setup();
    const real = mk('Djabooty');
    const impostor = mk('djabooty');
    const other = mk('Alice');
    expect(admin.isAdmin(real)).toBe(true);
    expect(admin.isAdmin(impostor)).toBe(false);
    expect(admin.isAdmin(other)).toBe(false);
  });

  it('the owner can make other players developers (editor access) and revoke it', () => {
    const { admin, mk } = setup();
    const owner = mk('Djabooty');
    const bob = mk('Bob');
    expect(admin.isOwner(owner)).toBe(true);
    expect(admin.isAdmin(bob)).toBe(false);
    expect(admin.setDeveloper(bob.id, true)).toEqual([bob.id]);
    expect(admin.isAdmin(bob)).toBe(true);
    expect(admin.isOwner(bob)).toBe(false); // developers do not get to appoint others
    expect(() => admin.setDeveloper(owner.id, true)).toThrow(AdminError);
    expect(() => admin.setDeveloper('nope', true)).toThrow(AdminError);
    expect(admin.setDeveloper(bob.id, false)).toEqual([]);
    expect(admin.isAdmin(bob)).toBe(false);
  });

  it('created cards reach every player; deleting one removes it from collections, decks and the catalog', () => {
    const { db, admin, progression, mk } = setup();
    const alice = mk('Alice');
    progression.ensureStarter(alice.id);
    expect(progression.collection(alice.id).some((c) => c.cardId === 'custom_wolf')).toBe(false);

    admin.saveBalance({ cards: {}, pieces: {}, customCards: [wolf] });
    expect(getCardDef('custom_wolf').name).toBe('Dire Wolf');
    const profile = progression.profile(alice);
    const owned = profile.collection.find((c) => c.cardId === 'custom_wolf');
    expect(owned).toMatchObject({ count: 3, isNew: true });

    // She puts it in a deck.
    const deck = [...profile.decks[0]!.cards.slice(0, 24), 'custom_wolf'];
    progression.saveDeck(alice.id, 2, 'Wolves', deck);
    expect(progression.decks(alice.id)[1]!.cards).toContain('custom_wolf');

    // Deleting the card cleans everything up.
    const { removedCards } = admin.saveBalance({ cards: {}, pieces: {} });
    expect(removedCards).toEqual(['custom_wolf']);
    expect(() => getCardDef('custom_wolf')).toThrow();
    expect(progression.collection(alice.id).some((c) => c.cardId === 'custom_wolf')).toBe(false);
    expect(progression.decks(alice.id)[1]!.cards).not.toContain('custom_wolf');
    expect(db.collectionFor(alice.id).length).toBeGreaterThan(0); // the rest is untouched
  });

  it('site stats and last-seen bookkeeping', () => {
    const { db, mk } = setup();
    const a = mk('Alice');
    mk('Bob');
    let s = db.siteStats();
    expect(s.accounts).toBe(2);
    expect(s.newThisWeek).toBe(2);
    expect(s.activeToday).toBe(0);
    db.touchLastSeen(a.id);
    s = db.siteStats();
    expect(s.activeToday).toBe(1);
    expect(db.allUsers().map((u) => u.name)).toEqual(['Bob', 'Alice']); // newest first
    expect(db.userById(a.id)!.last_seen_at).toBeGreaterThan(0);
  });

  it('stores PNG uploads by content hash and rejects anything else', () => {
    const { admin } = setup();
    // Smallest valid-looking PNG header + junk body.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('hello')]);
    const url = admin.saveImage(`data:image/png;base64,${png.toString('base64')}`);
    expect(url).toMatch(/^\/uploads\/[a-f0-9]{20}\.png$/);
    expect(admin.saveImage(`data:image/png;base64,${png.toString('base64')}`)).toBe(url); // same bytes, same name
    expect(() => admin.saveImage('data:image/jpeg;base64,AAAA')).toThrow(AdminError);
    expect(() => admin.saveImage(`data:image/png;base64,${Buffer.from('not a png').toString('base64')}`)).toThrow(AdminError);
  });
});
