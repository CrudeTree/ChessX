import { decode, encode, type AuthProviders, type ClientMessage, type ServerMessage, type UserInfo } from '@chessx/protocol';

// ---------------------------------------------------------------------------
// HTTP: accounts

export class ApiError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...init });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status}).`);
  return body;
}

export const authApi = {
  me: () => api<{ user: UserInfo }>('/api/me').then((r) => r.user).catch(() => null),
  providers: () => api<AuthProviders>('/api/auth/providers').catch(() => ({ google: false, facebook: false })),
  register: (email: string, name: string, password: string) =>
    api<{ user: UserInfo }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, name, password }) }).then((r) => r.user),
  login: (email: string, password: string) =>
    api<{ user: UserInfo }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }).then((r) => r.user),
  logout: () => api('/api/auth/logout', { method: 'POST' }),
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
    };
    ws.onmessage = (ev) => this.onMessage(decode<ServerMessage>(String(ev.data)));
    ws.onclose = async () => {
      this.onStatus(false);
      if (this.closedByUser) return;
      if (!opened) {
        // Likely a 401: confirm before retrying so we do not hammer the server while signed out.
        const user = await authApi.me();
        if (!user) return this.onUnauthorized();
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    };
    ws.onerror = () => ws.close();
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
