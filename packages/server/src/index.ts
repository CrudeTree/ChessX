// ChessX game server: one process, one SQLite file.
//  - /api/*      accounts (email/password, Google, Facebook) — HTTP
//  - /ws         game traffic, authenticated by the session cookie — WebSocket
//  - everything else: the built client (production)

import { PROTOCOL_VERSION, decode, encode, type ClientMessage, type ServerMessage } from '@chessx/protocol';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { Auth, AuthError, configFromEnv, toUserInfo } from './auth.js';
import { Db } from './db.js';
import { GameError, GameManager, type LiveGame, type Transport } from './games.js';

const PORT = Number(process.env.PORT ?? 8080);
const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(here, '..', 'data', 'chessx.sqlite');

const db = new Db(DB_PATH);
const auth = new Auth(db, configFromEnv(process.env));
const games = new GameManager(db, (id) => db.userById(id)?.name ?? 'Player');
setInterval(() => db.purgeExpiredSessions(), 60 * 60_000).unref();

/** Open sockets per user, so home pages can be refreshed when one of their games changes. */
const socketsByUser = new Map<string, Set<SocketTransport>>();
games.onChanged = (game) => {
  for (const uid of game.participants()) {
    for (const t of socketsByUser.get(uid) ?? []) {
      // Tabs sitting on the home page (not attached to a game) get a fresh list.
      if (!t.game) t.send({ type: 'games', games: games.summariesFor(uid) });
    }
  }
};

// ---------------------------------------------------------------------------
// HTTP helpers

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 16_384) reject(new AuthError('Request too large.'));
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        reject(new AuthError('Malformed JSON.'));
      }
    });
  });
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ---------------------------------------------------------------------------
// Static files (production: the built client)

const clientDist = join(here, '..', '..', 'client', 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!existsSync(clientDist)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ChessX server running. Build the client (npm run build) to serve it from here.');
    return;
  }
  let path = normalize(join(clientDist, decodeURIComponent(url.pathname)));
  if (!path.startsWith(clientDist)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(clientDist, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  res.end(readFileSync(path));
}

// ---------------------------------------------------------------------------
// HTTP routing

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  if (!path.startsWith('/api/')) return serveStatic(req, res, url);

  try {
    if (req.method === 'GET' && path === '/api/me') {
      const user = auth.userFromRequest(req);
      return user ? json(res, 200, { user: toUserInfo(user) }) : json(res, 401, { error: 'Not signed in.' });
    }
    if (req.method === 'GET' && path === '/api/auth/providers') return json(res, 200, auth.providers());

    if (req.method === 'POST' && path === '/api/auth/register') {
      const b = await readJson(req);
      const user = auth.register(str(b.email), str(b.name), str(b.password));
      auth.signIn(res, user);
      return json(res, 200, { user: toUserInfo(user) });
    }
    if (req.method === 'POST' && path === '/api/auth/login') {
      const b = await readJson(req);
      const user = auth.login(str(b.email), str(b.password));
      auth.signIn(res, user);
      return json(res, 200, { user: toUserInfo(user) });
    }
    if (req.method === 'POST' && path === '/api/auth/logout') {
      auth.signOut(req, res);
      return json(res, 200, { ok: true });
    }

    for (const provider of ['google', 'facebook'] as const) {
      if (req.method === 'GET' && path === `/api/auth/${provider}`) return auth.beginOAuth(provider, res);
      if (req.method === 'GET' && path === `/api/auth/${provider}/callback`) {
        try {
          await auth.completeOAuth(provider, req, res, url);
        } catch (e) {
          const message = e instanceof AuthError ? e.message : 'Sign-in failed.';
          res.writeHead(302, { Location: `/?authError=${encodeURIComponent(message)}` });
          res.end();
        }
        return;
      }
    }

    json(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e instanceof AuthError) return json(res, 400, { error: e.message });
    console.error(e);
    json(res, 500, { error: 'Server error.' });
  }
}

// ---------------------------------------------------------------------------
// WebSocket

class SocketTransport implements Transport {
  game: LiveGame | null = null;
  constructor(
    private ws: WebSocket,
    readonly userId: string,
  ) {}
  send(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }
  error(message: string): void {
    this.send({ type: 'error', message });
  }
}

function detach(t: SocketTransport): void {
  t.game?.detach(t);
  t.game = null;
}

function open(t: SocketTransport, game: LiveGame): void {
  detach(t);
  t.game = game;
  game.attach(t);
}

function handleMessage(t: SocketTransport, msg: ClientMessage): void {
  switch (msg.type) {
    case 'listGames':
      t.send({ type: 'games', games: games.summariesFor(t.userId) });
      return;
    case 'createGame':
    case 'createSolo': {
      const game = games.create(t.userId, msg.type === 'createSolo');
      open(t, game);
      console.log(`[game ${game.row.code}] ${msg.type === 'createSolo' ? 'practice' : 'created'} by ${t.userId}`);
      return;
    }
    case 'joinGame': {
      const game = games.byCode(msg.code);
      if (!game) return t.error('No game with that code.');
      if (game.isParticipant(t.userId)) {
        open(t, game); // re-opening your own game by code is fine
        return;
      }
      game.join(t.userId, msg.deck);
      open(t, game);
      console.log(`[game ${game.row.code}] ${t.userId} joined`);
      return;
    }
    case 'openGame': {
      const game = games.get(msg.gameId);
      if (!game || !game.isParticipant(t.userId)) return t.error('That game is not yours.');
      open(t, game);
      return;
    }
    case 'action':
      if (!t.game) return t.error('You are not in a game.');
      t.game.act(t, msg.action);
      return;
    case 'chat':
      if (!t.game) return t.error('You are not in a game.');
      if (typeof msg.text === 'string') t.game.chatMessage(t, msg.text);
      return;
    case 'leave':
      detach(t);
      t.send({ type: 'left' });
      return;
  }
}

const httpServer = createServer((req, res) => void handleHttp(req, res));
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const user = auth.userFromRequest(req);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const t = new SocketTransport(ws, user.id);
    let set = socketsByUser.get(user.id);
    if (!set) socketsByUser.set(user.id, (set = new Set()));
    set.add(t);
    t.send({ type: 'welcome', version: PROTOCOL_VERSION, user: toUserInfo(user) });

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = decode<ClientMessage>(raw.toString());
      } catch {
        return t.error('Malformed message.');
      }
      try {
        handleMessage(t, msg);
      } catch (e) {
        if (e instanceof GameError) return t.error(e.message);
        console.error(e);
        t.error('Server error.');
      }
    });
    ws.on('close', () => {
      detach(t);
      set!.delete(t);
      if (set!.size === 0) socketsByUser.delete(user.id);
    });
  });
});

httpServer.listen(PORT, () => {
  const p = auth.providers();
  console.log(`ChessX server listening on http://localhost:${PORT} (ws path /ws)`);
  console.log(`  database: ${DB_PATH}`);
  console.log(`  sign-in: email/password${p.google ? ', Google' : ''}${p.facebook ? ', Facebook' : ''}`);
  if (!p.google) console.log('  (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to enable Google sign-in)');
  if (!p.facebook) console.log('  (set FACEBOOK_APP_ID + FACEBOOK_APP_SECRET to enable Facebook sign-in)');
});
