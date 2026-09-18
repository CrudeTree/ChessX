// ChessX game server: one process, one SQLite file.
//  - /api/*      accounts (email/password, Google, Facebook) — HTTP
//  - /ws         game traffic, authenticated by the session cookie — WebSocket
//  - everything else: the built client (production)

import { currentBalance } from '@chessx/engine';
import { PROTOCOL_VERSION, decode, encode, type ClientMessage, type ServerMessage } from '@chessx/protocol';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { Admin, AdminError } from './admin.js';
import { Auth, AuthError, configFromEnv, setAdminCheck, toUserInfo } from './auth.js';
import { Db } from './db.js';
import { GameError, GameManager, type LiveGame, type Transport } from './games.js';
import { Notifier } from './notify.js';
import { Progression, ProgressionError } from './progression.js';
import { SocialError, SocialService } from './social.js';

const PORT = Number(process.env.PORT ?? 8080);
const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(here, '..', 'data', 'chessx.sqlite');

const db = new Db(DB_PATH);
const admin = new Admin(db, dirname(DB_PATH));
setAdminCheck((u) => admin.isAdmin(u));
admin.loadBalance(); // before any game is loaded or created
const auth = new Auth(db, configFromEnv(process.env));
const games = new GameManager(db, (id) => db.userById(id)?.name ?? 'Player');
const progression = new Progression(db);
setInterval(() => db.purgeExpiredSessions(), 60 * 60_000).unref();

/** Open sockets per user, so home pages can be refreshed when one of their games changes. */
const socketsByUser = new Map<string, Set<SocketTransport>>();
const social = new SocialService(db);
social.isOnline = (uid) => (socketsByUser.get(uid)?.size ?? 0) > 0;
const notifier = new Notifier(db, `mailto:admin@${new URL(auth.config.publicUrl).hostname}`);
notifier.isOnline = social.isOnline;
const nameOf = (uid: string) => db.userById(uid)?.name ?? 'Your opponent';

/** Push a fresh Friends panel to every tab a user has open. */
function pushSocial(...userIds: string[]): void {
  for (const uid of new Set(userIds)) {
    const user = db.userById(uid);
    if (!user) continue;
    const payload = social.social(user);
    for (const t of socketsByUser.get(uid) ?? []) t.send({ type: 'social', social: payload });
  }
}

/** Presence changed: friends see the online dot flip. */
function pushPresenceToFriends(userId: string): void {
  const user = db.userById(userId);
  if (!user) return;
  pushSocial(...social.social(user).friends.map((f) => f.id));
}

function notify(userId: string, message: string): void {
  for (const t of socketsByUser.get(userId) ?? []) t.send({ type: 'notice', message });
}

games.onChanged = (game) => {
  for (const uid of game.participants()) {
    for (const t of socketsByUser.get(uid) ?? []) {
      // Tabs sitting on the home page (not attached to a game) get a fresh list.
      if (!t.game) t.send({ type: 'games', games: games.summariesFor(uid) });
    }
  }
};

// A two-player game reached a result: XP for both, cards where earned, and tell them.
games.onFinished = (game) => {
  const status = game.state?.status;
  if (!status || status.kind === 'playing') return;
  const winner = 'winner' in status ? status.winner : null;
  const checkmate = status.kind === 'checkmate' || status.kind === 'kingCaptured';
  for (const uid of game.participants()) {
    const won = winner !== null && game.seatOf(uid) === winner;
    const report = progression.award(uid, game.id, won, checkmate);
    for (const t of socketsByUser.get(uid) ?? []) t.send({ type: 'rewards', report });
    const opp = game.participants().find((x) => x !== uid);
    const how = status.kind === 'timeout' ? 'on time' : status.kind === 'resigned' ? 'by resignation' : 'by checkmate';
    void notifier.push(uid, {
      title: won ? 'You won!' : 'Game over',
      body: `${won ? 'You beat' : 'You lost to'} ${opp ? nameOf(opp) : 'your opponent'} ${how}.${report.cards.length ? ' A new card is waiting for you.' : ''}`,
      url: `/?game=${game.id}`,
      tag: `game-${game.id}`,
    });
  }
};

// Push notifications for players who are not on the site right now.
games.onYourTurn = (game, uid) => {
  const opp = game.participants().find((x) => x !== uid);
  void notifier.push(uid, {
    title: 'Your move',
    body: `${opp ? nameOf(opp) : 'Your opponent'} has played. It's your turn in ChessX.`,
    url: `/?game=${game.id}`,
    tag: `game-${game.id}`,
  });
};
games.onChat = (game, from, to, text) => {
  void notifier.push(to, { title: `${nameOf(from)} says`, body: text, url: `/?game=${game.id}`, tag: `chat-${game.id}` });
};

// ---------------------------------------------------------------------------
// HTTP helpers

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 16_384): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > limit) reject(new AuthError('Request too large.'));
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
  '.webmanifest': 'application/manifest+json',
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

/** Admin-uploaded card art. Content-hashed names, so cache forever. */
function serveUpload(res: ServerResponse, pathname: string): void {
  const name = pathname.slice('/uploads/'.length);
  if (!/^[a-f0-9]{20}\.png$/.test(name)) {
    res.writeHead(404).end();
    return;
  }
  const file = join(admin.uploadsDir, name);
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' });
  res.end(readFileSync(file));
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  if (path.startsWith('/uploads/')) return serveUpload(res, path);
  if (!path.startsWith('/api/')) return serveStatic(req, res, url);

  try {
    if (req.method === 'GET' && path === '/api/me') {
      const user = auth.userFromRequest(req);
      return user ? json(res, 200, { user: toUserInfo(user) }) : json(res, 401, { error: 'Not signed in.' });
    }
    if (req.method === 'GET' && path === '/api/auth/providers') return json(res, 200, auth.providers());

    // ---- balance (card/piece numbers). Reading is public: every client needs it to render cards.
    if (req.method === 'GET' && path === '/api/balance') return json(res, 200, { balance: currentBalance() });
    if ((path === '/api/balance' && req.method === 'PUT') || (path === '/api/admin/upload' && req.method === 'POST')) {
      const user = auth.userFromRequest(req);
      if (!user) return json(res, 401, { error: 'Not signed in.' });
      if (!admin.isAdmin(user)) return json(res, 403, { error: 'Only the game admin can edit cards.' });
      // Images arrive base64-encoded; the balance itself grows with custom cards.
      const b = await readJson(req, path === '/api/admin/upload' ? 4 * 1024 * 1024 + 1024 : 1024 * 1024);
      if (path === '/api/admin/upload') {
        const url = admin.saveImage(b.image);
        return json(res, 200, { url });
      }
      const { balance, removedCards } = admin.saveBalance(b.balance);
      console.log(
        `[admin] ${user.name} saved balance (${Object.keys(balance.cards).length} cards, ${Object.keys(balance.pieces).length} pieces patched, ${balance.customCards?.length ?? 0} custom cards${removedCards.length ? `, removed ${removedCards.join(', ')}` : ''})`,
      );
      // Everyone online picks up the new numbers immediately (definitions first, then the
      // games themselves: pieces on the board, legal moves, playable cards).
      for (const set of socketsByUser.values()) for (const t of set) t.send({ type: 'balance', balance });
      games.rebalanceAll();
      return json(res, 200, { balance });
    }

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

    // ---- progression (signed-in only)
    if (path === '/api/profile' || path.startsWith('/api/decks/') || path === '/api/collection/seen') {
      const user = auth.userFromRequest(req);
      if (!user) return json(res, 401, { error: 'Not signed in.' });
      if (req.method === 'GET' && path === '/api/profile') return json(res, 200, progression.profile(user));
      if (req.method === 'PUT' && path.startsWith('/api/decks/')) {
        const slot = Number(path.slice('/api/decks/'.length));
        const b = await readJson(req);
        const deck = progression.saveDeck(user.id, slot, str(b.name), Array.isArray(b.cards) ? (b.cards as string[]) : []);
        return json(res, 200, { deck });
      }
      if (req.method === 'POST' && path === '/api/collection/seen') {
        progression.markSeen(user.id);
        return json(res, 200, { ok: true });
      }
    }
    if (req.method === 'GET' && path === '/api/users/search') {
      const user = auth.userFromRequest(req);
      if (!user) return json(res, 401, { error: 'Not signed in.' });
      return json(res, 200, { results: social.search(user, url.searchParams.get('q') ?? '') });
    }

    // ---- web push
    if (req.method === 'GET' && path === '/api/push/vapid') return json(res, 200, { publicKey: notifier.publicKey });
    if (path === '/api/push/subscribe' || path === '/api/push/unsubscribe') {
      const user = auth.userFromRequest(req);
      if (!user) return json(res, 401, { error: 'Not signed in.' });
      const b = await readJson(req);
      if (path === '/api/push/subscribe') notifier.subscribe(user.id, b.subscription as never);
      else notifier.unsubscribe(str(b.endpoint));
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
    if (e instanceof AuthError || e instanceof ProgressionError || e instanceof AdminError) return json(res, 400, { error: e.message });
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
  close(code: number, reason: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(code, reason);
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
      const deck = progression.deckForPlay(t.userId, msg.deckSlot);
      const game = games.create(t.userId, msg.type === 'createSolo', deck);
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
      const deck = progression.deckForPlay(t.userId, msg.deckSlot);
      game.join(t.userId, deck);
      open(t, game);
      console.log(`[game ${game.row.code}] ${t.userId} joined`);
      return;
    }
    case 'openGame': {
      const game = games.get(msg.gameId);
      if (!game) return t.error('That game is no longer available.');
      if (!game.isParticipant(t.userId)) return t.error('That game is not yours.');
      open(t, game);
      return;
    }
    case 'cancelGame': {
      const game = games.get(msg.gameId);
      if (!game) return t.error('That game is no longer available.');
      if (!game.isParticipant(t.userId)) return t.error('That game is not yours.');
      if (game.state) return t.error('The game has already started — use Resign instead.');
      const c = db.pendingChallengeForGame(game.id);
      games.discardUnstarted(game.id);
      if (c) {
        social.resolveChallenge(c.id, 'declined');
        pushSocial(c.from_user, c.to_user);
        notify(c.to_user, `${nameOf(t.userId)} withdrew their challenge.`);
      }
      notify(t.userId, 'Invite cancelled.');
      console.log(`[game ${game.row.code}] cancelled by ${t.userId}`);
      return;
    }
    case 'action':
      if (!t.game) return t.error('You are not in a game.');
      t.game.act(t, msg.action);
      return;

    // ---- friends
    case 'getSocial':
      pushSocial(t.userId);
      return;
    case 'friendRequest': {
      const me = db.userById(t.userId)!;
      const other = social.request(me, msg.userId);
      pushSocial(me.id, other.id);
      const nowFriends = social.areFriends(me.id, other.id);
      notify(other.id, nowFriends ? `You and ${me.name} are now friends.` : `${me.name} wants to be your friend.`);
      void notifier.push(other.id, {
        title: nowFriends ? 'New friend' : 'Friend request',
        body: nowFriends ? `You and ${me.name} are now friends.` : `${me.name} wants to be your friend on ChessX.`,
        url: '/',
        tag: `friend-${me.id}`,
      });
      return;
    }
    case 'friendAccept': {
      const me = db.userById(t.userId)!;
      const other = social.accept(me, msg.userId);
      pushSocial(me.id, other.id);
      notify(other.id, `${me.name} accepted your friend request.`);
      void notifier.push(other.id, { title: 'Friend request accepted', body: `${me.name} accepted your friend request.`, url: '/', tag: `friend-${me.id}` });
      return;
    }
    case 'friendRemove': {
      const other = social.remove(db.userById(t.userId)!, msg.userId);
      pushSocial(t.userId, other.id);
      return;
    }

    // ---- challenges
    case 'challenge': {
      const me = db.userById(t.userId)!;
      const friend = db.userById(msg.friendId);
      if (!friend || !social.areFriends(me.id, friend.id)) return t.error('You can only challenge friends.');
      const deck = progression.deckForPlay(me.id, msg.deckSlot);
      const game = games.create(me.id, false, deck);
      social.createChallenge(me.id, friend.id, game.id);
      open(t, game);
      pushSocial(me.id, friend.id);
      notify(friend.id, `${me.name} challenged you to a game!`);
      // Challenges are worth a push even if they are on the site (they may be in another game).
      void notifier.push(friend.id, { title: `${me.name} challenged you!`, body: 'Open ChessX to accept and pick your deck.', url: '/', tag: `challenge-${game.id}` }, { evenIfOnline: true });
      console.log(`[game ${game.row.code}] ${me.name} challenged ${friend.name}`);
      return;
    }
    case 'acceptChallenge': {
      const c = social.pendingChallenge(msg.challengeId);
      if (c.to_user !== t.userId) return t.error('That challenge is not for you.');
      const game = games.get(c.game_id);
      if (!game || game.state) {
        social.resolveChallenge(c.id, 'declined');
        pushSocial(t.userId, c.from_user);
        return t.error('That game is no longer available.');
      }
      const deck = progression.deckForPlay(t.userId, msg.deckSlot);
      game.join(t.userId, deck);
      social.resolveChallenge(c.id, 'accepted');
      open(t, game);
      pushSocial(t.userId, c.from_user);
      notify(c.from_user, `${nameOf(t.userId)} accepted your challenge — game on!`);
      void notifier.push(c.from_user, { title: 'Challenge accepted!', body: `${nameOf(t.userId)} accepted. It's your move.`, url: `/?game=${game.id}`, tag: `game-${game.id}` });
      return;
    }
    case 'declineChallenge': {
      const c = social.pendingChallenge(msg.challengeId);
      if (c.to_user !== t.userId && c.from_user !== t.userId) return t.error('Not your challenge.');
      social.resolveChallenge(c.id, 'declined');
      games.discardUnstarted(c.game_id);
      pushSocial(c.from_user, c.to_user);
      const me = db.userById(t.userId)?.name ?? 'Your friend';
      if (t.userId === c.to_user) notify(c.from_user, `${me} declined your challenge.`);
      else notify(c.to_user, `${me} withdrew their challenge.`);
      return;
    }
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
    const cameOnline = set.size === 0;
    set.add(t);
    t.send({ type: 'welcome', version: PROTOCOL_VERSION, user: toUserInfo(user), balance: currentBalance() });
    if (cameOnline) pushPresenceToFriends(user.id);

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
        if (e instanceof GameError || e instanceof ProgressionError || e instanceof SocialError) return t.error(e.message);
        console.error(e);
        t.error('Server error.');
      }
    });
    ws.on('close', () => {
      detach(t);
      set!.delete(t);
      if (set!.size === 0) {
        socketsByUser.delete(user.id);
        pushPresenceToFriends(user.id);
      }
    });
  });
});

// Graceful stop (docker sends SIGTERM on deploy): warn practice players, then close sockets
// so clients reconnect promptly to the new process instead of waiting on a dead one.
let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  games.shutdown();
  for (const set of socketsByUser.values()) for (const t of set) t.close(1012, 'Server restarting');
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

httpServer.listen(PORT, () => {
  const p = auth.providers();
  console.log(`ChessX server listening on http://localhost:${PORT} (ws path /ws)`);
  console.log(`  database: ${DB_PATH}`);
  console.log(`  sign-in: email/password${p.google ? ', Google' : ''}${p.facebook ? ', Facebook' : ''}`);
  if (!p.google) console.log('  (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to enable Google sign-in)');
  if (!p.facebook) console.log('  (set FACEBOOK_APP_ID + FACEBOOK_APP_SECRET to enable Facebook sign-in)');
});
