// ChessX game server: one process hosts many rooms. Each room is identified by a
// short invite code. The server owns the authoritative GameState and only ever
// sends each player the parts of the state they are allowed to see.

import { PROTOCOL_VERSION, decode, encode, type ClientMessage, type ServerMessage } from '@chessx/protocol';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { Room, randomCode, type Transport } from './room.js';

const PORT = Number(process.env.PORT ?? 8080);
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

const rooms = new Map<string, Room>();

// ---------------------------------------------------------------------------
// Static file serving (production: serve the built client from the same port)

const here = dirname(fileURLToPath(import.meta.url));
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

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(clientDist)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ChessX server running. Build the client (npm run build) to serve it from here.');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
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
// WebSocket handling

class SocketTransport implements Transport {
  room: Room | null = null;
  constructor(private ws: WebSocket) {}
  send(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }
  error(message: string): void {
    this.send({ type: 'error', message });
  }
}

function handleMessage(t: SocketTransport, msg: ClientMessage): void {
  switch (msg.type) {
    case 'createRoom': {
      leaveCurrent(t);
      let code = randomCode();
      while (rooms.has(code)) code = randomCode();
      const room = new Room(code);
      rooms.set(code, room);
      const { color, token } = room.seat(msg.name, msg.deck, t);
      t.room = room;
      t.send({ type: 'seated', code, color, token, room: room.info() });
      console.log(`[room ${code}] created by ${msg.name}`);
      return;
    }
    case 'createSolo': {
      leaveCurrent(t);
      let code = randomCode();
      while (rooms.has(code)) code = randomCode();
      const room = new Room(code, true);
      rooms.set(code, room);
      const { color, token } = room.seatSolo(msg.name, msg.deck, t);
      t.room = room;
      t.send({ type: 'seated', code, color, token, room: room.info(), solo: true });
      console.log(`[room ${code}] practice room created by ${msg.name}`);
      return;
    }
    case 'joinRoom': {
      leaveCurrent(t);
      const room = rooms.get(msg.code.trim().toUpperCase());
      if (!room) return t.error('No game with that code.');
      if (room.isFull) return t.error('That game is already full.');
      const { color, token } = room.seat(msg.name, msg.deck, t);
      t.room = room;
      t.send({ type: 'seated', code: room.code, color, token, room: room.info() });
      console.log(`[room ${room.code}] ${msg.name} joined as ${color}`);
      return;
    }
    case 'rejoin': {
      leaveCurrent(t);
      const room = rooms.get(msg.code.trim().toUpperCase());
      if (!room) return t.error('That game no longer exists.');
      const color = room.rejoin(msg.token, t);
      t.room = room;
      t.send({ type: 'seated', code: room.code, color, token: msg.token, room: room.info(), solo: room.solo || undefined });
      return;
    }
    case 'action': {
      if (!t.room) return t.error('You are not in a game.');
      t.room.act(t, msg.action);
      return;
    }
    case 'leave': {
      leaveCurrent(t);
      t.send({ type: 'left' });
      return;
    }
  }
}

function leaveCurrent(t: SocketTransport): void {
  if (!t.room) return;
  t.room.disconnect(t);
  t.room = null;
}

const httpServer = createServer(serveStatic);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  const t = new SocketTransport(ws);
  t.send({ type: 'welcome', version: PROTOCOL_VERSION });

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
      t.error(e instanceof Error ? e.message : 'Unknown error.');
    }
  });

  ws.on('close', () => leaveCurrent(t));
});

// Garbage-collect abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.isEmpty && now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
      console.log(`[room ${code}] expired`);
    }
  }
}, 60_000).unref();

httpServer.listen(PORT, () => {
  console.log(`ChessX server listening on http://localhost:${PORT} (ws path /ws)`);
});
