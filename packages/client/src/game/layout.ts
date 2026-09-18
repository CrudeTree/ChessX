import { fileOf, rankOf, sq, type Square } from '@chessx/engine';

// Layout metrics for the game canvas. These are `let` exports (live bindings)
// so `configureLayout()` can switch between the desktop and phone arrangements
// before the Pixi app is created. Everything else imports them as usual.

export let MOBILE = false;
export let SQ = 72;
/** Width of the columns flanking the board on desktop (decks live there). */
export let SIDE_W = 160;
export let BOARD_X = SIDE_W;
export let BOARD_Y = 84;
export let BOARD_SIZE = SQ * 8;
export let CANVAS_W = SIDE_W * 2 + BOARD_SIZE;
export let CARD_W = 92;
export let CARD_H = 150;
export let HAND_Y = BOARD_Y + BOARD_SIZE + 20;
export let CANVAS_H = HAND_Y + CARD_H + 20;
/** Horizontal span available to the hand (cards scroll within it on phones). */
export let HAND_X0 = 20;
export let HAND_X1 = CANVAS_W - 20;

/** Face-down row showing how many cards the opponent holds. */
export let OPP_HAND_Y = 34;
export let OPP_CARD_W = 30;
export let OPP_CARD_H = 42;
/** Where the opponent-hand row may extend horizontally. */
export let OPP_HAND_X0 = BOARD_X;
export let OPP_HAND_X1 = BOARD_X + BOARD_SIZE;

/** Deck sprites are drawn at desktop size and scaled. */
export const DECK_W = 78;
export const DECK_H = 108;
export const DECK_RING_R = 74;
export let DECK_SCALE = 1;
export let MY_DECK = { x: 0, y: 0 };
export let OPP_DECK = { x: 0, y: 0 };

function desktop(): void {
  MOBILE = false;
  SQ = 72;
  SIDE_W = 160;
  BOARD_X = SIDE_W;
  BOARD_Y = 84;
  BOARD_SIZE = SQ * 8;
  CANVAS_W = SIDE_W * 2 + BOARD_SIZE;
  CARD_W = 92;
  CARD_H = 150;
  HAND_Y = BOARD_Y + BOARD_SIZE + 20;
  CANVAS_H = HAND_Y + CARD_H + 20;
  HAND_X0 = 20;
  HAND_X1 = CANVAS_W - 20;
  OPP_HAND_Y = 34;
  OPP_CARD_W = 30;
  OPP_CARD_H = 42;
  OPP_HAND_X0 = BOARD_X;
  OPP_HAND_X1 = BOARD_X + BOARD_SIZE;
  DECK_SCALE = 1;
  MY_DECK = { x: BOARD_X + BOARD_SIZE + SIDE_W / 2, y: BOARD_Y + BOARD_SIZE - DECK_RING_R - 8 };
  OPP_DECK = { x: SIDE_W / 2, y: BOARD_Y + DECK_RING_R + 8 };
}

/**
 * Portrait phone layout: full-width board, opponent row above, your hand as a
 * horizontal strip below with your deck at the right end of that strip.
 */
function mobile(viewportW: number): void {
  MOBILE = true;
  const W = Math.min(viewportW, 520);
  SQ = Math.floor((W - 12) / 8);
  BOARD_SIZE = SQ * 8;
  CANVAS_W = W;
  BOARD_X = Math.floor((W - BOARD_SIZE) / 2);
  SIDE_W = 0;

  // Opponent row: their deck (small) at the left, their face-down hand beside it.
  DECK_SCALE = 0.42;
  const deckR = DECK_RING_R * DECK_SCALE;
  OPP_HAND_Y = deckR + 6;
  OPP_CARD_W = 22;
  OPP_CARD_H = 32;
  OPP_DECK = { x: deckR + 8, y: deckR + 6 };
  OPP_HAND_X0 = deckR * 2 + 24;
  OPP_HAND_X1 = W - 8;
  BOARD_Y = Math.round(deckR * 2 + 16);

  // Hand strip below the board, your deck at the right end.
  CARD_W = 84;
  CARD_H = 136;
  HAND_Y = BOARD_Y + BOARD_SIZE + 12;
  const myDeckColumn = deckR * 2 + 16;
  MY_DECK = { x: W - myDeckColumn / 2 - 4, y: HAND_Y + CARD_H / 2 };
  HAND_X0 = 8;
  HAND_X1 = W - myDeckColumn - 8;
  CANVAS_H = HAND_Y + CARD_H + 10;
}

/** Pick the arrangement for the current viewport. Call once before creating the Pixi app. */
export function configureLayout(viewportW: number): void {
  if (viewportW < 900) mobile(viewportW);
  else desktop();
}

desktop();

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
