import type { Action, Color, PlayerView } from '@chessx/engine';

export const PROTOCOL_VERSION = 1;

export interface RoomInfo {
  code: string;
  players: Record<Color, { name: string; connected: boolean } | null>;
}

/** Messages the browser sends to the server. */
export type ClientMessage =
  | { type: 'createRoom'; name: string; deck?: string[] }
  /** Practice room: one connection controls both sides. */
  | { type: 'createSolo'; name: string; deck?: string[] }
  | { type: 'joinRoom'; code: string; name: string; deck?: string[] }
  /** Rejoin an existing seat after a refresh/disconnect. */
  | { type: 'rejoin'; code: string; token: string }
  | { type: 'action'; action: Action }
  | { type: 'leave' };

/** Messages the server sends to the browser. */
export type ServerMessage =
  | { type: 'welcome'; version: number }
  /** You now occupy a seat. Keep `token` to rejoin. */
  | { type: 'seated'; code: string; color: Color; token: string; room: RoomInfo; solo?: boolean }
  | { type: 'room'; room: RoomInfo }
  | { type: 'state'; view: PlayerView }
  | { type: 'error'; message: string }
  | { type: 'left' };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
