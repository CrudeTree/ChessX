import type { CardInstance } from '@chessx/engine';
import { Container, Graphics, Text } from 'pixi.js';
import { CardSprite } from './CardSprite.js';
import { CARD_H, CARD_W, COLORS, UI_FONT } from './layout.js';

/**
 * A player's discard pile: the most recently played card face-up (scaled down)
 * with a count badge. Clicking opens the full browser in the side panel.
 */
export class DiscardSprite extends Container {
  onOpen: () => void = () => {};
  private face: CardSprite | null = null;
  private placeholder = new Graphics();
  private count: Text;
  private caption: Text;
  private topId: string | null = null;

  constructor(private pileScale: number) {
    super();
    this.placeholder
      .roundRect((-CARD_W / 2) * pileScale, (-CARD_H / 2) * pileScale, CARD_W * pileScale, CARD_H * pileScale, 8 * pileScale)
      .fill({ color: 0xffffff, alpha: 0.04 })
      .stroke({ width: 2, color: COLORS.deckEdge, alpha: 0.35 });
    this.addChild(this.placeholder);

    this.count = new Text({ text: '', style: { fontFamily: UI_FONT, fontSize: 13, fontWeight: '900', fill: 0xffffff, stroke: { color: 0x000000, width: 3 } } });
    this.count.anchor.set(0.5);
    this.count.position.set((CARD_W / 2) * pileScale - 2, (-CARD_H / 2) * pileScale + 2);
    this.addChild(this.count);

    this.caption = new Text({ text: 'DISCARD', style: { fontFamily: UI_FONT, fontSize: 9, fontWeight: '700', fill: 0xbdb8d6, letterSpacing: 1 } });
    this.caption.anchor.set(0.5);
    this.caption.position.set(0, (CARD_H / 2) * pileScale + 9);
    this.addChild(this.caption);

    this.eventMode = 'static';
    this.cursor = 'pointer';
    this.on('pointerdown', (e) => {
      e.stopPropagation();
      this.onOpen();
    });
    this.on('pointerover', () => this.scale.set(1.06));
    this.on('pointerout', () => this.scale.set(1));
  }

  update(pile: CardInstance[]): void {
    const top = pile[pile.length - 1] ?? null;
    this.count.text = pile.length ? `${pile.length}` : '';
    this.caption.visible = pile.length === 0;
    if ((top?.instanceId ?? null) === this.topId) return;
    this.topId = top?.instanceId ?? null;
    this.face?.destroy();
    this.face = null;
    if (top) {
      this.face = new CardSprite(top, false);
      this.face.alpha = 1;
      this.face.eventMode = 'none';
      this.face.scale.set(this.pileScale);
      this.addChildAt(this.face, 1);
    }
  }
}
