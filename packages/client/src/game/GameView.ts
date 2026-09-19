import { canAct, getCardDef, getPieceDef, opposite, previewAbilities, previewMoves, rankOf, type Action, type ArenaOp, type Color, type GameEvent, type Piece, type PlayerView, type Square } from '@chessx/engine';
import { Application, Container, Graphics, Text, type FederatedPointerEvent } from 'pixi.js';
import { preloadArt } from './art.js';
import { CardSprite } from './CardSprite.js';
import { DeckSprite } from './DeckSprite.js';
import { DiscardSprite } from './DiscardSprite.js';
import { ManaCounter } from './ManaCounter.js';
import {
  BOARD_SIZE,
  BOARD_X,
  BOARD_Y,
  CANVAS_H,
  CANVAS_W,
  CARD_H,
  CARD_W,
  COLORS,
  DECK_H,
  DECK_SCALE,
  DECK_W,
  DISCARD_SCALE,
  HAND_X0,
  HAND_X1,
  HAND_Y,
  MOBILE,
  MY_DECK,
  MY_DISCARD,
  MY_MANA,
  OPP_CARD_H,
  OPP_CARD_W,
  OPP_DECK,
  OPP_DISCARD,
  OPP_MANA,
  OPP_HAND_X0,
  OPP_HAND_X1,
  OPP_HAND_Y,
  SQ,
  TRASH,
  UI_FONT,
  isOverBoard,
  isOverTrash,
  squareToXY,
  xyToSquare,
} from './layout.js';
import { PieceSprite } from './PieceSprite.js';
import { Tweens, easeInOutQuad, easeOutBack } from './tween.js';

type MoveAction = Extract<Action, { type: 'move' }>;
type CardAction = Extract<Action, { type: 'playCard' }>;

interface Targets {
  /** Square -> action to send when dropped there. */
  bySquare: Map<Square, Action>;
  /** Action for untargeted cards, playable by dropping anywhere on the board. */
  anywhere: Action | null;
}

type Drag =
  | { kind: 'piece'; sprite: PieceSprite; from: Square; targets: Targets; startX: number; startY: number; moved: boolean }
  | { kind: 'card'; sprite: CardSprite; homeX: number; homeY: number; homeLayer: Container; homeScale: number; targets: Targets; startX: number; startY: number; moved: boolean };

interface Selection {
  square: Square;
  targets: Targets;
}

/** What the side panel should show: a piece on the board or a card in hand. */
export type InspectTarget = { kind: 'piece'; piece: Piece } | { kind: 'card'; cardId: string };

export type ArenaDrop =
  | { zone: 'square'; square: Square }
  | { zone: 'hand'; color: Color }
  | { zone: 'trash' }
  | { zone: 'none' };

/**
 * Renders the board + hand with PixiJS and turns pointer input into engine
 * Actions. It never decides legality itself: everything it offers the player
 * comes from `view.legalActions` sent by the server.
 */
export class GameView {
  app = new Application();
  onAction: (a: Action) => void = () => {};
  /** Testing-arena setup (spawn / grant / remove). */
  onArena: (op: ArenaOp) => void = () => {};
  /** Fired whenever the inspected piece/card changes or its data refreshes (null = nothing inspected). */
  onInspect: (target: InspectTarget | null) => void = () => {};
  /** Board/hand inspect replaced a catalog pick — clear the arena list highlight. */
  onCatalogHighlightClear: () => void = () => {};
  /** Practice mode: one player controls both sides, board stays white-at-bottom. */
  hotseat = false;
  /** Testing arena: palette drops and free relocate/remove. */
  arena = false;

  manaOf(color: Color): number {
    return this.view?.players[color]?.mana ?? 0;
  }

  hasPendingGrant(): boolean {
    return !!this.view?.pendingGrant;
  }

  private tweens!: Tweens;
  private boardLayer = new Container();
  private lastMoveLayer = new Container();
  private inspectLayer = new Container();
  private voidLayer = new Container();
  private highlightLayer = new Container();
  private pieceLayer = new Container();
  private fxLayer = new Container();
  private handLayer = new Container();
  private oppHandLayer = new Container();
  private deckLayer = new Container();
  private dragLayer = new Container();
  private banner = new Container();
  private myDeck = new DeckSprite();
  private oppDeck = new DeckSprite();
  private myDiscard!: DiscardSprite;
  private oppDiscard!: DiscardSprite;
  private myMana!: ManaCounter;
  private oppMana!: ManaCounter;
  private trash = new Container();
  /** Fired when a discard pile is clicked, with the colour whose pile it is. */
  onOpenDiscard: (color: Color) => void = () => {};

  private sprites = new Map<string, PieceSprite>();
  private voids = new Map<string, Graphics>();
  private view: PlayerView | null = null;
  private flipped = false;
  /** Set once init() has built the stage; a view arriving earlier is parked here. */
  private ready = false;
  private pendingView: PlayerView | null = null;
  private drag: Drag | null = null;
  private selection: Selection | null = null;
  private inspected: string | null = null;
  private inspectedCard: string | null = null;
  /** Arena list pick: a preview piece/card that is not on the board. */
  private catalogInspect: InspectTarget | null = null;
  /** A finger/pointer went down on a hand card; we decide tap / swipe / drag once it moves. */
  private pendingCard: { sprite: CardSprite; homeX: number; homeY: number; homeLayer: Container; homeScale: number; startX: number; startY: number; scrollStart: number } | null = null;
  private handScrolling = false;
  /** Instance ids in the hand at the last render, to spot freshly drawn cards. */
  private handIds = new Set<string>();
  /** Phone: badges showing how many hand cards are scrolled off each edge. */
  private handOverflow = new Container();
  /** Horizontal scroll offset of the hand strip (phones). */
  private handScroll = 0;
  private handMaxScroll = 0;
  /** Fired on a tap (no drag) on a hand card. */
  onCardTap: (cardId: string) => void = () => {};
  /** Fired on a tap (no drag) on a piece — after it has been inspected/selected. */
  onPieceTap: (piece: Piece) => void = () => {};
  private pulse = 0;
  /** The current set of target-square highlights, faded in and out by the ticker. */
  private pulsingHighlights: Graphics | null = null;
  /** Pieces waiting to be picked for an on-summon grant — they pulse with the overlay. */
  private grantPulseSprites: PieceSprite[] = [];

  async init(mount: HTMLElement): Promise<void> {
    const base = { width: CANVAS_W, height: CANVAS_H, backgroundAlpha: 0, autoDensity: true } as const;
    try {
      await this.app.init({ ...base, antialias: true, resolution: Math.min(2, window.devicePixelRatio || 1), preference: 'webgl' });
    } catch (err) {
      // Some GPUs/drivers refuse an antialiased or high-resolution context; try the plainest one.
      console.warn('renderer init failed, retrying with conservative settings', err);
      this.app = new Application();
      await this.app.init({ ...base, antialias: false, resolution: 1, preference: 'webgl' });
    }
    mount.appendChild(this.app.canvas);
    // Logical size for the stylesheet: it scales the canvas down to fit but never above this.
    this.app.canvas.style.setProperty('--canvas-w', `${CANVAS_W}px`);
    this.app.canvas.style.setProperty('--canvas-h', `${CANVAS_H}px`);
    this.tweens = new Tweens(this.app.ticker);
    await preloadArt();

    this.app.stage.addChild(
      this.boardLayer,
      this.lastMoveLayer,
      this.inspectLayer,
      this.voidLayer,
      this.pieceLayer,
      this.highlightLayer,
      this.fxLayer,
      this.deckLayer,
      this.oppHandLayer,
      this.handLayer,
      this.dragLayer,
      this.banner,
    );
    this.highlightLayer.eventMode = 'none';
    this.drawBoard();

    this.myDeck.position.set(MY_DECK.x, MY_DECK.y);
    this.oppDeck.position.set(OPP_DECK.x, OPP_DECK.y);
    this.myDeck.scale.set(DECK_SCALE);
    this.oppDeck.scale.set(DECK_SCALE);
    // Cards scroll horizontally inside the hand strip; keep them out of the deck column.
    const handMask = new Graphics().rect(HAND_X0 - 6, HAND_Y - 30, HAND_X1 - HAND_X0 + 12, CARD_H + 60).fill(0xffffff);
    this.app.stage.addChild(handMask);
    this.handOverflow.eventMode = 'none';
    this.app.stage.addChild(this.handOverflow);
    this.handLayer.mask = handMask;
    this.myDeck.onDraw = () => this.onAction({ type: 'draw' });
    this.oppDeck.onDraw = () => this.onAction({ type: 'draw' });
    this.myDiscard = new DiscardSprite(DISCARD_SCALE);
    this.oppDiscard = new DiscardSprite(DISCARD_SCALE);
    this.myDiscard.position.set(MY_DISCARD.x, MY_DISCARD.y);
    this.oppDiscard.position.set(OPP_DISCARD.x, OPP_DISCARD.y);
    this.myDiscard.onOpen = () => this.onOpenDiscard(this.bottomColor());
    this.oppDiscard.onOpen = () => this.onOpenDiscard(opposite(this.bottomColor()));
    this.deckLayer.addChild(this.oppDeck, this.myDeck, this.oppDiscard, this.myDiscard);
    this.myMana = new ManaCounter(MY_MANA.size, 'MANA', !MOBILE);
    this.oppMana = new ManaCounter(OPP_MANA.size, 'THEIR MANA', !MOBILE);
    this.myMana.tweens = this.tweens;
    this.oppMana.tweens = this.tweens;
    this.myMana.position.set(MY_MANA.x, MY_MANA.y);
    this.oppMana.position.set(OPP_MANA.x, OPP_MANA.y);
    this.drawTrash();
    this.deckLayer.addChild(this.myMana, this.oppMana, this.trash);

    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on('pointermove', (e) => this.onPointerMove(e));
    this.app.stage.on('pointerup', (e) => this.onPointerUp(e));
    this.app.stage.on('pointerupoutside', (e) => this.onPointerUp(e));
    this.app.stage.on('pointerdown', (e) => this.onStagePointerDown(e));

    this.app.ticker.add((tk) => {
      this.pulse += tk.deltaMS / 1000;
      const a = 0.55 + 0.25 * Math.sin(this.pulse * 3);
      for (const v of this.voids.values()) {
        v.alpha = a;
        v.rotation += tk.deltaMS / 2500;
      }
      this.myDeck.tick(tk.deltaMS);
      this.oppDeck.tick(tk.deltaMS);
      // Target highlights breathe on a 2 s cycle.
      const beat = 0.7 + 0.3 * Math.sin((this.pulse * 2 * Math.PI) / 2);
      const hl = this.pulsingHighlights;
      if (hl && !hl.destroyed) hl.alpha = beat;
      for (const sprite of this.grantPulseSprites) {
        if (!sprite.destroyed) sprite.alpha = 0.62 + 0.38 * Math.sin((this.pulse * 2 * Math.PI) / 2);
      }
    });

    this.ready = true;
    if (this.pendingView) {
      const v = this.pendingView;
      this.pendingView = null;
      this.sync(v);
    }
  }

  /** Forget the current game (called when leaving a room). */
  /**
   * The catalog changed (admin edit): load any new pictures, then rebuild the
   * piece sprites and hand so they pick up new art/stats. No animations replay.
   */
  async refreshArt(): Promise<void> {
    if (!this.ready) return;
    await preloadArt();
    for (const s of this.sprites.values()) s.destroy();
    this.sprites.clear();
    if (this.view) this.sync({ ...this.view, events: [] });
  }

  reset(): void {
    this.cancelDrag();
    this.selection = null;
    for (const s of this.sprites.values()) s.destroy();
    for (const v of this.voids.values()) v.destroy();
    this.sprites.clear();
    this.voids.clear();
    this.clearGrantPulse();
    for (const layer of [this.highlightLayer, this.lastMoveLayer, this.inspectLayer, this.fxLayer, this.banner]) layer.removeChildren();
    for (const old of this.handLayer.removeChildren()) old.destroy();
    for (const old of this.dragLayer.removeChildren()) old.destroy({ children: true }); // an in-flight card reveal
    this.handOverflow.removeChildren();
    this.handIds.clear();
    this.handScroll = 0;
    if (this.ready) {
      this.myDiscard.update([]);
      this.oppDiscard.update([]);
    }
    this.view = null;
    this.pendingView = null;
    this.inspectedCard = null;
    this.catalogInspect = null;
    this.setInspected(null);
  }

  // -------------------------------------------------------------------------
  // Inspection (zoomed card in the side panel)

  private setInspected(pieceId: string | null, clearCatalog = false): void {
    this.inspected = pieceId;
    this.inspectLayer.removeChildren();
    const piece = pieceId && this.view ? this.view.pieces[pieceId] : undefined;
    if (clearCatalog || piece) {
      if (this.catalogInspect) {
        this.catalogInspect = null;
        this.onCatalogHighlightClear();
      }
    }
    if (piece) {
      this.inspectedCard = null;
      const { x, y } = squareToXY(piece.square, this.flipped);
      const g = new Graphics().roundRect(x - SQ / 2 + 2, y - SQ / 2 + 2, SQ - 4, SQ - 4, 6).stroke({ width: 3, color: COLORS.select, alpha: 0.9 });
      this.inspectLayer.addChild(g);
      this.onInspect({ kind: 'piece', piece });
    } else if (this.catalogInspect) {
      this.onInspect(this.catalogInspect);
    } else if (this.inspectedCard) {
      this.onInspect({ kind: 'card', cardId: this.inspectedCard });
    } else {
      this.onInspect(null);
    }
  }

  /** Show a hand card in the side panel (hover or grab). Replaces any inspected piece. */
  private inspectCard(cardId: string): void {
    this.inspectedCard = cardId;
    this.inspected = null;
    if (this.catalogInspect) {
      this.catalogInspect = null;
      this.onCatalogHighlightClear();
    }
    this.inspectLayer.removeChildren();
    this.onInspect({ kind: 'card', cardId });
  }

  /** Arena catalog: show a card in the inspect panel the same way a hand card does. */
  inspectCatalogCard(cardId: string): void {
    this.inspected = null;
    this.inspectedCard = null;
    this.inspectLayer.removeChildren();
    this.catalogInspect = { kind: 'card', cardId };
    this.onInspect(this.catalogInspect);
  }

  /** Arena catalog: show a piece def as if it were sitting on the board. */
  inspectCatalogPiece(kind: string, owner: Color): void {
    const def = getPieceDef(kind);
    const defense = def.defense ?? 0;
    const piece: Piece = {
      id: 'catalog-preview',
      kind,
      owner,
      square: 0,
      defense,
      hasMoved: true,
      stance: defense > 0 ? 'defense' : 'attack',
    };
    this.inspected = null;
    this.inspectedCard = null;
    this.inspectLayer.removeChildren();
    this.catalogInspect = { kind: 'piece', piece };
    this.onInspect(this.catalogInspect);
  }

  /** The legal stance-change for a piece, if any (only exists on its owner's turn). */
  stanceActionFor(pieceId: string): Extract<Action, { type: 'setStance' }> | null {
    const piece = this.view?.pieces[pieceId];
    if (!piece || !this.view) return null;
    for (const a of this.view.legalActions) {
      if (a.type === 'setStance' && a.square === piece.square) return a;
    }
    return null;
  }

  /** Toggle the inspected piece's stance (uses the turn). */
  toggleInspectedStance(): void {
    if (!this.inspected) return;
    const action = this.stanceActionFor(this.inspected);
    if (action) this.onAction(action);
  }

  /** Cannot act right now: frozen in Defense, being sacrificed, or switched stance this turn. */
  isLocked(piece: Piece): boolean {
    return !canAct(piece) || (this.view?.turnInfo.stanceChanged.includes(piece.id) ?? false);
  }

  // -------------------------------------------------------------------------
  // Sync with server state

  sync(view: PlayerView): void {
    if (!this.ready) {
      // Stage not built yet (slow WebGL start / art still loading): apply once init() finishes.
      this.pendingView = view;
      return;
    }
    const first = this.view === null;
    this.view = view;
    const flipped = !this.hotseat && view.you === 'black';
    if (first || flipped !== this.flipped) {
      this.flipped = flipped;
      this.drawBoard();
    }

    this.cancelDrag();
    this.selection = null;
    this.clearGrantPulse();
    this.highlightLayer.removeChildren();

    // Pieces: tween existing, pop new, fade removed.
    const seen = new Set<string>();
    for (const piece of Object.values(view.pieces)) {
      seen.add(piece.id);
      const { x, y } = squareToXY(piece.square, this.flipped);
      let sprite = this.sprites.get(piece.id);
      if (!sprite) {
        sprite = new PieceSprite(piece);
        sprite.update(piece, !this.arena && this.isLocked(piece));
        sprite.position.set(x, y);
        sprite.on('pointerdown', (e) => this.onPiecePointerDown(e, sprite!));
        this.pieceLayer.addChild(sprite);
        sprite.zIndex = this.stackZ(piece.square);
        this.sprites.set(piece.id, sprite);
        if (!first) {
          sprite.scale.set(0);
          const s = sprite;
          this.tweens.run(320, (t) => !s.destroyed && s.scale.set(t), { ease: easeOutBack });
        }
      } else {
        sprite.update(piece, !this.arena && this.isLocked(piece));
        if (sprite.x !== x || sprite.y !== y) {
          const s = sprite;
          const sx = s.x;
          const sy = s.y;
          s.zIndex = 10;
          this.tweens.run(
            first ? 0 : 220,
            (t) => !s.destroyed && s.position.set(sx + (x - sx) * t, sy + (y - sy) * t),
            { ease: easeInOutQuad, done: () => !s.destroyed && (s.zIndex = this.stackZ(piece.square)) },
          );
        } else {
          sprite.zIndex = this.stackZ(piece.square);
        }
      }
      this.syncVoid(piece.id, !!piece.summon, x, y);
    }
    for (const [id, sprite] of this.sprites) {
      if (seen.has(id)) continue;
      this.sprites.delete(id);
      this.syncVoid(id, false, 0, 0);
      sprite.eventMode = 'none';
      this.tweens.run(260, (t) => {
        if (sprite.destroyed) return;
        sprite.alpha = 1 - t;
        sprite.scale.set(1 - 0.4 * t);
      }, { done: () => !sprite.destroyed && sprite.destroy() });
    }
    this.pieceLayer.sortableChildren = true;

    this.playEvents(view.events);
    this.drawLastMove(view.events);
    this.setSandboxChrome();
    this.renderDecks();
    this.renderHand();
    this.renderOpponentHand();
    this.renderBanner();
    // Refresh the inspected piece (it may have moved, changed stats, or died).
    this.setInspected(this.inspected && view.pieces[this.inspected] ? this.inspected : null);
    this.showPendingGrant();
  }

  /** After a summon with several grant targets: keep those neighbours flashing. */
  private showPendingGrant(): void {
    const view = this.view;
    const pending = view?.pendingGrant;
    if (!view || !pending) return;
    if (!this.arena && !this.hotseat && view.turn !== view.you) return;
    const bySquare = new Map<Square, Action>();
    for (const to of pending.targets) {
      bySquare.set(to, { type: 'useAbility', from: pending.from, to, index: pending.index });
    }
    const targets = { bySquare, anywhere: null };
    this.selection = { square: pending.from, targets };
    this.drawHighlights(targets, pending.from);
    this.clearGrantPulse();
    for (const to of pending.targets) {
      const id = view.board[to];
      const sprite = id ? this.sprites.get(id) : undefined;
      if (sprite) this.grantPulseSprites.push(sprite);
    }
    this.setInspected(pending.pieceId);
  }

  private clearGrantPulse(): void {
    for (const sprite of this.grantPulseSprites) {
      if (!sprite.destroyed) sprite.alpha = 1;
    }
    this.grantPulseSprites = [];
  }

  private syncVoid(pieceId: string, active: boolean, x: number, y: number): void {
    const existing = this.voids.get(pieceId);
    if (active && !existing) {
      const g = new Graphics();
      g.circle(0, 0, 31).fill(COLORS.void);
      g.circle(0, 0, 31).stroke({ width: 3, color: COLORS.summon, alpha: 0.9 });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.moveTo(Math.cos(a) * 20, Math.sin(a) * 20).lineTo(Math.cos(a) * 29, Math.sin(a) * 29).stroke({ width: 2, color: COLORS.summon, alpha: 0.6 });
      }
      g.position.set(x, y);
      g.scale.set(0);
      this.voidLayer.addChild(g);
      this.voids.set(pieceId, g);
      this.tweens.run(400, (t) => g.scale.set(t), { ease: easeOutBack });
    } else if (!active && existing) {
      this.voids.delete(pieceId);
      this.tweens.run(300, (t) => !existing.destroyed && existing.scale.set(1 - t), { done: () => !existing.destroyed && existing.destroy() });
    } else if (existing) {
      existing.position.set(x, y);
    }
  }

  private playEvents(events: GameEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'attacked': {
          const attacker = this.sprites.get(ev.attackerId);
          const repelled = events.some((e) => e.type === 'repelled' && e.pieceId === ev.attackerId);
          if (attacker && repelled) {
            const home = squareToXY(ev.from, this.flipped);
            const target = squareToXY(ev.to, this.flipped);
            attacker.zIndex = 10;
            this.tweens.run(340, (t) => {
              if (attacker.destroyed || this.drag?.sprite === attacker) return;
              const k = Math.sin(t * Math.PI) * 0.6;
              attacker.position.set(home.x + (target.x - home.x) * k, home.y + (target.y - home.y) * k);
            }, { ease: easeInOutQuad, done: () => !attacker.destroyed && (attacker.zIndex = this.stackZ(ev.from)) });
          }
          break;
        }
        case 'defenseAbsorbed': {
          const { x, y } = squareToXY(ev.square, this.flipped);
          this.flash(x, y, COLORS.def, 220);
          this.floatText(x, y, 'Defense broken', COLORS.def, 240);
          break;
        }
        case 'defenseGranted': {
          const { x, y } = squareToXY(ev.square, this.flipped);
          this.flash(x, y, COLORS.def, 220);
          this.floatText(x, y, `+${ev.amount} Defense`, COLORS.def, 240);
          break;
        }
        case 'stanceChanged': {
          const { x, y } = squareToXY(ev.square, this.flipped);
          this.flash(x, y, ev.stance === 'defense' ? COLORS.def : COLORS.attack, 300);
          this.burst(x, y, ev.stance === 'defense' ? COLORS.def : COLORS.attack, 0.9);
          break;
        }
        case 'destroyed':
        case 'kingCaptured': {
          const { x, y } = squareToXY(ev.square, this.flipped);
          this.burst(x, y, COLORS.attack);
          break;
        }
        case 'summoned': {
          const { x, y } = squareToXY(ev.square, this.flipped);
          this.burst(x, y, COLORS.summon, 1.6);
          break;
        }
        case 'abilityUsed': {
          const dest = squareToXY(ev.to, this.flipped);
          this.burst(dest.x, dest.y, COLORS.ability, 0.9);
          if (ev.defense) this.floatText(dest.x, dest.y, `+${ev.defense} Defense`, COLORS.ability);
          break;
        }
        case 'summonStarted': {
          const { x, y } = squareToXY(ev.square, this.flipped);
          this.flash(x, y, COLORS.summon);
          break;
        }
        case 'manaGained': {
          // A blue number rises from every piece, rippling from the back rank forward,
          // while the owner's counter counts up to the new total.
          const mine = ev.color === this.bottomColor();
          const pieces = [...ev.pieces].sort((a, b) => {
            const ya = squareToXY(a.square, this.flipped).y;
            const yb = squareToXY(b.square, this.flipped).y;
            return mine ? yb - ya : ya - yb;
          });
          pieces.forEach((p, i) => {
            const { x, y } = squareToXY(p.square, this.flipped);
            this.floatText(x, y, `+${p.amount}`, COLORS.mana, i * 35, MOBILE ? 15 : 18, 900);
          });
          const counter = mine ? this.myMana : this.oppMana;
          counter.countTo(ev.mana, 250, 900);
          break;
        }
        default:
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Drawing

  private drawBoard(): void {
    this.boardLayer.removeChildren();
    const g = new Graphics();
    g.roundRect(BOARD_X - 10, BOARD_Y - 10, BOARD_SIZE + 20, BOARD_SIZE + 20, 12).fill(COLORS.edge);
    for (let sf = 0; sf < 8; sf++) {
      for (let sr = 0; sr < 8; sr++) {
        const light = (sf + sr) % 2 === 0;
        g.rect(BOARD_X + sf * SQ, BOARD_Y + sr * SQ, SQ, SQ).fill(light ? COLORS.light : COLORS.dark);
      }
    }
    this.boardLayer.addChild(g);
    for (let i = 0; i < 8; i++) {
      const file = this.flipped ? 7 - i : i;
      const rank = this.flipped ? i : 7 - i;
      const fl = new Text({ text: 'abcdefgh'[file]!, style: { fontFamily: UI_FONT, fontSize: 10, fill: 0xffffff, fontWeight: '600' } });
      fl.alpha = 0.55;
      fl.position.set(BOARD_X + i * SQ + SQ - 10, BOARD_Y + BOARD_SIZE - 13);
      const rk = new Text({ text: `${rank + 1}`, style: { fontFamily: UI_FONT, fontSize: 10, fill: 0xffffff, fontWeight: '600' } });
      rk.alpha = 0.55;
      rk.position.set(BOARD_X + 3, BOARD_Y + i * SQ + 2);
      this.boardLayer.addChild(fl, rk);
    }
  }

  private drawLastMove(events: GameEvent[]): void {
    this.lastMoveLayer.removeChildren();
    const g = new Graphics();
    for (const ev of events) {
      if (ev.type === 'moved' || ev.type === 'attacked') {
        for (const s of [ev.from, ev.to]) {
          const { x, y } = squareToXY(s, this.flipped);
          g.rect(x - SQ / 2, y - SQ / 2, SQ, SQ).fill({ color: COLORS.lastMove, alpha: 0.28 });
        }
      }
      if (ev.type === 'cardPlayed' && ev.target !== undefined) {
        const { x, y } = squareToXY(ev.target, this.flipped);
        g.rect(x - SQ / 2, y - SQ / 2, SQ, SQ).fill({ color: COLORS.card, alpha: 0.3 });
      }
      if (ev.type === 'abilityUsed') {
        for (const s of [ev.from, ev.to]) {
          const { x, y } = squareToXY(s, this.flipped);
          g.rect(x - SQ / 2, y - SQ / 2, SQ, SQ).fill({ color: COLORS.ability, alpha: 0.28 });
        }
      }
    }
    this.lastMoveLayer.addChild(g);
  }

  private drawHighlights(targets: Targets, origin?: Square): void {
    this.highlightLayer.removeChildren();
    const g = new Graphics();
    if (origin !== undefined) {
      const { x, y } = squareToXY(origin, this.flipped);
      g.rect(x - SQ / 2, y - SQ / 2, SQ, SQ).fill({ color: COLORS.select, alpha: 0.45 });
    }
    if (targets.anywhere) {
      g.rect(BOARD_X, BOARD_Y, BOARD_SIZE, BOARD_SIZE).fill({ color: COLORS.card, alpha: 0.18 });
      g.rect(BOARD_X, BOARD_Y, BOARD_SIZE, BOARD_SIZE).stroke({ width: 4, color: COLORS.card, alpha: 0.9 });
    }
    // Target squares: bright border + faded fill; the whole group pulses (see ticker).
    const pulse = new Graphics();
    for (const [square, action] of targets.bySquare) {
      const { x, y } = squareToXY(square, this.flipped);
      const color =
        action.type === 'playCard' ? COLORS.card
        : action.type === 'useAbility' ? COLORS.ability
        : this.view?.board[square] ? COLORS.attack
        : COLORS.move;
      const pad = action.type === 'useAbility' ? 1 : 3;
      pulse.roundRect(x - SQ / 2 + pad, y - SQ / 2 + pad, SQ - pad * 2, SQ - pad * 2, 6).fill({ color, alpha: action.type === 'useAbility' ? 0.4 : 0.28 });
      pulse.roundRect(x - SQ / 2 + pad, y - SQ / 2 + pad, SQ - pad * 2, SQ - pad * 2, 6).stroke({ width: action.type === 'useAbility' ? 4 : 3, color, alpha: 1 });
    }
    this.highlightLayer.addChild(g, pulse);
    this.pulsingHighlights = pulse;
  }

  /** Colour of the player sitting at the bottom of the screen. */
  private bottomColor(): Color {
    return this.hotseat ? 'white' : (this.view?.you ?? 'white');
  }

  private drawTrash(): void {
    this.trash.removeChildren();
    const r = TRASH.r;
    const g = new Graphics();
    g.roundRect(-r + 6, -r + 10, r * 2 - 12, r * 2 - 16, 10).fill({ color: 0x1c1c28, alpha: 0.95 }).stroke({ width: 2, color: 0x6a6a82 });
    g.roundRect(-r + 2, -r + 2, r * 2 - 4, 14, 4).fill(0x343446);
    g.roundRect(-10, -r - 4, 20, 8, 3).stroke({ width: 2, color: 0x8a8aa0 });
    g.moveTo(-r + 18, -r + 22).lineTo(-r + 22, r - 12).stroke({ width: 2, color: 0x5a5a70 });
    g.moveTo(0, -r + 22).lineTo(0, r - 12).stroke({ width: 2, color: 0x5a5a70 });
    g.moveTo(r - 18, -r + 22).lineTo(r - 22, r - 12).stroke({ width: 2, color: 0x5a5a70 });
    const label = new Text({
      text: 'TRASH',
      style: { fontFamily: UI_FONT, fontSize: 11, fontWeight: '800', fill: 0xb8b8cc, letterSpacing: 1 },
    });
    label.anchor.set(0.5);
    label.position.set(0, r + 12);
    this.trash.addChild(g, label);
    this.trash.position.set(TRASH.x, TRASH.y);
    this.trash.eventMode = 'none';
    this.trash.visible = false;
  }

  private setSandboxChrome(): void {
    const on = this.arena;
    this.myDeck.visible = !on;
    this.oppDeck.visible = !on;
    this.myDiscard.visible = !on;
    this.oppDiscard.visible = !on;
    this.myMana.visible = !on;
    this.oppMana.visible = !on;
    this.trash.visible = on;
    this.trash.position.set(TRASH.x, TRASH.y);
  }

  private renderDecks(): void {
    const view = this.view;
    if (!view) return;
    const bottom = this.bottomColor();
    this.myDiscard.update(view.players[bottom].graveyard);
    this.oppDiscard.update(view.players[opposite(bottom)].graveyard);
    // Income animates the count-up (see playEvents); anything else (a card's cost) snaps.
    this.myMana.caption = this.hotseat ? (MOBILE ? 'WHITE' : 'WHITE MANA') : 'MANA';
    this.oppMana.caption = this.hotseat ? (MOBILE ? 'BLACK' : 'BLACK MANA') : MOBILE ? 'THEIRS' : 'THEIR MANA';
    const gained = new Set(view.events.filter((e) => e.type === 'manaGained').map((e) => e.color));
    this.myMana.set(view.players[bottom].mana, view.players[bottom].manaIncome, gained.has(bottom));
    this.oppMana.set(view.players[opposite(bottom)].mana, view.players[opposite(bottom)].manaIncome, gained.has(opposite(bottom)));
    const canDraw = view.legalActions.some((a) => a.type === 'draw');
    for (const [deck, color] of [
      [this.myDeck, bottom],
      [this.oppDeck, opposite(bottom)],
    ] as const) {
      const side = view.players[color];
      const drawReady = side.pendingDraws > 0;
      deck.update({
        count: side.deckCount,
        // One segment per turn taken; closes on the drawEvery-th turn.
        progress: (side.turnsTaken % view.rules.drawEvery) / view.rules.drawEvery,
        drawReady,
        clickable: drawReady && view.turn === color && canDraw && view.status.kind === 'playing',
        label: this.hotseat ? (color === 'white' ? 'WHITE DECK' : 'BLACK DECK') : color === view.you ? 'YOUR DECK' : 'THEIR DECK',
      });
    }
    for (const ev of view.events) {
      // Timer completed: ring burst on that deck.
      if (ev.type === 'drawReady') {
        const at = ev.color === bottom ? MY_DECK : OPP_DECK;
        this.burst(at.x, at.y, COLORS.ringFill, 2);
      }
      // Opponent drew: fly face-down cards from their deck to their hand row.
      // (Our own draws are animated per card by renderHand -> arriveCard.)
      if (ev.type !== 'drew' || ev.color === bottom) continue;
      const to = { x: (OPP_HAND_X0 + OPP_HAND_X1) / 2, y: OPP_HAND_Y };
      for (let i = 0; i < ev.count; i++) this.flyCard(OPP_DECK, to, i * 120);
    }
  }

  /** Promise wrapper around a tween. */
  private tween(duration: number, update: (t: number) => void, ease = easeInOutQuad): Promise<void> {
    return new Promise((done) => this.tweens.run(duration, update, { ease, done }));
  }

  /**
   * Show the opponent playing a card: a face-down card rises from their hand
   * row to the middle of the board, flips face-up, holds so it can be read,
   * then glides onto their discard pile. Resolves when the card lands.
   */
  async revealCard(cardId: string, fromBottom: boolean, target?: Square): Promise<void> {
    if (!this.ready) return;
    const from = fromBottom ? { x: (HAND_X0 + HAND_X1) / 2, y: HAND_Y + CARD_H / 2 } : { x: (OPP_HAND_X0 + OPP_HAND_X1) / 2, y: OPP_HAND_Y };
    const centre = { x: BOARD_X + BOARD_SIZE / 2, y: BOARD_Y + BOARD_SIZE / 2 };
    // Spells go to the discard pile; a summon card sinks into the sacrificed piece's square.
    const isSummon = getCardDef(cardId).type === 'summon';
    const pile = isSummon && target !== undefined ? squareToXY(target, this.flipped) : fromBottom ? MY_DISCARD : OPP_DISCARD;
    const landScale = isSummon ? 0.1 : DISCARD_SCALE;
    const bigScale = MOBILE ? 1.35 : 1.6;

    const holder = new Container();
    holder.position.set(from.x, from.y);
    holder.zIndex = 200;
    const back = new Graphics()
      .roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 9)
      .fill(COLORS.deckBack)
      .stroke({ width: 2.5, color: COLORS.deckEdge });
    const face = new CardSprite({ instanceId: `reveal-${cardId}`, cardId }, true);
    face.alpha = 1;
    face.eventMode = 'none';
    face.visible = false;
    const glow = new Graphics().roundRect(-CARD_W / 2 - 10, -CARD_H / 2 - 10, CARD_W + 20, CARD_H + 20, 14).fill({ color: COLORS.select, alpha: 0.35 });
    glow.visible = false;
    holder.addChild(glow, back, face);
    holder.scale.set(fromBottom ? 1 : 0.5);
    this.dragLayer.addChild(holder);

    // 1. Rise to the centre, growing, spinning face-down -> face-up at the halfway point.
    const s0 = holder.scale.x;
    await this.tween(650, (t) => {
      if (holder.destroyed) return;
      holder.position.set(from.x + (centre.x - from.x) * t, from.y + (centre.y - from.y) * t);
      const s = s0 + (bigScale - s0) * t;
      const flip = Math.cos(t * Math.PI); // 1 -> -1
      holder.scale.set(s * Math.abs(flip), s);
      if (flip < 0 && !face.visible) {
        face.visible = true;
        back.visible = false;
        glow.visible = true;
      }
    });
    if (holder.destroyed) return;
    holder.scale.set(bigScale);
    // 2. Hold so it can be read; a gentle breathing glow.
    await this.tween(1000, (t) => {
      if (!glow.destroyed) glow.alpha = 0.7 + 0.3 * Math.sin(t * Math.PI * 2);
    });
    if (holder.destroyed) return;
    // 3. Glide onto the discard pile, shrinking to pile size.
    glow.visible = false;
    await this.tween(450, (t) => {
      if (holder.destroyed) return;
      holder.position.set(centre.x + (pile.x - centre.x) * t, centre.y + (pile.y - centre.y) * t);
      holder.scale.set(bigScale + (landScale - bigScale) * t);
      if (isSummon) holder.alpha = 1 - t * 0.6;
    });
    if (holder.destroyed) return;
    holder.destroy({ children: true });
    this.burst(pile.x, pile.y, isSummon ? COLORS.summon : COLORS.card, isSummon ? 1.2 : 0.6);
  }

  private flyCard(from: { x: number; y: number }, to: { x: number; y: number }, delay: number): void {
    const card = new Graphics().roundRect(-DECK_W / 2, -DECK_H / 2, DECK_W, DECK_H, 8).fill(COLORS.deckBack).stroke({ width: 2, color: COLORS.deckEdge });
    card.position.set(from.x, from.y);
    card.scale.set(DECK_SCALE);
    card.zIndex = 100;
    this.dragLayer.addChild(card);
    this.tweens.run(420, (t) => {
      card.position.set(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 60);
      card.rotation = t * Math.PI * 0.5;
      card.scale.set(DECK_SCALE * (1 + 0.25 * Math.sin(t * Math.PI)));
      card.alpha = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
    }, { ease: easeInOutQuad, delay, done: () => card.destroy() });
  }

  /**
   * The opponent's hand as a row of face-down card backs above the board. The
   * server never sends us what those cards are, only how many, so there is
   * nothing to inspect here and the sprites are not interactive.
   */
  private handColorOf(instanceId: string): Color {
    const view = this.view;
    if (view?.players.black.hand?.some((c) => c.instanceId === instanceId)) return 'black';
    return 'white';
  }

  private renderOpponentHand(): void {
    for (const old of this.oppHandLayer.removeChildren()) old.destroy();
    const view = this.view;
    if (!view) return;
    const oppColor = opposite(this.bottomColor());
    const revealed = this.arena ? view.players[oppColor].hand : null;
    if (revealed) {
      this.oppHandLayer.eventMode = 'passive';
      const n = revealed.length;
      const span = OPP_HAND_X1 - OPP_HAND_X0;
      const scale = MOBILE ? 0.42 : 0.55;
      const w = CARD_W * scale;
      const spacing = n <= 1 ? 0 : Math.min(w + 8, (span - w) / Math.max(1, n - 1));
      const startX = BOARD_X + BOARD_SIZE / 2 - ((n - 1) * spacing) / 2;
      revealed.forEach((inst, i) => {
        const sprite = new CardSprite(inst, true, true);
        sprite.scale.set(scale);
        const hx = n === 0 ? startX : startX + i * spacing;
        const hy = OPP_HAND_Y;
        sprite.position.set(hx, hy);
        sprite.on('pointerover', () => {
          if (this.drag) return;
          this.inspectCard(inst.cardId);
        });
        sprite.on('pointerdown', (e) => this.onCardPointerDown(e, sprite, hx, hy, this.oppHandLayer, scale));
        this.oppHandLayer.addChild(sprite);
      });
      return;
    }
    this.oppHandLayer.eventMode = 'none';
    const n = view.players[oppColor].handCount;
    const g = new Graphics();
    const span = OPP_HAND_X1 - OPP_HAND_X0;
    const labelRoom = MOBILE ? 70 : 120;
    const spacing = n <= 1 ? 0 : Math.min(OPP_CARD_W + 6, (span - labelRoom - OPP_CARD_W) / (n - 1));
    const startX = MOBILE ? OPP_HAND_X0 + OPP_CARD_W / 2 : BOARD_X + BOARD_SIZE / 2 - ((n - 1) * spacing) / 2;
    for (let i = 0; i < n; i++) {
      const x = startX + i * spacing;
      g.roundRect(x - OPP_CARD_W / 2, OPP_HAND_Y - OPP_CARD_H / 2, OPP_CARD_W, OPP_CARD_H, 4)
        .fill(COLORS.deckBack)
        .stroke({ width: 1.5, color: COLORS.deckEdge, alpha: 0.9 });
      g.roundRect(x - OPP_CARD_W / 2 + 4, OPP_HAND_Y - OPP_CARD_H / 2 + 4, OPP_CARD_W - 8, OPP_CARD_H - 8, 2)
        .stroke({ width: 1, color: COLORS.deckEdge, alpha: 0.5 });
    }
    this.oppHandLayer.addChild(g);
    const label = new Text({
      text: n === 0 ? 'No cards in hand' : MOBILE ? `${n} in hand` : `${n} card${n === 1 ? '' : 's'} in hand`,
      style: { fontFamily: UI_FONT, fontSize: 11, fontWeight: '700', fill: 0xbdb8d6, letterSpacing: 1 },
    });
    label.anchor.set(0, 0.5);
    label.position.set(n === 0 ? OPP_HAND_X0 + (MOBILE ? 0 : span / 2 - 50) : startX + (n - 1) * spacing + OPP_CARD_W / 2 + 10, OPP_HAND_Y);
    this.oppHandLayer.addChild(label);
    this.oppHandLayer.eventMode = 'none';
  }

  private renderHand(): void {
    for (const old of this.handLayer.removeChildren()) old.destroy();
    const view = this.view;
    if (!view) return;
    const handColor = this.arena ? this.bottomColor() : view.you;
    const hand = view.players[handColor].hand ?? [];
    const playable = this.arena
      ? new Set(hand.map((c) => c.instanceId))
      : new Set(view.legalActions.filter((a): a is CardAction => a.type === 'playCard').map((a) => a.cardInstanceId));
    const n = hand.length;
    if (n === 0) return;
    const span = HAND_X1 - HAND_X0;
    // Desktop: centred, allowed to overlap when crowded. Phone: fixed spacing, scrollable strip.
    const spacing = MOBILE ? CARD_W + 8 : n <= 1 ? 0 : Math.min(CARD_W + 6, (span - CARD_W) / (n - 1));
    const contentW = CARD_W + (n - 1) * spacing;
    const startX = MOBILE ? HAND_X0 + CARD_W / 2 : (HAND_X0 + HAND_X1) / 2 - ((n - 1) * spacing) / 2;
    this.handMaxScroll = Math.max(0, contentW - span);
    // Cards that were not in the hand last time we drew it are new (drawn this action).
    // Only when this action actually drew for us — in practice mode the whole hand
    // swaps sides every turn, which is not a draw.
    const drew = view.events.some((e) => e.type === 'drew' && e.color === view.you);
    const fresh = drew ? hand.filter((inst) => this.handIds.size > 0 && !this.handIds.has(inst.instanceId)) : [];
    this.handIds = new Set(hand.map((inst) => inst.instanceId));
    // New cards go on the right; on the phone strip make sure they are on screen.
    if (fresh.length && MOBILE) this.handScroll = this.handMaxScroll;
    this.handScroll = Math.min(this.handScroll, this.handMaxScroll);
    this.handLayer.x = -this.handScroll;
    const mana = view.players[view.you].mana;
    hand.forEach((inst, i) => {
      const sprite = new CardSprite(inst, playable.has(inst.instanceId), getCardDef(inst.cardId).cost <= mana);
      const hx = startX + i * spacing;
      const hy = HAND_Y + CARD_H / 2;
      sprite.position.set(hx, hy);
      if (fresh.includes(inst)) this.arriveCard(sprite, hx - this.handScroll, hy, fresh.indexOf(inst));
      sprite.on('pointerover', () => {
        if (this.drag) return;
        this.inspectCard(inst.cardId);
        sprite.zIndex = 20;
        this.tweens.run(120, (t) => {
          if (sprite.destroyed || this.drag?.sprite === sprite) return;
          sprite.y = hy - 14 * t;
          sprite.scale.set(1 + 0.06 * t);
        });
      });
      sprite.on('pointerout', () => {
        if (this.drag) return;
        sprite.zIndex = 0;
        this.tweens.run(120, (t) => {
          if (sprite.destroyed || this.drag?.sprite === sprite) return;
          sprite.y = hy - 14 * (1 - t);
          sprite.scale.set(1 + 0.06 * (1 - t));
        });
      });
      sprite.on('pointerdown', (e) => this.onCardPointerDown(e, sprite, hx, hy, this.handLayer, 1));
      this.handLayer.addChild(sprite);
    });
    this.handLayer.sortableChildren = true;
    this.renderHandOverflow();
  }

  /**
   * A freshly drawn card: it flies in from the deck to its slot and glows for a
   * moment so it is obvious which cards are new (even in a crowded hand).
   */
  private arriveCard(sprite: CardSprite, x: number, y: number, index: number): void {
    const from = MY_DECK;
    sprite.alpha = 0;
    const ghost = new Graphics().roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 9).fill(COLORS.deckBack).stroke({ width: 2.5, color: COLORS.deckEdge });
    ghost.position.set(from.x, from.y);
    ghost.scale.set(DECK_SCALE);
    this.dragLayer.addChild(ghost);
    this.tweens.run(420, (t) => {
      if (ghost.destroyed) return;
      ghost.position.set(from.x + (x - from.x) * t, from.y + (y - from.y) * t - Math.sin(t * Math.PI) * 40);
      ghost.scale.set(DECK_SCALE + (1 - DECK_SCALE) * t);
    }, {
      delay: index * 140,
      ease: easeInOutQuad,
      done: () => {
        if (!ghost.destroyed) ghost.destroy();
        if (sprite.destroyed) return;
        sprite.alpha = sprite.playable ? 1 : 0.6;
        const glow = new Graphics().roundRect(-CARD_W / 2 - 6, -CARD_H / 2 - 6, CARD_W + 12, CARD_H + 12, 12).stroke({ width: 4, color: COLORS.select });
        sprite.addChildAt(glow, 0);
        this.tweens.run(1400, (t) => {
          if (glow.destroyed) return;
          glow.alpha = (1 - t) * (0.6 + 0.4 * Math.sin(t * Math.PI * 4));
        }, { done: () => !glow.destroyed && glow.destroy() });
      },
    });
  }

  /** Phone strip: "‹ 2" / "3 ›" badges when cards are scrolled out of view. */
  private renderHandOverflow(): void {
    this.handOverflow.removeChildren();
    if (!MOBILE || !this.view) return;
    const hand = this.view.players[this.view.you].hand ?? [];
    const spacing = CARD_W + 8;
    let left = 0;
    let right = 0;
    hand.forEach((_, i) => {
      const cx = HAND_X0 + CARD_W / 2 + i * spacing - this.handScroll;
      if (cx + CARD_W / 2 < HAND_X0 + 12) left++;
      else if (cx - CARD_W / 2 > HAND_X1 - 12) right++;
    });
    const badge = (text: string, x: number, anchorX: number) => {
      const t = new Text({ text, style: { fontFamily: UI_FONT, fontSize: 13, fontWeight: '900', fill: 0xffffff, stroke: { color: 0x000000, width: 4 } } });
      t.anchor.set(anchorX, 0.5);
      t.position.set(x, HAND_Y + CARD_H / 2);
      const bg = new Graphics().roundRect(t.x - (anchorX ? t.width + 8 : 4), t.y - 12, t.width + 12, 24, 12).fill({ color: 0x000000, alpha: 0.55 });
      this.handOverflow.addChild(bg, t);
    };
    if (left) badge(`‹ ${left}`, HAND_X0 + 4, 0);
    if (right) badge(`${right} ›`, HAND_X1 - 4, 1);
  }

  private renderBanner(): void {
    this.banner.removeChildren();
    const view = this.view;
    if (!view || view.status.kind === 'playing') return;
    const text = this.hotseat ? describeStatusNeutral(view.status) : describeStatus(view.status, view.you);
    const bg = new Graphics().roundRect(BOARD_X + 40, BOARD_Y + BOARD_SIZE / 2 - 44, BOARD_SIZE - 80, 88, 14).fill({ color: 0x000000, alpha: 0.82 }).stroke({ width: 3, color: COLORS.select });
    const t = new Text({ text, style: { fontFamily: UI_FONT, fontSize: 30, fontWeight: '800', fill: 0xffffff, align: 'center' } });
    t.anchor.set(0.5);
    t.position.set(BOARD_X + BOARD_SIZE / 2, BOARD_Y + BOARD_SIZE / 2);
    this.banner.addChild(bg, t);
    this.banner.alpha = 0;
    this.tweens.run(500, (a) => (this.banner.alpha = a), { delay: 400 });
  }

  // -------------------------------------------------------------------------
  // Effects

  private flash(x: number, y: number, color: number, duration = 260): void {
    const g = new Graphics().rect(x - SQ / 2, y - SQ / 2, SQ, SQ).fill(color);
    this.fxLayer.addChild(g);
    this.tweens.run(duration, (t) => (g.alpha = 0.7 * (1 - t)), { done: () => g.destroy() });
  }

  private burst(x: number, y: number, color: number, size = 1): void {
    const ring = new Graphics().circle(0, 0, 20).stroke({ width: 5, color });
    ring.position.set(x, y);
    this.fxLayer.addChild(ring);
    this.tweens.run(420, (t) => {
      ring.scale.set(0.4 + 1.6 * size * t);
      ring.alpha = 1 - t;
    }, { done: () => ring.destroy() });
    for (let i = 0; i < 8; i++) {
      const p = new Graphics().circle(0, 0, 3.5).fill(color);
      const a = (i / 8) * Math.PI * 2 + Math.random() * 0.4;
      const d = (26 + Math.random() * 18) * size;
      p.position.set(x, y);
      this.fxLayer.addChild(p);
      this.tweens.run(380 + Math.random() * 120, (t) => {
        p.position.set(x + Math.cos(a) * d * t, y + Math.sin(a) * d * t);
        p.alpha = 1 - t;
      }, { done: () => p.destroy() });
    }
  }

  private floatText(x: number, y: number, text: string, color: number, delay = 0, fontSize = 22, duration = 700): void {
    const t = new Text({ text, style: { fontFamily: UI_FONT, fontSize, fontWeight: '900', fill: color, stroke: { color: 0x000000, width: 4 } } });
    t.anchor.set(0.5);
    t.position.set(x, y - 10);
    t.alpha = 0;
    this.fxLayer.addChild(t);
    this.tweens.run(duration, (k) => {
      t.y = y - 10 - 34 * k;
      t.alpha = Math.min(1, k * 6) * (1 - k * k);
    }, { delay, done: () => t.destroy() });
  }

  // -------------------------------------------------------------------------
  // Input

  private get myTurn(): boolean {
    return !!this.view && this.view.status.kind === 'playing' && this.view.turn === this.view.you;
  }

  private clientToLocal(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = this.app.canvas;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((clientX - rect.left) * CANVAS_W) / rect.width,
      y: ((clientY - rect.top) * CANVAS_H) / rect.height,
    };
  }

  /** Where a palette drag would land, in board/hand space. */
  dropTarget(clientX: number, clientY: number): ArenaDrop {
    const p = this.clientToLocal(clientX, clientY);
    if (!p) return { zone: 'none' };
    return this.dropTargetLocal(p.x, p.y);
  }

  private dropTargetLocal(x: number, y: number): ArenaDrop {
    if (this.arena && isOverTrash(x, y)) return { zone: 'trash' };
    const square = xyToSquare(x, y, this.flipped);
    if (square !== null) return { zone: 'square', square };
    if (y >= HAND_Y - 16 && y <= HAND_Y + CARD_H + 16 && x >= HAND_X0 - 24 && x <= HAND_X1 + 24) {
      return { zone: 'hand', color: this.hotseat ? 'white' : (this.view?.you ?? 'white') };
    }
    if (y >= OPP_HAND_Y - OPP_CARD_H && y <= OPP_HAND_Y + OPP_CARD_H && x >= OPP_HAND_X0 - 24 && x <= OPP_HAND_X1 + 24) {
      return { zone: 'hand', color: this.hotseat ? 'black' : opposite(this.view?.you ?? 'white') };
    }
    return { zone: 'none' };
  }

  /** Highlight a palette drop target (or clear when `none`). */
  previewDrop(target: ArenaDrop): void {
    if (this.view?.pendingGrant) {
      if (target.zone === 'none') this.showPendingGrant();
      return;
    }
    this.highlightLayer.removeChildren();
    this.pulsingHighlights = null;
    if (target.zone === 'none') return;
    const g = new Graphics();
    if (target.zone === 'trash') {
      g.circle(TRASH.x, TRASH.y, TRASH.r + 4).fill({ color: 0xe0503c, alpha: 0.28 });
      g.circle(TRASH.x, TRASH.y, TRASH.r + 4).stroke({ width: 3, color: 0xe0503c, alpha: 0.95 });
      this.highlightLayer.addChild(g);
      return;
    }
    if (target.zone === 'square') {
      const { x, y } = squareToXY(target.square, this.flipped);
      g.roundRect(x - SQ / 2 + 3, y - SQ / 2 + 3, SQ - 6, SQ - 6, 6).fill({ color: COLORS.ability, alpha: 0.32 });
      g.roundRect(x - SQ / 2 + 3, y - SQ / 2 + 3, SQ - 6, SQ - 6, 6).stroke({ width: 3, color: COLORS.ability, alpha: 1 });
    } else {
      const mine = this.hotseat ? target.color === 'white' : target.color === this.view?.you;
      if (mine) {
        g.roundRect(HAND_X0, HAND_Y, HAND_X1 - HAND_X0, CARD_H, 10).fill({ color: COLORS.ability, alpha: 0.22 });
        g.roundRect(HAND_X0, HAND_Y, HAND_X1 - HAND_X0, CARD_H, 10).stroke({ width: 3, color: COLORS.ability, alpha: 0.9 });
      } else {
        const w = OPP_HAND_X1 - OPP_HAND_X0;
        g.roundRect(OPP_HAND_X0, OPP_HAND_Y - OPP_CARD_H / 2, w, OPP_CARD_H, 8).fill({ color: COLORS.ability, alpha: 0.22 });
        g.roundRect(OPP_HAND_X0, OPP_HAND_Y - OPP_CARD_H / 2, w, OPP_CARD_H, 8).stroke({ width: 3, color: COLORS.ability, alpha: 0.9 });
      }
    }
    this.highlightLayer.addChild(g);
  }

  private moveTargetsFrom(square: Square): Targets {
    const bySquare = new Map<Square, Action>();
    if (!this.view) return { bySquare, anywhere: null };
    if (this.arena) {
      const piece = Object.values(this.view.pieces).find((p) => p.square === square);
      if (!piece) return { bySquare, anywhere: null };
      for (const cand of previewMoves(this.view, piece)) {
        const existing = bySquare.get(cand.to) as MoveAction | undefined;
        if (!existing || cand.promotion) {
          bySquare.set(cand.to, { type: 'move', from: cand.from, to: cand.to, promotion: cand.promotion ? 'queen' : undefined });
        }
      }
      for (const a of previewAbilities(this.view, piece)) bySquare.set(a.to, a);
      return { bySquare, anywhere: null };
    }
    for (const a of this.view.legalActions) {
      if (a.type === 'move' && a.from === square) {
        const existing = bySquare.get(a.to) as MoveAction | undefined;
        // Several promotion options share a square; default to queen.
        if (!existing || a.promotion === 'queen') bySquare.set(a.to, a);
      } else if (a.type === 'useAbility' && a.from === square && !bySquare.has(a.to)) {
        bySquare.set(a.to, a);
      }
    }
    return { bySquare, anywhere: null };
  }

  private cardTargets(instanceId: string): Targets {
    const bySquare = new Map<Square, Action>();
    let anywhere: Action | null = null;
    if (!this.view) return { bySquare, anywhere };
    for (const a of this.view.legalActions) {
      if (a.type !== 'playCard' || a.cardInstanceId !== instanceId) continue;
      if (a.target === undefined) anywhere = a;
      else bySquare.set(a.target, a);
    }
    return { bySquare, anywhere };
  }

  private onPiecePointerDown(e: FederatedPointerEvent, sprite: PieceSprite): void {
    if (!this.view || this.drag) return;
    const piece = this.view.pieces[sprite.pieceId];
    if (!piece) return;

    // Clicking a highlighted target square (with a piece on it) while something is selected.
    if (this.selection && this.tryActOnSquare(piece.square)) return;

    e.stopPropagation();
    this.setInspected(piece.id);

    if (this.view.pendingGrant) {
      this.showPendingGrant();
      this.onPieceTap(piece);
      return;
    }

    if (!this.arena && (!this.myTurn || piece.owner !== this.view.you)) {
      this.clearSelection();
      this.onPieceTap(piece); // cannot be dragged, so this is a tap
      return;
    }
    const targets = this.moveTargetsFrom(piece.square);
    if (!this.arena && targets.bySquare.size === 0) {
      this.clearSelection();
      this.onPieceTap(piece);
      return;
    }

    this.drag = { kind: 'piece', sprite, from: piece.square, targets, startX: e.global.x, startY: e.global.y, moved: false };
    sprite.zIndex = 50;
    sprite.cursor = 'grabbing';
    this.pieceLayer.removeChild(sprite);
    this.dragLayer.addChild(sprite);
    this.drawHighlights(targets, piece.square);
  }

  /**
   * A pointer went down on a hand card. We don't know yet whether this is a
   * tap (read the card), a horizontal swipe (scroll the hand) or a drag (play
   * it), so remember it and decide in onPointerMove / onPointerUp.
   */
  private onCardPointerDown(e: FederatedPointerEvent, sprite: CardSprite, homeX: number, homeY: number, homeLayer: Container, homeScale = 1): void {
    if (!this.view || this.drag) return;
    e.stopPropagation();
    this.inspectCard(sprite.cardId);
    this.pendingCard = { sprite, homeX, homeY, homeLayer, homeScale, startX: e.global.x, startY: e.global.y, scrollStart: this.handScroll };
  }

  /** Lift a card out of the hand and start dragging it toward the board. */
  private beginCardDrag(p: NonNullable<typeof this.pendingCard>, e: FederatedPointerEvent): boolean {
    const { sprite, homeX, homeY, homeLayer, homeScale } = p;
    if (this.view?.pendingGrant) return false;
    if (this.arena) {
      this.selection = null;
      this.drag = { kind: 'card', sprite, homeX, homeY, homeLayer, homeScale, targets: { bySquare: new Map(), anywhere: null }, startX: p.startX, startY: p.startY, moved: true };
      sprite.zIndex = 50;
      sprite.scale.set(1.08);
      homeLayer.removeChild(sprite);
      this.dragLayer.addChild(sprite);
      sprite.position.set(e.global.x, e.global.y);
      const g = new Graphics().rect(BOARD_X, BOARD_Y, BOARD_SIZE, BOARD_SIZE).stroke({ width: 3, color: COLORS.card, alpha: 0.7 });
      this.highlightLayer.addChild(g);
      return true;
    }
    if (!sprite.playable || !this.myTurn) return false;
    const targets = this.cardTargets(sprite.instanceId);
    if (targets.bySquare.size === 0 && !targets.anywhere) return false;
    this.selection = null;
    this.drag = { kind: 'card', sprite, homeX, homeY, homeLayer, homeScale, targets, startX: p.startX, startY: p.startY, moved: true };
    sprite.zIndex = 50;
    sprite.scale.set(1.08);
    homeLayer.removeChild(sprite);
    this.dragLayer.addChild(sprite);
    sprite.position.set(e.global.x, e.global.y);
    this.drawHighlights(targets);
    return true;
  }

  private setHandScroll(x: number): void {
    this.handScroll = Math.max(0, Math.min(this.handMaxScroll, x));
    this.handLayer.x = -this.handScroll;
    this.renderHandOverflow();
  }

  private onStagePointerDown(e: FederatedPointerEvent): void {
    if (this.drag) return;
    const square = xyToSquare(e.global.x, e.global.y, this.flipped);
    if (this.view?.pendingGrant) {
      if (square !== null) this.tryActOnSquare(square);
      return;
    }
    if (square === null) {
      this.clearSelection();
      return;
    }
    if (this.tryActOnSquare(square)) return;
    this.clearSelection();
    if (!this.view?.board[square]) this.setInspected(null, true);
  }

  private onPointerMove(e: FederatedPointerEvent): void {
    const p = this.pendingCard;
    if (p && !this.drag) {
      const dx = e.global.x - p.startX;
      const dy = e.global.y - p.startY;
      if (this.handScrolling) {
        this.setHandScroll(p.scrollStart - dx);
        return;
      }
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // still a tap
      // Mostly sideways on a scrollable hand = swipe; otherwise lift the card.
      if (p.homeLayer === this.handLayer && this.handMaxScroll > 0 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        this.handScrolling = true;
        this.setHandScroll(p.scrollStart - dx);
        return;
      }
      if (!this.beginCardDrag(p, e)) {
        // Not playable right now: treat the gesture as a swipe on phones, else ignore.
        if (this.handMaxScroll > 0) this.handScrolling = true;
        else this.pendingCard = null;
      }
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (Math.hypot(e.global.x - d.startX, e.global.y - d.startY) > 4) d.moved = true;
    d.sprite.position.set(e.global.x, e.global.y);
    if (this.arena && d.kind !== 'piece') this.previewDrop(this.dropTargetLocal(e.global.x, e.global.y));
  }

  private onPointerUp(e: FederatedPointerEvent): void {
    const p = this.pendingCard;
    this.pendingCard = null;
    if (p && !this.drag) {
      const wasScroll = this.handScrolling;
      this.handScrolling = false;
      if (!wasScroll) this.onCardTap(p.sprite.cardId);
      return;
    }
    this.handScrolling = false;
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const square = xyToSquare(e.global.x, e.global.y, this.flipped);

    if (d.kind === 'piece') {
      const action = square !== null && square !== d.from ? d.targets.bySquare.get(square) : undefined;
      this.dragLayer.removeChild(d.sprite);
      this.pieceLayer.addChild(d.sprite);
      d.sprite.zIndex = this.stackZ(d.from);
      d.sprite.cursor = 'grab';
      const home = squareToXY(d.from, this.flipped);
      if (action) {
        this.highlightLayer.removeChildren();
        if (this.arena) {
          if (action.type === 'useAbility') {
            d.sprite.position.set(home.x, home.y);
            this.onArena({ type: 'useAbility', from: d.from, to: square!, index: action.index });
          } else {
            const dest = squareToXY(square!, this.flipped);
            d.sprite.position.set(dest.x, dest.y);
            this.onArena({ type: 'relocate', from: d.from, to: square! });
          }
          return;
        }
        if (action.type === 'useAbility') {
          // The piece stays put; the ability lands on the neighbour.
          d.sprite.position.set(home.x, home.y);
        } else {
          // Snap to destination immediately; the server's state will confirm.
          const dest = squareToXY(square!, this.flipped);
          d.sprite.position.set(dest.x, dest.y);
        }
        this.onAction(action);
      } else if (this.arena && this.dropTargetLocal(e.global.x, e.global.y).zone === 'trash') {
        this.highlightLayer.removeChildren();
        this.onArena({ type: 'removePiece', square: d.from });
      } else if (this.arena && square !== null && square !== d.from) {
        const dest = squareToXY(square, this.flipped);
        d.sprite.position.set(dest.x, dest.y);
        this.highlightLayer.removeChildren();
        this.onArena({ type: 'relocate', from: d.from, to: square });
      } else {
        d.sprite.position.set(home.x, home.y);
        if (!d.moved) {
          // A simple click: keep the piece selected so move dots stay visible. Arena
          // relocates only on a drag; a second click never walks the piece.
          this.selection = { square: d.from, targets: d.targets };
          this.drawHighlights(d.targets, d.from);
          const piece = this.view?.pieces[d.sprite.pieceId];
          if (piece) this.onPieceTap(piece);
        } else {
          this.highlightLayer.removeChildren();
        }
      }
      return;
    }

    // Card
    this.highlightLayer.removeChildren();
    if (this.arena && square !== null) {
      this.dragLayer.removeChild(d.sprite);
      d.sprite.destroy();
      const { x, y } = squareToXY(square, this.flipped);
      this.burst(x, y, COLORS.card, 0.8);
      this.onArena({
        type: 'dropCard',
        cardId: d.sprite.cardId,
        color: this.handColorOf(d.sprite.instanceId),
        square,
        fromHand: d.sprite.instanceId,
      });
      return;
    }
    let action: Action | undefined;
    if (square !== null) action = d.targets.bySquare.get(square);
    if (!action && d.targets.anywhere && isOverBoard(e.global.x, e.global.y)) action = d.targets.anywhere;
    if (action) {
      this.dragLayer.removeChild(d.sprite);
      d.sprite.destroy();
      if (square !== null) {
        const { x, y } = squareToXY(square, this.flipped);
        this.burst(x, y, COLORS.card, 0.8);
      }
      this.onAction(action);
    } else {
      this.dragLayer.removeChild(d.sprite);
      d.homeLayer.addChild(d.sprite);
      d.sprite.zIndex = 0;
      // The hand layer may be scrolled: convert the drop point into its local space.
      const scrolled = d.homeLayer === this.handLayer ? this.handScroll : 0;
      const sx = d.sprite.x + scrolled;
      const sy = d.sprite.y;
      d.sprite.x = sx;
      this.tweens.run(180, (t) => {
        d.sprite.position.set(sx + (d.homeX - sx) * t, sy + (d.homeY - sy) * t);
        d.sprite.scale.set(1.08 + (d.homeScale - 1.08) * t);
      });
    }
  }

  private tryActOnSquare(square: Square): boolean {
    const sel = this.selection;
    if (!sel) return false;
    if (this.arena) {
      if (square === sel.square) return false;
      const marked = sel.targets.bySquare.get(square);
      // Click-to-activate (grant / ability) is fine; click-to-walk is not.
      if (marked?.type !== 'useAbility') return false;
      this.selection = null;
      this.highlightLayer.removeChildren();
      this.onArena({ type: 'useAbility', from: sel.square, to: square, index: marked.index });
      return true;
    }
    const action = sel.targets.bySquare.get(square);
    if (!action) return false;
    this.selection = null;
    this.highlightLayer.removeChildren();
    this.onAction(action);
    return true;
  }

  private clearSelection(): void {
    this.selection = null;
    this.highlightLayer.removeChildren();
  }

  /** Near-side ranks draw on top so a tall summon isn't hidden by the piece in front. */
  private stackZ(square: Square): number {
    return this.flipped ? rankOf(square) : 7 - rankOf(square);
  }

  private cancelDrag(): void {
    this.pendingCard = null;
    this.handScrolling = false;
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.dragLayer.removeChild(d.sprite);
    if (d.kind === 'piece') {
      this.pieceLayer.addChild(d.sprite);
      const home = squareToXY(d.from, this.flipped);
      d.sprite.position.set(home.x, home.y);
      d.sprite.zIndex = this.stackZ(d.from);
    } else {
      d.sprite.destroy();
    }
  }
}

export function describeStatusNeutral(status: PlayerView['status']): string {
  const w = 'winner' in status ? (status.winner === 'white' ? 'White' : 'Black') : '';
  switch (status.kind) {
    case 'playing':
      return '';
    case 'stalemate':
      return 'Stalemate';
    case 'checkmate':
      return `Checkmate — ${w} wins!`;
    case 'kingCaptured':
      return `King captured — ${w} wins!`;
    case 'resigned':
      return `${w} wins by resignation`;
    case 'timeout':
      return `${w} wins on time`;
  }
}

export function describeStatus(status: PlayerView['status'], you: Color): string {
  switch (status.kind) {
    case 'playing':
      return '';
    case 'stalemate':
      return 'Stalemate';
    case 'checkmate':
      return status.winner === you ? 'Checkmate — you win!' : 'Checkmate — you lose';
    case 'kingCaptured':
      return status.winner === you ? 'King captured — you win!' : 'Your King was captured';
    case 'resigned':
      return status.winner === you ? 'Opponent resigned — you win!' : 'You resigned';
    case 'timeout':
      return status.winner === you ? 'Opponent ran out of time — you win!' : 'You ran out of time';
  }
}
