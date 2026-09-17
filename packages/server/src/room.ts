import {
  applyAction,
  createGame,
  IllegalActionError,
  starterDeck,
  validateDeck,
  viewFor,
  type Action,
  type Color,
  type GameState,
} from '@chessx/engine';
import type { RoomInfo, ServerMessage } from '@chessx/protocol';
import { randomBytes } from 'node:crypto';

export interface Transport {
  send(msg: ServerMessage): void;
}

interface Seat {
  name: string;
  token: string;
  deck: string[];
  transport: Transport | null;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(len = 5): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

export class Room {
  readonly code: string;
  private seats: Record<Color, Seat | null> = { white: null, black: null };
  private state: GameState | null = null;
  /** Practice room: a single connection plays both colours. */
  readonly solo: boolean;
  /** Timestamp of the last activity, used to garbage-collect dead rooms. */
  lastActivity = Date.now();

  constructor(code: string, solo = false) {
    this.code = code;
    this.solo = solo;
  }

  get isFull(): boolean {
    return !!this.seats.white && !!this.seats.black;
  }

  get isEmpty(): boolean {
    return !this.seats.white?.transport && !this.seats.black?.transport;
  }

  info(): RoomInfo {
    const side = (c: Color) => {
      const s = this.seats[c];
      return s ? { name: s.name, connected: !!s.transport } : null;
    };
    return { code: this.code, players: { white: side('white'), black: side('black') } };
  }

  /** Take an open seat. The first player to sit gets a random colour. */
  seat(name: string, deck: string[] | undefined, transport: Transport): { color: Color; token: string } {
    this.touch();
    const chosenDeck = deck && deck.length ? deck : starterDeck();
    const problems = validateDeck(chosenDeck);
    if (problems.length) throw new Error(problems.join(' '));

    let color: Color;
    if (!this.seats.white && !this.seats.black) color = Math.random() < 0.5 ? 'white' : 'black';
    else if (!this.seats.white) color = 'white';
    else if (!this.seats.black) color = 'black';
    else throw new Error('Room is full.');

    const token = randomBytes(16).toString('hex');
    this.seats[color] = { name: name.slice(0, 24) || color, token, deck: chosenDeck, transport };

    if (this.isFull && !this.state) {
      this.state = createGame({
        decks: { white: this.seats.white!.deck, black: this.seats.black!.deck },
      });
    }
    this.broadcastRoom();
    this.broadcastState();
    return { color, token };
  }

  /** Practice mode: one connection takes both seats and the game starts immediately. */
  seatSolo(name: string, deck: string[] | undefined, transport: Transport): { color: Color; token: string } {
    this.touch();
    const chosenDeck = deck && deck.length ? deck : starterDeck();
    const problems = validateDeck(chosenDeck);
    if (problems.length) throw new Error(problems.join(' '));
    const token = randomBytes(16).toString('hex');
    const label = name.slice(0, 24) || 'Player';
    this.seats.white = { name: label, token, deck: chosenDeck, transport };
    this.seats.black = { name: label, token, deck: chosenDeck.slice(), transport };
    this.state = createGame({ decks: { white: chosenDeck, black: chosenDeck } });
    this.broadcastRoom();
    this.broadcastState();
    return { color: 'white', token };
  }

  rejoin(token: string, transport: Transport): Color {
    this.touch();
    let found: Color | null = null;
    for (const color of ['white', 'black'] as Color[]) {
      const s = this.seats[color];
      if (s && s.token === token) {
        s.transport = transport;
        found ??= color;
      }
    }
    if (!found) throw new Error('Invalid rejoin token.');
    this.broadcastRoom();
    this.broadcastState();
    return found;
  }

  disconnect(transport: Transport): void {
    for (const color of ['white', 'black'] as Color[]) {
      const s = this.seats[color];
      if (s && s.transport === transport) {
        s.transport = null;
        // Before the game starts, a leaving player frees the seat entirely.
        if (!this.state) this.seats[color] = null;
      }
    }
    this.broadcastRoom();
  }

  /** Apply an action for the seat owning `transport`. Throws on illegal actions. */
  act(transport: Transport, action: Action): void {
    this.touch();
    if (!this.state) throw new Error('Waiting for an opponent.');
    const color = this.solo && this.colorOf(transport) ? this.state.turn : this.colorOf(transport);
    if (!color) throw new Error('You are not seated in this room.');
    if (this.state.turn !== color && action.type !== 'resign') throw new Error('It is not your turn.');
    if (action.type === 'resign' && this.state.turn !== color) {
      // Allow resigning off-turn by temporarily flipping the perspective.
      this.state = { ...this.state, status: { kind: 'resigned', winner: color === 'white' ? 'black' : 'white' } };
      this.state.events = [{ type: 'gameOver', status: this.state.status }];
    } else {
      try {
        this.state = applyAction(this.state, action);
      } catch (e) {
        if (e instanceof IllegalActionError) throw new Error(e.message);
        throw e;
      }
    }
    this.broadcastState();
  }

  private colorOf(transport: Transport): Color | null {
    if (this.seats.white?.transport === transport) return 'white';
    if (this.seats.black?.transport === transport) return 'black';
    return null;
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private broadcastRoom(): void {
    const msg: ServerMessage = { type: 'room', room: this.info() };
    for (const t of this.transports()) t.send(msg);
  }

  private broadcastState(): void {
    if (!this.state) return;
    if (this.solo) {
      // One connection, one view: always from the perspective of the side to move.
      for (const t of this.transports()) t.send({ type: 'state', view: viewFor(this.state, this.state.turn) });
      return;
    }
    for (const color of ['white', 'black'] as Color[]) {
      this.seats[color]?.transport?.send({ type: 'state', view: viewFor(this.state, color) });
    }
  }

  private transports(): Set<Transport> {
    const set = new Set<Transport>();
    if (this.seats.white?.transport) set.add(this.seats.white.transport);
    if (this.seats.black?.transport) set.add(this.seats.black.transport);
    return set;
  }
}
