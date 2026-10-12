// The rules-2 game screen: a plain-DOM board (8x8), your hand, mana, seals, and the turn controls.
// The original (rules 1) game keeps its own Pixi renderer in ../game/GameView.ts.

import { v2 } from '@chessx/engine';
import type { ChatMessage, RoomInfo } from '@chessx/protocol';
import { cardBack, fillFrame, hourglass, tiltWithPointer, type FrameCard } from './cardFrame.js';
import { BoardFx, CARD_DIVE_MS, LAVA_FLIGHT_MS, SPELL_HOLD_MS, SPELL_LANDS_MS, type BannerTone } from './fx.js';
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
}

/**
 * Glyphs for the placeholder cards; any other piece falls back to its initial. An evolution line shares the glyph
 * of the chess piece it ends in. Page, Hopper, Cathedral Runner, Tower and Dawnfang live on in saved games.
 */
const GLYPHS: Record<string, string> = {
  king: '♚',
  initiate: '✚',
  squire: '♟',
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
/** How hard an evolution lands (0 to 1): the final forms slam. */
const evolveForce = (card: v2.ViewCard | undefined): number => ((card?.level ?? 2) >= 3 ? 1 : 0.6);
/** Picture window of a spell card that has no picture yet. */
const SPELL_GLYPH = '✦\uFE0E';

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
  hover: v2.Square | null;
  /** Over your player bar, where letting go pitches the card for mana. */
  pitch: boolean;
}

/** Pixels the pointer must travel before a press on a card or piece becomes a drag rather than a click. */
const DRAG_THRESHOLD = 6;

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
 * screen, or clicked while the viewer sits beside the board), or a discard pile, `id` being whose: its newest card,
 * or the one `pick` names.
 */
interface Inspected {
  kind: 'piece' | 'seal' | 'card' | 'discard';
  id: string;
  pick?: string;
}

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
const CHAT_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>';

function paintSwitch(btn: HTMLButtonElement, on: boolean, name: string, icon: string): void {
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}${on ? '' : SLASH}</svg><span>${name}</span>`;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.title = `Turn ${name.toLowerCase()} ${on ? 'off' : 'on'}`;
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
  /** Resurrect was dropped on a square: the cards it can raise there, to pick from. */
  private readonly raiseEl = el('div', 'g2-raise hidden');
  /** What the viewer showed last, so it only plays its entrance when that changes. */
  private inspectKey = '';
  /** The press on the board so far; `held` once it was held long enough to open a card, `dragged` once it lifted a piece. */
  private boardPress: { x: number; y: number; at: number; held?: boolean; dragged?: boolean } | null = null;
  private holdTimer: number | undefined;

  private readonly memory: PieceMemory = new Map();
  private lastSeq = -1;

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
  private readonly hintEl = el('div', 'hint');
  /** Under a thumb the hovered square is hidden, so a touch drag repeats its seal warning here. */
  private readonly dropNoteEl = el('div', 'g2-dropnote hidden');
  private readonly dropTagEl = el('div', 'g2-droptag');
  private readonly oppEl = el('div', 'g2-player');
  private readonly meEl = el('div', 'g2-player');
  private readonly resignBtn = el('button', 'danger', 'Resign');
  private readonly inspectEl = el('div', 'g2-inspect hidden');
  /** Wide screens: the column left of the board that holds the card viewer. */
  private readonly detailEl = el('aside', 'g2-detail');
  /** "Cards, then move" on the board's top edge during your turn. */
  private readonly cueEl = el('div', 'g2-cue hidden');
  private readonly sideEl = el('aside', 'g2-side');
  private readonly codeBlock = el('div', 'side-block');
  private readonly statusBlock = el('div', 'side-block g2-statusblock');
  private readonly effectsBtn = el('button', 'g2-sound-btn');
  private readonly musicBtn = el('button', 'g2-sound-btn');
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
    boardBox.append(this.boardEl, this.cueEl);
    this.fx = new BoardFx(this.boardEl, boardBox, (square) => this.cells[square]);
    boardBox.append(this.raiseEl);
    boardWrap.append(this.oppEl, boardBox, this.meEl);
    main.append(boardWrap, this.handEl);
    // The bars are rebuilt every second for the clocks, so a discard pile is pointed at through its bar.
    for (const bar of [this.oppEl, this.meEl]) {
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
    this.codeBlock.append(el('div', 'label', 'Invite code'), this.codeEl, this.hintEl);
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
    this.statusBlock.append(this.statusEl, this.endBtn, this.chatBtn, this.menuBtn, this.chatPeek);
    const logBlock = this.logBlock;
    logBlock.append(el('div', 'label', 'Log'), this.logEl);
    const soundBlock = el('div', 'side-block g2-sound');
    const switches = el('div', 'g2-sound-switches');
    this.effectsBtn.type = 'button';
    this.musicBtn.type = 'button';
    this.effectsBtn.onclick = () => sound.setEffects(!sound.effectsOn);
    this.musicBtn.onclick = () => sound.setMusic(!sound.musicOn);
    switches.append(this.effectsBtn, this.musicBtn);
    soundBlock.append(el('div', 'label', 'Sound'), switches, this.creditEl);
    sound.onChange(() => this.renderSound());
    this.renderSound();
    const buttons = el('div', 'side-block actions');
    const leave = el('button', '', 'Back to games');
    leave.onclick = () => this.hooks.leave();
    this.resignBtn.onclick = () => this.hooks.resign();
    buttons.append(this.resignBtn, leave);
    side.append(sheetClose, this.codeBlock, this.statusBlock, logBlock, this.chatSlot, soundBlock, buttons);
    this.sheetShade.onclick = () => {
      this.toggleSheet(false);
      this.openChat(false);
    };

    root.append(this.detailEl, main, side, this.sheetShade);
    this.placeStatus();
    this.placeInspect();
    this.narrow.addEventListener('change', () => this.placeStatus());
    this.wide.addEventListener('change', () => this.placeInspect());

    this.endBtn.onclick = () => this.hooks.act({ type: 'endTurn' });
    this.buildBoard();
    boardBox.addEventListener('pointerdown', (e) => {
      this.boardPress = { x: e.clientX, y: e.clientY, at: performance.now() };
      this.startHold(e);
      this.pressPiece(e);
    });
    boardBox.addEventListener('pointermove', (e) => {
      const press = this.boardPress;
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP) clearTimeout(this.holdTimer);
    });
    boardBox.addEventListener('pointerup', () => clearTimeout(this.holdTimer));
    boardBox.addEventListener('pointercancel', () => clearTimeout(this.holdTimer));
    this.boardEl.addEventListener('click', (e) => {
      const tap = this.boardTap(e);
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-sq]');
      if (tap && cell) this.onSquare(Number(cell.dataset.sq), tap === 'quick');
    });
    this.boardEl.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || !this.docked || this.drag || this.pieceDrag?.ghost) return;
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-sq]');
      this.setBoardHover(cell ? Number(cell.dataset.sq) : null);
    });
    this.boardEl.addEventListener('pointerleave', () => this.setBoardHover(null));
    this.inspectEl.addEventListener('click', (e) => {
      // Beside the board the viewer stays put; only its close button clears it.
      if (this.docked && !(e.target as HTMLElement).closest('.g2-inspect-close')) return;
      if (!this.docked && !this.boardTap(e)) return;
      this.inspected = null;
      this.hoverCard = null;
      this.render();
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
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.g2-cell');
    if (!cell) return;
    const square = Number(cell.dataset.sq);
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

  // ------------------------------------------------------------------ lifecycle

  open(opts: { code: string; solo: boolean; you: Color }): void {
    this.reset();
    this.code = opts.code;
    this.solo = opts.solo;
    this.seat = opts.solo ? 'white' : opts.you;
    this.codeEl.textContent = opts.solo ? 'PRACTICE' : opts.code;
    this.hintEl.textContent = opts.solo ? 'You play both sides.' : 'Send this to a friend. They enter it under "Join".';
    this.hintEl.classList.toggle('hidden', opts.solo);
    this.buildBoard();
    this.renderPlayers();
  }

  reset(): void {
    this.cancelDrag();
    this.cancelPieceDrag();
    this.clearDropped();
    this.clearReturning();
    sound.setBattle(false);
    this.view = null;
    this.room = null;
    this.selectedSquare = null;
    this.aimLava = null;
    this.inspected = null;
    this.hoverCard = null;
    this.hoverBoard = null;
    this.hoverPile = null;
    this.pileHeld = {};
    this.closeRaise();
    this.inspectKey = '';
    this.renderEmptyInspect();
    this.cueEl.classList.add('hidden');
    this.handEl.classList.remove('spent');
    this.memory.clear();
    this.fx.clear();
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
    if (waiting && !this.view) this.statusEl.textContent = 'Waiting for an opponent to join. Share the invite code!';
  }

  /** The newest game state. */
  sync(view: v2.PlayerView): void {
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
    // After queueFx, which does not slide a piece that was dragged to its square.
    if (changed) {
      this.clearDropped();
      this.clearReturning();
    }
    this.appendLog(view);
    this.render();
  }

  /** Refresh clocks (called every second by the host). */
  tick(): void {
    this.renderPlayers();
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
  }

  private legal(): Action[] {
    return this.view?.legalActions ?? [];
  }

  /**
   * Squares the picked piece can move to (or spit lava onto, while it takes aim), with the action for each. Cards
   * are played by dragging them instead.
   */
  private targets(): Map<v2.Square, Action> {
    const out = new Map<v2.Square, Action>();
    if (this.selectedSquare === null) return out;
    const kind = this.aimLava === this.selectedSquare ? 'lava' : 'move';
    for (const a of this.legal()) {
      if ((a.type === 'move' || a.type === 'lava') && a.type === kind && a.from === this.selectedSquare) out.set(a.to, a);
    }
    return out;
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
      this.hooks.act(target);
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
    const tok = el('div', `g2-piece ${piece.owner}${piece.king ? ' king' : ''}${state}${boardArt ? ' art' : ''}`);
    if (boardArt) tok.style.backgroundImage = `url("${boardArt}")`;
    else tok.append(el('span', 'g2-piece-glyph', glyphFor(piece.kind, piece.name)));
    if (card?.level) tok.append(el('span', 'g2-piece-level', LEVEL_MARK[card.level] ?? String(card.level)));
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
          sfx.summon(e.color, !this.wasDropped(e.square, now), Math.min(1, cost / 5));
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
        default:
          break;
      }
    }
    // With the banner (see `queueBanner`).
    const at = turnAt + 150;
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
          const card = this.takeLanding(e.square, now) ? null : this.cardFace(piece.cardId, piece.owner, view);
          const cost = piece.cardId ? (view.cards[piece.cardId]?.cost ?? 0) : 0;
          this.fx.summon(e.square, piece.owner, card, 0, Math.min(1, cost / 5));
          this.tokenFx.set(piece.id, { kind: 'fx-rise', at: now + (card ? CARD_DIVE_MS : 0) });
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
          const consumed = pieceBefore.get(e.consumedPieceId);
          if (consumed) this.fx.vanish(e.square, this.pieceToken(consumed, prev), 'consume', 80);
          this.fx.seal(e.square, e.color, this.takeLanding(e.square, now) ? null : cardBack());
          this.tokenFx.set(e.sealId, { kind: 'fx-seal-in', at: now });
          break;
        }
        case 'evolved': {
          const piece = view.pieces.find((p) => p.id === e.pieceId);
          if (!piece) break;
          const old = pieceBefore.get(e.fromPieceId);
          const card = this.takeLanding(e.square, now) ? null : this.cardFace(piece.cardId, piece.owner, view);
          const force = evolveForce(piece.cardId ? view.cards[piece.cardId] : undefined);
          this.fx.evolve(e.square, e.color, old ? this.pieceToken(old, prev) : null, card, force);
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
        default:
          break;
      }
    }
    this.queueBanner(view, turnAt);
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
    if (!cell || !this.fx.enabled) {
      ghost.remove();
      return;
    }
    this.landed.set(square, performance.now());
    const box = cell.getBoundingClientRect();
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

  /** Nothing to show: a card back and a hint beside the board, nothing over it. */
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
    const info = el('div', 'g2-inspect-info');
    info.append(
      el('div', 'g2-inspect-title', 'Card viewer'),
      el('p', 'g2-inspect-hint', 'Point at a card in your hand, a piece or sacrifice on the board, or a discard pile, to see its card. Click one to keep it here.'),
    );
    box.replaceChildren(cardBack('g2-inspect-card'), info);
  }

  private exists(view: v2.PlayerView, it: Inspected): boolean {
    if (it.kind === 'card') return !!view.hand?.some((c) => c.uid === it.id);
    if (it.kind === 'discard') return (view.discard[it.id as Color]?.length ?? 0) > 0;
    if (it.kind === 'piece') return view.pieces.some((p) => p.id === it.id);
    return view.seals.some((s) => s.id === it.id);
  }

  /** Shows, in order: the hand card or discard pile under the mouse, the piece or seal under the mouse, the one tapped. */
  private renderInspect(view: v2.PlayerView): void {
    const box = this.inspectEl;
    if (this.hoverCard && !view.hand?.some((c) => c.uid === this.hoverCard)) this.hoverCard = null;
    if (this.hoverPile && !view.discard[this.hoverPile].length) this.hoverPile = null;
    if (this.hoverBoard && !this.exists(view, this.hoverBoard)) this.hoverBoard = null;
    if (this.inspected && !this.exists(view, this.inspected)) this.inspected = null;
    const shown: Inspected | null = this.hoverCard
      ? { kind: 'card', id: this.hoverCard }
      : this.hoverPile
        ? { kind: 'discard', id: this.hoverPile }
        : (this.hoverBoard ?? this.inspected);
    const handCard = shown?.kind === 'card' ? view.hand?.find((c) => c.uid === shown.id) : undefined;
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
      notes.push(this.solo ? `In ${sideName(view.you)}'s hand.` : 'In your hand.', this.howToPlay(handCard.uid, card));
      if (card?.type === 'piece' && card.detail) notes.push(card.detail);
      const next = this.evolvesInto(handCard.cardId, view);
      if (next) notes.push(next);
      const pitch = this.pitchAction(handCard.uid);
      if (pitch) {
        buttons.push(
          this.inspectButton(`Pitch it: +${v2.PITCH_MANA} mana`, 'Discard this card for mana. Once a turn; it does not end your turn.', 'mana', () =>
            this.hooks.act(pitch),
          ),
        );
      }
    } else if (piece) {
      card = piece.cardId ? view.cards[piece.cardId] : undefined;
      owner = piece.owner;
      if (piece.king) {
        frame = { kind: 'king', id: 'king', name: piece.name, text: v2.describeMovement(v2.KING), glyph: glyphFor(piece.kind, piece.name), owner, rules: v2.KING.rules };
        notes.push('No card: the King cannot be summoned, sacrificed or evolved.');
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
    } else if (seal) {
      card = view.cards[seal.cardId];
      owner = seal.owner;
      frame = this.frameFor(card, seal.cardId, owner);
      const whose = this.solo ? `${sideName(owner)}'s` : owner === view.you ? 'your' : "your opponent's";
      const when = seal.timer <= 1 ? `at the start of ${whose} next turn` : `in ${seal.timer} of ${whose} turns`;
      notes.push(`A sacrifice: this piece arrives ${when}.`);
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

    const key = handCard ? `card:${handCard.uid}` : piece ? `piece:${piece.id}` : seal ? `seal:${seal.id}` : `discard:${pileOf}:${discarded!.uid}`;
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
    const pinned = !this.hoverCard && !this.hoverBoard && this.inspected !== null;
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
      if (handCard) info.append(el('p', 'g2-inspect-note', 'Cast it any time before you move; it does not end your turn. Not while your King is in check.'));
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

  /** A button in the card viewer; using it closes a viewer that floats over the board. */
  private inspectButton(text: string, title: string, tone: 'mana' | 'lava', run: () => void): HTMLButtonElement {
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
    if (card?.type === 'spell') {
      const goOn = 'Casting does not end your turn.';
      if (card.grants) {
        const who = card.tribe ? `one of your ${card.tribe}s` : 'one of your pieces';
        return `Drag it onto ${who} to teach it ${v2.ABILITIES[card.grants].name}. ${goOn}`;
      }
      switch (card.spell) {
        case 'raise':
          return `Drag it onto a free square of your first two rows, then pick a piece card that costs ${card.maxCost} or less from your discard pile, where the pieces you capture go too: it rises there as your piece. ${goOn}`;
        case 'shield':
          return `Drag it onto one of your pieces (not the King): nothing can capture it until your next turn. ${goOn}`;
        case 'freeze':
          return `Drag it onto an enemy piece (not the King): it cannot move or capture on its owner's next turn. ${goOn}`;
        case 'destroyPiece':
          return `Drag it onto an enemy piece (not the King) that costs ${card.maxCost} or less to destroy it. ${goOn}`;
        default:
          break;
      }
      const targeted = this.legal().some((a) => a.type === 'spell' && a.cardUid === uid && a.target !== undefined);
      return `Drag it ${targeted ? 'onto a glowing target' : 'onto the board'} to cast it. ${goOn}`;
    }
    if (card?.evolvesFrom) {
      const cards = this.view?.cards ?? {};
      const from = cards[card.evolvesFrom];
      // A level-2 card can also go onto an Initiate (any path), for its own cost plus the level it skips.
      const anyPath = from && !from.evolvesFrom ? Object.values(cards).find((c) => c.anyPath) : undefined;
      const also = anyPath ? ` (or onto ${/^[aeiou]/i.test(anyPath.name) ? 'an' : 'a'} ${anyPath.name}, paying ${from!.name}'s ${from!.cost} mana as well)` : '';
      return `Drag it onto your ${from?.name ?? 'earlier form'}${also} to evolve it, if that piece was already on the board when your turn began. The new piece can move from your next turn. Evolving does not end your turn.`;
    }
    return 'Drag it to a free square on your first two rows to summon it, or onto one of your pieces (not the King) to sacrifice that piece for it. Neither ends your turn: play more cards, then move a piece.';
  }

  /** "Evolves into Mystic Dragon." for a card with a next level in this game's cards. */
  private evolvesInto(cardId: string, view: v2.PlayerView): string | null {
    const next = Object.values(view.cards).filter((c) => c.evolvesFrom === cardId).map((c) => c.name);
    return next.length ? `Evolves into ${next.join(' or ')}.` : null;
  }

  /**
   * The frame for a card, or for a piece whose card is missing from the view (name only). A piece on the board
   * also shows the abilities spells taught it (`learned`).
   */
  private frameFor(card: v2.ViewCard | undefined, kind: string, owner: Color, name = card?.name ?? kind, learned: readonly v2.Ability[] = []): FrameCard {
    const taught = learned.map((a) => v2.ABILITIES[a].name);
    if (!card) return { kind: 'piece', id: kind, name, text: '', glyph: glyphFor(kind, name), owner, learned: taught };
    return {
      kind: card.type,
      id: card.id,
      name: card.name,
      cost: card.cost,
      sealTimer: card.sealTimer,
      line: card.line,
      level: card.level,
      evolvesFrom: card.evolvesFrom ? (this.view?.cards[card.evolvesFrom]?.name ?? card.evolvesFrom) : undefined,
      tribe: card.tribe,
      text: card.text,
      ability: card.abilityText,
      learned: taught,
      art: v2.faceArt(card, owner).art,
      glyph: card.type === 'spell' ? SPELL_GLYPH : glyphFor(card.id, card.name),
      owner,
      rules: card.rules,
    };
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
    return view.cards[cardId] !== undefined && view.status.kind === 'playing' && (this.solo || view.active === view.you);
  }

  /**
   * Squares a held card can be dropped on: a free square on your first two rows summons it (the back row deploys it), one of your
   * pieces seals (sacrifices) it or, for an evolution card, evolves it, a spell's target casts it. A spell with no
   * target goes anywhere (`untargetedSpell`).
   */
  private dropTargets(uid: string): Map<v2.Square, Action> {
    const out = new Map<v2.Square, Action>();
    for (const a of this.legal()) {
      if (!('cardUid' in a) || a.cardUid !== uid) continue;
      if (a.type === 'deploy' || a.type === 'summon') out.set(a.to, a);
      else if (a.type === 'seal' || a.type === 'evolve') out.set(a.target, a);
      else if (a.type === 'spell' && a.target !== undefined) out.set(a.target, a);
    }
    return out;
  }

  /** What dropping the held card on `square` does, if anything. */
  private dropAction(uid: string, square: v2.Square | null): Action | undefined {
    if (square === null) return undefined;
    return this.dropTargets(uid).get(square) ?? this.untargetedSpell(uid) ?? undefined;
  }

  private pressCard(e: PointerEvent, uid: string, tile: HTMLElement): void {
    if (e.button !== 0 || this.drag || this.pieceDrag) return;
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
      // Only a pull up towards the board picks the card up; a sideways swipe scrolls the hand.
      if (-dy < Math.abs(dx)) {
        if (e.pointerType === 'mouse' && row) {
          drag.scrollFrom = row.scrollLeft;
          return;
        }
        this.removeDragListeners();
        this.drag = null;
        return;
      }
      const tile = this.tileFor(drag.uid);
      if (!tile) return this.cancelDrag();
      const ghost = tile.cloneNode(true) as HTMLElement;
      ghost.classList.remove('lifted', 'fresh', 'inspected');
      ghost.classList.add('g2-drag-ghost');
      if (!this.dropTargets(drag.uid).size && !this.untargetedSpell(drag.uid) && !this.pitchAction(drag.uid)) ghost.classList.add('nowhere');
      ghost.style.fontSize = getComputedStyle(tile).fontSize;
      ghost.style.animationDelay = '';
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      sound.sfx?.cardLift();
      this.hoverCard = null;
      if (this.inspected?.kind === 'card') this.inspected = null;
      this.clearSelection();
      this.render();
    }
    e.preventDefault();
    // The card hangs above the pointer so the square it would land on stays visible.
    drag.ghost.style.left = `${e.clientX - drag.ghost.offsetWidth / 2}px`;
    drag.ghost.style.top = `${e.clientY - drag.ghost.offsetHeight - 6}px`;
    const square = this.squareAt(e.clientX, e.clientY);
    const anywhere = this.untargetedSpell(drag.uid) !== null;
    const hover = square !== null && (anywhere || this.dropTargets(drag.uid).has(square)) ? square : null;
    const pitch = this.overPitch(e.clientX, e.clientY);
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
      this.showSealWarning(drag);
    }
  };

  /** Whether the pointer is over the player bar that takes a pitched card (see `renderPlayers`). */
  private overPitch(x: number, y: number): boolean {
    return !!document.elementFromPoint(x, y)?.closest('.g2-player.pitch-drop');
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
    // Onto an Initiate (any path): the level it skips is paid for as well.
    const skipped = card?.evolvesFrom && target?.cardId !== card.evolvesFrom ? this.view?.cards[card.evolvesFrom] : undefined;
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
    const square = e.type === 'pointerup' ? this.squareAt(e.clientX, e.clientY) : null;
    const pitch = e.type === 'pointerup' && square === null && this.overPitch(e.clientX, e.clientY) ? this.pitchAction(drag.uid) : null;
    const gem = pitch ? document.querySelector('.g2-player.pitch-drop .g2-gem')?.getBoundingClientRect() : undefined;
    const action = this.dropAction(drag.uid, square);
    this.drag = null;
    if (pitch) {
      this.burnAway(ghost, gem);
      this.hooks.act(pitch);
      this.clearSelection();
      this.render();
      return;
    }
    if (action?.type === 'spell' && action.pick !== undefined && square !== null && this.raiseOptions(drag.uid, square).length > 1) {
      this.render();
      this.snapBack(ghost, drag.uid);
      this.openRaise(drag.uid, square);
      return;
    }
    if (action && square !== null) {
      if (action.type === 'spell') {
        this.castAway(ghost);
        sound.sfx?.cardCast();
      } else {
        this.land(ghost, square);
        sound.sfx?.cardDrop();
      }
      this.hooks.act(action);
      this.clearSelection();
      this.render();
      return;
    }
    this.render();
    this.snapBack(ghost, drag.uid);
  };

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
    head.append(el('b', '', `Resurrect onto ${v2.squareName(square)}`), el('span', '', `Pick a piece from ${whose}. It rises there as yours.`));
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

  private squareAt(x: number, y: number): v2.Square | null {
    const cell = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-sq]');
    return cell && this.boardEl.contains(cell) ? Number(cell.dataset.sq) : null;
  }

  // ---------------------------------------------------------------- piece drag

  /** A press on one of your pieces that can move. Dragging it moves it; letting go without dragging is a tap. */
  private pressPiece(e: PointerEvent): void {
    if (e.button !== 0 || !e.isPrimary || this.drag || this.pieceDrag || this.dropped || !this.view) return;
    const cell = (e.target as HTMLElement).closest<HTMLElement>('.g2-cell');
    if (!cell || !this.boardEl.contains(cell)) return;
    const from = Number(cell.dataset.sq);
    if (!this.movers(this.view).has(from)) return;
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
    const lift = drag.pointerType === 'touch' ? ghost.offsetHeight * 0.9 : 0;
    ghost.style.left = `${e.clientX - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${e.clientY - ghost.offsetHeight / 2 - lift}px`;
    const square = this.squareAt(e.clientX, e.clientY);
    const hover = square !== null && this.targets().has(square) ? square : null;
    if (hover === drag.hover) return;
    if (drag.hover !== null) this.cells[drag.hover]?.classList.remove('drag-over');
    if (hover !== null) this.cells[hover]?.classList.add('drag-over');
    drag.hover = hover;
    ghost.classList.toggle('over', hover !== null);
  };

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
    if (drag.hover !== null) this.cells[drag.hover]?.classList.remove('drag-over');
    const square = e.type === 'pointerup' ? this.squareAt(e.clientX, e.clientY) : null;
    const move = square === null ? undefined : this.targets().get(square);
    if (move && square !== null) this.dropPiece(drag.from, square, move, ghost);
    else this.returnPiece(drag.from, ghost);
  };

  /** Let go on a lit square: the move is sent, and the piece waits on its new square until the server answers. */
  private dropPiece(from: v2.Square, to: v2.Square, move: Action, ghost: HTMLElement): void {
    this.clearDropped();
    ghost.classList.add('landing');
    this.placeOn(ghost, to);
    const timer = window.setTimeout(() => {
      this.clearDropped();
      this.render();
    }, DROP_WAIT_MS);
    this.dropped = { from, to, ghost, timer };
    this.hooks.act(move);
    this.clearSelection();
    this.render();
  }

  /** Let go anywhere else: the piece flies back to its square and stays picked up, so a tap can still move it. */
  private returnPiece(from: v2.Square, ghost: HTMLElement): void {
    this.clearReturning();
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
    if (drag.hover !== null) this.cells[drag.hover]?.classList.remove('drag-over');
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
    const label = el('div', 'g2-handlabel');
    label.textContent = this.solo ? `${this.name(view.you)}'s hand` : spent ? 'Your hand · opponent\'s turn' : 'Your hand';
    if (view.hand?.some((c) => this.canLift(view, c.cardId))) {
      const read = this.docked ? 'tap a card to read it' : 'tap a card or hold a piece to read it';
      label.append(
        el(
          'span',
          'g2-handtip',
          ` · drag a piece to your first two rows to summon it, or onto your piece to sacrifice that piece for it · drag an evolution onto the piece it evolves from · drag a spell onto the board to cast it · once a turn, drop a card on your name bar to pitch it for +${v2.PITCH_MANA} mana · ${read}`,
        ),
      );
    }
    this.handEl.append(label, this.dropNoteEl);

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
    const away = this.dropped?.from ?? null;
    const aiming = this.aimLava !== null && this.aimLava === this.selectedSquare;

    for (let square = 0; square < v2.FILES * v2.RANKS; square++) {
      const cell = this.cells[square]!;
      const piece = view.pieces.find((p) => p.square === square);
      const seal = view.seals.find((s) => s.square === square);
      const lava = view.lava.find((l) => l.square === square);
      const classes = ['g2-cell', (v2.fileOf(square) + v2.rankOf(square)) % 2 === 0 ? 'dark' : 'light'];
      if (movers.has(square) && square !== away) classes.push('movable');
      if (targets.has(square)) classes.push(this.pieceDrag?.hover === square ? 'target drag-over' : 'target');
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
      const warning = this.sealWarning(drop);
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
      const tok = piece ? this.pieceToken(piece, view) : seal ? this.sealToken(seal, view) : null;
      if (tok) {
        this.applyTokenFx(tok, piece?.id ?? seal!.id, now);
        if (piece && square === away) tok.classList.add('away');
        else if (piece && square === lifted) tok.classList.add('lifted');
        cell.appendChild(tok);
      }
    }

    this.renderHand(view);
    this.renderInspect(view);
    this.renderPlayers();
    this.renderStatus(view);
    this.renderCue(view);
  }

  private renderPlayers(): void {
    const view = this.view;
    const top: Color = this.seat === 'white' ? 'black' : 'white';
    for (const [elx, color] of [
      [this.oppEl, top],
      [this.meEl, this.seat],
    ] as const) {
      elx.innerHTML = '';
      elx.className = `g2-player ${color}`;
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
        mana.title = `${view.mana[color]} mana. ${turn ? 'This' : 'The next'} turn brings ${income}; every 5th turn brings 1 more, up to 4.`;
        mana.append(el('i', 'g2-gem'), el('b', '', String(view.mana[color])), el('span', 'g2-mana-word', ' mana'), el('span', 'g2-income', `+${income}`));
        // Holding a card you can pitch: the bar takes it (see `onDragEnd`).
        const held = this.drag?.ghost ? this.drag : null;
        if (held && color === view.you && this.pitchAction(held.uid)) {
          elx.classList.add('pitch-drop');
          if (held.pitch) elx.classList.add('pitch-over');
          who.replaceChildren(el('span', 'g2-pitch-label', `Drop here to pitch it: +${v2.PITCH_MANA} mana`));
        }
        const hand = el('span', 'g2-count hand', `Hand ${view.handCount[color]}`);
        // The hand you cannot see is shown as card backs.
        if (color !== view.you && view.handCount[color] > 0) {
          const backs = el('span', 'g2-backs');
          for (let i = 0; i < Math.min(view.handCount[color], 8); i++) backs.append(cardBack());
          hand.prepend(backs);
        }
        stats.append(mana, hand, el('span', 'g2-count', `Deck ${view.deckCount[color]}`), this.discardPile(color, view));
        elx.appendChild(stats);
      }
    }
  }

  /**
   * A player's discard pile: its newest card face up and how many it holds. Point at it to read that card in the
   * card viewer; click it to keep it there with the whole pile.
   */
  private discardPile(color: Color, view: v2.PlayerView): HTMLElement {
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
    btn.append(thumb, el('span', 'g2-pile-count', `Discard ${pile.length}`));
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
    const turn = view.turns[view.active];
    if (!mine) {
      s.textContent = `Opponent's turn (${turn}).`;
      return;
    }
    if (view.actionTaken) {
      s.textContent = `${who}: action done. End the turn.`;
      return;
    }
    const mana = `${view.mana[view.active]} mana`;
    if (canEnd) {
      s.textContent = `${who}: no move left, ${mana}. Play more cards if you like, then End turn.`;
      return;
    }
    s.textContent = view.inCheck
      ? `${who}: turn ${turn}, ${mana}. You are in CHECK: move out of it, or summon a piece that blocks it. No spells until your King is safe.`
      : `${who}: turn ${turn}, ${mana}. Play any cards you can afford, then move a piece.`;
    s.append(el('span', 'g2-status-more', ' The move ends your turn.'));
  }

  private renderCue(view: v2.PlayerView): void {
    const cue = this.cueEl;
    const mine = this.solo || view.active === view.you;
    const show = mine && view.status.kind === 'playing' && view.phase === 'play' && !view.actionTaken;
    cue.classList.toggle('hidden', !show);
    if (!show) return;
    const canPlay = view.legalActions.some((a) => a.type === 'summon' || a.type === 'seal' || a.type === 'evolve' || a.type === 'spell');
    const canEnd = view.legalActions.some((a) => a.type === 'endTurn');
    const cards = el('span', `g2-cue-step${canPlay ? '' : ' off'}`, 'Cards');
    const finish = el('span', 'g2-cue-step now', canEnd ? 'End turn' : 'move');
    cards.title = canPlay ? 'Optional: play any cards you can afford' : 'No card you can play now';
    finish.title = canEnd ? 'No move left: End turn closes your turn.' : 'Move a piece. It ends your turn.';
    cue.replaceChildren(cards, el('span', 'g2-cue-then', ', then '), finish);
    // The picked piece has Lava Breath: aim it from here.
    const from = this.selectedSquare;
    if (from === null || !this.canSpit(from)) return;
    const aiming = this.aimLava === from;
    const lava = el('button', `g2-cue-lava${aiming ? ' on' : ''}`, aiming ? 'Pick a square for the lava · cancel' : `Spit lava · ${v2.LAVA_COST} mana`);
    lava.type = 'button';
    lava.title = aiming ? 'Put the lava away' : 'Spit lava onto an empty square this piece could move to';
    lava.onclick = () => this.toggleLavaAim(from);
    cue.append(el('span', 'g2-cue-then', ' · '), lava);
  }

  /** Opening a game brings its whole log (`view.history`); after that, each update adds what its action did. */
  private appendLog(view: v2.PlayerView): void {
    if (view.seq === this.lastSeq) return;
    this.lastSeq = view.seq;
    const names = this.hooks.names();
    if (view.history) this.logEl.replaceChildren();
    for (const events of view.history ?? [view.events]) {
      for (const line of describeEvents(events, view, names, this.memory)) {
        const div = el('div', `entry ${line.color ?? ''} ${line.important ? 'important' : ''}`, line.text);
        this.logEl.appendChild(div);
      }
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** Whose turn it is, for the host's "your move" alerts. */
  get myTurn(): boolean {
    return !!this.view && this.view.status.kind === 'playing' && !this.solo && this.view.active === this.view.you;
  }

  get currentView(): v2.PlayerView | null {
    return this.view;
  }

  get statusText(): string {
    return this.statusEl.textContent ?? '';
  }
}
