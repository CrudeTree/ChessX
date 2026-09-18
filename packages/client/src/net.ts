import type { Balance } from '@chessx/engine';
import {
  decode,
  encode,
  type AuthProviders,
  type ClientMessage,
  type DeckInfo,
  type DeveloperInfo,
  type PlayerInfo,
  type Profile,
  type ServerMessage,
  type SiteStats,
  type UserInfo,
} from '@chessx/protocol';

// ---------------------------------------------------------------------------
// HTTP: accounts

export class ApiError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...init });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status}).`);
  return body;
}

/** Three-way answer for "am I signed in?": the user, `null` for a definite no, `'unknown'` if the server was unreachable. */
async function whoAmI(): Promise<UserInfo | null | 'unknown'> {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) return 'unknown'; // 502/503 while the server restarts
    const body = (await res.json()) as { user: UserInfo };
    return body.user;
  } catch {
    return 'unknown'; // network down
  }
}

export const authApi = {
  me: () => whoAmI().then((u) => (u === 'unknown' ? null : u)),
  whoAmI,
  providers: () => api<AuthProviders>('/api/auth/providers').catch(() => ({ google: false, facebook: false })),
  register: (email: string, name: string, password: string) =>
    api<{ user: UserInfo }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name, password }) }).then((r) => r.user),
  login: (email: string, password: string) =>
    api<{ user: UserInfo }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }).then((r) => r.user),
  logout: () => api('/api/auth/logout', { method: 'POST' }),
};

export const balanceApi = {
  get: () => api<{ balance: Balance }>('/api/balance').then((r) => r.balance),
  save: (balance: Balance) => api<{ balance: Balance }>('/api/balance', { method: 'PUT', body: JSON.stringify({ balance }) }).then((r) => r.balance),
  /** Upload a PNG data: URL; returns its public path. */
  upload: (image: string) => api<{ url: string }>('/api/admin/upload', { method: 'POST', body: JSON.stringify({ image }) }).then((r) => r.url),
  /** Owner only: every account plus site totals. */
  players: () => api<{ stats: SiteStats; players: PlayerInfo[] }>('/api/admin/players'),
  /** Owner only: who else may use the editor. */
  developers: () => api<{ developers: DeveloperInfo[] }>('/api/admin/developers').then((r) => r.developers),
  setDeveloper: (userId: string, grant: boolean) =>
    api<{ developers: DeveloperInfo[] }>('/api/admin/developers', { method: 'POST', body: JSON.stringify({ userId, grant }) }).then((r) => r.developers),
};

export const profileApi = {
  get: () => api<Profile>('/api/profile'),
  saveDeck: (slot: number, name: string, cards: string[]) =>
    api<{ deck: DeckInfo }>(`/api/decks/${slot}`, { method: 'PUT', body: JSON.stringify({ name, cards }) }).then((r) => r.deck),
  markSeen: () => api('/api/collection/seen', { method: 'POST' }),
};

// ---------------------------------------------------------------------------
// Per-tab memory of which game is open, so a refresh lands back in it.

const GAME_KEY = 'chessx.openGame';
export const rememberOpenGame = (id: string | null): void => {
  if (id) sessionStorage.setItem(GAME_KEY, id);
  else sessionStorage.removeItem(GAME_KEY);
};
export const openGameId = (): string | null => sessionStorage.getItem(GAME_KEY);

// ---------------------------------------------------------------------------
// WebSocket: game traffic. Authenticated by the session cookie.

function defaultUrl(): string {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  if (env.VITE_WS_URL) return env.VITE_WS_URL;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export class Net {
  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};
  /** Called when the server refuses the socket (no valid session). */
  onUnauthorized: () => void = () => {};
  private ws: WebSocket | null = null;
  private backoff = 500;
  private closedByUser = false;
  private everOpened = false;
  /** Messages sent while reconnecting (e.g. during a server restart); flushed once the socket is back. */
  private pending: ClientMessage[] = [];

  constructor(private url = defaultUrl()) {}

  connect(): void {
    this.closedByUser = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.everOpened = true;
      this.backoff = 500;
      this.onStatus(true);
      // The server sends `welcome` first; our queued requests follow it (see main.ts onMessage).
    };
    ws.onmessage = (ev) => this.onMessage(decode<ServerMessage>(String(ev.data)));
    ws.onclose = async () => {
      this.onStatus(false);
      if (this.closedByUser) return;
      if (!opened) {
        // Could be a 401 (signed out) or the server being down/restarting. Only a definite
        // "not signed in" answer sends the player to the sign-in screen; otherwise keep retrying.
        const who = await authApi.whoAmI();
        if (who === null) return this.onUnauthorized();
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
    ws.onerror = () => ws.close();
  }

  /** Send now, or queue until the socket is back (bounded so a long outage cannot pile up junk). */
  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encode(msg));
      return;
    }
    if (this.closedByUser) return;
    // Only intent-carrying requests are worth replaying; list refreshes happen on `welcome` anyway.
    if (msg.type === 'listGames' || msg.type === 'getSocial' || msg.type === 'openGame' || msg.type === 'leave') return;
    if (this.pending.length < 8) this.pending.push(msg);
  }

  /** Replay requests made while disconnected. Called after the server's `welcome`. */
  flushPending(): void {
    const queue = this.pending;
    this.pending = [];
    for (const msg of queue) this.send(msg);
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  close(): void {
    this.closedByUser = true;
    this.pending = [];
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
