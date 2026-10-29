// The rules-2 game screen: a plain-DOM board (8x8), your hand, mana, seals, and the turn controls.
// The original (rules 1) game keeps its own Pixi renderer in ../game/GameView.ts.

import { v2 } from '@chessx/engine';
import type { ChatMessage, RoomInfo } from '@chessx/protocol';
import { fillEmbers } from '../embers.js';
import type { Board3D, Figure } from './board3d.js';
import { cardBack, fillFrame, hourglass, tiltWithPointer, tribeClass, type FrameCard } from './cardFrame.js';
import {
  BoardFx,
  CARD_DIVE_MS,
  HATCH_T0_MS,
  LAVA_FLIGHT_MS,
  SHIFT_GONE_MS,
  SHIFT_LAND_MS,
  SHIFT_MS,
  SPELL_HOLD_MS,
  SPELL_LANDS_MS,
  strikeBurst,
  type BannerTone,
} from './fx.js';
import { CardLibrary, type LibraryTool } from './library.js';
import { describeEvents, type PieceMemory } from './log.js';
import { movementPanel } from './movement.js';
import { sound } from './sound.js';

type Color = v2.Color;
type Action = v2.Action;

export interface ClockText {
  text: string;
  running: boolean;
  low: boolean;
}

export interface GameScreenHooks {
  /** Send a rules-2 action to the server. */
  act(action: Action): void;
  /** Resign (or cancel the invite, if nobody has joined). Main decides which. */
  resign(): void;
  leave(): void;
  names(): Record<Color, string>;
  /** Clock for a side, or null in practice games. */
  clock(color: Color): ClockText | null;
  /** The chat box was opened or moved; a moved box forgets how far it was scrolled. */
  chatShown(): void;
  /** Send an edit to the arena's board (place, give, move or remove something, mana, pass, undo, reset). */
  arena(op: v2.ArenaOp): void;
  /** Ask the server for the game as it stood after `step` steps; the answer comes to `showPast`. */
  past(step: number): void;
}

/**
 * Glyphs for the placeholder cards; any other piece falls back to its initial. An evolution line shares the glyph
 * of the chess piece it ends in. Page, Hopper, Cathedral Runner, Tower and Dawnfang live on in saved games.
 */
const GLYPHS: Record<string, string> = {
  king: '♚',
  initiate: '♟',
  squire: '✚',
  recruit: '♜',
  warrior: '♜',
  warlord: '♜',
  apprentice: '♝',
  mage: '♝',
  archmage: '♝',
  colt: '♞',
  paladin: '♞',
  dawn_paladin: '☀\uFE0E',
  eclipse_knight: '◐\uFE0E',
  wyrmling: '§',
  mystic_dragon: '♛',
  ancient_mystic_dragon: '♛',
  duskfang: '☾\uFE0E',
  page: '¶',
  hopper: '♞',
  cathedral_runner: '♝',
  tower: '♜',
  dawnfang: '☼\uFE0E',
};
export const glyphFor = (kind: string, name: string): string => GLYPHS[kind] ?? (name[0] ?? '?').toUpperCase();
/** A piece's level in its evolution line, as printed on its token. */
const LEVEL_MARK = ['', 'I', 'II', 'III'];
/**
 * The chess piece each line moves like, on the badge of every piece in it (Djabooty, 2026-10-12). A piece in no line
 * shows its own glyph: the Initiate's pawn, the Squire's cross, the Duskfang's moon.
 */
const LINE_GLYPH: Record<string, string> = { Warrior: '♜', Mage: '♝', Paladin: '♞', Dragon: '♛' };
/** How hard an evolution lands (0 to 1): the final forms slam. */
const evolveForce = (card: v2.ViewCard | undefined): number => ((card?.level ?? 2) >= 3 ? 1 : 0.6);
/** How tall a piece's figure stands on the 3D board, in squares, by its level; a King stands tallest. */
const FIGURE_HEIGHT = [1, 1, 1.15, 1.3];
const KING_HEIGHT = 1.4;
/** The ring round a King's base (a piece's is its type's colour). */
const KING_RING = { white: '#e2b75e', black: '#c4b2ff' } as const;
/** Set to 'off' when the player turns the 3D board off. */
const BOARD_3D_KEY = 'chessx.board3d';
const SHRINE_TIP = 'Mana square: 1 mana at the start of each turn to the side whose piece (not its King) stands here';

/** A piece's figure on the 3D board: named like its board picture, which is its owner's face; Kings have their own. */
function figureName(piece: v2.ViewPiece, view: v2.PlayerView): string {
  if (piece.king) return piece.owner === 'white' ? 'king_white' : 'king_dark';
  const card = piece.cardId ? view.cards[piece.cardId] : undefined;
  const art = card ? v2.faceArt(card, piece.owner).boardArt : undefined;
  return art?.split('/').pop()?.replace(/\.\w+$/, '') ?? '';
}
/** Picture window of a spell card that has no picture yet. */
const SPELL_GLYPH = '✦\uFE0E';

/** A card drawn with `owner`'s face; `cards` names the card it evolves from, `learned` what spells taught its piece. */
export function frameOfCard(card: v2.ViewCard, owner: Color, cards: Record<string, v2.ViewCard>, learned: string[] = []): FrameCard {
  return {
    kind: card.type,
    id: card.id,
    name: card.name,
    cost: card.cost,
    sealTimer: card.sealTimer,
    line: card.line,
    level: card.level,
    evolvesFrom: card.evolvesFrom
      ? [cards[card.evolvesFrom]?.name ?? card.evolvesFrom, ...(card.evolvesFromAlso ?? []).map((id) => cards[id]?.name ?? id)].join(' or ')
      : undefined,
    tribe: card.tribe,
    text: card.text,
    ability: card.abilityText,
    learned,
    art: v2.faceArt(card, owner).art,
    glyph: card.type === 'spell' ? SPELL_GLYPH : glyphFor(card.id, card.name),
    owner,
    rules: card.rules,
  };
}

/**
 * A press on a card in the hand. `ghost` is null until the pointer has moved past the threshold.
 * A mostly sideways mouse drag scrolls the hand instead (`scrollFrom`); touch swipes scroll natively.
 */
interface CardDrag {
  uid: string;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  scrollFrom: number | null;
  ghost: HTMLElement | null;
  /** The ball of static the card turns into over the board (`orbFor`). */
  orb: HTMLElement | null;
  /** The held card's size in pixels, measured once when the drag starts (`placeHeld`). */
  size?: { w: number; h: number };
  /** Where the held card can go, worked out once per drag rather than on every pointer move (`dropTargets`). */
  drops?: Map<v2.Square, Action>;
  hover: v2.Square | null;
  /** Over your discard pile, where letting go pitches the card for mana. */
  pitch: boolean;
}

/** Pixels the pointer must travel before a press on a card or piece becomes a drag rather than a click. */
const DRAG_THRESHOLD = 6;
/** A finger holds a card by its foot: this many pixels of the card lie below the point it touches. */
const TOUCH_GRIP = 10;
/**
 * Off the board a finger's card hangs by its foot and its ball of static this far above the fingertip, so the finger
 * does not cover it. Over the board the ball sits on the square under the finger instead (`cardAim`).
 */
const TOUCH_ORB_LIFT = 36;
/**
 * A mouse drag only scrolls the hand when it is this many times more sideways than it is up or down, and has gone at
 * least `SCROLL_SLOP` pixels. A click that wanders a few pixels sideways plays the card instead of being swallowed.
 */
const SIDEWAYS_RATIO = 1.6;
const SCROLL_SLOP = 16;
/** Let go on a square, the ball charges and dives in: it lands this long after (ms), and the summon plays on from there. */
const STRIKE_MS = 190;

/**
 * A press on one of your pieces that can move. `ghost` is null until the pointer has moved past DRAG_THRESHOLD;
 * from then on a copy of the piece follows the pointer, and letting go on a lit square moves it there.
 */
interface PieceDrag {
  from: v2.Square;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  ghost: HTMLElement | null;
  /** The dragged piece's size in pixels, measured once when the ghost is made (`onPieceMove`). */
  size?: { w: number; h: number };
  /** Where the piece can go, worked out once per drag rather than on every pointer move (`targets`). */
  targets?: Map<v2.Square, Action>;
  hover: v2.Square | null;
}

/** A piece dropped on a square is shown there until the server's answer redraws the board, at most this long. */
const DROP_WAIT_MS = 3000;
/** A piece let go anywhere else flies back to its square for this long (`.g2-piece-ghost.returning`). */
const RETURN_MS = 200;

/** A press on the board only counts as a tap if it stays within TAP_SLOP pixels; only a quick one opens a card. */
const TAP_SLOP = 10;
const TAP_MS = 450;

/**
 * Whose card the card viewer shows: a piece or seal (followed as it moves), a card in your hand (tapped on a touch
 * screen, or clicked while the viewer sits beside the board), a discard pile, `id` being whose: its newest card,
 * or the one `pick` names; or a card in the arena's library, by card id.
 */
interface Inspected {
  kind: 'piece' | 'seal' | 'card' | 'discard' | 'library';
  id: string;
  pick?: string;
}

/** Where a card from the arena's library would go: onto a square, into a hand, or onto a discard pile. */
type LibraryTarget = { kind: 'square'; square: v2.Square } | { kind: 'hand' | 'pile'; color: Color };

/** Token animations in style.css and how long each runs: a piece appearing, sliding, a seal settling or ticking. */
const TOKEN_FX_MS = { 'fx-rise': 900, 'fx-slide': 300, 'fx-seal-in': 800, 'fx-tick': 650, 'fx-lava-in': 700 } as const;
type TokenFxKind = keyof typeof TOKEN_FX_MS;

/**
 * A token animation that outlives re-renders: the board's tokens are rebuilt on every render, so each new one
 * resumes the animation where it is by starting it with a negative delay.
 */
interface TokenFx {
  kind: TokenFxKind;
  /** performance.now() when it starts; later than now while it waits for the effects before it. */
  at: number;
  vars?: Record<string, string>;
}

/** The next turn's effects (hatching, the turn banner) wait for the action's own. */
const TURN_FX_DELAY = 900;
/** A hatched piece appears this long after its seal starts to crack. */
const HATCH_RISE_DELAY = 260;
/** What a spell does lands on the board as its card leaves it for the discard pile. */
const SPELL_HIT_DELAY = SPELL_HOLD_MS;
/** A drawn card slides into the hand for this long (the g2-draw animation). */
const DRAW_MS = 560;
/** The card viewer sits beside the board from this width; narrower screens float it over the board. */
const DOCKED_QUERY = '(min-width: 1200px)';
/** Arena mana buttons: held this long they start repeating, this often; a run of steps is sent once it rests this long. */
const MANA_HOLD_MS = 400;
const MANA_REPEAT_MS = 80;
const MANA_SEND_MS = 300;
/** Phones: how long a new message shows over the status row while the chat is closed. */
const CHAT_PEEK_MS = 4500;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const sideName = (c: Color): string => (c === 'white' ? 'White' : 'Black');

/** When the next turn's effects start after an action's own, and when a spell's effect lands (ms). */
function fxDelays(view: v2.PlayerView): { turnAt: number; spellAt: number } {
  const acted = view.events.some(
    (e) => e.type === 'moved' || e.type === 'summoned' || e.type === 'sealed' || e.type === 'evolved' || e.type === 'deployed',
  );
  return { turnAt: acted ? TURN_FX_DELAY : 0, spellAt: view.events.some((e) => e.type === 'spellPlayed') ? SPELL_HIT_DELAY : 0 };
}

const link = (text: string, href: string): HTMLAnchorElement => {
  const a = el('a', '', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
};

/** Icons for the sound switches; a slash goes through them while they are off. */
const SPEAKER = '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z" fill="currentColor"/>';
const WAVES = '<path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
const NOTE = '<path d="M9.5 17V6.5l9-2V15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="7.3" cy="17" r="2.3" fill="currentColor"/><circle cx="16.3" cy="15" r="2.3" fill="currentColor"/>';
const SLASH = '<path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
const CUBE = '<path d="M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7zM12 12l7.5-4.3M12 12v8.5M12 12L4.5 7.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>';
const CHAT_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>';
/** The arrows that step back and forth through the game. */
const chevrons = (d: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FIRST_ICON = chevrons('M12 6l-6 6 6 6M18 6l-6 6 6 6');
const BACK_ICON = chevrons('M15 6l-6 6 6 6');
const NEXT_ICON = chevrons('M9 6l6 6-6 6');
const LIVE_ICON = chevrons('M6 6l6 6-6 6M12 6l6 6-6 6');

function paintSwitch(btn: HTMLButtonElement, on: boolean, name: string, icon: string, what = name.toLowerCase()): void {
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}${on ? '' : SLASH}</svg><span>${name}</span>`;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = `Turn ${what} ${on ? 'off' : 'on'}`;
}

export class GameScreen {
  private view: v2.PlayerView | null = null;
  private room: RoomInfo | null = null;
  private solo = false;
  private code = '';
  /** Which colour sits at the bottom of the board. */
  private seat: Color = 'white';

  private selectedSquare: v2.Square | null = null;
  /** The picked piece is taking aim with Lava Breath: the squares it can spit lava onto light up instead of its moves. */
  private aimLava: v2.Square | null = null;
  private drag: CardDrag | null = null;
  private pieceDrag: PieceDrag | null = null;
  /** A dragged piece let go on a lit square: its copy waits there until the move comes back from the server. */
  private dropped: { from: v2.Square; to: v2.Square; ghost: HTMLElement; timer: number } | null = null;
  /** A dragged piece let go anywhere else, flying back to its square. */
  private returning: { from: v2.Square; ghost: HTMLElement; timer: number } | null = null;
  private suppressClick = false;
  private inspected: Inspected | null = null;
  /** Hand card under the mouse; it is shown in the card viewer until the mouse leaves. */
  private hoverCard: string | null = null;
  /** Piece or seal under the mouse while the viewer is docked beside the board. */
  private hoverBoard: Inspected | null = null;
  /** Discard pile under the mouse: its newest card is shown in the card viewer until the mouse leaves. */
  private hoverPile: Color | null = null;
  /** A cast spell's card is still flying to this discard pile: until `until`, it shows only its first `length` cards. */
  private pileHeld: Partial<Record<Color, { length: number; until: number }>> = {};
  /**
   * The mana squares are moving: the old ones show until `gone` (when their gems burst), none show until `land` (when
   * the pillars come down on the new ones), and nothing can be played until it is over.
   */
  private shift: { from: Set<v2.Square>; gone: number; land: number } | null = null;
  private shiftTimer = 0;
  /** Resurrect was dropped on a square: the cards it can raise there, to pick from. */
  private readonly raiseEl = el('div', 'g2-raise hidden');
  /** What the viewer showed last, so it only plays its entrance when that changes. */
  private inspectKey = '';
  /** The press on the board so far; `held` once it was held long enough to open a card, `dragged` once it lifted a piece. */
  private boardPress: { x: number; y: number; at: number; held?: boolean; dragged?: boolean } | null = null;
  private holdTimer: number | undefined;

  private readonly memory: PieceMemory = new Map();
  private lastSeq = -1;

  /**
   * Looking back through the game: the step shown (0: as the game began), with the newest view from the server kept
   * aside meanwhile. Nothing can be played in an earlier view; stepping on past the last step comes back to the game.
   */
  private review: { step: number; live: v2.PlayerView } | null = null;
  /** Earlier views the server sent, by step; and the step asked for and not yet shown. */
  private readonly pastViews = new Map<number, v2.PlayerView>();
  private wantStep: number | null = null;
  private readonly navEl = el('div', 'g2-nav hidden');
  private readonly navFirst = el('button', 'g2-nav-btn first');
  private readonly navBack = el('button', 'g2-nav-btn');
  private readonly navCount = el('span', 'g2-nav-count');
  private readonly navNext = el('button', 'g2-nav-btn');
  private readonly navLive = el('button', 'g2-nav-btn live');
  /** On the board's top edge while looking back. */
  private readonly liveEl = el('button', 'g2-live hidden', 'Back to the game');

  /** The arena: a sandbox where any card can be put anywhere from the library, and any piece moved or taken off. */
  private arena = false;
  private readonly library: CardLibrary;
  /** Library card under the mouse; it is shown in the card viewer until the mouse leaves. */
  private hoverLib: string | null = null;
  /** Where a library card held over the game would go; it lights up. */
  private libTarget: LibraryTarget | null = null;
  /** Where a piece from the library was just put down, so it rises there with a summon. */
  private placedAt: v2.Square | null = null;
  /** Pieces just let go off the board: they burst where they were let go, not again on their square. */
  private readonly arenaGone = new Set<string>();
  /** A piece let go off the board stays hidden on its square until the server takes it away. */
  private vanishing: { square: v2.Square; timer: number } | null = null;
  /** Mana set with the − and + buttons, shown before the server's answer. */
  private manaShown: Partial<Record<Color, number>> = {};
  /** A run of mana steps waiting to be sent, by side. */
  private manaSend: Partial<Record<Color, number>> = {};
  /** The held − or + button's repeat (a timeout, then an interval). */
  private manaHold = 0;

  private readonly tokenFx = new Map<string, TokenFx>();
  /** Squares a held card was just dropped on, so its summon does not show the card a second time. */
  private readonly landed = new Map<v2.Square, number>();
  /** Hand cards seen so far (null before the first hand), and when each newly drawn one starts sliding in. */
  private seenCards: Set<string> | null = null;
  private readonly drawnAt = new Map<string, number>();
  /**
   * Whose hand is showing, and whose hands have been shown this game. Practice shows the side to move, so each
   * turn the other side's whole hand slides in again; only the first time it does is dealt with a sound.
   */
  private handOwner: Color | null = null;
  private readonly shownHands = new Set<Color>();

  // DOM
  private readonly boardEl = el('div', 'g2-board');
  private readonly boardBox = el('div', 'g2-boardbox');
  private readonly handEl = el('div', 'g2-hand');
  private readonly statusEl = el('div', 'status g2-status');
  private readonly logEl = el('div', 'g2-log');
  private readonly endBtn = el('button', 'primary g2-end', 'End turn');
  private readonly codeEl = el('div', 'code', '-----');
  /** Under a thumb the hovered square is hidden, so a touch drag repeats its seal warning here. */
  private readonly dropNoteEl = el('div', 'g2-dropnote hidden');
  private readonly dropTagEl = el('div', 'g2-droptag');
  private readonly oppEl = el('div', 'g2-player');
  private readonly meEl = el('div', 'g2-player');
  /**
   * Right of the board, each side's discard pile at its own end: out of the way of a card pulled up from the hand.
   * Phones have no room beside the board, so there the piles stay in the bars.
   */
  private readonly pilesEl = el('div', 'g2-piles');
  private readonly oppPileEl = el('div', 'g2-pile-slot');
  private readonly mePileEl = el('div', 'g2-pile-slot');
  private readonly resignBtn = el('button', 'danger', 'Resign');
  private readonly inspectEl = el('div', 'g2-inspect hidden');
  /** Wide screens: the column left of the board that holds the card viewer. */
  private readonly detailEl = el('aside', 'g2-detail');
  /** On the board's top edge: Spit lava, while a piece that can spit is picked. */
  private readonly cueEl = el('div', 'g2-cue hidden');
  private readonly sideEl = el('aside', 'g2-side');
  private readonly codeBlock = el('div', 'side-block');
  private readonly statusBlock = el('div', 'side-block g2-statusblock');
  private readonly effectsBtn = el('button', 'g2-sound-btn');
  private readonly musicBtn = el('button', 'g2-sound-btn');
  private readonly board3dBtn = el('button', 'g2-sound-btn');
  /** The pieces as figures standing on a leaning board, while that is on and WebGL works; flat tokens otherwise. */
  private board3d: Board3D | null = null;
  /** The 3D board while it is turned off: hidden, with its figures still loaded, so turning it on again is instant. */
  private spare3d: Board3D | null = null;
  private starting3d = false;
  /** The squares lit up for the player to choose between, as last drawn: what the figures in front of fade for. */
  private choices: v2.Square[] = [];
  /** Type colours (a tribe class's --line), for the rings round the figures' bases. */
  private readonly rings = new Map<string, string>();
  /** The music's licence asks for this credit wherever it plays. */
  private readonly creditEl = el('div', 'g2-credit');
  private readonly menuBtn = el('button', 'g2-menu', '☰');
  private readonly logBlock = el('div', 'side-block grow');
  /** Phones: opens the chat, with a count of messages that came while it was closed. */
  private readonly chatBtn = el('button', 'g2-chat-btn');
  private readonly chatBadge = el('span', 'g2-chat-badge hidden');
  /** Phones: the newest message, shown for a moment over the status row while the chat is closed. */
  private readonly chatPeek = el('button', 'g2-chat-peek hidden');
  private unread = 0;
  private peekTimer = 0;
  private readonly sheetShade = el('div', 'g2-sheet-shade hidden');
  /**
   * Phones fit the whole game on one screen, so a pull on a card never fights a page scroll: the status and
   * End turn sit under the hand, and the rest of the side column becomes a sheet behind the ☰ button.
   */
  private readonly narrow = window.matchMedia('(max-width: 899px)');
  private readonly wide = window.matchMedia(DOCKED_QUERY);
  /** Chat is moved in here: under the log on wide screens, a sheet of its own on phones. */
  readonly chatSlot = el('div', 'g2-chat-slot');
  private readonly cells: HTMLElement[] = [];
  private readonly fx: BoardFx;

  constructor(
    readonly root: HTMLElement,
    private hooks: GameScreenHooks,
  ) {
    const main = el('div', 'g2-main');
    const boardWrap = el('div', 'g2-boardwrap');
    const boardBox = this.boardBox;
    boardBox.append(this.boardEl, this.cueEl, this.liveEl);
    this.fx = new BoardFx(this.boardEl, boardBox, (square) => this.cells[square]);
    boardBox.append(this.raiseEl);
    this.pilesEl.append(this.oppPileEl, this.mePileEl);
    boardWrap.append(this.oppEl, boardBox, this.meEl, this.pilesEl);
    main.append(boardWrap, this.handEl);
    // The bars and piles are rebuilt every second for the clocks, so a discard pile is pointed at through what holds it.
    for (const bar of [this.oppEl, this.meEl, this.pilesEl]) {
      bar.addEventListener('pointerover', (e) => {
        if (e.pointerType !== 'mouse' || this.drag?.ghost) return;
        const pile = (e.target as HTMLElement).closest<HTMLElement>('.g2-pile:not(.empty)');
        this.setPileHover((pile?.dataset.pile as Color | undefined) ?? null);
      });
      bar.addEventListener('pointerleave', () => this.setPileHover(null));
    }

    const side = this.sideEl;
    const sheetClose = el('button', 'g2-sheet-close', 'Close');
    sheetClose.type = 'button';
    sheetClose.onclick = () => this.toggleSheet(false);
    this.codeBlock.append(el('div', 'label', 'Invite code'), this.codeEl);
    this.menuBtn.type = 'button';
    this.menuBtn.title = 'Log, sound, invite code and resign';
    this.menuBtn.onclick = () => this.toggleSheet();
    this.chatBtn.type = 'button';
    this.chatBtn.title = 'Chat';
    this.chatBtn.setAttribute('aria-label', 'Chat');
    this.chatBtn.innerHTML = CHAT_ICON;
    this.chatBtn.append(this.chatBadge);
    this.chatBtn.onclick = () => this.openChat(!this.chatOpen);
    this.chatPeek.type = 'button';
    this.chatPeek.onclick = () => this.openChat(true);
    const navButtons: [HTMLButtonElement, string, string, () => void][] = [
      [this.navFirst, FIRST_ICON, 'To the start of the game', () => this.goTo(0)],
      [this.navBack, BACK_ICON, 'Step back (←)', () => this.goTo(this.stepShown - 1)],
      [this.navNext, NEXT_ICON, 'Step forward (→)', () => this.goTo(this.stepShown + 1)],
      [this.navLive, LIVE_ICON, 'Back to the game as it is now', () => this.toLive()],
    ];
    for (const [btn, icon, title, go] of navButtons) {
      btn.type = 'button';
      btn.innerHTML = icon;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.onclick = go;
    }
    this.navEl.append(this.navFirst, this.navBack, this.navCount, this.navNext, this.navLive);
    this.liveEl.type = 'button';
    this.liveEl.onclick = () => this.toLive();
    this.statusBlock.append(this.statusEl, this.navEl, this.endBtn, this.chatBtn, this.menuBtn, this.chatPeek);
    const logBlock = this.logBlock;
    logBlock.append(el('div', 'label', 'Log'), this.logEl);
    // A line of the log shows the game as it stood after what it tells of.
    this.logEl.addEventListener('click', (e) => {
      const step = (e.target as HTMLElement).closest<HTMLElement>('.entry[data-step]')?.dataset.step;
      if (step !== undefined) this.goTo(Number(step));
    });
    const soundBlock = el('div', 'side-block g2-sound');
    const switches = el('div', 'g2-sound-switches');
    this.effectsBtn.type = 'button';
    this.musicBtn.type = 'button';
    this.board3dBtn.type = 'button';
    this.effectsBtn.onclick = () => sound.setEffects(!sound.effectsOn);
    this.musicBtn.onclick = () => sound.setMusic(!sound.musicOn);
    this.board3dBtn.onclick = () => this.setBoard3d(!this.wants3d);
    switches.append(this.effectsBtn, this.musicBtn, this.board3dBtn);
    soundBlock.append(el('div', 'label', 'Settings'), switches, this.creditEl);
    sound.onChange(() => this.renderSound());
    this.renderSound();
    const buttons = el('div', 'side-block actions');
    const leave = el('button', '', 'Back to games');
    leave.onclick = () => this.hooks.leave();
    this.resignBtn.onclick = () => this.hooks.resign();
    buttons.append(this.resignBtn, leave);
    this.library = new CardLibrary(
      {
        give: (cardId, color, tile) => this.giveFromLibrary(cardId, color, tile),
        ghost: (cardId, color) => this.libraryGhost(cardId, color),
        hover: (cardId, x, y) => this.hoverLibrary(cardId, x, y),
        drop: (cardId, color, at, ghost) => this.dropFromLibrary(cardId, color, at, ghost),
        preview: (cardId, pinned) => this.previewLibrary(cardId, pinned),
        tool: (tool) => this.arenaTool(tool),
      },
      () => this.narrow.matches,
    );
    side.append(sheetClose, this.codeBlock, this.statusBlock, this.library.el, logBlock, this.chatSlot, soundBlock, buttons);
    this.sheetShade.onclick = () => {
      this.toggleSheet(false);
      this.openChat(false);
    };

    const embers = el('div', 'hx-embers g2-embers');
    embers.setAttribute('aria-hidden', 'true');
    fillEmbers(embers, 14, 2.2);
    root.append(embers, this.detailEl, main, side, this.sheetShade);
    this.placeStatus();
    this.placeInspect();
    this.narrow.addEventListener('change', () => {
      this.placeStatus();
      this.renderPlayers();
    });
    this.wide.addEventListener('change', () => this.placeInspect());

    this.endBtn.onclick = () => this.hooks.act({ type: 'endTurn' });
    this.buildBoard();
    // The box, not just the board: a figure on the 3D board stands up over the board's far edge.
    boardBox.addEventListener('pointerdown', (e) => {
      this.boardPress = { x: e.clientX, y: e.clientY, at: performance.now() };
      this.startHold(e);
      this.pressPiece(e);
    });
    boardBox.addEventListener('pointermove', (e) => {
      const press = this.boardPress;
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP) clearTimeout(this.holdTimer);
      if (e.pointerType !== 'mouse' || !this.docked || this.drag || this.pieceDrag?.ghost || this.library.dragging) return;
      this.setBoardHover(this.squareAt(e.clientX, e.clientY));
    });
    boardBox.addEventListener('pointerup', () => clearTimeout(this.holdTimer));
    boardBox.addEventListener('pointercancel', () => clearTimeout(this.holdTimer));
    boardBox.addEventListener('pointerleave', () => this.setBoardHover(null));
    boardBox.addEventListener('click', (e) => {
      if (e.target !== boardBox && !this.boardEl.contains(e.target as Node)) return;
      const tap = this.boardTap(e);
      const targets = this.targets();
      const square = this.squareAt(e.clientX, e.clientY, targets.size ? (sq) => targets.has(sq) : undefined);
      if (tap && square !== null) this.onSquare(square, tap === 'quick');
    });
    this.renderBoard3dBtn();
    if (this.wants3d) void this.start3d();
    this.inspectEl.addEventListener('click', (e) => {
      // Beside the board the viewer stays put; only its close button clears it.
      if (this.docked && !(e.target as HTMLElement).closest('.g2-inspect-close')) return;
      if (!this.docked && !this.boardTap(e)) return;
      this.inspected = null;
      this.hoverCard = null;
      this.render();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (this.stepCount === null || this.root.classList.contains('hidden') || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
      if (!this.raiseEl.classList.contains('hidden')) return;
      e.preventDefault();
      this.goTo(this.stepShown + (e.key === 'ArrowLeft' ? -1 : 1));
    });
    window.addEventListener('keydown', (e) => {
      if (!this.arena || this.root.classList.contains('hidden') || e.key.toLowerCase() !== 'z' || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]')) return;
      e.preventDefault();
      this.arenaTool('undo');
    });
  }

  /**
   * A press that wandered off is a drag, which moves a piece by itself (`pressPiece`) or does nothing; nor does
   * letting go of a press that was held to open a card. Only a quick tap opens a card.
   */
  private boardTap(e: MouseEvent): 'quick' | 'slow' | null {
    const press = this.boardPress;
    this.boardPress = null;
    clearTimeout(this.holdTimer);
    if (!press) return 'quick';
    if (press.held || press.dragged || Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP) return null;
    return performance.now() - press.at < TAP_MS ? 'quick' : 'slow';
  }

  /**
   * When the card viewer floats over the board, a tap on a piece you can move only picks it up, so that its card
   * does not hide where it can go; holding a piece or seal opens its card instead. Beside the board there is no
   * need: the mouse shows it, and a tap keeps it there.
   */
  private startHold(e: PointerEvent): void {
    clearTimeout(this.holdTimer);
    if (this.docked || !e.isPrimary || e.button !== 0) return;
    const square = this.squareAt(e.clientX, e.clientY);
    if (square === null) return;
    this.holdTimer = window.setTimeout(() => {
      const thing = this.view ? this.thingAt(this.view, square) : null;
      if (!thing || !this.boardPress) return;
      this.boardPress.held = true;
      this.inspected = thing;
      this.render();
    }, TAP_MS);
  }

  private placeStatus(): void {
    if (this.narrow.matches) {
      this.handEl.after(this.statusBlock);
      this.root.append(this.chatSlot);
    } else {
      this.codeBlock.after(this.statusBlock);
      this.logBlock.after(this.chatSlot);
      this.toggleSheet(false);
      this.openChat(false);
    }
    this.statusBlock.after(this.library.el);
    this.hooks.chatShown();
  }

  private get docked(): boolean {
    return this.wide.matches;
  }

  /** Beside the board on wide screens, floating over it otherwise. */
  private placeInspect(): void {
    if (this.docked) this.detailEl.append(this.inspectEl);
    else this.boardBox.append(this.inspectEl);
    this.hoverBoard = null;
    this.inspectKey = '';
    if (this.view) this.renderInspect(this.view);
    else this.renderEmptyInspect();
  }

  private toggleSheet(open = !this.sideEl.classList.contains('open')): void {
    if (open) this.openChat(false);
    this.sideEl.classList.toggle('open', open);
    this.syncShade();
  }

  private syncShade(): void {
    this.sheetShade.classList.toggle('hidden', !this.sideEl.classList.contains('open') && !this.chatOpen);
  }

  private get chatOpen(): boolean {
    return this.chatSlot.classList.contains('open');
  }

  /** Phones: the chat sheet. Wide screens always show the chat, so there is nothing to open. */
  openChat(open: boolean): void {
    if (open && !this.narrow.matches) return;
    if (open) this.toggleSheet(false);
    this.chatSlot.classList.toggle('open', open);
    this.followKeyboard(open);
    if (open) {
      this.unread = 0;
      this.renderUnread();
      this.hidePeek();
      this.hooks.chatShown();
    }
    this.syncShade();
  }

  /** A message from the other player: on a phone with the chat closed, count it and show it for a moment. */
  chatArrived(m: ChatMessage): void {
    if (!this.narrow.matches || this.chatOpen) return;
    this.unread++;
    this.renderUnread();
    this.chatPeek.replaceChildren(el('b', '', m.name), el('span', '', m.text || 'sent a GIF'));
    this.chatPeek.classList.remove('hidden');
    clearTimeout(this.peekTimer);
    this.peekTimer = window.setTimeout(() => this.hidePeek(), CHAT_PEEK_MS);
  }

  private hidePeek(): void {
    clearTimeout(this.peekTimer);
    this.chatPeek.classList.add('hidden');
  }

  private renderUnread(): void {
    this.chatBadge.textContent = this.unread > 9 ? '9+' : String(this.unread);
    this.chatBadge.classList.toggle('hidden', this.unread === 0);
    this.chatBtn.setAttribute('aria-label', this.unread ? `Chat, ${this.unread} new` : 'Chat');
  }

  /**
   * A phone's keyboard covers the bottom of the screen without moving fixed things out of its way, so while the chat
   * sheet is open it sits on top of whatever the keyboard leaves visible.
   */
  private readonly fitAboveKeyboard = (): void => {
    const vv = window.visualViewport;
    if (!vv) return;
    this.chatSlot.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    this.chatSlot.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  };

  private followKeyboard(on: boolean): void {
    const vv = window.visualViewport;
    if (!vv) return;
    vv.removeEventListener('resize', this.fitAboveKeyboard);
    vv.removeEventListener('scroll', this.fitAboveKeyboard);
    if (on) {
      vv.addEventListener('resize', this.fitAboveKeyboard);
      vv.addEventListener('scroll', this.fitAboveKeyboard);
      this.fitAboveKeyboard();
    } else {
      this.chatSlot.style.removeProperty('--kb');
      this.chatSlot.style.removeProperty('--vvh');
    }
  }

  private renderSound(): void {
    paintSwitch(this.effectsBtn, sound.effectsOn, 'Effects', sound.effectsOn ? SPEAKER + WAVES : SPEAKER);
    paintSwitch(this.musicBtn, sound.musicOn, 'Music', NOTE);
    this.creditEl.classList.toggle('hidden', !sound.musicOn);
    this.creditEl.replaceChildren(
      `Music: “${sound.track.title}” by Kevin MacLeod (`,
      link('incompetech.com', 'https://incompetech.com'),
      '), licensed under ',
      link('CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'),
    );
  }

  private get wants3d(): boolean {
    return localStorage.getItem(BOARD_3D_KEY) !== 'off';
  }

  private setBoard3d(on: boolean): void {
    if (on) localStorage.removeItem(BOARD_3D_KEY);
    else localStorage.setItem(BOARD_3D_KEY, 'off');
    if (on) void this.start3d();
    else this.stop3d();
    this.renderBoard3dBtn();
  }

  private renderBoard3dBtn(): void {
    paintSwitch(this.board3dBtn, this.wants3d, '3D', CUBE, 'the 3D board');
  }

  /**
   * Stand the pieces up as figures; without WebGL (or the figures) the board stays flat. The flat pieces stay until
   * every figure is loaded and drawn, and then the board changes over in one frame.
   */
  private async start3d(): Promise<void> {
    if (this.board3d || this.starting3d) return;
    this.starting3d = true;
    let board = this.spare3d;
    this.spare3d = null;
    try {
      if (!board) {
        const { Board3D } = await import('./board3d.js');
        const made = await Board3D.create(this.boardBox, this.boardEl, (square) => this.cells[square]);
        if (made) made.onLost = () => this.lose3d(made);
        board = made;
      }
      if (board && this.view) await board.prepare(this.figures(this.view, board));
    } catch {
      board?.dispose();
      board = null;
    }
    this.starting3d = false;
    if (!board) return;
    if (!this.wants3d) {
      this.spare3d = board;
      return;
    }
    this.board3d = board;
    board.show(this.view ? this.figures(this.view, board) : []);
    this.fx.shakeAlso(board.canvas);
    this.render();
  }

  private stop3d(): void {
    const board = this.board3d;
    if (!board) return;
    board.hide();
    this.board3d = null;
    this.spare3d = board;
    this.fx.shakeAlso(null);
    this.render();
  }

  /** The 3D board lost its WebGL context: flat tokens, until 3D is turned on again and builds a new one. */
  private lose3d(board: Board3D): void {
    if (this.board3d === board) {
      this.board3d = null;
      this.fx.shakeAlso(null);
      this.render();
    }
    if (this.spare3d === board) this.spare3d = null;
    board.dispose();
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * `bot`: the other side is the computer, which nobody can join by code and which does not chat. `arena`: the
   * sandbox, played from both sides like practice, with the card library and no log or resigning.
   */
  open(opts: { code: string; solo: boolean; you: Color; bot?: boolean; arena?: boolean }): void {
    this.reset();
    this.code = opts.code;
    this.solo = opts.solo;
    this.arena = !!opts.arena;
    this.seat = opts.solo ? 'white' : opts.you;
    this.codeEl.textContent = this.arena ? 'ARENA' : opts.solo ? 'PRACTICE' : opts.code;
    for (const part of [this.codeBlock, this.chatBtn, this.chatSlot]) part.classList.toggle('hidden', !!opts.bot || this.arena);
    for (const part of [this.logBlock, this.resignBtn]) part.classList.toggle('hidden', this.arena);
    this.root.classList.toggle('g2-arena', this.arena);
    this.library.show(this.arena);
    this.library.setSide('white');
    this.buildBoard();
    this.renderPlayers();
  }

  reset(): void {
    this.cancelDrag();
    this.cancelPieceDrag();
    this.clearDropped();
    this.clearReturning();
    this.library.cancel();
    this.clearVanishing();
    this.hoverLib = null;
    this.libTarget = null;
    this.placedAt = null;
    this.arenaGone.clear();
    this.stopManaHold();
    for (const timer of Object.values(this.manaSend)) clearTimeout(timer);
    this.manaSend = {};
    this.manaShown = {};
    sound.setBattle(false);
    this.view = null;
    this.review = null;
    this.pastViews.clear();
    this.wantStep = null;
    this.root.classList.remove('g2-reviewing');
    this.navEl.classList.add('hidden');
    this.liveEl.classList.add('hidden');
    this.room = null;
    this.selectedSquare = null;
    this.aimLava = null;
    this.inspected = null;
    this.hoverCard = null;
    this.hoverBoard = null;
    this.hoverPile = null;
    this.pileHeld = {};
    this.endShift();
    this.closeRaise();
    this.inspectKey = '';
    this.renderEmptyInspect();
    this.cueEl.classList.add('hidden');
    this.handEl.classList.remove('spent');
    this.memory.clear();
    this.fx.clear();
    this.board3d?.clear();
    this.tokenFx.clear();
    this.landed.clear();
    this.seenCards = null;
    this.drawnAt.clear();
    this.handOwner = null;
    this.shownHands.clear();
    this.lastSeq = -1;
    this.logEl.innerHTML = '';
    this.handEl.innerHTML = '';
    this.statusEl.textContent = 'Setting up the board…';
    this.statusEl.className = 'status g2-status';
    this.endBtn.classList.add('hidden');
    this.toggleSheet(false);
    this.openChat(false);
    this.unread = 0;
    this.renderUnread();
    this.hidePeek();
  }

  setRoom(room: RoomInfo): void {
    this.room = room;
    this.renderPlayers();
    const waiting = !this.solo && !(room.players.white && room.players.black);
    this.resignBtn.textContent = waiting ? 'Cancel invite' : 'Resign';
    if (waiting && !this.view) this.statusEl.textContent = 'Waiting for an opponent…';
  }

  /** The newest game state. */
  sync(view: v2.PlayerView): void {
    if (this.review) {
      // Looking back: the game goes on aside, in the log and the step count, until the player comes back to it.
      this.review.live = view;
      for (const p of view.pieces) this.memory.set(p.id, { name: p.name, owner: p.owner });
      sound.setBattle(view.status.kind === 'playing');
      this.appendLog(view);
      this.renderNav();
      return;
    }
    const prev = this.view;
    const changed = prev !== null && view.seq !== this.lastSeq;
    this.view = view;
    for (const p of view.pieces) this.memory.set(p.id, { name: p.name, owner: p.owner });
    // A picked piece or a held card only makes sense against the position it was picked in.
    if (changed) {
      this.clearSelection();
      this.cancelDrag();
      this.cancelPieceDrag();
      this.closeRaise();
    }
    const playing = view.status.kind === 'playing';
    // Before queueFx, which takes the cards just dropped on squares (see `takeLanding`).
    if (changed && prev) this.queueSounds(view);
    else if (!prev && playing) sound.sfx?.battle();
    sound.setBattle(playing);
    if (changed && prev && this.fx.enabled) this.queueFx(prev, view);
    if (changed && prev && this.arena) this.arenaFx(prev, view);
    // After queueFx and arenaFx, which do not slide a piece that was dragged to its square.
    if (changed) {
      this.clearDropped();
      this.clearReturning();
      this.clearVanishing();
      for (const color of ['white', 'black'] as const) if (this.manaSend[color] === undefined) delete this.manaShown[color];
    }
    if (this.arena) {
      this.library.setCards(view.cards);
      // The library hands out the cards of the side to move, until it is switched.
      if (prev?.active !== view.active) this.library.setSide(view.active);
    }
    this.appendLog(view);
    this.render();
  }

  /** Refresh clocks (called every second by the host). The arena has none. */
  tick(): void {
    if (!this.arena) this.renderPlayers();
  }

  // -------------------------------------------------------------- looking back

  /** How many steps the game can be looked back through; null where it cannot (the arena, games begun before). */
  private get stepCount(): number | null {
    const live = this.review?.live ?? this.view;
    return this.arena || live?.steps === undefined ? null : live.steps;
  }

  /** The step shown or asked for; the step count while the game is shown as it is. */
  private get stepShown(): number {
    return this.wantStep ?? this.review?.step ?? this.stepCount ?? 0;
  }

  /** Show the game as it stood after `step` steps (0: as it began); after the last one, as it is. */
  private goTo(step: number): void {
    const count = this.stepCount;
    if (count === null || !this.view) return;
    const to = Math.max(0, Math.min(step, count));
    if (to === count) return this.toLive();
    if (to === this.stepShown) return;
    const known = this.pastViews.get(to);
    if (known) return this.showStep(to, known);
    this.wantStep = to;
    this.hooks.past(to);
    this.renderNav();
  }

  /** The server's answer to `hooks.past`, shown if that step is still the one wanted. */
  showPast(step: number, view: v2.PlayerView): void {
    this.pastViews.set(step, view);
    if (step === this.wantStep) this.showStep(step, view);
  }

  private showStep(step: number, view: v2.PlayerView): void {
    const prev = this.view;
    if (!prev) return;
    const from = this.review?.step ?? this.stepCount;
    this.wantStep = null;
    if (this.review) this.review.step = step;
    else this.review = { step, live: prev };
    this.root.classList.add('g2-reviewing');
    this.view = view;
    this.leavePosition(prev, view, from === step - 1);
    this.render();
    // The next step asked for is most often the one before.
    if (step > 0 && !this.pastViews.has(step - 1)) this.hooks.past(step - 1);
  }

  /** Back to the game as it is now. */
  private toLive(): void {
    this.wantStep = null;
    const review = this.review;
    if (!review || !this.view) return this.renderNav();
    const prev = this.view;
    this.review = null;
    this.root.classList.remove('g2-reviewing');
    this.view = review.live;
    this.leavePosition(prev, review.live, review.live.steps === review.step + 1);
    this.render();
  }

  /**
   * Another position takes the place of `prev`: what was picked or held in it goes. A single step on plays as it
   * happened, with its sounds and effects; any other change is shown at once.
   */
  private leavePosition(prev: v2.PlayerView, view: v2.PlayerView, stepOn: boolean): void {
    this.clearSelection();
    this.cancelDrag();
    this.cancelPieceDrag();
    this.closeRaise();
    this.clearDropped();
    this.clearReturning();
    this.clearVanishing();
    if (this.inspected?.kind === 'card') this.inspected = null;
    this.hoverCard = null;
    if (stepOn) {
      this.queueSounds(view);
      if (this.fx.enabled) this.queueFx(prev, view);
    } else {
      this.seenCards = null;
    }
  }

  private renderNav(): void {
    const count = this.stepCount;
    this.navEl.classList.toggle('hidden', count === null);
    this.liveEl.classList.toggle('hidden', !this.review);
    const waiting = !!this.review && this.myTurn;
    this.liveEl.classList.toggle('mine', waiting);
    this.liveEl.textContent = waiting ? 'Your turn · back to the game' : 'Back to the game';
    for (const line of this.logEl.querySelectorAll('.entry.shown')) line.classList.remove('shown');
    if (count === null) return;
    const at = this.stepShown;
    this.navFirst.disabled = this.navBack.disabled = at === 0;
    this.navNext.disabled = this.navLive.disabled = at >= count;
    this.navCount.textContent = `${at} / ${count}`;
    this.navCount.title = at >= count ? 'Steps so far' : `Step ${at} of ${count}`;
    if (!this.review) return;
    // The step shown, lit up in the log and scrolled into sight there.
    const lines = this.logEl.querySelectorAll<HTMLElement>(`.entry[data-step="${this.review.step}"]`);
    for (const line of lines) line.classList.add('shown');
    const first = lines[0];
    if (!first) return;
    const box = this.logEl.getBoundingClientRect();
    const where = first.getBoundingClientRect();
    if (where.top < box.top || where.bottom > box.bottom) this.logEl.scrollTop += where.top - box.top - box.height / 3;
  }

  /** What the step shown did, in the log's words. */
  private stepText(view: v2.PlayerView, step: number): string {
    if (step === 0) return 'The game as it began.';
    const line = describeEvents(view.events, view, this.hooks.names(), this.memory)[0]?.text;
    return line ? line.replace(/^— | —$/g, '') : `Step ${step}`;
  }

  // --------------------------------------------------------------------- board

  private buildBoard(): void {
    this.boardEl.innerHTML = '';
    this.cells.length = 0;
    const flipped = this.seat === 'black';
    // Rows top to bottom: the far side first.
    for (let row = 0; row < v2.RANKS; row++) {
      const rank = flipped ? row : v2.RANKS - 1 - row;
      for (let col = 0; col < v2.FILES; col++) {
        const file = flipped ? v2.FILES - 1 - col : col;
        const square = v2.sq(file, rank);
        const cell = el('div', `g2-cell ${(file + rank) % 2 === 0 ? 'dark' : 'light'}`);
        cell.dataset.sq = String(square);
        if (col === 0) cell.append(el('span', 'g2-coord rank', String(rank + 1)));
        if (row === v2.RANKS - 1) cell.append(el('span', 'g2-coord file', v2.FILE_NAMES[file]!));
        this.boardEl.appendChild(cell);
        this.cells[square] = cell;
      }
    }
    this.fx.attach();
    this.board3d?.layout();
  }

  private legal(): Action[] {
    return this.view?.legalActions ?? [];
  }

  /**
   * Squares the picked piece can move to (or spit lava onto, while it takes aim), with the action for each. Cards
   * are played by dragging them instead. A move that can promote is its plain form here; `act` offers the rest.
   */
  private targets(): Map<v2.Square, Action> {
    const from = this.selectedSquare;
    const out = new Map<v2.Square, Action>();
    if (from === null) return out;
    // A drag asks for this on every pointer move; the legal actions only change when the server answers.
    const held = this.pieceDrag;
    if (held && held.from === from && held.targets) return held.targets;
    const kind = this.aimLava === this.selectedSquare ? 'lava' : 'move';
    for (const a of this.legal()) {
      if (a.type === 'move' && a.promote) continue;
      if ((a.type === 'move' || a.type === 'lava') && a.type === kind && a.from === this.selectedSquare) out.set(a.to, a);
    }
    if (held && held.from === from) held.targets = out;
    return out;
  }

  /** The pieces a move onto the far row can promote into: one per card in your hand, by name. */
  private promotions(move: Action): { action: Action; card: v2.ViewCard | undefined; cardId: string }[] {
    const view = this.view;
    if (!view || move.type !== 'move') return [];
    const out: { action: Action; card: v2.ViewCard | undefined; cardId: string }[] = [];
    for (const a of this.legal()) {
      if (a.type !== 'move' || !a.promote || a.from !== move.from || a.to !== move.to) continue;
      const cardId = view.hand?.find((c) => c.uid === a.promote)?.cardId;
      if (cardId && !out.some((o) => o.cardId === cardId)) out.push({ action: a, card: view.cards[cardId], cardId });
    }
    return out;
  }

  /** Plays a picked target: a move onto the far row first asks what the piece becomes. */
  private act(target: Action): void {
    if (this.promotions(target).length) this.openPromote(target);
    else this.hooks.act(target);
  }

  /** Whether the piece on `square` can spit lava now (Lava Breath). */
  private canSpit(square: v2.Square): boolean {
    return this.legal().some((a) => a.type === 'lava' && a.from === square);
  }

  /** Take aim with the picked piece's Lava Breath, or put it away again. */
  private toggleLavaAim(square: v2.Square): void {
    const aiming = this.aimLava === square && this.selectedSquare === square;
    this.selectedSquare = square;
    this.aimLava = aiming ? null : square;
    if (!aiming) sound.sfx?.select();
    if (!this.docked) this.inspected = null;
    this.render();
  }

  /** Pitching a card in your hand for mana, if you can now. */
  private pitchAction(uid: string): Action | null {
    return this.legal().find((a) => a.type === 'pitch' && a.cardUid === uid) ?? null;
  }

  /** Squares holding one of your pieces that can move now: tap one to pick it up, or drag it. */
  private movers(view: v2.PlayerView): Set<v2.Square> {
    const out = new Set<v2.Square>();
    if (view.status.kind !== 'playing') return out;
    const mine = new Set(view.pieces.filter((p) => p.owner === view.you).map((p) => p.square));
    for (const a of view.legalActions) if (a.type === 'move' && mine.has(a.from)) out.add(a.from);
    return out;
  }

  private onSquare(square: v2.Square, quick = true): void {
    const view = this.view;
    if (!view) return;
    const playing = view.status.kind === 'playing';
    const target = playing ? this.targets().get(square) : undefined;
    if (target) {
      this.act(target);
      this.clearSelection();
      this.inspected = null;
      this.render();
      return;
    }
    // A Dragon that cannot move can still be picked to spit lava.
    const movable = this.movers(view).has(square) || (playing && this.canSpit(square));
    // A card floating over the board would hide the squares the piece can move to (see `startHold`).
    if (movable && !this.docked) this.inspected = null;
    else if (quick) this.toggleInspect(view, square);
    if (movable && this.selectedSquare !== square) {
      this.selectedSquare = square;
      this.aimLava = null;
      sound.sfx?.select();
    } else {
      this.clearSelection();
    }
    this.render();
  }

  private clearSelection(): void {
    this.selectedSquare = null;
    this.aimLava = null;
  }

  /** A tap on a piece or seal opens its card; tapping the same one again, or an empty square, closes it. */
  private toggleInspect(view: v2.PlayerView, square: v2.Square): void {
    const next = this.thingAt(view, square);
    const same = next && this.inspected?.kind === next.kind && this.inspected.id === next.id;
    this.inspected = same ? null : next;
  }

  private thingAt(view: v2.PlayerView, square: v2.Square): Inspected | null {
    const piece = view.pieces.find((p) => p.square === square);
    if (piece) return { kind: 'piece', id: piece.id };
    const seal = view.seals.find((s) => s.square === square);
    return seal ? { kind: 'seal', id: seal.id } : null;
  }

  private setBoardHover(square: v2.Square | null): void {
    const view = this.view;
    if (!view) return;
    const next = square === null ? null : this.thingAt(view, square);
    if (next?.kind === this.hoverBoard?.kind && next?.id === this.hoverBoard?.id) return;
    this.hoverBoard = next;
    this.renderInspect(view);
  }

  // ------------------------------------------------------------------- tokens

  private pieceToken(piece: v2.ViewPiece, view: v2.PlayerView): HTMLElement {
    const card = piece.cardId ? view.cards[piece.cardId] : undefined;
    const boardArt = card ? v2.faceArt(card, piece.owner).boardArt : undefined;
    const state = `${piece.active ? '' : ' sick'}${piece.shielded ? ' shielded' : ''}${piece.frozen ? ' frozen' : ''}`;
    const tribe = card?.tribe ? ` ${tribeClass(card.tribe)}` : '';
    // On the 3D board a figure stands there instead (as it does in the effects' copies of the token).
    const figured = this.board3d?.shows(figureName(piece, view)) ? ' figured' : '';
    const tok = el('div', `g2-piece ${piece.owner}${piece.king ? ' king' : ''}${tribe}${state}${boardArt ? ' art' : ''}${figured}`);
    if (boardArt) {
      const figure = el('span', 'g2-piece-art');
      figure.style.backgroundImage = `url("${boardArt}")`;
      tok.append(figure);
    } else tok.append(el('span', 'g2-piece-glyph', glyphFor(piece.kind, piece.name)));
    // The badge: what the piece moves like and its level, in its type's colour.
    if (card) {
      const badge = el('span', 'g2-piece-badge');
      badge.append(el('span', 'g2-piece-family', (card.line && LINE_GLYPH[card.line]) || glyphFor(piece.kind, piece.name)));
      if (card.level) badge.append(LEVEL_MARK[card.level] ?? String(card.level));
      tok.append(badge);
    }
    // An ember on a piece that has Lava Breath, burning bright while it can spit.
    if (piece.abilities?.includes('lavaBreath')) tok.append(el('span', `g2-piece-ember${this.canSpit(piece.square) ? ' ready' : ''}`));
    if (piece.shielded) tok.append(el('span', 'g2-piece-shield'));
    if (piece.frozen) tok.append(el('span', 'g2-piece-frost'));
    const resting = piece.justSummoned
      ? ' (just arrived: cannot move or capture until its owner\'s next turn, but still gives check)'
      : piece.active ? '' : ' (summoning sickness: cannot capture yet, but still gives check)';
    const line = card?.line ? ` · ${card.line} level ${card.level}` : '';
    const learned = piece.abilities?.length ? ` · ${piece.abilities.map((a) => v2.ABILITIES[a].name).join(', ')}` : '';
    const shield = piece.shielded ? ' · Shielded: cannot be captured until its owner\'s next turn' : '';
    const frozen = piece.frozen ? ` · Frozen: cannot move or capture ${this.frozenWhen(piece, view)}` : '';
    tok.title = `${piece.name}${line}${learned}${shield}${frozen}${resting}`;
    return tok;
  }

  /** The pieces as the 3D board stands them up: each one's figure, where it stands, and what is on it. */
  private figures(view: v2.PlayerView, board = this.board3d): Figure[] {
    if (!board) return [];
    const out: Figure[] = [];
    for (const piece of view.pieces) {
      const name = figureName(piece, view);
      // Taken off the board in the arena: its figure is already on its way out (see `takeOff`).
      if (!board.shows(name) || piece.square === this.vanishing?.square) continue;
      const card = piece.cardId ? view.cards[piece.cardId] : undefined;
      // Dropped on a square: it waits there for the server, as its flat copy does.
      const square = piece.square === this.dropped?.from ? this.dropped.to : piece.square;
      const family = card ? (card.line && LINE_GLYPH[card.line]) || glyphFor(piece.kind, piece.name) : '';
      const fx = this.tokenFx.get(piece.id);
      out.push({
        id: piece.id,
        name,
        square,
        owner: piece.owner,
        height: piece.king ? KING_HEIGHT : (FIGURE_HEIGHT[card?.level ?? 1] ?? 1),
        ring: piece.king ? KING_RING[piece.owner] : this.ringColor(tribeClass(card?.tribe)),
        badge: card ? `${family}${LEVEL_MARK[card.level ?? 0] ?? ''}` : '',
        picked: square === this.selectedSquare,
        sick: !piece.active,
        shielded: !!piece.shielded,
        frozen: !!piece.frozen,
        ember: piece.abilities?.includes('lavaBreath') ? (this.canSpit(piece.square) ? 'ready' : 'idle') : 'none',
        ...(fx?.kind === 'fx-rise' ? { riseAt: fx.at } : {}),
      });
    }
    return out;
  }

  /** A type's colour: its tribe class's --line in style.css. */
  private ringColor(tribe: string): string {
    let color = this.rings.get(tribe);
    if (!color) {
      const probe = el('div', `g2-piece ${tribe}`);
      probe.style.display = 'none';
      this.boardEl.append(probe);
      color = getComputedStyle(probe).getPropertyValue('--line').trim() || '#c99d50';
      probe.remove();
      this.rings.set(tribe, color);
    }
    return color;
  }

  /** "this turn" while a frozen piece's owner plays, "on its owner's next turn" before that. */
  private frozenWhen(piece: v2.ViewPiece, view: v2.PlayerView): string {
    return view.active === piece.owner ? 'this turn' : "on its owner's next turn";
  }

  private sealToken(seal: v2.ViewSeal, view: v2.PlayerView): HTMLElement {
    const name = view.cards[seal.cardId]?.name ?? seal.cardId;
    const tok = el('div', `g2-seal ${seal.owner}`);
    const timer = el('span', 'g2-seal-timer');
    timer.append(hourglass(), String(seal.timer));
    tok.append(cardBack('g2-seal-back'), timer, el('span', 'g2-seal-name', name));
    tok.title = `Sacrifice: ${name} arrives in ${seal.timer} of ${seal.owner === view.you ? 'your' : "its owner's"} turn${seal.timer === 1 ? '' : 's'}`;
    return tok;
  }

  /** A pool of lava on the board, with how many of the other player's turns it still blocks. */
  private lavaPool(lava: v2.ViewLava, view: v2.PlayerView): HTMLElement {
    const pool = el('div', 'g2-lava');
    pool.append(el('span', 'g2-lava-turns', String(lava.turnsLeft)));
    const victim = v2.opposite(lava.by);
    const whose = this.solo ? `${sideName(victim)}'s` : victim === view.you ? 'your' : "your opponent's";
    const turns = `${lava.turnsLeft} more of ${whose} turn${lava.turnsLeft === 1 ? '' : 's'}`;
    pool.title = `Lava: no piece can move onto it or be summoned onto it for ${turns}. Pieces can still pass over it.`;
    return pool;
  }

  private applyTokenFx(tok: HTMLElement, id: string, now: number): void {
    const fx = this.tokenFx.get(id);
    if (!fx) return;
    const elapsed = now - fx.at;
    if (elapsed >= TOKEN_FX_MS[fx.kind]) {
      this.tokenFx.delete(id);
      return;
    }
    tok.classList.add(fx.kind);
    tok.style.animationDelay = `${Math.round(-elapsed)}ms`;
    for (const [k, v] of Object.entries(fx.vars ?? {})) tok.style.setProperty(k, v);
  }

  // ---------------------------------------------------------------------- effects

  /** A card face for an effect: the summoned card diving in, or the spell shown over the board. */
  private cardFace(cardId: string | null, owner: Color, view: v2.PlayerView): HTMLElement | null {
    if (!cardId) return null;
    const card = view.cards[cardId];
    return card ? fillFrame(el('div'), this.frameFor(card, cardId, owner)) : null;
  }

  /** Sounds for what the last action did, in step with the effects `queueFx` shows for it. */
  private queueSounds(view: v2.PlayerView): void {
    const sfx = sound.sfx;
    if (!sfx) return;
    const now = performance.now();
    const { turnAt, spellAt } = fxDelays(view);
    let ticked = false;
    let cooled = false;
    for (const e of view.events) {
      switch (e.type) {
        case 'summoned':
        case 'deployed': {
          const cardId = view.pieces.find((p) => p.id === e.pieceId)?.cardId;
          const cost = cardId ? (view.cards[cardId]?.cost ?? 0) : 0;
          sfx.summon(e.color, !this.wasDropped(e.square, now), Math.min(1, cost / 5), this.untilImpact(e.square, now));
          break;
        }
        case 'moved':
          sfx.move();
          break;
        case 'captured':
          sfx.capture(150);
          break;
        case 'sealDestroyed':
          sfx.shatter(spellAt || 150);
          break;
        case 'sealed':
          sfx.seal(this.wasDropped(e.square, now));
          break;
        case 'evolved': {
          const cardId = view.pieces.find((p) => p.id === e.pieceId)?.cardId;
          sfx.evolve(e.color, !this.wasDropped(e.square, now), evolveForce(cardId ? view.cards[cardId] : undefined));
          break;
        }
        case 'spellPlayed':
          sfx.spell(e.cardId, spellAt);
          break;
        case 'raised': {
          const cost = view.cards[e.cardId]?.cost ?? 0;
          sfx.summon(e.color, true, Math.min(1, cost / 5), spellAt);
          break;
        }
        case 'sealTick':
          // Several seals counting down at once still make one tick.
          if (!ticked) sfx.tick(turnAt);
          ticked = true;
          break;
        case 'hatched':
          sfx.hatch(e.color, turnAt);
          break;
        case 'pitched':
          sfx.pitch();
          break;
        case 'lava':
          sfx.lava();
          break;
        case 'lavaCooled':
          if (!cooled) sfx.cool(turnAt);
          cooled = true;
          break;
        case 'shrinesMoved':
          sfx.shift(turnAt, SHIFT_LAND_MS);
          break;
        default:
          break;
      }
    }
    // With the banner (see `queueBanner`).
    const at = turnAt + this.shiftDelay(view) + 150;
    const over = view.events.find((e): e is Extract<v2.GameEvent, { type: 'gameOver' }> => e.type === 'gameOver');
    if (over) {
      const tone = this.resultBanner(over.status, view)[1];
      if (tone === 'win') sfx.victory(at);
      else if (tone === 'lose') sfx.defeat(at);
      else sfx.stalemate(at);
      return;
    }
    const started = view.events.find((e): e is Extract<v2.GameEvent, { type: 'turnStarted' }> => e.type === 'turnStarted');
    if (!started) return;
    if (view.events.some((e) => e.type === 'check')) sfx.check(at);
    else if (!this.solo && started.color === view.you) sfx.chime(at);
  }

  /** Effects for what the last action did: its own first, then the next turn's (hatching, the banner). */
  private queueFx(prev: v2.PlayerView, view: v2.PlayerView): void {
    const now = performance.now();
    for (const [id, fx] of this.tokenFx) if (now - fx.at > 5000) this.tokenFx.delete(id);
    const pieceBefore = new Map(prev.pieces.map((p) => [p.id, p]));
    const sealBefore = new Map(prev.seals.map((s) => [s.id, s]));
    const { turnAt, spellAt } = fxDelays(view);
    for (const e of view.events) {
      switch (e.type) {
        case 'summoned':
        case 'deployed': {
          const piece = view.pieces.find((p) => p.id === e.pieceId);
          if (!piece) break;
          const impact = this.untilImpact(e.square, now);
          const card = this.takeLanding(e.square, now) ? null : this.cardFace(piece.cardId, piece.owner, view);
          const cost = piece.cardId ? (view.cards[piece.cardId]?.cost ?? 0) : 0;
          this.fx.summon(e.square, piece.owner, card, impact, Math.min(1, cost / 5));
          this.tokenFx.set(piece.id, { kind: 'fx-rise', at: now + impact + (card ? CARD_DIVE_MS : 0) });
          break;
        }
        case 'moved': {
          if (this.dropped?.from === e.from && this.dropped.to === e.to) break;
          const from = this.cells[e.from];
          const to = this.cells[e.to];
          if (!from || !to) break;
          const vars = { '--from-x': `${from.offsetLeft - to.offsetLeft}px`, '--from-y': `${from.offsetTop - to.offsetTop}px` };
          this.tokenFx.set(e.pieceId, { kind: 'fx-slide', at: now, vars });
          break;
        }
        case 'captured': {
          const victim = pieceBefore.get(e.pieceId);
          if (victim) this.fx.vanish(e.square, this.pieceToken(victim, prev), 'capture', 150);
          this.board3d?.leave(e.pieceId, 'capture', 150);
          if (e.bounty) this.fx.gain(e.square, `+${e.bounty} mana`, 450);
          break;
        }
        case 'lava':
          this.fx.lava(e.from, e.square);
          this.tokenFx.set(`lava:${e.square}`, { kind: 'fx-lava-in', at: now + LAVA_FLIGHT_MS });
          break;
        case 'learned':
          this.fx.learn(e.square, spellAt);
          break;
        case 'lavaCooled':
          this.fx.cool(e.square, turnAt);
          break;
        case 'sealDestroyed': {
          const seal = sealBefore.get(e.sealId);
          if (seal) this.fx.vanish(e.square, this.sealToken(seal, prev), 'shatter', spellAt || 150);
          break;
        }
        case 'sealed': {
          const impact = this.untilImpact(e.square, now);
          const consumed = pieceBefore.get(e.consumedPieceId);
          if (consumed) this.fx.vanish(e.square, this.pieceToken(consumed, prev), 'consume', impact + 80);
          this.board3d?.leave(e.consumedPieceId, 'consume', impact + 80);
          this.fx.seal(e.square, e.color, this.takeLanding(e.square, now) ? null : cardBack(), impact);
          this.tokenFx.set(e.sealId, { kind: 'fx-seal-in', at: now + impact });
          break;
        }
        case 'evolved': {
          const piece = view.pieces.find((p) => p.id === e.pieceId);
          if (!piece) break;
          const old = pieceBefore.get(e.fromPieceId);
          const card = this.takeLanding(e.square, now) ? null : this.cardFace(piece.cardId, piece.owner, view);
          const force = evolveForce(piece.cardId ? view.cards[piece.cardId] : undefined);
          this.fx.evolve(e.square, e.color, old ? this.pieceToken(old, prev) : null, card, force);
          this.board3d?.leave(e.fromPieceId, 'consume', (card ? CARD_DIVE_MS : 0) + HATCH_T0_MS, e.square);
          this.tokenFx.set(piece.id, { kind: 'fx-rise', at: now + (card ? CARD_DIVE_MS : 0) + HATCH_RISE_DELAY });
          break;
        }
        case 'spellPlayed': {
          const card = this.cardFace(e.cardId, e.color, view);
          if (!card) break;
          const color = e.color;
          const held = this.pileHeld[color];
          const length = held && performance.now() < held.until ? held.length : prev.discard[color].length;
          this.pileHeld[color] = { length, until: performance.now() + SPELL_LANDS_MS + 400 };
          window.setTimeout(() => this.renderPlayers(), SPELL_LANDS_MS + 420);
          this.fx.spell(
            card,
            color,
            () => this.pileTarget(color),
            () => {
              delete this.pileHeld[color];
              this.renderPlayers();
            },
          );
          break;
        }
        case 'raised': {
          const card = this.cardFace(e.cardId, e.color, view);
          const cost = view.cards[e.cardId]?.cost ?? 0;
          this.fx.summon(e.square, e.color, card, spellAt, Math.min(1, cost / 5));
          this.tokenFx.set(e.pieceId, { kind: 'fx-rise', at: now + spellAt + (card ? CARD_DIVE_MS : 0) });
          break;
        }
        case 'shielded':
          this.fx.shield(e.square, spellAt);
          break;
        case 'frozen':
          this.fx.freeze(e.square, spellAt);
          break;
        case 'destroyed': {
          const victim = pieceBefore.get(e.pieceId);
          if (victim) this.fx.smite(e.square, this.pieceToken(victim, prev), spellAt);
          this.board3d?.leave(e.pieceId, 'capture', spellAt + 90);
          break;
        }
        case 'manaGained':
          this.manaPop(e.color, `+${e.mana} mana`, spellAt);
          break;
        case 'sealTick': {
          const seal = view.seals.find((s) => s.id === e.sealId);
          if (!seal) break;
          this.fx.tick(seal.square, turnAt);
          this.tokenFx.set(seal.id, { kind: 'fx-tick', at: now + turnAt });
          break;
        }
        case 'hatched': {
          const old = [...sealBefore.values()].find((s) => s.square === e.square);
          this.fx.hatch(e.square, e.color, old ? this.sealToken(old, prev) : null, turnAt);
          this.tokenFx.set(e.pieceId, { kind: 'fx-rise', at: now + turnAt + HATCH_RISE_DELAY });
          break;
        }
        case 'turnStarted':
          e.held?.forEach((square, i) => this.fx.gain(square, '+1 mana', turnAt + 120 * i));
          break;
        case 'shrinesMoved':
          this.startShift(e.from, e.to, turnAt);
          break;
        default:
          break;
      }
    }
    this.queueBanner(view, turnAt + this.shiftDelay(view));
  }

  /**
   * The mana squares ran dry and move, `delay` ms from now: the old ones burst, a banner says so, pillars of mana come
   * down on the new ones, so both sides see what changed.
   *
   * Nothing is taken away from the player while it plays. This used to set `pointer-events: none` on the whole screen
   * for the length of the animation, which on a slow phone (where the timers ran late) left the board dead for
   * seconds: a press on a card did nothing, and the drag the player started after it landed somewhere else. The
   * effects still hide the old squares and the banners still play; the board just stays answerable throughout.
   */
  private startShift(from: v2.Square[], to: v2.Square[], delay: number): void {
    const now = performance.now();
    this.shift = { from: new Set(from), gone: now + delay + SHIFT_GONE_MS, land: now + delay + SHIFT_LAND_MS };
    this.fx.shiftShrines(from, to, delay);
    this.fx.banner('The mana moves', 'mana', to.map(v2.squareName).join(' · '), delay + SHIFT_GONE_MS);
    for (const at of [SHIFT_GONE_MS, SHIFT_LAND_MS]) window.setTimeout(() => this.render(), delay + at + 20);
    window.clearTimeout(this.shiftTimer);
    this.shiftTimer = window.setTimeout(() => {
      this.endShift();
      this.render();
    }, delay + SHIFT_MS);
  }

  private endShift(): void {
    window.clearTimeout(this.shiftTimer);
    this.shift = null;
    this.root.classList.remove('g2-pausing');
  }

  /** How much later the next turn's banner and chime come when the mana squares move first. */
  private shiftDelay(view: v2.PlayerView): number {
    return this.fx.enabled && view.events.some((e) => e.type === 'shrinesMoved') ? SHIFT_LAND_MS + 250 : 0;
  }

  private queueBanner(view: v2.PlayerView, at: number): void {
    const over = view.events.find((e): e is Extract<v2.GameEvent, { type: 'gameOver' }> => e.type === 'gameOver');
    if (over) {
      const [text, tone, sub] = this.resultBanner(over.status, view);
      this.fx.banner(text, tone, sub, at + 150);
      return;
    }
    const started = view.events.find((e): e is Extract<v2.GameEvent, { type: 'turnStarted' }> => e.type === 'turnStarted');
    if (!started) return;
    const mine = !this.solo && started.color === view.you;
    if (view.events.some((e) => e.type === 'check')) {
      const whose = this.solo ? `${sideName(started.color)}'s King` : mine ? 'Your King' : "Your opponent's King";
      this.fx.banner('Check', 'check', `${whose} is under attack`, at + 150);
    } else if (this.solo) {
      this.fx.banner(`${sideName(started.color)} to play`, 'turn', '', at + 150);
    } else if (mine) {
      this.fx.banner('Your turn', 'turn', '', at + 150);
    }
  }

  private resultBanner(status: v2.GameStatus, view: v2.PlayerView): [string, BannerTone, string] {
    if (status.kind === 'playing') return ['', 'draw', ''];
    if (status.kind === 'stalemate') return ['Stalemate', 'draw', 'The game is a draw'];
    const how = status.kind === 'checkmate' ? 'Checkmate' : status.kind === 'timeout' ? 'Out of time' : 'By resignation';
    if (this.solo) return [`${sideName(status.winner)} wins`, 'win', how];
    return status.winner === view.you ? ['Victory', 'win', how] : ['Defeat', 'lose', how];
  }

  /** Fly a dropped card into its square; the summon that follows then skips showing it again. */
  private land(ghost: HTMLElement, square: v2.Square): void {
    const cell = this.cells[square];
    if (cell && this.fx.enabled) this.landed.set(square, performance.now());
    this.sinkInto(ghost, cell?.getBoundingClientRect());
  }

  /** A dropped card shrinks into `box` and fades. */
  private sinkInto(ghost: HTMLElement, box: DOMRect | undefined): void {
    if (!box || !this.fx.enabled) {
      ghost.remove();
      return;
    }
    ghost.classList.add('landing');
    ghost.style.left = `${box.left + box.width / 2 - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${box.top + box.height / 2 - ghost.offsetHeight / 2}px`;
    setTimeout(() => ghost.remove(), 300);
  }

  /** A dropped spell flies to the middle of the board and fades, where the spell is then shown big. */
  private castAway(ghost: HTMLElement): void {
    if (!this.fx.enabled) {
      ghost.remove();
      return;
    }
    const box = this.boardEl.getBoundingClientRect();
    ghost.classList.add('casting');
    ghost.style.left = `${box.left + box.width / 2 - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${box.top + box.height / 2 - ghost.offsetHeight / 2}px`;
    setTimeout(() => ghost.remove(), 300);
  }

  /** A pitched card shrinks into your mana gem and burns away. */
  private burnAway(ghost: HTMLElement, gem: DOMRect | undefined): void {
    if (!gem || !this.fx.enabled) {
      ghost.remove();
      return;
    }
    ghost.classList.add('pitching');
    ghost.style.left = `${gem.left + gem.width / 2 - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${gem.top + gem.height / 2 - ghost.offsetHeight / 2}px`;
    setTimeout(() => ghost.remove(), 420);
  }

  private wasDropped(square: v2.Square, now: number): boolean {
    const at = this.landed.get(square);
    return at !== undefined && now - at < 4000;
  }

  private takeLanding(square: v2.Square, now: number): boolean {
    const dropped = this.wasDropped(square, now);
    this.landed.delete(square);
    return dropped;
  }

  // ------------------------------------------------------------------- inspect

  private inspectedSquare(view: v2.PlayerView): v2.Square | null {
    const it = this.inspected;
    if (!it || it.kind === 'card') return null;
    const found = it.kind === 'piece' ? view.pieces.find((p) => p.id === it.id) : view.seals.find((s) => s.id === it.id);
    return found ? found.square : null;
  }

  /** Nothing to show: a card back beside the board, nothing over it. */
  private renderEmptyInspect(): void {
    const box = this.inspectEl;
    if (!this.docked) {
      box.className = 'g2-inspect hidden';
      box.replaceChildren();
      this.inspectKey = '';
      return;
    }
    if (this.inspectKey === 'empty') return;
    this.inspectKey = 'empty';
    box.className = 'g2-inspect empty';
    box.removeAttribute('title');
    box.replaceChildren(cardBack('g2-inspect-card'));
  }

  private exists(view: v2.PlayerView, it: Inspected): boolean {
    if (it.kind === 'library') return this.arena && view.cards[it.id] !== undefined;
    if (it.kind === 'card') return !!view.hand?.some((c) => c.uid === it.id);
    if (it.kind === 'discard') return (view.discard[it.id as Color]?.length ?? 0) > 0;
    if (it.kind === 'piece') return view.pieces.some((p) => p.id === it.id);
    return view.seals.some((s) => s.id === it.id);
  }

  /**
   * Shows, in order: the hand card, library card or discard pile under the mouse, the piece or seal under the mouse,
   * the one tapped.
   */
  private renderInspect(view: v2.PlayerView): void {
    const box = this.inspectEl;
    if (this.hoverCard && !view.hand?.some((c) => c.uid === this.hoverCard)) this.hoverCard = null;
    if (this.hoverLib && !this.exists(view, { kind: 'library', id: this.hoverLib })) this.hoverLib = null;
    if (this.hoverPile && !view.discard[this.hoverPile].length) this.hoverPile = null;
    if (this.hoverBoard && !this.exists(view, this.hoverBoard)) this.hoverBoard = null;
    if (this.inspected && !this.exists(view, this.inspected)) this.inspected = null;
    const shown: Inspected | null = this.hoverCard
      ? { kind: 'card', id: this.hoverCard }
      : this.hoverLib
        ? { kind: 'library', id: this.hoverLib }
        : this.hoverPile
          ? { kind: 'discard', id: this.hoverPile }
          : (this.hoverBoard ?? this.inspected);
    const handCard = shown?.kind === 'card' ? view.hand?.find((c) => c.uid === shown.id) : undefined;
    const libCard = shown?.kind === 'library' ? view.cards[shown.id] : undefined;
    const piece = shown?.kind === 'piece' ? view.pieces.find((p) => p.id === shown.id) : undefined;
    const seal = shown?.kind === 'seal' ? view.seals.find((s) => s.id === shown.id) : undefined;
    const pileOf = shown?.kind === 'discard' ? (shown.id as Color) : undefined;
    const pile = pileOf ? view.discard[pileOf] : [];
    const discarded = pile.find((c) => c.uid === shown?.pick) ?? pile.at(-1);

    let frame: FrameCard;
    let card: v2.ViewCard | undefined;
    let owner: Color = view.you;
    const notes: string[] = [];
    const buttons: HTMLButtonElement[] = [];
    let strip: HTMLElement | null = null;
    if (handCard) {
      card = view.cards[handCard.cardId];
      frame = this.frameFor(card, handCard.cardId, owner);
      // A spell's detail already says where to drop it.
      if (card?.type !== 'spell' || !card.detail) notes.push(this.howToPlay(handCard.uid, card));
      if (card?.type === 'piece' && card.detail) notes.push(card.detail);
      const next = this.evolvesInto(handCard.cardId, view);
      if (next) notes.push(next);
      const pitch = this.pitchAction(handCard.uid);
      if (pitch) {
        buttons.push(
          this.inspectButton(`Pitch it: +${v2.PITCH_MANA} mana`, 'Discard this card for mana. Once a turn.', 'mana', () =>
            this.hooks.act(pitch),
          ),
        );
      }
    } else if (piece) {
      card = piece.cardId ? view.cards[piece.cardId] : undefined;
      owner = piece.owner;
      if (piece.king) {
        frame = { kind: 'king', id: 'king', name: piece.name, text: v2.describeMovement(v2.KING), glyph: glyphFor(piece.kind, piece.name), owner, rules: v2.KING.rules };
      } else {
        frame = this.frameFor(card, piece.kind, owner, piece.name, piece.abilities);
      }
      if (piece.justSummoned) notes.push('Just arrived: cannot move or capture until its owner\'s next turn, but still gives check.');
      else if (!piece.active) notes.push('Summoning sickness: cannot capture yet, but still gives check.');
      if (piece.shielded) notes.push('Shielded: cannot be captured, and enemy spells cannot touch it, until its owner\'s next turn.');
      if (piece.frozen) notes.push(`Frozen: cannot move or capture ${this.frozenWhen(piece, view)}. It still gives check.`);
      for (const a of piece.abilities ?? []) notes.push(`${v2.ABILITIES[a].name}: ${v2.ABILITIES[a].text}`);
      if (card?.type === 'piece' && card.detail) notes.push(card.detail);
      const next = piece.cardId ? this.evolvesInto(piece.cardId, view) : null;
      if (next) notes.push(next);
      if (this.canSpit(piece.square)) {
        const aiming = this.aimLava === piece.square && this.selectedSquare === piece.square;
        const square = piece.square;
        buttons.push(
          this.inspectButton(
            aiming ? 'Put the lava away' : `Spit lava: ${v2.LAVA_COST} mana`,
            `Pick an empty square it could move to. Lava blocks it for ${v2.LAVA_TURNS} of the other player's turns.`,
            'lava',
            () => this.toggleLavaAim(square),
          ),
        );
      }
      if (this.arena && !piece.king) buttons.push(this.removeButton(piece.square));
    } else if (seal) {
      card = view.cards[seal.cardId];
      owner = seal.owner;
      frame = this.frameFor(card, seal.cardId, owner);
      const whose = this.solo ? `${sideName(owner)}'s` : owner === view.you ? 'your' : "your opponent's";
      const when = seal.timer <= 1 ? `at the start of ${whose} next turn` : `in ${seal.timer} of ${whose} turns`;
      notes.push(`A sacrifice: this piece arrives ${when}.`);
      if (this.arena) buttons.push(this.removeButton(seal.square));
    } else if (libCard) {
      card = libCard;
      owner = this.library.side;
      frame = this.frameFor(card, card.id, owner);
      if (card.type === 'piece' && card.detail) notes.push(card.detail);
      const next = this.evolvesInto(card.id, view);
      if (next) notes.push(next);
    } else if (pileOf && discarded) {
      card = view.cards[discarded.cardId];
      owner = pileOf;
      frame = this.frameFor(card, discarded.cardId, owner);
      const whose = this.solo ? `${sideName(owner)}'s` : owner === view.you ? 'your' : "your opponent's";
      const count = `${pile.length} card${pile.length === 1 ? '' : 's'}`;
      notes.push(`${discarded === pile.at(-1) ? 'The newest card in' : 'In'} ${whose} discard pile (${count}).`);
      if (card?.type === 'piece' && card.detail) notes.push(card.detail);
      // Kept here by a click: the whole pile, newest first, to look through.
      if (shown === this.inspected) strip = this.pileStrip(pileOf, discarded.uid, view);
    } else {
      this.renderEmptyInspect();
      return;
    }

    const key =
      handCard ? `card:${handCard.uid}`
      : piece ? `piece:${piece.id}`
      : seal ? `seal:${seal.id}`
      : libCard ? `library:${libCard.id}:${owner}`
      : `discard:${pileOf}:${discarded!.uid}`;
    const entering = key !== this.inspectKey;
    this.inspectKey = key;
    // Floating over the board: over the half away from the piece; a hand card goes up top, clear of your back row.
    const at = piece ?? seal;
    const atBottom = at !== undefined && this.screenRow(at.square) < v2.RANKS / 2;
    const place = this.docked ? '' : atBottom ? ' at-bottom' : ' at-top';
    box.className = `g2-inspect${place}${entering ? ' enter' : ''}${this.drag?.ghost ? ' hidden' : ''}`;
    if (this.docked) box.removeAttribute('title');
    else box.title = 'Tap to close';

    const face = fillFrame(el('div', 'g2-inspect-card'), frame);
    tiltWithPointer(face);

    const info = el('div', 'g2-inspect-info');
    const head = el('div', 'g2-inspect-head');
    const title = el('div', 'g2-inspect-title', seal ? `Sacrifice: ${frame.name}` : frame.name);
    const chips = el('div', 'g2-inspect-chips');
    if (!handCard) chips.append(el('span', `g2-chip owner ${owner}`, this.ownerLabel(owner, view)));
    if (card) chips.append(el('span', 'g2-chip mana', `◆ ${card.cost} mana`));
    if (card?.line) chips.append(el('span', 'g2-chip line', `${card.line} · level ${card.level}`));
    if (card?.type === 'piece' && card.sealTimer !== undefined) {
      const timer = el('span', 'g2-chip timer');
      timer.append(hourglass(), ` sacrifice timer ${card.sealTimer}`);
      chips.append(timer);
    }
    head.append(title, chips);
    const pinned = !this.hoverCard && !this.hoverLib && !this.hoverBoard && this.inspected !== null;
    if (pinned || !this.docked) {
      const close = el('button', 'g2-inspect-close', '×');
      close.type = 'button';
      close.title = 'Close';
      head.append(close);
    }
    info.append(head);

    if (frame.rules) {
      const boardArt = card?.type === 'piece' ? v2.faceArt(card, owner).boardArt : undefined;
      info.append(
        el('div', 'g2-inspect-label', 'How it moves'),
        movementPanel({ rules: frame.rules, owner, glyph: frame.glyph, art: boardArt }, this.seat === 'black'),
      );
    } else if (card?.type === 'spell') {
      info.append(el('div', 'g2-inspect-label', 'What it does'), el('p', 'g2-inspect-spell', card.detail ?? card.text));
      if (handCard) info.append(el('p', 'g2-inspect-note', 'Not while your King is in check.'));
    }
    for (const n of notes) info.append(el('p', 'g2-inspect-note', n));
    if (strip) info.append(el('div', 'g2-inspect-label', 'The whole pile, newest first'), strip);
    if (buttons.length) {
      const row = el('div', 'g2-inspect-actions');
      row.append(...buttons);
      info.append(row);
    }
    box.replaceChildren(face, info);
  }

  /** Arena: take a piece or sacrifice off the board from the card viewer. */
  private removeButton(square: v2.Square): HTMLButtonElement {
    return this.inspectButton('Remove', 'Take it off the board', 'remove', () => this.hooks.arena({ type: 'remove', square }));
  }

  /** A button in the card viewer; using it closes a viewer that floats over the board. */
  private inspectButton(text: string, title: string, tone: 'mana' | 'lava' | 'remove', run: () => void): HTMLButtonElement {
    const btn = el('button', `g2-inspect-action ${tone}`, text);
    btn.type = 'button';
    btn.title = title;
    btn.onclick = (e) => {
      e.stopPropagation();
      if (!this.docked) this.inspected = null;
      this.hoverCard = null;
      run();
      this.render();
    };
    return btn;
  }

  private howToPlay(uid: string, card: v2.ViewCard | undefined): string {
    if (card?.type === 'spell') {      if (card.grants) {
        const who = card.tribe ? `one of your ${card.tribe}s` : 'one of your pieces';
        return `Drag it onto ${who} to teach it ${v2.ABILITIES[card.grants].name}.`;
      }
      switch (card.spell) {
        case 'raise':
          return `Drag it onto a free square of your first two rows, then pick a piece card that costs ${card.maxCost} or less from your discard pile, where the pieces you capture go too: it rises there as your piece.`;
        case 'shield':
          return 'Drag it onto one of your pieces (not the King): nothing can capture it until your next turn.';
        case 'freeze':
          return "Drag it onto an enemy piece (not the King): it cannot move or capture on its owner's next turn.";
        case 'destroyPiece':
          return `Drag it onto an enemy piece (not the King) that costs ${card.maxCost} or less to destroy it.`;
        default:
          break;
      }
      const targeted = this.legal().some((a) => a.type === 'spell' && a.cardUid === uid && a.target !== undefined);
      return `Drag it ${targeted ? 'onto a glowing target' : 'onto the board'} to cast it.`;
    }
    if (card?.evolvesFrom) {
      const cards = this.view?.cards ?? {};
      const from = cards[card.evolvesFrom];
      // A line begun by more than one card: the Squire is the Warrior's other first level.
      const also = (card.evolvesFromAlso ?? []).map((id) => cards[id]?.name ?? id);
      const names = [from?.name ?? card.evolvesFrom, ...also];
      const fromText = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]!;
      // A level-2 card can also go onto an Initiate (any path), for its own cost plus the level it skips.
      const anyPath = from && !from.evolvesFrom ? Object.values(cards).find((c) => c.anyPath) : undefined;
      const alsoPath = anyPath ? ` (or onto ${/^[aeiou]/i.test(anyPath.name) ? 'an' : 'a'} ${anyPath.name}, paying ${from!.name}'s ${from!.cost} mana as well)` : '';
      return `Drag it onto your ${fromText}${alsoPath} to evolve it, if that piece was already on the board when your turn began. The new piece can move from your next turn.`;
    }
    return 'Drag it to a free square on your first two rows to summon it, or onto one of your pieces (not the King) to sacrifice that piece for it.';
  }

  /** "Evolves into Mystic Dragon." for a card with a next level in this game's cards. */
  private evolvesInto(cardId: string, view: v2.PlayerView): string | null {
    // The next level up: it names this card as the one it evolves from, or as one of its first levels (`evolvesFromAlso`).
    const next = Object.values(view.cards)
      .filter((c) => c.evolvesFrom === cardId || (c.evolvesFromAlso ?? []).includes(cardId))
      .map((c) => c.name);
    return next.length ? `Evolves into ${next.join(' or ')}.` : null;
  }

  /**
   * The frame for a card, or for a piece whose card is missing from the view (name only). A piece on the board
   * also shows the abilities spells taught it (`learned`).
   */
  private frameFor(card: v2.ViewCard | undefined, kind: string, owner: Color, name = card?.name ?? kind, learned: readonly v2.Ability[] = []): FrameCard {
    const taught = learned.map((a) => v2.ABILITIES[a].name);
    if (!card) return { kind: 'piece', id: kind, name, text: '', glyph: glyphFor(kind, name), owner, learned: taught };
    return frameOfCard(card, owner, this.view?.cards ?? {}, taught);
  }

  /** 0 for the top row of the board as this player sees it. */
  private screenRow(square: v2.Square): number {
    const rank = v2.rankOf(square);
    return this.seat === 'black' ? rank : v2.RANKS - 1 - rank;
  }

  private ownerLabel(owner: Color, view: v2.PlayerView): string {
    const side = sideName(owner);
    if (this.solo) return side;
    return `${side} (${owner === view.you ? 'yours' : 'opponent'})`;
  }

  // ---------------------------------------------------------------------- hand

  /** Whether the server lists anything this card can do right now. */
  private playable(uid: string): boolean {
    return this.legal().some((a) => 'cardUid' in a && a.cardUid === uid);
  }

  /** A spell that needs no target is cast by dropping it anywhere on the board. */
  private untargetedSpell(uid: string): Action | null {
    const spell = this.legal().filter((a) => a.type === 'spell' && a.cardUid === uid);
    return spell.length === 1 && spell[0]!.type === 'spell' && spell[0]!.target === undefined ? spell[0]! : null;
  }

  private cardTile(uid: string, cardId: string, view: v2.PlayerView): HTMLElement {
    const card = view.cards[cardId];
    const playable = this.playable(uid);
    const liftable = this.canLift(view, cardId);
    const lifted = this.drag?.ghost && this.drag.uid === uid;
    const tile = el(
      'button',
      `g2-card ${card?.type ?? ''}${playable ? ' playable' : ''}${liftable ? ' draggable' : ''}${lifted ? ' lifted' : ''}${this.inspected?.kind === 'card' && this.inspected.id === uid ? ' inspected' : ''}`,
    );
    tile.type = 'button';
    tile.dataset.uid = uid;
    // Not `disabled`: a card you cannot play right now can still be tapped to read it.
    if (!playable && !liftable) tile.setAttribute('aria-disabled', 'true');
    tile.addEventListener('pointerdown', (e) => {
      if (liftable) this.pressCard(e, uid, tile);
    });
    fillFrame(tile, this.frameFor(card, cardId, view.you));
    tile.setAttribute('aria-label', `${card?.name ?? cardId}: ${card?.text ?? ''}`);
    tiltWithPointer(tile);
    tile.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || this.drag || this.hoverCard === uid) return;
      this.hoverCard = uid;
      this.renderInspect(view);
    });
    tile.addEventListener('pointerleave', () => {
      if (this.hoverCard !== uid) return;
      this.hoverCard = null;
      if (this.view) this.renderInspect(this.view);
    });
    // A click or tap only opens the card (or closes it again); cards are played by dragging them.
    tile.onclick = () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const open = this.inspected?.kind === 'card' && this.inspected.id === uid;
      this.inspected = open ? null : { kind: 'card', id: uid };
      this.render();
    };
    return tile;
  }

  // ---------------------------------------------------------------------- drag

  /** Any card can be picked up on your own turn, even when no drop is legal (it then snaps back). */
  private canLift(view: v2.PlayerView, cardId: string): boolean {
    return !this.review && view.cards[cardId] !== undefined && view.status.kind === 'playing' && (this.solo || view.active === view.you);
  }

  /**
   * Squares a held card can be dropped on: a free square on your first two rows summons it (the back row deploys it), one of your
   * pieces seals (sacrifices) it or, for an evolution card, evolves it, a spell's target casts it. A spell with no
   * target goes anywhere (`untargetedSpell`).
   */
  private dropTargets(uid: string): Map<v2.Square, Action> {
    // A drag asks for this on every pointer move, and the legal actions do not change until the server answers.
    const held = this.drag;
    if (held && held.uid === uid && held.drops) return held.drops;
    const out = new Map<v2.Square, Action>();
    for (const a of this.legal()) {
      if (!('cardUid' in a) || a.cardUid !== uid) continue;
      if (a.type === 'deploy' || a.type === 'summon') out.set(a.to, a);
      else if (a.type === 'seal' || a.type === 'evolve') out.set(a.target, a);
      else if (a.type === 'spell' && a.target !== undefined) out.set(a.target, a);
    }
    if (held && held.uid === uid) held.drops = out;
    return out;
  }

  /** What dropping the held card on `square` does, if anything. */
  private dropAction(uid: string, square: v2.Square | null): Action | undefined {
    if (square === null) return undefined;
    return this.dropTargets(uid).get(square) ?? this.untargetedSpell(uid) ?? undefined;
  }

  private pressCard(e: PointerEvent, uid: string, tile: HTMLElement): void {
    if (e.button !== 0 || this.pieceDrag) return;
    /*
     * A press whose release was never seen (the browser took the pointer for a scroll, or a second finger landed)
     * would otherwise leave a drag standing for ever, and every card after it would be ignored. A press is a fresh
     * start: whatever was held before is put down.
     */
    if (this.drag) this.cancelDrag();
    // Stops the browser starting a text selection; the click still fires.
    if (e.pointerType === 'mouse') e.preventDefault();
    // Touch pointers are captured by the pressed tile, which is rebuilt when the drag starts;
    // released, the later events reach the window listeners.
    if (tile.hasPointerCapture(e.pointerId)) tile.releasePointerCapture(e.pointerId);
    this.drag = {
      uid,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      scrollFrom: null,
      ghost: null,
      orb: null,
      hover: null,
      pitch: false,
    };
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragEnd);
    window.addEventListener('pointercancel', this.onDragEnd);
  }

  private readonly onDragMove = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const row = this.handEl.querySelector<HTMLElement>('.g2-handrow');
    if (drag.scrollFrom !== null) {
      if (row) row.scrollLeft = drag.scrollFrom - dx;
      return;
    }
    if (!drag.ghost) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      /*
       * Past the threshold the card is picked up, in whichever direction the gesture happens to start: a drag that
       * begins by wandering sideways is still a drag towards the board, and dropping it there made the card seem to
       * ignore the press until it was tried again.
       *
       * A sideways swipe over the hand scrolls it instead. On a finger the browser already does that: `.draggable`
       * carries `touch-action: pan-x`, so a swipe along the hand scrolls natively and the browser cancels the pointer
       * (this drag ends with it). Only a mouse needs asking, and only when the move is decisively along the hand.
       */
      const sideways = Math.abs(dx) > Math.abs(dy) * SIDEWAYS_RATIO && Math.abs(dx) > SCROLL_SLOP;
      const canScroll = !!row && row.scrollWidth > row.clientWidth + 1;
      if (e.pointerType === 'mouse' && sideways && canScroll) {
        drag.scrollFrom = row.scrollLeft;
        return;
      }
      const tile = this.tileFor(drag.uid);
      if (!tile) return this.cancelDrag();
      const ghost = tile.cloneNode(true) as HTMLElement;
      ghost.classList.remove('lifted', 'fresh', 'inspected');
      ghost.classList.add('g2-drag-ghost');
      if (drag.pointerType !== 'mouse') ghost.classList.add('touch');
      if (!this.dropTargets(drag.uid).size && !this.untargetedSpell(drag.uid) && !this.pitchAction(drag.uid)) ghost.classList.add('nowhere');
      const size = parseFloat(getComputedStyle(tile).fontSize);
      ghost.style.fontSize = `${size}px`;
      ghost.style.animationDelay = '';
      document.body.appendChild(ghost);
      // As big as the card in the hand, also where the phone's text size scales a copy out on the page differently.
      if (ghost.offsetHeight && tile.offsetHeight && Math.abs(ghost.offsetHeight - tile.offsetHeight) > 1) {
        ghost.style.fontSize = `${(size * tile.offsetHeight) / ghost.offsetHeight}px`;
      }
      drag.ghost = ghost;
      sound.sfx?.cardLift();
      this.hoverCard = null;
      if (this.inspected?.kind === 'card') this.inspected = null;
      this.clearSelection();
      this.render();
    }
    e.preventDefault();
    const aim = this.cardAim(drag, e.clientX, e.clientY);
    this.placeHeld(drag, e.clientX, e.clientY, aim);
    const anywhere = this.untargetedSpell(drag.uid) !== null;
    // Cached for the drag (`dropTargets`), so a spell's whole board and a summon's squares are worked out once.
    const drops = this.dropTargets(drag.uid);
    const square = this.squareAt(aim.x, aim.y, anywhere ? undefined : (sq) => drops.has(sq));
    const hover = square !== null && (anywhere || drops.has(square)) ? square : null;
    // The pile takes a card only off the board, so the point is not looked up while the aim is over it.
    const pitch = aim.onBoard ? false : this.overPitch(aim.x, aim.y);
    if (pitch !== drag.pitch) {
      drag.pitch = pitch;
      drag.ghost.classList.toggle('over', hover !== null || pitch);
      this.renderPlayers();
    }
    if (hover !== drag.hover) {
      if (drag.hover !== null) this.cells[drag.hover]?.classList.remove('drop-hover');
      if (hover !== null && !anywhere) this.cells[hover]?.classList.add('drop-hover');
      this.boardEl.classList.toggle('drop-over', anywhere && hover !== null);
      drag.hover = hover;
      drag.ghost.classList.toggle('over', hover !== null || pitch);
      drag.orb?.classList.toggle('over', hover !== null);
      this.showSealWarning(drag);
    }
  };

  /**
   * Moves the held card with the pointer. Over the board it is drawn into a ball of static where it aims, small enough
   * to put on the exact square, and off the board it comes back out of it.
   */
  private placeHeld(drag: CardDrag, x: number, y: number, aim: { x: number; y: number; onBoard: boolean; orbY: number }): void {
    const ghost = drag.ghost!;
    /*
     * The card's size never changes during a drag, so it is measured once (on the first move, when `size` is unset)
     * and kept. Reading offsetWidth/offsetHeight between the style writes below forced a synchronous layout on every
     * pointer move, which on a phone is the difference between a card that keeps up with the finger and one that
     * trails seconds behind it.
     */
    const size = drag.size ?? (drag.size = { w: ghost.offsetWidth, h: ghost.offsetHeight });
    const top = drag.pointerType === 'mouse' ? y - size.h - 6 : y + TOUCH_GRIP - size.h;
    ghost.style.left = `${x - size.w / 2}px`;
    ghost.style.top = `${top}px`;
    ghost.style.transformOrigin = `50% ${aim.y - top}px`;
    ghost.classList.toggle('to-orb', aim.onBoard);
    if (!aim.onBoard && !drag.orb) return;
    const orb = this.orbFor(drag);
    orb.style.left = `${aim.x}px`;
    orb.style.top = `${aim.orbY}px`;
    orb.classList.toggle('on', aim.onBoard);
  }

  /** The ball of static a held card turns into over the board, in its side's colours, made when first needed. */
  private orbFor(drag: CardDrag): HTMLElement {
    if (!drag.orb) {
      const nowhere = drag.ghost?.classList.contains('nowhere') ? ' nowhere' : '';
      const orb = el('div', `g2-orb ${this.view?.you ?? 'white'}${nowhere}`);
      orb.append(el('i', 'core'), el('i', 'arcs'), el('i', 'arcs late'));
      document.body.appendChild(orb);
      drag.orb = orb;
    }
    return drag.orb;
  }

  /**
   * Where a held card aims, and whether that is over the board, where the card is a ball of static.
   *
   * The aim is the square the card would land on, and the ball is drawn on that square's middle, so what the player
   * sees is what they get. A mouse aims with its pointer. A finger aims with the square it is touching: lifting the
   * aim clear of the fingertip (`TOUCH_ORB_LIFT`) moved it up to a whole row on a phone, where a square is only ~36px
   * tall, so a card let go on the near row or by a far edge landed on a square the player was not touching.
   */
  private cardAim(drag: CardDrag, x: number, y: number): { x: number; y: number; onBoard: boolean; orbY: number } {
    if (drag.pointerType === 'mouse') return { x, y, onBoard: this.overBoard(x, y), orbY: y };
    const square = this.cellAt(x, y);
    const box = square === null ? undefined : this.cells[square]?.getBoundingClientRect();
    if (!box) {
      // Off the board the card hangs above the finger, its ball with it.
      return { x, y, onBoard: false, orbY: y - TOUCH_ORB_LIFT };
    }
    // On the board the ball sits on the middle of the square under the finger: the square it will land on.
    const midY = box.top + box.height / 2;
    return { x: box.left + box.width / 2, y: midY, onBoard: true, orbY: midY };
  }

  /** The square of the board under (x, y) on the page, by what is drawn there. */
  private cellAt(x: number, y: number): v2.Square | null {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !this.boardEl.contains(hit)) return null;
    const cell = hit.closest<HTMLElement>('[data-sq]');
    return cell ? Number(cell.dataset.sq) : null;
  }

  /** Whether (x, y) is over the playing surface, whatever the finger covers. */
  private overBoard(x: number, y: number): boolean {
    const board = this.boardEl.getBoundingClientRect();
    return x >= board.left && x <= board.right && y >= board.top && y <= board.bottom;
  }

  /** Whether the pointer is over the discard pile that takes a pitched card (see `renderPlayers`). */
  private overPitch(x: number, y: number): boolean {
    return !!document.elementFromPoint(x, y)?.closest('.g2-pile.pitch-drop');
  }

  /**
   * "sacrifices Squire, gone for good" when the held card hovers one of your pieces, "evolves Recruit into Warrior"
   * for an evolution card; nothing for a summon.
   */
  private sealWarning(action: Action | undefined): string | null {
    if (action?.type === 'spell' && action.target !== undefined) {
      const spell = this.heldCard(action.cardUid);
      const name = this.view?.pieces.find((p) => p.square === action.target)?.name ?? 'this piece';
      if (spell?.grants) return `teaches ${name} ${v2.ABILITIES[spell.grants].name}`;
      switch (spell?.spell) {
        case 'shield':
          return `shields ${name} until your next turn`;
        case 'freeze':
          return `freezes ${name} for a turn`;
        case 'destroyPiece':
          return `destroys ${name}`;
        case 'destroySeal': {
          const seal = this.view?.seals.find((s) => s.square === action.target);
          return `destroys the ${(seal && this.view?.cards[seal.cardId]?.name) ?? 'sacrifice'} sacrifice`;
        }
        case 'raise': {
          const picks = this.raiseOptions(action.cardUid, action.target);
          const only = picks.length === 1 ? picks[0]!.card?.name : undefined;
          return only ? `raises ${only} here` : `raises one of ${picks.length} pieces here: pick it next`;
        }
        default:
          return null;
      }
    }
    if (action?.type !== 'seal' && action?.type !== 'evolve') return null;
    const target = this.view?.pieces.find((p) => p.square === action.target);
    if (action.type === 'seal') return `sacrifices ${target?.name ?? 'this piece'}, gone for good`;
    const card = this.heldCard(action.cardUid);
    const into = card ? ` into ${card.name}` : '';
    const promotes = target?.cardId ? this.view?.cards[target.cardId]?.promotes : false;
    if (target && promotes && v2.rankOf(target.square) === v2.backRank(v2.opposite(target.owner))) {
      return `promotes ${target.name}${into}, free`;
    }
    // Onto an Initiate (any path): the level it skips is paid for as well. Onto another first level of its own line
    // (the Squire to the Warrior) nothing is skipped: that card is this level.
    const ownFirstLevel = !!target?.cardId && (card?.evolvesFromAlso ?? []).includes(target.cardId);
    const skipped = card?.evolvesFrom && !ownFirstLevel && target?.cardId !== card.evolvesFrom ? this.view?.cards[card.evolvesFrom] : undefined;
    const cost = card && skipped ? ` for ${card.cost + skipped.cost} mana, skipping ${skipped.name}` : '';
    return `evolves ${target?.name ?? 'this piece'}${into}${cost}`;
  }

  /** The card of a card in your hand. */
  private heldCard(uid: string): v2.ViewCard | undefined {
    const cardId = this.view?.hand?.find((c) => c.uid === uid)?.cardId;
    return cardId ? this.view?.cards[cardId] : undefined;
  }

  private showSealWarning(drag: CardDrag): void {
    const action = drag.hover === null ? undefined : this.dropTargets(drag.uid).get(drag.hover);
    const text = this.sealWarning(action);
    this.dropNoteEl.classList.toggle('evolve', action?.type === 'evolve');
    this.dropTagEl.classList.toggle('evolve', action?.type === 'evolve');
    this.dropNoteEl.classList.toggle('grant', action?.type === 'spell');
    this.dropTagEl.classList.toggle('grant', action?.type === 'spell');
    const mouse = drag.pointerType === 'mouse';
    this.dropNoteEl.textContent = text ?? '';
    this.dropNoteEl.classList.toggle('hidden', !text || mouse);
    const cell = drag.hover === null ? undefined : this.cells[drag.hover];
    if (!text || !mouse || !cell) return this.dropTagEl.remove();
    // Below the square: the held card hangs above the pointer and would cover a tag placed there.
    this.dropTagEl.textContent = text;
    document.body.appendChild(this.dropTagEl);
    const box = cell.getBoundingClientRect();
    const half = this.dropTagEl.offsetWidth / 2;
    const x = Math.min(Math.max(box.left + box.width / 2, half + 4), window.innerWidth - half - 4);
    const y = Math.min(box.bottom + 4, window.innerHeight - this.dropTagEl.offsetHeight - 4);
    this.dropTagEl.style.left = `${x - half}px`;
    this.dropTagEl.style.top = `${y}px`;
  }

  private hideSealWarning(): void {
    this.dropNoteEl.classList.add('hidden');
    this.dropTagEl.remove();
  }

  private readonly onDragEnd = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.removeDragListeners();
    this.hideSealWarning();
    const ghost = drag.ghost;
    if (ghost || drag.scrollFrom !== null) {
      // The click that follows a drag must not also select the card.
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 0);
    }
    if (!ghost) {
      this.drag = null;
      return;
    }
    const aim = this.cardAim(drag, e.clientX, e.clientY);
    const orb = drag.orb;
    ghost.style.transformOrigin = '';
    const drops = this.dropTargets(drag.uid);
    const square = e.type === 'pointerup' ? this.squareAt(aim.x, aim.y, (sq) => drops.has(sq)) : null;
    const pitch = e.type === 'pointerup' && square === null && this.overPitch(aim.x, aim.y) ? this.pitchAction(drag.uid) : null;
    const gem = pitch ? this.root.querySelector(`.g2-player.${this.view?.you} .g2-gem`)?.getBoundingClientRect() : undefined;
    const action = this.dropAction(drag.uid, square);
    this.drag = null;
    if (pitch) {
      this.fadeOrb(orb);
      this.burnAway(ghost, gem);
      this.hooks.act(pitch);
      this.clearSelection();
      this.render();
      return;
    }
    if (action?.type === 'spell' && action.pick !== undefined && square !== null && this.raiseOptions(drag.uid, square).length > 1) {
      this.fadeOrb(orb);
      ghost.classList.remove('to-orb');
      this.render();
      this.snapBack(ghost, drag.uid);
      this.openRaise(drag.uid, square);
      return;
    }
    if (action && square !== null) {
      if (orb && aim.onBoard && this.fx.enabled) {
        ghost.remove();
        this.strike(orb, square, action.type !== 'spell');
      } else if (action.type === 'spell') {
        this.fadeOrb(orb);
        this.castAway(ghost);
        sound.sfx?.cardCast();
      } else {
        this.fadeOrb(orb);
        this.land(ghost, square);
        sound.sfx?.cardDrop();
      }
      this.hooks.act(action);
      this.clearSelection();
      this.render();
      return;
    }
    this.fadeOrb(orb);
    ghost.classList.remove('to-orb');
    this.render();
    this.snapBack(ghost, drag.uid);
  };

  /** The ball of static goes out, as the card it was goes back to the hand or into the discard pile. */
  private fadeOrb(orb: HTMLElement | null): void {
    if (!orb) return;
    orb.classList.remove('on');
    window.setTimeout(() => orb.remove(), 200);
  }

  /**
   * Let go on a square, the ball of static shoots down into it: it swells, dives in and bursts there in lightning, a
   * flash, rings and sparks, shaking the board. What the card does (a summon's pillar of light, a spell) plays on from
   * there (`untilImpact`). `landed`: a card that stays on the square, as a summon, a sacrifice or an evolution.
   */
  private strike(orb: HTMLElement, square: v2.Square, landed: boolean): void {
    const box = this.cells[square]?.getBoundingClientRect();
    if (!box) return orb.remove();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (landed) this.landed.set(square, performance.now() + STRIKE_MS);
    orb.classList.add('striking');
    orb.animate(
      [
        { left: orb.style.left, top: orb.style.top, scale: 1 },
        { left: orb.style.left, top: `${parseFloat(orb.style.top) - box.height * 0.25}px`, scale: 1.5, offset: 0.4 },
        { left: `${x}px`, top: `${y}px`, scale: 0.5 },
      ],
      { duration: STRIKE_MS, easing: 'cubic-bezier(0.55, 0, 0.85, 0.45)', fill: 'forwards' },
    );
    sound.sfx?.strike(STRIKE_MS);
    window.setTimeout(() => {
      orb.remove();
      document.body.appendChild(strikeBurst(x, y, box.width, this.view?.you ?? 'white'));
      this.fx.quake(0.5);
    }, STRIKE_MS);
  }

  /** How long until the ball of static a card was let go as lands on `square`; 0 once it has, or if there is none. */
  private untilImpact(square: v2.Square, now: number): number {
    const at = this.landed.get(square);
    return at === undefined ? 0 : Math.max(0, at - now);
  }

  /** What Resurrect (`uid`) could raise onto `square` from the caster's discard pile: one card per name, newest first. */
  private raiseOptions(uid: string, square: v2.Square): { action: Action; card: v2.ViewCard | undefined; cardId: string }[] {
    const view = this.view;
    if (!view) return [];
    const out: { action: Action; card: v2.ViewCard | undefined; cardId: string }[] = [];
    for (const a of this.legal()) {
      if (a.type !== 'spell' || a.cardUid !== uid || a.target !== square || a.pick === undefined) continue;
      const found = view.discard[view.active].find((c) => c.uid === a.pick);
      if (found) out.push({ action: a, card: view.cards[found.cardId], cardId: found.cardId });
    }
    return out;
  }

  /** Resurrect was dropped on `square`: show the cards it can raise there, in the caster's colours, to pick one. */
  private openRaise(uid: string, square: v2.Square): void {
    const view = this.view;
    const options = this.raiseOptions(uid, square);
    if (!view || !options.length) return;
    const me = view.active;
    const panel = el('div', 'g2-raise-panel');
    const head = el('div', 'g2-raise-head');
    const whose = this.solo ? `${sideName(me)}'s discard pile` : 'your discard pile';
    head.append(el('b', '', `Resurrect onto ${v2.squareName(square)}`), el('span', '', `Pick a piece from ${whose}.`));
    const row = el('div', 'g2-raise-row');
    for (const option of options) {
      const pick = el('button', 'g2-raise-card');
      pick.type = 'button';
      fillFrame(pick, this.frameFor(option.card, option.cardId, me));
      pick.title = `Raise ${option.card?.name ?? option.cardId} on ${v2.squareName(square)}`;
      pick.onclick = () => {
        this.closeRaise();
        sound.sfx?.cardCast();
        this.hooks.act(option.action);
      };
      row.append(pick);
    }
    panel.append(head, row);
    const cancel = el('button', 'g2-raise-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => this.closeRaise();
    panel.append(cancel);
    this.raiseEl.replaceChildren(panel);
    this.raiseEl.classList.remove('hidden');
    this.raiseEl.onclick = (e) => {
      if (e.target === this.raiseEl) this.closeRaise();
    };
    window.addEventListener('keydown', this.onRaiseKey);
  }

  /**
   * A move takes an Initiate onto the far row: show the piece cards in hand it can become, for free, or let it stay
   * as it is (it can still promote on a later turn).
   */
  private openPromote(move: Action): void {
    const view = this.view;
    const options = this.promotions(move);
    if (!view || move.type !== 'move' || !options.length) return;
    const me = view.active;
    const name = view.pieces.find((p) => p.square === move.from)?.name ?? 'piece';
    const panel = el('div', 'g2-raise-panel');
    const head = el('div', 'g2-raise-head');
    const whose = this.solo ? `${sideName(me)}'s hand` : 'your hand';
    head.append(
      el('b', '', `Promote on ${v2.squareName(move.to)}`),
      el('span', '', `Your ${name} reached the far row. Pick a piece from ${whose} for it to become, free.`),
    );
    const row = el('div', 'g2-raise-row');
    for (const option of options) {
      const pick = el('button', 'g2-raise-card');
      pick.type = 'button';
      fillFrame(pick, this.frameFor(option.card, option.cardId, me));
      pick.title = `Promote into ${option.card?.name ?? option.cardId} on ${v2.squareName(move.to)}`;
      pick.onclick = () => {
        this.closeRaise();
        this.hooks.act(option.action);
      };
      row.append(pick);
    }
    panel.append(head, row);
    const actions = el('div', 'g2-raise-actions');
    const stay = el('button', 'g2-raise-cancel', `Stay ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`);
    stay.type = 'button';
    stay.title = 'Move without promoting; drop a piece card on it on a later turn to promote it then.';
    stay.onclick = () => {
      this.closeRaise();
      this.hooks.act(move);
    };
    const cancel = el('button', 'g2-raise-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => this.closeRaise();
    actions.append(stay, cancel);
    panel.append(actions);
    this.raiseEl.replaceChildren(panel);
    this.raiseEl.classList.remove('hidden');
    this.raiseEl.onclick = (e) => {
      if (e.target === this.raiseEl) this.closeRaise();
    };
    window.addEventListener('keydown', this.onRaiseKey);
  }

  private readonly onRaiseKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.closeRaise();
  };

  private closeRaise(): void {
    this.raiseEl.classList.add('hidden');
    this.raiseEl.replaceChildren();
    window.removeEventListener('keydown', this.onRaiseKey);
  }

  /** Slide an illegally dropped card back to its place in the hand. */
  private snapBack(ghost: HTMLElement, uid: string): void {
    const home = this.tileFor(uid)?.getBoundingClientRect();
    if (!home) return ghost.remove();
    sound.sfx?.cardReturn();
    ghost.classList.add('returning');
    ghost.style.left = `${home.left}px`;
    ghost.style.top = `${home.top}px`;
    setTimeout(() => ghost.remove(), 220);
  }

  private cancelDrag(): void {
    this.hideSealWarning();
    if (!this.drag) return;
    this.removeDragListeners();
    this.drag.ghost?.remove();
    this.drag.orb?.remove();
    this.drag = null;
    if (this.view) this.render();
  }

  private removeDragListeners(): void {
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
    window.removeEventListener('pointercancel', this.onDragEnd);
  }

  private tileFor(uid: string): HTMLElement | null {
    return this.handEl.querySelector<HTMLElement>(`[data-uid="${CSS.escape(uid)}"]`);
  }

  /**
   * The square at (x, y) on the page. On the 3D board a figure stands in front of the squares behind it, so that is
   * its square; for a figure being dragged, which is drawn on the floor under the pointer, it is the square there. If
   * `wanted` (where what is held can go) takes the other of the two and not that one, it is the other.
   */
  private squareAt(x: number, y: number, wanted?: (square: v2.Square) => boolean, onFloor = false): v2.Square | null {
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== this.boardBox && !this.boardEl.contains(hit))) return null;
    const cell = hit.closest<HTMLElement>('[data-sq]');
    const floor = cell ? Number(cell.dataset.sq) : null;
    const figure = this.board3d?.pick(x, y) ?? null;
    const [first, other] = onFloor ? [floor, figure] : [figure, floor];
    if (first === null) return other;
    return wanted && other !== null && !wanted(first) && wanted(other) ? other : first;
  }

  /** On the 3D board, figures in front of a square the player can choose, or is holding something over, fade. */
  private reveal(): void {
    if (!this.board3d) return;
    const over = [this.pieceDrag?.hover, this.libTarget?.kind === 'square' ? this.libTarget.square : null];
    this.board3d.reveal([...this.choices, ...over.filter((s): s is v2.Square => s !== null && s !== undefined)]);
  }

  // ---------------------------------------------------------------- piece drag

  /**
   * A press on one of your pieces that can move (in the arena, on any piece). Dragging it moves it; letting go without
   * dragging is a tap.
   */
  private pressPiece(e: PointerEvent): void {
    if (e.button !== 0 || !e.isPrimary || this.drag || this.pieceDrag || this.dropped || !this.view) return;
    const from = this.squareAt(e.clientX, e.clientY);
    if (from === null) return;
    const loose = this.arena && this.view.pieces.some((p) => p.square === from);
    if (!this.movers(this.view).has(from) && !loose) return;
    // Stops the browser starting a text selection; the click still fires.
    if (e.pointerType === 'mouse') e.preventDefault();
    this.pieceDrag = { from, pointerId: e.pointerId, pointerType: e.pointerType, startX: e.clientX, startY: e.clientY, ghost: null, hover: null };
    window.addEventListener('pointermove', this.onPieceMove);
    window.addEventListener('pointerup', this.onPieceUp);
    window.addEventListener('pointercancel', this.onPieceUp);
  }

  private readonly onPieceMove = (e: PointerEvent): void => {
    const drag = this.pieceDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    let ghost = drag.ghost;
    if (!ghost) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      ghost = this.liftPiece(drag);
      if (!ghost) return;
    }
    // Under a finger the piece rides above it, so the finger does not hide it; it lands where the finger is.
    // Its size cannot change mid-drag, so it is measured on the first move and kept (see `placeHeld`).
    const size = drag.size ?? (drag.size = { w: ghost.offsetWidth, h: ghost.offsetHeight });
    const lift = drag.pointerType === 'touch' ? size.h * 0.9 : 0;
    ghost.style.left = `${e.clientX - size.w / 2}px`;
    ghost.style.top = `${e.clientY - size.h / 2 - lift}px`;
    this.board3d?.follow(e.clientX, e.clientY, drag.pointerType === 'touch');
    const targets = this.targets();
    const square = this.squareAt(e.clientX, e.clientY, (sq) => targets.has(sq) || this.canRelocate(drag.from, sq), true);
    const legal = square !== null && targets.has(square);
    const hover = legal || (square !== null && this.canRelocate(drag.from, square)) ? square : null;
    ghost.classList.toggle('off', this.canTakeOff(drag.from, e.clientX, e.clientY));
    if (hover === drag.hover) return;
    if (drag.hover !== null) this.cells[drag.hover]?.classList.remove('drag-over', 'arena-over');
    if (hover !== null) this.cells[hover]?.classList.add(legal ? 'drag-over' : 'arena-over');
    drag.hover = hover;
    ghost.classList.toggle('over', hover !== null);
    this.reveal();
  };

  /** Arena: whether a piece can be put down on `to` out of turn and out of the rules (anywhere but on a King). */
  private canRelocate(from: v2.Square, to: v2.Square): boolean {
    return this.arena && to !== from && !this.kingAt(to);
  }

  /** Arena: whether letting go of the piece from `from` at (`x`, `y`) takes it off the board (any piece but a King). */
  private canTakeOff(from: v2.Square, x: number, y: number): boolean {
    if (!this.arena || this.kingAt(from)) return false;
    const box = this.boardEl.getBoundingClientRect();
    return x < box.left || x > box.right || y < box.top || y > box.bottom;
  }

  private kingAt(square: v2.Square): boolean {
    return !!this.view?.pieces.some((p) => p.square === square && p.king);
  }

  /** Past the threshold: a copy of the piece follows the pointer, and the squares it can go to light up. */
  private liftPiece(drag: PieceDrag): HTMLElement | null {
    const token = this.cells[drag.from]?.querySelector<HTMLElement>('.g2-piece');
    if (!token) {
      this.cancelPieceDrag();
      return null;
    }
    clearTimeout(this.holdTimer);
    this.clearReturning();
    if (this.boardPress) this.boardPress.dragged = true;
    const ghost = token.cloneNode(true) as HTMLElement;
    ghost.classList.remove(...Object.keys(TOKEN_FX_MS), 'lifted');
    ghost.classList.add('g2-piece-ghost');
    if (drag.pointerType === 'touch') ghost.classList.add('touch');
    ghost.style.animationDelay = '';
    ghost.style.width = `${token.offsetWidth}px`;
    ghost.style.height = `${token.offsetHeight}px`;
    ghost.style.fontSize = getComputedStyle(token).fontSize;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    const piece = this.view?.pieces.find((p) => p.square === drag.from);
    if (piece) this.board3d?.hold(piece.id);
    if (drag.pointerType === 'mouse') document.body.classList.add('g2-grabbing');
    // A piece being dragged moves; it does not spit lava.
    this.aimLava = null;
    if (this.selectedSquare !== drag.from) {
      this.selectedSquare = drag.from;
      sound.sfx?.select();
    }
    // A card floating over the board would hide the squares the piece can go to.
    if (!this.docked) this.inspected = null;
    this.render();
    return ghost;
  }

  private readonly onPieceUp = (e: PointerEvent): void => {
    const drag = this.pieceDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.removePieceListeners();
    this.pieceDrag = null;
    document.body.classList.remove('g2-grabbing');
    const ghost = drag.ghost;
    // Never dragged: the click that follows picks the piece up, or puts it down (`onSquare`).
    if (!ghost) return;
    if (drag.hover !== null) this.cells[drag.hover]?.classList.remove('drag-over', 'arena-over');
    const up = e.type === 'pointerup';
    const targets = this.targets();
    const from = drag.from;
    const square = up ? this.squareAt(e.clientX, e.clientY, (sq) => targets.has(sq) || this.canRelocate(from, sq), true) : null;
    const move = square === null ? undefined : targets.get(square);
    if (move && this.promotions(move).length) {
      this.returnPiece(from, ghost);
      this.clearSelection();
      this.render();
      this.openPromote(move);
    } else if (move && square !== null) this.dropPiece(from, square, () => this.hooks.act(move), ghost);
    else if (square !== null && this.canRelocate(from, square)) this.dropPiece(from, square, () => this.hooks.arena({ type: 'relocate', from, to: square }), ghost);
    else if (up && square === null && this.canTakeOff(from, e.clientX, e.clientY)) this.takeOff(from, ghost);
    else this.returnPiece(from, ghost);
  };

  /** Let go on a lit square: the move is sent, and the piece waits on its new square until the server answers. */
  private dropPiece(from: v2.Square, to: v2.Square, send: () => void, ghost: HTMLElement): void {
    this.clearDropped();
    this.board3d?.release();
    ghost.classList.add('landing');
    this.placeOn(ghost, to);
    const timer = window.setTimeout(() => {
      this.clearDropped();
      this.render();
    }, DROP_WAIT_MS);
    this.dropped = { from, to, ghost, timer };
    send();
    this.clearSelection();
    this.render();
  }

  /** Arena: a piece let go off the board bursts there, and is gone from its square until the server agrees. */
  private takeOff(from: v2.Square, ghost: HTMLElement): void {
    const piece = this.view?.pieces.find((p) => p.square === from);
    if (piece) {
      this.arenaGone.add(piece.id);
      this.board3d?.leave(piece.id, 'consume', 0);
    }
    this.board3d?.release();
    ghost.classList.add('poof');
    window.setTimeout(() => ghost.remove(), 320);
    sound.sfx?.capture(0);
    this.clearVanishing();
    const timer = window.setTimeout(() => {
      this.clearVanishing();
      this.render();
    }, DROP_WAIT_MS);
    this.vanishing = { square: from, timer };
    this.hooks.arena({ type: 'remove', square: from });
    this.clearSelection();
    this.render();
  }

  private clearVanishing(): void {
    if (!this.vanishing) return;
    clearTimeout(this.vanishing.timer);
    this.vanishing = null;
  }

  /** Let go anywhere else: the piece flies back to its square and stays picked up, so a tap can still move it. */
  private returnPiece(from: v2.Square, ghost: HTMLElement): void {
    this.clearReturning();
    this.board3d?.release();
    ghost.classList.add('returning');
    this.placeOn(ghost, from);
    const timer = window.setTimeout(() => {
      this.clearReturning();
      this.render();
    }, RETURN_MS);
    this.returning = { from, ghost, timer };
    this.render();
  }

  /** Centre a dragged piece's copy on a square. */
  private placeOn(ghost: HTMLElement, square: v2.Square): void {
    const box = this.cells[square]?.getBoundingClientRect();
    if (!box) return;
    ghost.style.left = `${box.left + box.width / 2 - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${box.top + box.height / 2 - ghost.offsetHeight / 2}px`;
  }

  private clearDropped(): void {
    if (!this.dropped) return;
    clearTimeout(this.dropped.timer);
    this.dropped.ghost.remove();
    this.dropped = null;
  }

  private clearReturning(): void {
    if (!this.returning) return;
    clearTimeout(this.returning.timer);
    this.returning.ghost.remove();
    this.returning = null;
  }

  /** Put a held piece back without moving it: a new position came in, or the game closed. */
  private cancelPieceDrag(): void {
    const drag = this.pieceDrag;
    if (!drag) return;
    this.removePieceListeners();
    this.pieceDrag = null;
    document.body.classList.remove('g2-grabbing');
    drag.ghost?.remove();
    this.board3d?.release();
    if (drag.hover !== null) this.cells[drag.hover]?.classList.remove('drag-over', 'arena-over');
  }

  private removePieceListeners(): void {
    window.removeEventListener('pointermove', this.onPieceMove);
    window.removeEventListener('pointerup', this.onPieceUp);
    window.removeEventListener('pointercancel', this.onPieceUp);
  }

  private renderHand(view: v2.PlayerView): void {
    const scroll = this.handEl.querySelector('.g2-handrow')?.scrollLeft ?? 0;
    this.handEl.innerHTML = '';
    // Off turn, the hand rests until your next one.
    const spent = view.phase === 'play' && view.status.kind === 'playing' && !this.solo && view.active !== view.you;
    this.handEl.classList.toggle('spent', spent);
    // Practice shows the hand of the side to move, so it says whose it is.
    if (this.solo) this.handEl.append(el('div', 'g2-handlabel', `${this.name(view.you)}'s hand`));
    this.handEl.append(this.dropNoteEl);

    const hand = view.hand ?? [];
    const now = performance.now();
    if (this.seenCards) {
      let k = 0;
      for (const c of hand) if (!this.seenCards.has(c.uid) && !this.drawnAt.has(c.uid)) this.drawnAt.set(c.uid, now + Math.min(k++, 6) * 90);
      const reshown = view.you !== this.handOwner && this.shownHands.has(view.you);
      if (k && !reshown) sound.sfx?.deal(k);
    }
    this.seenCards = new Set(hand.map((c) => c.uid));
    this.handOwner = view.you;
    this.shownHands.add(view.you);

    const row = el('div', 'g2-handrow');
    row.style.setProperty('--n', String(Math.max(hand.length, 1)));
    const mid = (hand.length - 1) / 2;
    hand.forEach((c, i) => {
      const tile = this.cardTile(c.uid, c.cardId, view);
      // -1 for the leftmost card of the fan, 1 for the rightmost.
      const fan = mid > 0 ? (i - mid) / mid : 0;
      tile.style.setProperty('--fan', fan.toFixed(3));
      tile.style.setProperty('--arc', (fan * fan).toFixed(3));
      const drawn = this.drawnAt.get(c.uid);
      if (drawn !== undefined) {
        if (now - drawn < DRAW_MS) {
          tile.classList.add('fresh');
          tile.style.animationDelay = `${Math.round(drawn - now)}ms`;
        } else {
          this.drawnAt.delete(c.uid);
        }
      }
      row.appendChild(tile);
    });
    if (!hand.length) row.appendChild(el('span', 'hint', 'No cards in hand.'));
    this.handEl.appendChild(row);
    row.scrollLeft = scroll;
  }

  // --------------------------------------------------------------------- arena

  private arenaTool(tool: LibraryTool): void {
    if (!this.arena) return;
    sound.sfx?.select();
    this.hooks.arena({ type: tool });
  }

  /** The card that follows the pointer out of the library: the whole card, with `color`'s face. */
  private libraryGhost(cardId: string, color: Color): HTMLElement {
    const card = this.view?.cards[cardId];
    return fillFrame(el('div', `g2-card g2-drag-ghost g2-lib-ghost ${card?.type ?? ''}`), this.frameFor(card, cardId, color));
  }

  /** Where a library card let go at (`x`, `y`) goes: a piece onto any square but a King's; any card into a hand or onto a pile. */
  private libraryTarget(cardId: string, x: number, y: number): LibraryTarget | null {
    const card = this.view?.cards[cardId];
    if (!card) return null;
    const square = this.squareAt(x, y, (sq) => card.type === 'piece' && !this.kingAt(sq));
    if (square !== null) return card.type === 'piece' && !this.kingAt(square) ? { kind: 'square', square } : null;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !this.root.contains(hit)) return null;
    const pile = hit.closest<HTMLElement>('.g2-pile')?.dataset.pile;
    if (pile === 'white' || pile === 'black') return { kind: 'pile', color: pile };
    if (this.meEl.contains(hit)) return { kind: 'hand', color: this.seat };
    if (this.oppEl.contains(hit)) return { kind: 'hand', color: v2.opposite(this.seat) };
    if (this.handEl.contains(hit) && this.view) return { kind: 'hand', color: this.view.you };
    return null;
  }

  private hoverLibrary(cardId: string, x: number, y: number): boolean {
    const target = this.libraryTarget(cardId, x, y);
    if (JSON.stringify(target) !== JSON.stringify(this.libTarget)) {
      this.libTarget = target;
      this.paintLibraryTarget();
    }
    return target !== null;
  }

  /** Lights up where the held library card would go: a square, a player's bar and hand, or a discard pile. */
  private paintLibraryTarget(): void {
    const t = this.libTarget;
    this.cells.forEach((cell, square) => cell.classList.toggle('lib-drop', t?.kind === 'square' && t.square === square));
    const hand = t?.kind === 'hand' ? t.color : null;
    const pile = t?.kind === 'pile' ? t.color : null;
    this.meEl.classList.toggle('lib-drop', hand === this.seat);
    this.oppEl.classList.toggle('lib-drop', hand !== null && hand !== this.seat);
    this.handEl.classList.toggle('lib-drop', hand !== null && hand === this.view?.you);
    for (const p of this.root.querySelectorAll<HTMLElement>('.g2-pile')) p.classList.toggle('lib-drop', pile !== null && p.dataset.pile === pile);
    this.reveal();
  }

  private dropFromLibrary(cardId: string, color: Color, at: { x: number; y: number } | null, ghost: HTMLElement): boolean {
    const target = at ? this.libraryTarget(cardId, at.x, at.y) : null;
    this.libTarget = null;
    this.paintLibraryTarget();
    if (!target) return false;
    sound.sfx?.cardDrop();
    if (target.kind === 'square') {
      this.placedAt = target.square;
      this.sinkInto(ghost, this.cells[target.square]?.getBoundingClientRect());
      this.hooks.arena({ type: 'place', cardId, color, square: target.square });
    } else if (target.kind === 'pile') {
      this.sinkInto(ghost, this.pileTarget(target.color)?.getBoundingClientRect());
      this.hooks.arena({ type: 'bury', cardId, color: target.color });
    } else {
      this.sinkInto(ghost, this.handBox(target.color));
      this.hooks.arena({ type: 'give', cardId, color: target.color });
    }
    return true;
  }

  /** A tap on a library card: into the hand on show it deals itself in; into the other, a copy flies to its count. */
  private giveFromLibrary(cardId: string, color: Color, tile: HTMLElement): void {
    if (!this.view) return;
    if (color !== this.view.you && this.fx.enabled) {
      const ghost = this.libraryGhost(cardId, color);
      const from = tile.getBoundingClientRect();
      document.body.append(ghost);
      ghost.style.left = `${from.left + from.width / 2 - ghost.offsetWidth / 2}px`;
      ghost.style.top = `${from.top + from.height / 2 - ghost.offsetHeight / 2}px`;
      ghost.getBoundingClientRect();
      this.sinkInto(ghost, this.handBox(color));
      sound.sfx?.cardDrop();
    }
    this.hooks.arena({ type: 'give', cardId, color });
  }

  /** Where a card put into `color`'s hand flies: the end of the hand on show, or the hand count on their bar. */
  private handBox(color: Color): DOMRect | undefined {
    if (color === this.view?.you) {
      const row = this.handEl.querySelector('.g2-handrow');
      return (row?.querySelector('.g2-card:last-child') ?? row)?.getBoundingClientRect();
    }
    return (color === this.seat ? this.meEl : this.oppEl).querySelector('.g2-count.hand')?.getBoundingClientRect();
  }

  /** A library card under the mouse shows in the viewer beside the board; one held down by a finger opens there. */
  private previewLibrary(cardId: string | null, pinned: boolean): void {
    const view = this.view;
    if (!view) return;
    if (pinned) {
      this.inspected = cardId ? { kind: 'library', id: cardId } : null;
      this.render();
      return;
    }
    if (!this.docked || cardId === this.hoverLib) return;
    this.hoverLib = cardId;
    this.renderInspect(view);
  }

  /**
   * The arena's edits come without events, so what one changed is found by comparing the board with the one before:
   * a piece put down from the library rises with a summon, one moved slides, one taken away bursts (Undo and Reset
   * play the same way). Whatever the events tell of (a move, a capture, a summon...) is left to `queueFx`.
   */
  private arenaFx(prev: v2.PlayerView, view: v2.PlayerView): void {
    const told = new Set<string>();
    const hatchedAt = new Set<v2.Square>();
    for (const e of view.events) {
      if ('pieceId' in e) told.add(e.pieceId);
      if ('sealId' in e) told.add(e.sealId);
      if (e.type === 'evolved') told.add(e.fromPieceId);
      if (e.type === 'sealed') told.add(e.consumedPieceId);
      if (e.type === 'hatched') hatchedAt.add(e.square);
    }
    const now = performance.now();
    const fx = this.fx.enabled;
    const sfx = sound.sfx;
    const before = new Map(prev.pieces.map((p) => [p.id, p]));
    const after = new Set(view.pieces.map((p) => p.id));
    let rose = false;
    let slid = false;
    let burst = false;
    for (const piece of view.pieces) {
      if (told.has(piece.id)) continue;
      const old = before.get(piece.id);
      if (!old) {
        if (this.placedAt === piece.square) {
          const force = Math.min(1, (piece.cardId ? (view.cards[piece.cardId]?.cost ?? 0) : 0) / 5);
          if (fx) this.fx.summon(piece.square, piece.owner, null, 0, force);
          sfx?.summon(piece.owner, false, force);
        } else {
          rose = true;
        }
        if (fx) this.tokenFx.set(piece.id, { kind: 'fx-rise', at: now });
      } else if (old.square !== piece.square && !(this.dropped?.from === old.square && this.dropped.to === piece.square)) {
        const from = this.cells[old.square];
        const to = this.cells[piece.square];
        if (fx && from && to) {
          const vars = { '--from-x': `${from.offsetLeft - to.offsetLeft}px`, '--from-y': `${from.offsetTop - to.offsetTop}px` };
          this.tokenFx.set(piece.id, { kind: 'fx-slide', at: now, vars });
        }
        slid = true;
      }
    }
    for (const old of prev.pieces) {
      if (told.has(old.id) || after.has(old.id) || this.arenaGone.has(old.id)) continue;
      if (fx) this.fx.vanish(old.square, this.pieceToken(old, prev), 'capture', 0);
      this.board3d?.leave(old.id, 'capture', 0);
      burst = true;
    }
    const sealsBefore = new Set(prev.seals.map((s) => s.id));
    const sealsAfter = new Set(view.seals.map((s) => s.id));
    for (const seal of view.seals) {
      if (fx && !told.has(seal.id) && !sealsBefore.has(seal.id)) this.tokenFx.set(seal.id, { kind: 'fx-seal-in', at: now });
    }
    for (const seal of prev.seals) {
      if (told.has(seal.id) || sealsAfter.has(seal.id) || hatchedAt.has(seal.square)) continue;
      if (fx) this.fx.vanish(seal.square, this.sealToken(seal, prev), 'shatter', 0);
      burst = true;
    }
    if (burst) sfx?.capture(0);
    else if (slid) sfx?.move();
    else if (rose) sfx?.cardReturn();
    this.placedAt = null;
    this.arenaGone.clear();
  }

  // -------------------------------------------------------------------- render

  private name(color: Color): string {
    return this.hooks.names()[color];
  }

  private render(): void {
    const view = this.view;
    if (!view) return;
    const now = performance.now();
    const held = this.drag?.ghost ? this.drag : null;
    const targets = held ? new Map<v2.Square, Action>() : this.targets();
    const drops = held ? this.dropTargets(held.uid) : new Map<v2.Square, Action>();
    // A held spell with no target lights up the whole board rather than any one square.
    const anywhere = held !== null && this.untargetedSpell(held.uid) !== null;
    this.boardEl.classList.toggle('drop-all', anywhere);
    this.boardEl.classList.toggle('drop-over', anywhere && held?.hover !== null);
    const lastMove = view.events.find((e): e is Extract<v2.GameEvent, { type: 'moved' }> => e.type === 'moved');
    const inspectedAt = this.inspectedSquare(view);
    const movers = this.movers(view);
    // A dragged piece leaves a faint copy on its square, also while it flies back; one dropped elsewhere is gone from it.
    const lifted = this.pieceDrag?.ghost ? this.pieceDrag.from : (this.returning?.from ?? null);
    const away = this.dropped?.from ?? this.vanishing?.square ?? null;
    const aiming = this.aimLava !== null && this.aimLava === this.selectedSquare;
    // While the mana squares move, the old ones show until their gems burst, and the new ones once their pillars land.
    const shift = this.shift && now < this.shift.land ? this.shift : null;
    const shrines = shift ? (now < shift.gone ? shift.from : new Set<v2.Square>()) : new Set(view.shrines);
    const dry = shift !== null || view.well === 0;
    const shrineTip =
      view.well === undefined ? SHRINE_TIP
      : dry ? `${SHRINE_TIP}. Run dry: they move as the next turn starts.`
      : `${SHRINE_TIP}. The four share ${view.well} more mana, then they move.`;

    for (let square = 0; square < v2.FILES * v2.RANKS; square++) {
      const cell = this.cells[square]!;
      const piece = view.pieces.find((p) => p.square === square);
      const seal = view.seals.find((s) => s.square === square);
      const lava = view.lava.find((l) => l.square === square);
      const classes = ['g2-cell', (v2.fileOf(square) + v2.rankOf(square)) % 2 === 0 ? 'dark' : 'light'];
      const shrine = shrines.has(square);
      if (shrine) classes.push(dry ? 'shrine dry' : piece && !piece.king ? `shrine held-${piece.owner}` : 'shrine');
      if (movers.has(square) && square !== away) classes.push('movable');
      else if (this.arena && piece && square !== away) classes.push('grab');
      if (targets.has(square)) classes.push(this.pieceDrag?.hover === square ? 'target drag-over' : 'target');
      else if (this.pieceDrag?.hover === square) classes.push('arena-over');
      if (aiming && targets.has(square)) classes.push('lava-aim');
      const drop = drops.get(square);
      if (drop) {
        // Resurrect's squares light up like a summon's; Smite and Dispel like a threat.
        const spell = drop.type === 'spell' && held !== null ? this.heldCard(held.uid) : undefined;
        const kind =
          drop.type === 'seal' ? ' drop-seal'
          : drop.type === 'evolve' ? ' drop-evolve'
          : spell?.grants !== undefined ? ' drop-grant'
          : spell?.spell === 'shield' ? ' drop-shield'
          : spell?.spell === 'freeze' ? ' drop-freeze'
          : spell?.spell === 'raise' ? ''
          : drop.type === 'spell' ? ' drop-spell'
          : '';
        classes.push(`drop${kind}`);
      }
      if (drop && held?.hover === square) classes.push('drop-hover');
      const warning = this.sealWarning(drop) ?? (shrine ? shrineTip : null);
      if (warning) cell.title = warning;
      else cell.removeAttribute('title');
      if (this.selectedSquare === square) classes.push('selected');
      if (inspectedAt === square) classes.push('inspected');
      if (lastMove && (lastMove.from === square || lastMove.to === square)) classes.push('last');
      if (piece?.king && piece.owner === view.active && view.inCheck) classes.push('check');
      cell.className = classes.join(' ');
      // Keep the coordinate labels, replace the rest.
      for (const child of [...cell.children]) if (!child.classList.contains('g2-coord')) child.remove();
      if (lava) {
        const pool = this.lavaPool(lava, view);
        this.applyTokenFx(pool, `lava:${square}`, now);
        cell.appendChild(pool);
      }
      if (shrine && !dry && view.well !== undefined) cell.appendChild(el('span', 'g2-well', String(view.well)));
      const tok = piece ? this.pieceToken(piece, view) : seal ? this.sealToken(seal, view) : null;
      if (tok) {
        this.applyTokenFx(tok, piece?.id ?? seal!.id, now);
        if (piece && square === away) tok.classList.add('away');
        else if (piece && square === lifted) tok.classList.add('lifted');
        cell.appendChild(tok);
      }
    }
    this.board3d?.sync(this.figures(view));
    this.choices = [...targets.keys(), ...drops.keys()];
    this.reveal();

    this.renderHand(view);
    this.renderInspect(view);
    this.renderPlayers();
    this.renderStatus(view);
    this.renderCue(view);
    this.renderNav();
    this.paintLibraryTarget();
  }

  private renderPlayers(): void {
    const view = this.view;
    const top: Color = this.seat === 'white' ? 'black' : 'white';
    for (const [elx, slot, color] of [
      [this.oppEl, this.oppPileEl, top],
      [this.meEl, this.mePileEl, this.seat],
    ] as const) {
      elx.innerHTML = '';
      elx.className = `g2-player ${color}`;
      slot.replaceChildren();
      const seat = this.room?.players[color];
      const label = this.solo ? sideName(color) : seat ? seat.name + (color === this.seat ? ' (you)' : '') : 'Waiting for opponent…';
      if (seat && !seat.connected && !this.solo) elx.classList.add('offline');
      const who = el('div', 'g2-who');
      who.append(el('span', 'dot'), el('span', 'pname', label));
      const clock = this.hooks.clock(color);
      if (clock) {
        who.append(el('span', `clock ${clock.running ? 'running' : ''} ${clock.low ? 'low' : ''}`, `⏱ ${clock.text}`));
      }
      elx.appendChild(who);
      if (view) {
        const stats = el('div', 'g2-stats');
        const turn = view.status.kind === 'playing' && view.active === color;
        if (turn) elx.classList.add('turn');
        const mana = el('span', 'g2-mana');
        const income = view.income[color];
        const amount = this.manaShown[color] ?? view.mana[color];
        if (view.shrines) {
          const squares = `${income} mana square${income === 1 ? '' : 's'}`;
          mana.title = `${amount} mana. Holds ${squares}: +${income} at the start of the next turn, if still held.`;
        } else {
          const rise = income < view.maxIncome ? `; every 5th turn brings 1 more, up to ${view.maxIncome}` : ', as every turn will from now on';
          mana.title = `${amount} mana. ${turn ? 'This' : 'The next'} turn brings ${income}${rise}.`;
        }
        mana.append(el('i', 'g2-gem'), el('b', '', String(amount)), el('span', 'g2-mana-word', ' mana'), el('span', 'g2-income', `+${income}`));
        if (this.arena) {
          mana.prepend(this.manaStep(color, -1));
          mana.append(this.manaStep(color, 1));
        }
        // Holding a card you can pitch: your discard pile takes it (see `onDragEnd`).
        const held = this.drag?.ghost ? this.drag : null;
        const pitch = held && color === view.you && this.pitchAction(held.uid) ? (held.pitch ? 'over' : 'open') : null;
        const hand = el('span', 'g2-count hand', `Hand ${view.handCount[color]}`);
        // The hand you cannot see is shown as card backs.
        if (color !== view.you && view.handCount[color] > 0) {
          const backs = el('span', 'g2-backs');
          for (let i = 0; i < Math.min(view.handCount[color], 8); i++) backs.append(cardBack());
          hand.prepend(backs);
        }
        stats.append(mana, hand, el('span', 'g2-count', `Deck ${view.deckCount[color]}`));
        const pile = this.discardPile(color, view, pitch);
        if (this.narrow.matches) stats.append(pile);
        else slot.append(pile);
        elx.appendChild(stats);
      }
    }
    this.paintLibraryTarget();
  }

  /**
   * Arena: a button that takes 1 mana from a side or gives it 1, again and again while it is held. The bars are
   * rebuilt with every step, so it acts on the press, and a run of steps is sent once it stops (one step to undo).
   */
  private manaStep(color: Color, by: 1 | -1): HTMLButtonElement {
    const btn = el('button', 'g2-mana-step', by > 0 ? '+' : '−');
    btn.type = 'button';
    btn.title = by > 0 ? 'One more mana' : 'One less mana';
    btn.setAttribute('aria-label', `${sideName(color)}: ${btn.title.toLowerCase()}`);
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.stopManaHold();
      this.stepMana(color, by);
      this.manaHold = window.setTimeout(() => (this.manaHold = window.setInterval(() => this.stepMana(color, by), MANA_REPEAT_MS)), MANA_HOLD_MS);
      window.addEventListener('pointerup', this.stopManaHold);
      window.addEventListener('pointercancel', this.stopManaHold);
    });
    // Enter or Space on the focused button.
    btn.onclick = (e) => {
      if (e.detail === 0) this.stepMana(color, by);
    };
    return btn;
  }

  private stepMana(color: Color, by: 1 | -1): void {
    const now = this.manaShown[color] ?? this.view?.mana[color] ?? 0;
    const mana = Math.max(0, Math.min(v2.ARENA_MAX_MANA, now + by));
    if (mana === now) return;
    this.manaShown[color] = mana;
    clearTimeout(this.manaSend[color]);
    this.manaSend[color] = window.setTimeout(() => {
      delete this.manaSend[color];
      this.hooks.arena({ type: 'mana', color, mana });
    }, MANA_SEND_MS);
    this.renderPlayers();
  }

  private readonly stopManaHold = (): void => {
    clearTimeout(this.manaHold);
    window.removeEventListener('pointerup', this.stopManaHold);
    window.removeEventListener('pointercancel', this.stopManaHold);
  };

  /**
   * A player's discard pile: its newest card face up and how many it holds. Point at it to read that card in the
   * card viewer; click it to keep it there with the whole pile. While you hold a card you can pitch (`pitch`), your
   * pile takes it: lit up, and brighter (`over`) with the card over it.
   */
  private discardPile(color: Color, view: v2.PlayerView, pitch: 'open' | 'over' | null = null): HTMLElement {
    const held = this.pileHeld[color];
    const pile = held && performance.now() < held.until ? view.discard[color].slice(0, held.length) : view.discard[color];
    const top = pile.at(-1);
    const card = top ? view.cards[top.cardId] : undefined;
    const open = this.inspected?.kind === 'discard' && this.inspected.id === color;
    const btn = el('button', `g2-pile${top ? '' : ' empty'}${open ? ' open' : ''}`);
    btn.type = 'button';
    btn.dataset.pile = color;
    const thumb = el('span', 'g2-pile-card');
    if (top) this.paintThumb(thumb, card, top.cardId, color);
    const count = el('span', 'g2-pile-count', this.narrow.matches ? String(pile.length) : `Discard ${pile.length}`);
    btn.append(thumb, count);
    if (pitch) {
      btn.classList.add('pitch-drop');
      if (pitch === 'over') btn.classList.add('pitch-over');
      count.textContent = this.narrow.matches ? `Pitch +${v2.PITCH_MANA}` : `Pitch: +${v2.PITCH_MANA} mana`;
      btn.title = `Let go here to pitch the card: +${v2.PITCH_MANA} mana`;
      return btn;
    }
    if (!top) {
      btn.disabled = true;
      btn.title = 'Discard pile: empty';
      return btn;
    }
    btn.title = `Discard pile, ${pile.length} card${pile.length === 1 ? '' : 's'}. Newest: ${card?.name ?? top.cardId}. Click to see them all.`;
    btn.onclick = () => {
      this.inspected = open ? null : { kind: 'discard', id: color };
      this.hoverPile = null;
      this.render();
    };
    return btn;
  }

  /** Every card in a discard pile, newest first; click one to show it. */
  private pileStrip(color: Color, current: string, view: v2.PlayerView): HTMLElement {
    const strip = el('div', 'g2-pile-strip');
    for (const c of [...view.discard[color]].reverse()) {
      const card = view.cards[c.cardId];
      const thumb = el('button', `g2-pile-thumb${c.uid === current ? ' on' : ''}`);
      thumb.type = 'button';
      thumb.title = card?.name ?? c.cardId;
      this.paintThumb(thumb, card, c.cardId, color);
      thumb.onclick = (e) => {
        e.stopPropagation();
        this.inspected = { kind: 'discard', id: color, pick: c.uid };
        this.render();
      };
      strip.append(thumb);
    }
    return strip;
  }

  /** A card's picture, or its glyph, on a small thumbnail. */
  private paintThumb(thumb: HTMLElement, card: v2.ViewCard | undefined, cardId: string, owner: Color): void {
    const art = card ? v2.faceArt(card, owner).art : undefined;
    if (art) thumb.style.backgroundImage = `url("${art}")`;
    else thumb.append(el('span', 'g2-thumb-glyph', card?.type === 'spell' ? SPELL_GLYPH : glyphFor(cardId, card?.name ?? cardId)));
  }

  /** Where a cast spell's card flies to: the top of its caster's discard pile. */
  private pileTarget(color: Color): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`.g2-pile[data-pile="${color}"] .g2-pile-card`);
  }

  private setPileHover(color: Color | null): void {
    if (color === this.hoverPile) return;
    this.hoverPile = color;
    if (this.view) this.renderInspect(this.view);
  }

  /** Mana a spell gave floats up off its player's mana gem. */
  private manaPop(color: Color, text: string, delay: number): void {
    window.setTimeout(() => {
      const gem = this.root.querySelector(`.g2-player.${color} .g2-gem`)?.getBoundingClientRect();
      if (!gem?.width) return;
      const pop = el('div', 'g2-mana-pop', text);
      pop.style.left = `${gem.left + gem.width / 2}px`;
      pop.style.top = `${gem.top}px`;
      document.body.append(pop);
      window.setTimeout(() => pop.remove(), 1500);
    }, delay);
  }

  private renderStatus(view: v2.PlayerView): void {
    const s = this.statusEl;
    s.className = 'status g2-status';
    s.removeAttribute('title');
    if (this.review) {
      s.classList.add('review');
      s.textContent = this.stepText(view, this.review.step);
      s.title = 'Looking back through the game: ← and → step through it.';
      this.endBtn.classList.add('hidden');
      return;
    }
    const playing = view.status.kind === 'playing';
    const mine = this.solo || view.active === view.you;
    const who = this.solo ? this.name(view.active) : 'You';
    const canEnd = view.legalActions.some((a) => a.type === 'endTurn');
    this.endBtn.classList.toggle('hidden', !playing || !canEnd);
    this.endBtn.classList.toggle('ready', canEnd);

    if (!playing) {
      s.classList.add('over');
      const st = view.status;
      const winner = 'winner' in st ? st.winner : null;
      const how = st.kind === 'timeout' ? ' (out of time)' : st.kind === 'resigned' ? ' (resignation)' : '';
      s.textContent =
        st.kind === 'stalemate' ? 'Stalemate — draw.'
        : this.solo ? `${this.name(winner!)} wins!${how}`
        : winner === view.you ? `You win!${how}` : `You lose.${how}`;
      return;
    }
    if (mine) s.classList.add('mine');
    if (view.inCheck) s.classList.add('check');

    if (view.phase === 'setup') {
      const n = view.setupDeployed[view.active];
      s.textContent = mine
        ? `${who}: deploy a zero-cost piece to your back row (${n} of ${view.setupTotal} placed).`
        : `Opponent is deploying their starting pieces (${n} of ${view.setupTotal}).`;
      return;
    }
    s.textContent =
      !mine ? "Opponent's turn"
      : view.actionTaken ? 'End the turn'
      : canEnd ? 'No moves left'
      : view.inCheck ? (this.solo ? `${who} is in check!` : 'You are in check!')
      : this.solo ? `${who}'s turn` : 'Your turn';
    if (mine && !view.actionTaken && !canEnd) {
      s.title = view.inCheck
        ? 'Move out of check, or summon a piece that blocks it. No spells until your King is safe.'
        : 'Play any cards you can afford, then move a piece. The move ends your turn.';
    }
  }

  private renderCue(view: v2.PlayerView): void {
    const cue = this.cueEl;
    const mine = this.solo || view.active === view.you;
    const from = this.selectedSquare;
    const show = mine && view.status.kind === 'playing' && view.phase === 'play' && !view.actionTaken && from !== null && this.canSpit(from);
    cue.classList.toggle('hidden', !show);
    if (!show || from === null) return;
    const aiming = this.aimLava === from;
    const lava = el('button', `g2-cue-lava${aiming ? ' on' : ''}`, aiming ? 'Pick a square for the lava · cancel' : `Spit lava · ${v2.LAVA_COST} mana`);
    lava.type = 'button';
    lava.title = aiming ? 'Put the lava away' : 'Spit lava onto an empty square this piece could move to';
    lava.onclick = () => this.toggleLavaAim(from);
    cue.replaceChildren(lava);
  }

  /** Opening a game brings its whole log (`view.history`); after that, each update adds what its action did. */
  private appendLog(view: v2.PlayerView): void {
    if (view.seq === this.lastSeq) return;
    this.lastSeq = view.seq;
    const names = this.hooks.names();
    if (view.history) this.logEl.replaceChildren();
    const batches = view.history ?? [view.events];
    // Each batch is one step, the last of them the step the view stands at, where the game can be looked back to.
    const firstStep = view.steps !== undefined ? view.steps - batches.length + 1 : null;
    batches.forEach((events, i) => {
      for (const line of describeEvents(events, view, names, this.memory)) {
        const div = el('div', `entry ${line.color ?? ''} ${line.important ? 'important' : ''}`, line.text);
        if (firstStep !== null && firstStep + i > 0) {
          div.dataset.step = String(firstStep + i);
          div.title = 'Show the game as it stood after this';
        }
        this.logEl.appendChild(div);
      }
    });
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** Whose turn it is, for the host's "your move" alerts; also while an earlier position is shown. */
  get myTurn(): boolean {
    const view = this.review?.live ?? this.view;
    return !!view && view.status.kind === 'playing' && !this.solo && view.active === view.you;
  }

  get currentView(): v2.PlayerView | null {
    return this.review?.live ?? this.view;
  }

  get statusText(): string {
    return this.statusEl.textContent ?? '';
  }
}
