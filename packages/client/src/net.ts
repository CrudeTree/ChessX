import { decode, encode, type ClientMessage, type ServerMessage } from '@chessx/protocol';

export interface Session {
  code: string;
  token: string;
}

const SESSION_KEY = 'chessx.session';

// sessionStorage is per-tab: a refresh rejoins your seat, but a second tab
// in the same browser can join as the opponent (handy for local testing).
export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else sessionStorage.removeItem(SESSION_KEY);
}

function defaultUrl(): string {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  if (env.VITE_WS_URL) return env.VITE_WS_URL;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/** WebSocket wrapper with automatic reconnect + rejoin. */
export class Net {
  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};
  private ws: WebSocket | null = null;
  private backoff = 500;
  private closedByUser = false;

  constructor(private url = defaultUrl()) {}

  connect(): void {
    this.closedByUser = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.onStatus(true);
      const session = loadSession();
      if (session) this.send({ type: 'rejoin', code: session.code, token: session.token });
    };
    ws.onmessage = (ev) => this.onMessage(decode<ServerMessage>(String(ev.data)));
    ws.onclose = () => {
      this.onStatus(false);
      if (this.closedByUser) return;
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
  }
}
