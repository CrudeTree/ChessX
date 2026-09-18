import { Container, Graphics, Text } from 'pixi.js';
import { COLORS, DECK_H, DECK_RING_R, DECK_W, EMOJI_FONT, UI_FONT } from './layout.js';

export interface DeckInfo {
  count: number;
  /** 0..1 progress of the draw timer around the deck. */
  progress: number;
  /** The timer has completed: a draw is owed. */
  drawReady: boolean;
  /** This deck belongs to the player at the controls and may be clicked now. */
  clickable: boolean;
  label: string;
}

/**
 * A face-down deck with a circular timer around it. Each turn the owner takes
 * fills a segment of the green ring; when the ring closes it pulses until the
 * owner clicks the deck to draw.
 */
export class DeckSprite extends Container {
  onDraw: () => void = () => {};

  private ring = new Graphics();
  private glow = new Graphics();
  private stack = new Graphics();
  private count: Text;
  private caption: Text;
  private prompt: Text;
  private info: DeckInfo = { count: 0, progress: 0, drawReady: false, clickable: false, label: '' };
  private pulse = 0;

  constructor() {
    super();
    this.addChild(this.glow, this.ring, this.stack);

    this.count = new Text({ text: '', style: { fontFamily: UI_FONT, fontSize: 22, fontWeight: '900', fill: 0xffffff, stroke: { color: 0x000000, width: 4 } } });
    this.count.anchor.set(0.5);
    this.addChild(this.count);

    this.caption = new Text({ text: '', style: { fontFamily: UI_FONT, fontSize: 11, fontWeight: '700', fill: 0xbdb8d6, letterSpacing: 1 } });
    this.caption.anchor.set(0.5);
    this.caption.position.set(0, DECK_RING_R + 14);
    this.addChild(this.caption);

    this.prompt = new Text({ text: 'DRAW', style: { fontFamily: UI_FONT, fontSize: 14, fontWeight: '900', fill: COLORS.ringFill, stroke: { color: 0x000000, width: 3 }, letterSpacing: 2 } });
    this.prompt.anchor.set(0.5);
    this.prompt.position.set(0, -DECK_RING_R - 14);
    this.prompt.visible = false;
    this.addChild(this.prompt);

    this.eventMode = 'static';
    this.on('pointerdown', (e) => {
      e.stopPropagation();
      if (this.info.clickable) this.onDraw();
    });
    this.on('pointerover', () => {
      if (this.info.clickable) this.scale.set(1.05);
    });
    this.on('pointerout', () => this.scale.set(1));
    this.drawStack();
  }

  update(info: DeckInfo): void {
    this.info = info;
    this.count.text = `${info.count}`;
    this.caption.text = info.label;
    this.cursor = info.clickable ? 'pointer' : 'default';
    this.prompt.visible = info.drawReady;
    this.stack.alpha = info.count === 0 ? 0.35 : 1;
    this.drawRing(info.drawReady ? 1 : info.progress);
  }

  /** Call every frame. */
  tick(dtMs: number): void {
    if (!this.info.drawReady) {
      this.glow.clear();
      this.pulse = 0;
      return;
    }
    this.pulse += dtMs / 1000;
    const k = 0.5 + 0.5 * Math.sin(this.pulse * 4);
    this.glow.clear();
    this.glow.circle(0, 0, DECK_RING_R + 6 + 8 * k).fill({ color: COLORS.ringFill, alpha: 0.10 + 0.15 * k });
    this.glow.circle(0, 0, DECK_RING_R).stroke({ width: 12 + 6 * k, color: COLORS.ringFill, alpha: 0.18 });
    this.prompt.alpha = 0.6 + 0.4 * k;
    this.prompt.scale.set(1 + 0.08 * k);
  }

  private drawStack(): void {
    const g = this.stack;
    g.clear();
    // A few offset card backs to read as a pile.
    for (let i = 2; i >= 0; i--) {
      const o = i * 3;
      g.roundRect(-DECK_W / 2 + o, -DECK_H / 2 - o, DECK_W, DECK_H, 8)
        .fill(COLORS.deckBack)
        .stroke({ width: 2, color: COLORS.deckEdge, alpha: 0.9 });
    }
    // Card-back pattern.
    g.roundRect(-DECK_W / 2 + 8, -DECK_H / 2 + 8, DECK_W - 16, DECK_H - 16, 5).stroke({ width: 1.5, color: COLORS.deckEdge, alpha: 0.6 });
    g.moveTo(-DECK_W / 2 + 8, 0).lineTo(0, -DECK_H / 2 + 8).lineTo(DECK_W / 2 - 8, 0).lineTo(0, DECK_H / 2 - 8).closePath().stroke({ width: 1.5, color: COLORS.deckEdge, alpha: 0.6 });
    const emblem = new Text({ text: '♛', style: { fontFamily: EMOJI_FONT, fontSize: 26, fill: COLORS.deckEdge } });
    emblem.anchor.set(0.5);
    emblem.alpha = 0.5;
    emblem.position.set(0, -2);
    this.addChildAt(emblem, this.getChildIndex(this.stack) + 1);
  }

  private drawRing(progress: number): void {
    const g = this.ring;
    g.clear();
    g.circle(0, 0, DECK_RING_R).stroke({ width: 8, color: COLORS.ringTrack, alpha: 0.9 });
    const p = Math.max(0, Math.min(1, progress));
    if (p <= 0) return;
    const start = -Math.PI / 2;
    const end = start + Math.PI * 2 * p;
    if (p >= 1) {
      g.circle(0, 0, DECK_RING_R).stroke({ width: 8, color: COLORS.ringFill });
    } else {
      g.moveTo(Math.cos(start) * DECK_RING_R, Math.sin(start) * DECK_RING_R);
      g.arc(0, 0, DECK_RING_R, start, end);
      g.stroke({ width: 8, color: COLORS.ringFill, cap: 'round' });
      // Bright tip so the sweep reads as a timer hand.
      g.circle(Math.cos(end) * DECK_RING_R, Math.sin(end) * DECK_RING_R, 6).fill(0xffffff);
    }
  }
}
