// Admin: who may edit the game's balance, and where the edits live.
//
// Identity. Display names are not unique, so admin rights are pinned to a user
// *id* stored in the database (`admin_user_id`). The first time the server
// needs it, it is bootstrapped from ADMIN_NAME (default "Djabooty"): the
// earliest-registered account with that name becomes the admin, permanently.
// Anyone registering the same name later gets nothing. Extra admins can be
// listed in ADMIN_USER_IDS (comma-separated ids).
//
// Balance. The admin's card/piece patches are one JSON blob in the kv table,
// applied to the engine at startup and after every save. They live in the
// database volume, so deploys and code changes never overwrite them.

import { applyBalance, currentBalance, EMPTY_BALANCE, validateBalance, type Balance, type CustomCard } from '@chessx/engine';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, UserRow } from './db.js';

const ADMIN_ID_KEY = 'admin_user_id';
const DEVELOPERS_KEY = 'developer_user_ids';
const BALANCE_KEY = 'balance';
/** Uploaded art is re-encoded by the browser to a 512px PNG before upload; allow headroom. */
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

const CANDLE_ID = 'custom_2gmmis';
const CANDLE_ART = '/uploads/c9f7c8e25f9d03cb2fda.png';

/** One-shot: rename the production Cowardly Candle custom card and give it creature art. */
export function restyleCowardlyCandle(balance: Balance): Balance {
  const list = balance.customCards;
  if (!list?.length) return balance;
  let changed = false;
  const customCards = list.map((card) => {
    const isCandle = card.id === CANDLE_ID || card.name === 'Cowardly Candle' || card.art === CANDLE_ART;
    if (!isCandle || card.type !== 'summon') return card;
    if (card.name === 'Emberling' && card.art === '/art/emberling.png') return card;
    changed = true;
    return {
      ...card,
      name: 'Emberling',
      glyph: '🦊',
      art: '/art/emberling.png',
      text: 'Too shy to step sideways.',
      piece: { ...card.piece, name: 'Emberling', glyph: '🦊' },
    } satisfies CustomCard;
  });
  return changed ? { ...balance, customCards } : balance;
}

export class AdminError extends Error {}

export class Admin {
  private readonly extraIds: Set<string>;
  private readonly bootstrapName: string;
  /** Where uploaded card/board images live (inside the data volume, so they survive deploys). */
  readonly uploadsDir: string;

  constructor(
    private db: Db,
    dataDir: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.bootstrapName = (env.ADMIN_NAME ?? 'Djabooty').trim();
    this.extraIds = new Set((env.ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    this.uploadsDir = join(dataDir, 'uploads');
    mkdirSync(this.uploadsDir, { recursive: true });
  }

  /**
   * Store an uploaded PNG (as a data: URL) and return its public path. Files are
   * named by content hash, so re-uploading the same picture is free and URLs are
   * safe to cache forever.
   */
  saveImage(dataUrl: unknown): string {
    if (typeof dataUrl !== 'string') throw new AdminError('No image received.');
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) throw new AdminError('Image must be a PNG.');
    const bytes = Buffer.from(m[1]!, 'base64');
    if (bytes.length > MAX_UPLOAD_BYTES) throw new AdminError('Image is too large (max 3 MB).');
    // PNG signature.
    if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) throw new AdminError('That is not a PNG file.');
    const name = `${createHash('sha1').update(bytes).digest('hex').slice(0, 20)}.png`;
    const path = join(this.uploadsDir, name);
    if (!existsSync(path)) writeFileSync(path, bytes);
    return `/uploads/${name}`;
  }

  /** Load the saved balance into the engine. Call once at startup. */
  loadBalance(): Balance {
    const raw = this.db.getKv(BALANCE_KEY);
    let balance: Balance = EMPTY_BALANCE;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Balance;
        const problems = validateBalance(parsed);
        if (problems.length) console.warn('[admin] saved balance has problems, applying anyway:', problems.join(' '));
        balance = {
          cards: parsed.cards ?? {},
          pieces: parsed.pieces ?? {},
          ...(parsed.rules ? { rules: parsed.rules } : {}),
          ...(parsed.customCards?.length ? { customCards: parsed.customCards } : {}),
        };
      } catch (e) {
        console.error('[admin] could not parse saved balance; using shipped values', e);
      }
    }
    const restyled = restyleCowardlyCandle(balance);
    if (restyled !== balance) {
      this.db.setKv(BALANCE_KEY, JSON.stringify(restyled));
      console.log('[admin] restyled Cowardly Candle into Emberling');
      balance = restyled;
    }
    applyBalance(balance);
    const n = Object.keys(balance.cards).length + Object.keys(balance.pieces).length;
    if (n) console.log(`[admin] balance: ${n} patched card(s)/piece(s)`);
    return balance;
  }

  /**
   * Validate, persist and apply a new balance. Returns the applied balance and
   * the ids of admin-created cards that were removed (so callers can clean up
   * collections, decks and games that still mention them).
   */
  saveBalance(proposed: unknown): { balance: Balance; removedCards: string[] } {
    const problems = validateBalance(proposed);
    if (problems.length) throw new AdminError(problems.join(' '));
    const b = proposed as Balance;
    // Drop empty patches so "reset to default" really removes the entry.
    const balance: Balance = { cards: {}, pieces: {} };
    for (const [id, p] of Object.entries(b.cards ?? {})) if (p && Object.keys(p).length) balance.cards[id] = p;
    for (const [k, p] of Object.entries(b.pieces ?? {})) if (p && Object.keys(p).length) balance.pieces[k] = p;
    if (b.rules && Object.keys(b.rules).length) balance.rules = b.rules;
    if (b.customCards?.length) balance.customCards = b.customCards;
    const before = new Set((currentBalance().customCards ?? []).map((c) => c.id));
    const after = new Set((balance.customCards ?? []).map((c) => c.id));
    const removedCards = [...before].filter((id) => !after.has(id));
    this.db.setKv(BALANCE_KEY, JSON.stringify(balance));
    applyBalance(balance);
    for (const id of removedCards) this.db.removeCardEverywhere(id);
    return { balance: currentBalance(), removedCards };
  }

  /**
   * The owner: the pinned account (or anyone in ADMIN_USER_IDS). Owners can edit
   * cards *and* decide who else may.
   */
  isOwner(user: UserRow): boolean {
    if (this.extraIds.has(user.id)) return true;
    let pinned = this.db.getKv(ADMIN_ID_KEY);
    if (!pinned && this.bootstrapName) {
      const first = this.db.oldestUserNamed(this.bootstrapName);
      if (first) {
        pinned = first.id;
        this.db.setKv(ADMIN_ID_KEY, pinned);
        console.log(`[admin] pinned admin to ${first.name} (${first.id})`);
      }
    }
    return pinned === user.id;
  }

  /** Anyone allowed into the card editor: the owner plus the developers they have added. */
  isAdmin(user: UserRow): boolean {
    return this.isOwner(user) || this.developerIds().includes(user.id);
  }

  developerIds(): string[] {
    const raw = this.db.getKv(DEVELOPERS_KEY);
    if (!raw) return [];
    try {
      const ids = JSON.parse(raw) as unknown;
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Grant or revoke editor access. Owners cannot be revoked (they are not on this list). */
  setDeveloper(userId: string, grant: boolean): string[] {
    const target = this.db.userById(userId);
    if (!target) throw new AdminError('No such player.');
    if (grant && this.isOwner(target)) throw new AdminError(`${target.name} is already the owner.`);
    const ids = new Set(this.developerIds());
    if (grant) ids.add(userId);
    else ids.delete(userId);
    this.db.setKv(DEVELOPERS_KEY, JSON.stringify([...ids]));
    return [...ids];
  }
}
