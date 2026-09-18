import { canAct, opposite, type Action, type Color, type GameEvent, type Piece, type PlayerView, type Square } from '@chessx/engine';
import { Application, Container, Graphics, Text, type FederatedPointerEvent } from 'pixi.js';
import { preloadArt } from './art.js';
import { CardSprite } from './CardSprite.js';
import { DeckSprite } from './DeckSprite.js';
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
  DECK_W,
  HAND_Y,
  MY_DECK,
  OPP_CARD_H,
  OPP_CARD_W,
  OPP_DECK,
  OPP_HAND_Y,
  SQ,
  UI_FONT,
  isOverBoard,
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
  | { kind: 'card'; sprite: CardSprite; homeX: number; homeY: number; targets: Targets; startX: number; startY: number; moved: boolean };

interface Selection {
  square: Square;
  targets: Targets;
}

/** What the side panel should show: a piece on the board or a card in hand. */
export type InspectTarget = { kind: 'piece'; piece: Piece } | { kind: 'card'; cardId: string };

/**
 * Renders the board + hand with PixiJS and turns pointer input into engine
 * Actions. It never decides legality itself: everything it offers the player
 * comes from `view.legalActions` sent by the server.
 */
export class GameView {
  readonly app = new Application();
  onAction: (a: Action) => void = () => {};
  /** Fired whenever the inspected piece/card changes or its data refreshes (null = nothing inspected). */
  onInspect: (target: InspectTarget | null) => void = () => {};
  /** Practice mode: one player controls both sides, board stays white-at-bottom. */
  hotseat = false;

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

  private sprites = new Map<string, PieceSprite>();
  private voids = new Map<string, Graphics>();
  private view: PlayerView | null = null;
  private flipped = false;
  private drag: Drag | null = null;
  private selection: Selection | null = null;
  private inspected: string | null = null;
  private inspectedCard: string | null = null;
  private pulse = 0;
  /** The current set of target-square highlights, faded in and out by the ticker. */
  private pulsingHighlights: Graphics | null = null;

  async init(mount: HTMLElement): Promise<void> {
    await this.app.init({
      width: CANVAS_W,
      height: CANVAS_H,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    mount.appendChild(this.app.canvas);
    this.tweens = new Tweens(this.app.ticker);
    await preloadArt();

    this.app.stage.addChild(
      this.boardLayer,
      this.lastMoveLayer,
      this.inspectLayer,
      this.voidLayer,
      this.highlightLayer,
      this.pieceLayer,
      this.fxLayer,
      this.deckLayer,
      this.oppHandLayer,
      this.handLayer,
      this.dragLayer,
      this.banner,
    );
    this.drawBoard();

    this.myDeck.position.set(MY_DECK.x, MY_DECK.y);
    this.oppDeck.position.set(OPP_DECK.x, OPP_DECK.y);
    this.myDeck.onDraw = () => this.onAction({ type: 'draw' });
    this.oppDeck.onDraw = () => this.onAction({ type: 'draw' });
    this.deckLayer.addChild(this.oppDeck, this.myDeck);

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
      const hl = this.pulsingHighlights;
      if (hl && !hl.destroyed) hl.alpha = 0.7 + 0.3 * Math.sin((this.pulse * 2 * Math.PI) / 2);
    });
  }

  /** Forget the current game (called when leaving a room). */
  reset(): void {
    this.cancelDrag();
    this.selection = null;
    for (const s of this.sprites.values()) s.destroy();
    for (const v of this.voids.values()) v.destroy();
    this.sprites.clear();
    this.voids.clear();
    for (const layer of [this.highlightLayer, this.lastMoveLayer, this.inspectLayer, this.fxLayer, this.banner]) layer.removeChildren();
    for (const old of this.handLayer.removeChildren()) old.destroy();
    this.view = null;
    this.inspectedCard = null;
    this.setInspected(null);
  }

  // -------------------------------------------------------------------------
  // Inspection (zoomed card in the side panel)

  private setInspected(pieceId: string | null): void {
    this.inspected = pieceId;
    this.inspectLayer.removeChildren();
    const piece = pieceId && this.view ? this.view.pieces[pieceId] : undefined;
    if (piece) {
      this.inspectedCard = null;
      const { x, y } = squareToXY(piece.square, this.flipped);
      const g = new Graphics().roundRect(x - SQ / 2 + 2, y - SQ / 2 + 2, SQ - 4, SQ - 4, 6).stroke({ width: 3, color: COLORS.select, alpha: 0.9 });
      this.inspectLayer.addChild(g);
      this.onInspect({ kind: 'piece', piece });
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
    this.inspectLayer.removeChildren();
    this.onInspect({ kind: 'card', cardId });
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
    const first = this.view === null;
    this.view = view;
    const flipped = !this.hotseat && view.you === 'black';
    if (first || flipped !== this.flipped) {
      this.flipped = flipped;
      this.drawBoard();
    }

    this.cancelDrag();
    this.selection = null;
    this.highlightLayer.removeChildren();

    // Pieces: tween existing, pop new, fade removed.
    const seen = new Set<string>();
    for (const piece of Object.values(view.pieces)) {
      seen.add(piece.id);
      const { x, y } = squareToXY(piece.square, this.flipped);
      let sprite = this.sprites.get(piece.id);
      if (!sprite) {
        sprite = new PieceSprite(piece);
        sprite.update(piece, this.isLocked(piece));
        sprite.position.set(x, y);
        sprite.on('pointerdown', (e) => this.onPiecePointerDown(e, sprite!));
        this.pieceLayer.addChild(sprite);
        this.sprites.set(piece.id, sprite);
        if (!first) {
          sprite.scale.set(0);
          const s = sprite;
          this.tweens.run(320, (t) => !s.destroyed && s.scale.set(t), { ease: easeOutBack });
        }
      } else {
        sprite.update(piece, this.isLocked(piece));
        if (sprite.x !== x || sprite.y !== y) {
          const s = sprite;
          const sx = s.x;
          const sy = s.y;
          s.zIndex = 10;
          this.tweens.run(
            first ? 0 : 220,
            (t) => !s.destroyed && s.position.set(sx + (x - sx) * t, sy + (y - sy) * t),
            { ease: easeInOutQuad, done: () => !s.destroyed && (s.zIndex = 0) },
          );
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
        sprite.alpha = 1 - t;
        sprite.scale.set(1 - 0.4 * t);
      }, { done: () => sprite.destroy() });
    }
    this.pieceLayer.sortableChildren = true;

    this.playEvents(view.events);
    this.drawLastMove(view.events);
    this.renderDecks();
    this.renderHand();
    this.renderOpponentHand();
    this.renderBanner();
    // Refresh the inspected piece (it may have moved, changed stats, or died).
    this.setInspected(this.inspected && view.pieces[this.inspected] ? this.inspected : null);
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
      this.tweens.run(300, (t) => existing.scale.set(1 - t), { done: () => existing.destroy() });
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
            }, { ease: easeInOutQuad, done: () => !attacker.destroyed && (attacker.zIndex = 0) });
          }
          break;
        }
        case 'damaged': {
          const { x, y } = squareToXY(ev.square, this.flipped);
          const hpHit = ev.amount - ev.shield;
          if (ev.shield > 0) {
            this.flash(x, y, COLORS.def, 200);
            this.floatText(x - 14, y, `-${ev.shield}`, COLORS.def, 220);
          }
          if (hpHit > 0 || ev.shield === 0) {
            this.flash(x, y, COLORS.attack, 180);
            this.floatText(x + (ev.shield > 0 ? 14 : 0), y, `-${hpHit}`, COLORS.attack, 220);
          }
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
        case 'statsChanged': {
          const { x, y } = squareToXY(ev.square, this.flipped);
          this.flash(x, y, COLORS.select);
          break;
        }
        case 'summonStarted': {
          const { x, y } = squareToXY(ev.square, this.flipped);
          this.flash(x, y, COLORS.summon);
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
      const color = action.type === 'playCard' ? COLORS.card : this.view?.board[square] ? COLORS.attack : COLORS.move;
      pulse.roundRect(x - SQ / 2 + 3, y - SQ / 2 + 3, SQ - 6, SQ - 6, 6).fill({ color, alpha: 0.28 });
      pulse.roundRect(x - SQ / 2 + 3, y - SQ / 2 + 3, SQ - 6, SQ - 6, 6).stroke({ width: 3, color, alpha: 1 });
    }
    this.highlightLayer.addChild(g, pulse);
    this.pulsingHighlights = pulse;
  }

  /** Colour of the player sitting at the bottom of the screen. */
  private bottomColor(): Color {
    return this.hotseat ? 'white' : (this.view?.you ?? 'white');
  }

  private renderDecks(): void {
    const view = this.view;
    if (!view) return;
    const bottom = this.bottomColor();
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
      // Card drawn: fly a card back from the deck toward the hand.
      if (ev.type !== 'drew') continue;
      const fromBottom = ev.color === bottom;
      const from = fromBottom ? MY_DECK : OPP_DECK;
      const to = fromBottom ? { x: CANVAS_W / 2, y: HAND_Y + CARD_H / 2 } : { x: BOARD_X + BOARD_SIZE / 2, y: OPP_HAND_Y };
      for (let i = 0; i < ev.count; i++) this.flyCard(from, to, i * 120);
    }
  }

  private flyCard(from: { x: number; y: number }, to: { x: number; y: number }, delay: number): void {
    const card = new Graphics().roundRect(-DECK_W / 2, -DECK_H / 2, DECK_W, DECK_H, 8).fill(COLORS.deckBack).stroke({ width: 2, color: COLORS.deckEdge });
    card.position.set(from.x, from.y);
    card.zIndex = 100;
    this.dragLayer.addChild(card);
    this.tweens.run(420, (t) => {
      card.position.set(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 60);
      card.rotation = t * Math.PI * 0.5;
      card.scale.set(1 + 0.25 * Math.sin(t * Math.PI));
      card.alpha = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
    }, { ease: easeInOutQuad, delay, done: () => card.destroy() });
  }

  /**
   * The opponent's hand as a row of face-down card backs above the board. The
   * server never sends us what those cards are, only how many, so there is
   * nothing to inspect here and the sprites are not interactive.
   */
  private renderOpponentHand(): void {
    for (const old of this.oppHandLayer.removeChildren()) old.destroy();
    const view = this.view;
    if (!view) return;
    const oppColor = opposite(this.bottomColor());
    const n = view.players[oppColor].handCount;
    const g = new Graphics();
    const spacing = n <= 1 ? 0 : Math.min(OPP_CARD_W + 6, (BOARD_SIZE - 40 - OPP_CARD_W) / (n - 1));
    const startX = BOARD_X + BOARD_SIZE / 2 - ((n - 1) * spacing) / 2;
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
      text: n === 0 ? 'No cards in hand' : `${n} card${n === 1 ? '' : 's'} in hand`,
      style: { fontFamily: UI_FONT, fontSize: 11, fontWeight: '700', fill: 0xbdb8d6, letterSpacing: 1 },
    });
    label.anchor.set(0, 0.5);
    label.position.set(n === 0 ? BOARD_X + BOARD_SIZE / 2 - 50 : startX + (n - 1) * spacing + OPP_CARD_W / 2 + 10, OPP_HAND_Y);
    this.oppHandLayer.addChild(label);
    this.oppHandLayer.eventMode = 'none';
  }

  private renderHand(): void {
    for (const old of this.handLayer.removeChildren()) old.destroy();
    const view = this.view;
    if (!view) return;
    const hand = view.players[view.you].hand ?? [];
    const playable = new Set(view.legalActions.filter((a): a is CardAction => a.type === 'playCard').map((a) => a.cardInstanceId));
    const n = hand.length;
    if (n === 0) return;
    const spacing = n <= 1 ? 0 : Math.min(CARD_W + 6, (CANVAS_W - 40 - CARD_W) / (n - 1));
    const startX = CANVAS_W / 2 - ((n - 1) * spacing) / 2;
    hand.forEach((inst, i) => {
      const sprite = new CardSprite(inst, playable.has(inst.instanceId));
      const hx = startX + i * spacing;
      const hy = HAND_Y + CARD_H / 2;
      sprite.position.set(hx, hy);
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
      sprite.on('pointerdown', (e) => this.onCardPointerDown(e, sprite, hx, hy));
      this.handLayer.addChild(sprite);
    });
    this.handLayer.sortableChildren = true;
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

  private floatText(x: number, y: number, text: string, color: number, delay = 0): void {
    const t = new Text({ text, style: { fontFamily: UI_FONT, fontSize: 22, fontWeight: '900', fill: color, stroke: { color: 0x000000, width: 4 } } });
    t.anchor.set(0.5);
    t.position.set(x, y - 10);
    this.fxLayer.addChild(t);
    this.tweens.run(700, (k) => {
      t.y = y - 10 - 34 * k;
      t.alpha = 1 - k * k;
    }, { delay, done: () => t.destroy() });
  }

  // -------------------------------------------------------------------------
  // Input

  private get myTurn(): boolean {
    return !!this.view && this.view.status.kind === 'playing' && this.view.turn === this.view.you;
  }

  private moveTargetsFrom(square: Square): Targets {
    const bySquare = new Map<Square, Action>();
    if (!this.view) return { bySquare, anywhere: null };
    for (const a of this.view.legalActions) {
      if (a.type !== 'move' || a.from !== square) continue;
      const existing = bySquare.get(a.to) as MoveAction | undefined;
      // Several promotion options share a square; default to queen.
      if (!existing || a.promotion === 'queen') bySquare.set(a.to, a);
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

    if (!this.myTurn || piece.owner !== this.view.you) {
      this.clearSelection();
      return;
    }
    const targets = this.moveTargetsFrom(piece.square);
    if (targets.bySquare.size === 0) {
      this.clearSelection();
      return;
    }

    this.drag = { kind: 'piece', sprite, from: piece.square, targets, startX: e.global.x, startY: e.global.y, moved: false };
    sprite.zIndex = 50;
    sprite.cursor = 'grabbing';
    this.pieceLayer.removeChild(sprite);
    this.dragLayer.addChild(sprite);
    this.drawHighlights(targets, piece.square);
  }

  private onCardPointerDown(e: FederatedPointerEvent, sprite: CardSprite, homeX: number, homeY: number): void {
    if (!this.view || this.drag) return;
    this.inspectCard(sprite.cardId);
    if (!sprite.playable || !this.myTurn) {
      e.stopPropagation();
      return;
    }
    const targets = this.cardTargets(sprite.instanceId);
    if (targets.bySquare.size === 0 && !targets.anywhere) return;
    e.stopPropagation();
    this.selection = null;
    this.drag = { kind: 'card', sprite, homeX, homeY, targets, startX: e.global.x, startY: e.global.y, moved: false };
    sprite.zIndex = 50;
    sprite.scale.set(1.08);
    this.handLayer.removeChild(sprite);
    this.dragLayer.addChild(sprite);
    sprite.position.set(e.global.x, e.global.y);
    this.drawHighlights(targets);
  }

  private onStagePointerDown(e: FederatedPointerEvent): void {
    if (this.drag) return;
    const square = xyToSquare(e.global.x, e.global.y, this.flipped);
    if (square === null) {
      this.clearSelection();
      return;
    }
    if (this.tryActOnSquare(square)) return;
    this.clearSelection();
    if (!this.view?.board[square]) this.setInspected(null);
  }

  private onPointerMove(e: FederatedPointerEvent): void {
    const d = this.drag;
    if (!d) return;
    if (Math.hypot(e.global.x - d.startX, e.global.y - d.startY) > 4) d.moved = true;
    d.sprite.position.set(e.global.x, e.global.y);
  }

  private onPointerUp(e: FederatedPointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const square = xyToSquare(e.global.x, e.global.y, this.flipped);

    if (d.kind === 'piece') {
      const action = square !== null && square !== d.from ? d.targets.bySquare.get(square) : undefined;
      this.dragLayer.removeChild(d.sprite);
      this.pieceLayer.addChild(d.sprite);
      d.sprite.zIndex = 0;
      d.sprite.cursor = 'grab';
      const home = squareToXY(d.from, this.flipped);
      if (action) {
        // Snap to destination immediately; the server's state will confirm.
        const dest = squareToXY(square!, this.flipped);
        d.sprite.position.set(dest.x, dest.y);
        this.highlightLayer.removeChildren();
        this.onAction(action);
      } else {
        d.sprite.position.set(home.x, home.y);
        if (!d.moved) {
          // A simple click: keep the piece selected so the player can click a target.
          this.selection = { square: d.from, targets: d.targets };
          this.drawHighlights(d.targets, d.from);
        } else {
          this.highlightLayer.removeChildren();
        }
      }
      return;
    }

    // Card
    let action: Action | undefined;
    if (square !== null) action = d.targets.bySquare.get(square);
    if (!action && d.targets.anywhere && isOverBoard(e.global.x, e.global.y)) action = d.targets.anywhere;
    this.highlightLayer.removeChildren();
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
      this.handLayer.addChild(d.sprite);
      d.sprite.zIndex = 0;
      const sx = d.sprite.x;
      const sy = d.sprite.y;
      this.tweens.run(180, (t) => {
        d.sprite.position.set(sx + (d.homeX - sx) * t, sy + (d.homeY - sy) * t);
        d.sprite.scale.set(1.08 - 0.08 * t);
      });
    }
  }

  private tryActOnSquare(square: Square): boolean {
    const sel = this.selection;
    if (!sel) return false;
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

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.dragLayer.removeChild(d.sprite);
    if (d.kind === 'piece') {
      this.pieceLayer.addChild(d.sprite);
      const home = squareToXY(d.from, this.flipped);
      d.sprite.position.set(home.x, home.y);
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
