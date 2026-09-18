import { fileOf, rankOf, sq, type Square } from '@chessx/engine';

export const SQ = 72;
/** Width of the columns flanking the board (decks live there). */
export const SIDE_W = 160;
export const BOARD_X = SIDE_W;
/** Face-down row showing how many cards the opponent holds. */
export const OPP_HAND_Y = 34;
export const OPP_CARD_W = 30;
export const OPP_CARD_H = 42;
export const BOARD_Y = 84;
export const BOARD_SIZE = SQ * 8;
export const CANVAS_W = SIDE_W * 2 + BOARD_SIZE;
export const CARD_W = 92;
export const CARD_H = 150;
export const HAND_Y = BOARD_Y + BOARD_SIZE + 20;
export const CANVAS_H = HAND_Y + CARD_H + 20;

/** Deck positions: yours bottom-right, the opponent's top-left (their right, from their side). */
export const DECK_W = 78;
export const DECK_H = 108;
export const DECK_RING_R = 74;
export const MY_DECK = { x: BOARD_X + BOARD_SIZE + SIDE_W / 2, y: BOARD_Y + BOARD_SIZE - DECK_RING_R - 8 };
export const OPP_DECK = { x: SIDE_W / 2, y: BOARD_Y + DECK_RING_R + 8 };

export const COLORS = {
  light: 0xd6c9a8,
  dark: 0x7a5f45,
  edge: 0x2a2233,
  whitePiece: 0xf7f3ea,
  whiteOutline: 0x2b2420,
  blackPiece: 0x1c1b24,
  blackOutline: 0xd8d2e6,
  move: 0x22d3ee,
  attack: 0xe0503c,
  card: 0x8f6cff,
  select: 0xf0c75e,
  lastMove: 0xf0c75e,
  atk: 0xd9534f,
  def: 0x4a8fe7,
  hp: 0x3fbf6f,
  summon: 0x9b6bff,
  void: 0x05030a,
  deckBack: 0x2c2450,
  deckEdge: 0x8f7bd6,
  ringTrack: 0x2a2a3a,
  ringFill: 0x3dd68c,
} as const;

/** Board orientation: your pieces are always at the bottom. */
export function squareToXY(square: Square, flipped: boolean): { x: number; y: number } {
  const f = fileOf(square);
  const r = rankOf(square);
  const sf = flipped ? 7 - f : f;
  const sr = flipped ? r : 7 - r;
  return { x: BOARD_X + sf * SQ + SQ / 2, y: BOARD_Y + sr * SQ + SQ / 2 };
}

export function xyToSquare(x: number, y: number, flipped: boolean): Square | null {
  const sf = Math.floor((x - BOARD_X) / SQ);
  const sr = Math.floor((y - BOARD_Y) / SQ);
  if (sf < 0 || sf > 7 || sr < 0 || sr > 7) return null;
  const f = flipped ? 7 - sf : sf;
  const r = flipped ? sr : 7 - sr;
  return sq(f, r);
}

export function isOverBoard(x: number, y: number): boolean {
  return x >= BOARD_X && x < BOARD_X + BOARD_SIZE && y >= BOARD_Y && y < BOARD_Y + BOARD_SIZE;
}

export const CHESS_FONT = '"Segoe UI Symbol", "DejaVu Sans", "Arial Unicode MS", "Noto Sans Symbols2", sans-serif';
export const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
export const UI_FONT = '"Segoe UI", system-ui, sans-serif';
