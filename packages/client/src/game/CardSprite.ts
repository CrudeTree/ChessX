import { getCardDef, type CardInstance } from '@chessx/engine';
import { Container, Graphics, Sprite, Text } from 'pixi.js';
import { artTextures } from './art.js';
import { CARD_H, CARD_W, COLORS, EMOJI_FONT, UI_FONT } from './layout.js';

export class CardSprite extends Container {
  readonly instanceId: string;
  readonly cardId: string;
  playable: boolean;

  /**
   * @param playable  has a legal target right now (bright border, draggable)
   * @param affordable  the owner has the mana for it (cost gem blue; red when not)
   */
  constructor(inst: CardInstance, playable: boolean, affordable = true) {
    super();
    this.instanceId = inst.instanceId;
    this.cardId = inst.cardId;
    this.playable = playable;
    const card = getCardDef(inst.cardId);
    const isSummon = card.type === 'summon';

    const bg = new Graphics()
      .roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 9)
      .fill(isSummon ? 0x3a1f2a : 0x1f2740)
      .stroke({ width: 2.5, color: playable ? COLORS.select : 0x4a4a5c, alpha: playable ? 1 : 0.7 });
    this.addChild(bg);

    // Art area: pixel art when the card has it, otherwise the glyph.
    const artX = -CARD_W / 2 + 6;
    const artY = -CARD_H / 2 + 22;
    const artW = CARD_W - 12;
    const artH = 46;
    const art = new Graphics().roundRect(artX, artY, artW, artH, 5).fill({ color: isSummon ? 0x5a2f3d : 0x2b3a66, alpha: 0.9 });
    this.addChild(art);
    const tex = card.art ? artTextures.get(card.art) : undefined;
    if (tex) {
      const img = new Sprite(tex);
      const scale = artH / tex.height;
      img.scale.set(scale);
      img.anchor.set(0.5);
      img.position.set(0, artY + artH / 2);
      const mask = new Graphics().roundRect(artX, artY, artW, artH, 5).fill(0xffffff);
      img.mask = mask;
      this.addChild(mask, img);
    } else {
      const glyph = new Text({ text: card.glyph, style: { fontFamily: EMOJI_FONT, fontSize: 28 } });
      glyph.anchor.set(0.5);
      glyph.position.set(0, artY + artH / 2);
      this.addChild(glyph);
    }

    // Name
    const name = new Text({
      text: card.name,
      style: { fontFamily: UI_FONT, fontSize: 11, fontWeight: '700', fill: 0xffffff, wordWrap: true, wordWrapWidth: CARD_W - 10, align: 'center' },
    });
    name.anchor.set(0.5, 0);
    name.position.set(0, -CARD_H / 2 + 5);
    this.addChild(name);

    // Mana cost gem in the corner of the art (blue; red when the owner cannot afford it).
    const gemColor = affordable ? COLORS.mana : COLORS.atk;
    const gem = new Graphics().roundRect(artX - 2, artY - 2, 30, 16, 6).fill({ color: 0x0b1020, alpha: 0.9 }).stroke({ width: 1.5, color: gemColor });
    const cost = new Text({ text: `${card.cost}`, style: { fontFamily: UI_FONT, fontSize: 10, fontWeight: '900', fill: gemColor } });
    cost.anchor.set(0.5);
    cost.position.set(artX + 13, artY + 6);
    this.addChild(gem, cost);

    // Summon info: tier + timer
    if (isSummon) {
      const tier = new Text({ text: `Tier ${card.tier}`, style: { fontFamily: UI_FONT, fontSize: 9, fontWeight: '700', fill: 0xffd9a0 } });
      tier.anchor.set(0, 0.5);
      tier.position.set(-CARD_W / 2 + 7, -CARD_H / 2 + 76);
      const timer = new Text({ text: `⏳${card.summonTurns}`, style: { fontFamily: EMOJI_FONT, fontSize: 9, fill: 0xffffff } });
      timer.anchor.set(1, 0.5);
      timer.position.set(CARD_W / 2 - 7, -CARD_H / 2 + 76);
      this.addChild(tier, timer);
    } else {
      const kind = new Text({ text: 'Spell', style: { fontFamily: UI_FONT, fontSize: 9, fontWeight: '700', fill: 0xa9c4ff } });
      kind.anchor.set(0, 0.5);
      kind.position.set(-CARD_W / 2 + 7, -CARD_H / 2 + 76);
      this.addChild(kind);
    }

    // Rules text, clipped to the card (tap/hover the card for the full text).
    const textTop = -CARD_H / 2 + 84;
    const text = new Text({
      text: card.text,
      style: { fontFamily: UI_FONT, fontSize: 8, fill: 0xd8d8e6, wordWrap: true, wordWrapWidth: CARD_W - 14, lineHeight: 10 },
    });
    text.anchor.set(0.5, 0);
    text.position.set(0, textTop);
    const textMask = new Graphics().rect(-CARD_W / 2, textTop, CARD_W, CARD_H / 2 - 84 + CARD_H / 2 - 6).fill(0xffffff);
    text.mask = textMask;
    this.addChild(textMask, text);

    if (!playable) this.alpha = 0.6;
    this.eventMode = 'static';
    this.cursor = playable ? 'grab' : 'default';
  }
}
