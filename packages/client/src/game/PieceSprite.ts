import { getPieceDef, STANDARD_PIECES, type Piece } from '@chessx/engine';
import { Container, Graphics, Text } from 'pixi.js';
import { CHESS_FONT, COLORS, EMOJI_FONT, SQ, UI_FONT } from './layout.js';

const isStandard = (kind: string) => kind in STANDARD_PIECES;

/**
 * Visual for one piece: glyph, owner ring (for summoned creatures), stat
 * badges, and the summon timer. The "void" beneath a sacrificed piece is
 * drawn separately so it stays below every piece.
 */
export class PieceSprite extends Container {
  pieceId: string;
  square: number;
  private ring = new Graphics();
  private stanceMark = new Graphics();
  private glyph: Text;
  private badges = new Container();
  private timer = new Container();
  private timerText: Text;
  private lock: Text;

  constructor(piece: Piece) {
    super();
    this.pieceId = piece.id;
    this.square = piece.square;
    const def = getPieceDef(piece.kind);
    const standard = isStandard(piece.kind);

    this.addChild(this.stanceMark);
    this.addChild(this.ring);
    this.glyph = new Text({
      text: def.glyph,
      style: standard
        ? {
            fontFamily: CHESS_FONT,
            fontSize: 54,
            fill: piece.owner === 'white' ? COLORS.whitePiece : COLORS.blackPiece,
            stroke: { color: piece.owner === 'white' ? COLORS.whiteOutline : COLORS.blackOutline, width: standard ? 2.5 : 0 },
          }
        : { fontFamily: EMOJI_FONT, fontSize: 40 },
    });
    this.glyph.anchor.set(0.5);
    this.glyph.y = standard ? -2 : -4;
    this.addChild(this.glyph);
    this.addChild(this.badges);

    const timerBg = new Graphics().circle(0, 0, 12).fill(COLORS.summon).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
    this.timerText = new Text({ text: '', style: { fontFamily: UI_FONT, fontSize: 14, fontWeight: '800', fill: 0xffffff } });
    this.timerText.anchor.set(0.5);
    this.timer.addChild(timerBg, this.timerText);
    this.timer.position.set(SQ / 2 - 14, -SQ / 2 + 14);
    this.addChild(this.timer);

    this.lock = new Text({ text: '🔒', style: { fontFamily: EMOJI_FONT, fontSize: 14 } });
    this.lock.anchor.set(0.5);
    this.lock.position.set(-SQ / 2 + 13, -SQ / 2 + 13);
    this.addChild(this.lock);

    this.eventMode = 'static';
    this.update(piece, false);
  }

  update(piece: Piece, locked: boolean): void {
    this.square = piece.square;
    const def = getPieceDef(piece.kind);
    const standard = isStandard(piece.kind);
    if (this.glyph.text !== def.glyph) this.glyph.text = def.glyph; // promotion

    // Defense mode: a blue shield frame around the square.
    this.stanceMark.clear();
    if (piece.stance === 'defense') {
      this.stanceMark
        .roundRect(-SQ / 2 + 4, -SQ / 2 + 4, SQ - 8, SQ - 8, 10)
        .fill({ color: COLORS.def, alpha: 0.18 })
        .stroke({ width: 3, color: COLORS.def, alpha: 0.95 });
    }

    // Owner ring for summoned creatures (emoji have no colour of their own).
    this.ring.clear();
    if (!standard) {
      const fill = piece.owner === 'white' ? COLORS.whitePiece : COLORS.blackPiece;
      const line = piece.owner === 'white' ? COLORS.whiteOutline : COLORS.blackOutline;
      this.ring.circle(0, -2, 27).fill({ color: fill, alpha: 0.85 }).stroke({ width: 2, color: line, alpha: 0.8 });
    }

    // Stat badges: only shown when a stat is non-default so the board stays readable.
    this.badges.removeChildren();
    const isKing = piece.kind === 'king';
    const showAtk = piece.atk !== 1 || !standard;
    const showHp = !isKing && (piece.maxHp !== 1 || !standard);
    const showDef = piece.maxDef > 0;
    const items: { color: number; text: string }[] = [];
    if (showAtk) items.push({ color: COLORS.atk, text: `${piece.atk}` });
    if (showDef) items.push({ color: COLORS.def, text: piece.def === piece.maxDef ? `${piece.def}` : `${piece.def}/${piece.maxDef}` });
    if (showHp) items.push({ color: COLORS.hp, text: piece.hp === piece.maxHp ? `${piece.hp}` : `${piece.hp}/${piece.maxHp}` });
    const gap = 22;
    const startX = -((items.length - 1) * gap) / 2;
    items.forEach((it, i) => {
      const b = new Container();
      const w = it.text.length > 1 ? 26 : 20;
      b.addChild(new Graphics().roundRect(-w / 2, -8, w, 16, 6).fill(it.color).stroke({ width: 1.5, color: 0x111111, alpha: 0.7 }));
      const t = new Text({ text: it.text, style: { fontFamily: UI_FONT, fontSize: 11, fontWeight: '800', fill: 0xffffff } });
      t.anchor.set(0.5);
      b.addChild(t);
      b.position.set(startX + i * gap, SQ / 2 - 12);
      this.badges.addChild(b);
    });

    // Summon timer.
    if (piece.summon) {
      this.timer.visible = true;
      this.timerText.text = `${piece.summon.turnsRemaining}`;
      this.glyph.alpha = 0.7;
    } else {
      this.timer.visible = false;
      this.glyph.alpha = locked ? 0.8 : 1;
    }

    // Stance lock (not shown for sacrifices, which already have the timer).
    this.lock.visible = locked && !piece.summon;
  }
}
