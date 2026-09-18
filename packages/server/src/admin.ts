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

import { applyBalance, currentBalance, EMPTY_BALANCE, validateBalance, type Balance } from '@chessx/engine';
import type { Db, UserRow } from './db.js';

const ADMIN_ID_KEY = 'admin_user_id';
const BALANCE_KEY = 'balance';

export class AdminError extends Error {}

export class Admin {
  private readonly extraIds: Set<string>;
  private readonly bootstrapName: string;

  constructor(
    private db: Db,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.bootstrapName = (env.ADMIN_NAME ?? 'Djabooty').trim();
    this.extraIds = new Set((env.ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
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
        balance = { cards: parsed.cards ?? {}, pieces: parsed.pieces ?? {}, ...(parsed.rules ? { rules: parsed.rules } : {}) };
      } catch (e) {
        console.error('[admin] could not parse saved balance; using shipped values', e);
      }
    }
    applyBalance(balance);
    const n = Object.keys(balance.cards).length + Object.keys(balance.pieces).length;
    if (n) console.log(`[admin] balance: ${n} patched card(s)/piece(s)`);
    return balance;
  }

  /** Validate, persist and apply a new balance. Returns the applied balance. */
  saveBalance(proposed: unknown): Balance {
    const problems = validateBalance(proposed);
    if (problems.length) throw new AdminError(problems.join(' '));
    const b = proposed as Balance;
    // Drop empty patches so "reset to default" really removes the entry.
    const balance: Balance = { cards: {}, pieces: {} };
    for (const [id, p] of Object.entries(b.cards ?? {})) if (p && Object.keys(p).length) balance.cards[id] = p;
    for (const [k, p] of Object.entries(b.pieces ?? {})) if (p && Object.keys(p).length) balance.pieces[k] = p;
    if (b.rules && Object.keys(b.rules).length) balance.rules = b.rules;
    this.db.setKv(BALANCE_KEY, JSON.stringify(balance));
    applyBalance(balance);
    return currentBalance();
  }

  isAdmin(user: UserRow): boolean {
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
}
