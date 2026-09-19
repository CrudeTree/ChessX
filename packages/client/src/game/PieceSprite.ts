import { allCards, clampBoardArtZoom, getPieceDef, STANDARD_PIECES, type Piece } from '@chessx/engine';
import { Container, Graphics, Rectangle, Sprite, Text, type Texture } from 'pixi.js';
import { artTextures } from './art.js';
import { CHESS_FONT, COLORS, EMOJI_FONT, SQ, UI_FONT } from './layout.js';

const isStandard = (kind: string) => kind in STANDARD_PIECES;

/** The board sprite for a summoned creature: its own board picture if it has one, else the card art. */
function summonCard(kind: string) {
  return allCards().find((c) => c.type === 'summon' && c.piece.kind === kind);
}

function artFor(kind: string): Texture | undefined {
  const card = summonCard(kind);
  const url = card?.boardArt ?? card?.art ?? getPieceDef(kind).art;
  return url ? artTextures.get(url) : undefined;
}

/**
 * Visual for one piece: glyph, owner ring (for summoned creatures), stat
 * badges, and the summon timer. The "void" beneath a sacrificed piece is
 * drawn separately so it stays below every piece.
 */
export class PieceSprite extends Container {
  pieceId: string;
  kind: string;
  square: number;
  private ring = new Graphics();
  private stanceMark = new Graphics();
  private glyph: Text;
  /** Card artwork standing in for the glyph (summoned creatures with art). */
  private art: Sprite | null = null;
  private badges = new Container();
  private timer = new Container();
  private timerText: Text;
  private lock: Text;

  constructor(piece: Piece) {
    super();
    this.pieceId = piece.id;
    this.kind = piece.kind;
    this.square = piece.square;
    const def = getPieceDef(piece.kind);
    const standard = isStandard(piece.kind);

    this.addChild(this.stanceMark);
    this.addChild(this.ring);
    const k = SQ / 72; // everything was tuned for 72px squares; scale for phones
    this.glyph = new Text({
      text: def.glyph,
      style: standard
        ? {
            fontFamily: CHESS_FONT,
            fontSize: Math.round(54 * k),
            fill: piece.owner === 'white' ? COLORS.whitePiece : COLORS.blackPiece,
            stroke: { color: piece.owner === 'white' ? COLORS.whiteOutline : COLORS.blackOutline, width: Math.max(1.5, 2.5 * k) },
          }
        : { fontFamily: EMOJI_FONT, fontSize: Math.round(40 * k) },
    });
    this.glyph.anchor.set(0.5);
    this.glyph.y = standard ? -2 * k : -4 * k;
    this.addChild(this.glyph);

    // Creatures with card art: show the art itself (the emoji is only the fallback).
    // Black's creatures are mirrored so the two armies face each other.
    const tex = standard ? undefined : artFor(piece.kind);
    if (tex) {
      this.art = new Sprite(tex);
      this.art.anchor.set(0.5);
      // The art has ~10% empty margin inside its frame, so a little over a square
      // reads as square-sized; lifted so it stands on the plinth above the badges.
      // boardArtZoom scales the whole figure — it may overflow the square, not crop.
      const size = SQ * 1.12 * clampBoardArtZoom(summonCard(piece.kind)?.boardArtZoom);
      this.art.scale.set((size / tex.height) * (piece.owner === 'black' ? -1 : 1), size / tex.height);
      this.art.y = -8 * k;
      this.glyph.visible = false;
      this.addChild(this.art);
    }
    this.addChild(this.badges);

    const tr = Math.max(9, 12 * k);
    const timerBg = new Graphics().circle(0, 0, tr).fill(COLORS.summon).stroke({ width: 2, color: 0xffffff, alpha: 0.9 });
    this.timerText = new Text({ text: '', style: { fontFamily: UI_FONT, fontSize: Math.max(10, Math.round(14 * k)), fontWeight: '800', fill: 0xffffff } });
    this.timerText.anchor.set(0.5);
    this.timer.addChild(timerBg, this.timerText);
    this.timer.position.set(SQ / 2 - tr - 2, -SQ / 2 + tr + 2);
    this.addChild(this.timer);

    this.lock = new Text({ text: '🔒', style: { fontFamily: EMOJI_FONT, fontSize: Math.max(10, Math.round(14 * k)) } });
    this.lock.anchor.set(0.5);
    this.lock.position.set(-SQ / 2 + tr + 1, -SQ / 2 + tr + 1);
    this.addChild(this.lock);

    this.eventMode = 'static';
    this.hitArea = new Rectangle(-SQ / 2, -SQ / 2, SQ, SQ);
    this.update(piece, false);
  }

  update(piece: Piece, locked: boolean, veiled = false): void {
    this.kind = piece.kind;
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

    const k = SQ / 72;

    // Owner marker for summoned creatures (their art has no side colour of its own):
    // a full disc behind emoji, a low plinth under artwork so the creature stays visible.
    this.ring.clear();
    if (!standard) {
      const fill = piece.owner === 'white' ? COLORS.whitePiece : COLORS.blackPiece;
      const line = piece.owner === 'white' ? COLORS.whiteOutline : COLORS.blackOutline;
      if (this.art) {
        // A tinted backdrop in the owner's colour behind the artwork, plus a plinth under its feet.
        this.ring
          .roundRect(-SQ / 2 + 3, -SQ / 2 + 3, SQ - 6, SQ - 6, 9 * k)
          .fill({ color: fill, alpha: piece.owner === 'white' ? 0.42 : 0.5 })
          .stroke({ width: 2, color: line, alpha: 0.7 });
        this.ring.ellipse(0, SQ / 2 - 20 * k, 27 * k, 9 * k).fill({ color: fill, alpha: 0.9 }).stroke({ width: 2, color: line, alpha: 0.9 });
      } else {
        this.ring.circle(0, -2 * k, 27 * k).fill({ color: fill, alpha: 0.85 }).stroke({ width: 2, color: line, alpha: 0.8 });
      }
    }

    // Defense count when stacked above 1 (a single charge is the shield frame).
    this.badges.removeChildren();
    if (piece.defense > 1) {
      const bh = Math.max(12, 16 * k);
      const w = 26 * Math.max(0.75, k);
      const b = new Container();
      b.addChild(new Graphics().roundRect(-w / 2, -bh / 2, w, bh, bh / 2.6).fill(COLORS.def).stroke({ width: 1.5, color: 0x111111, alpha: 0.7 }));
      const t = new Text({ text: `${piece.defense}`, style: { fontFamily: UI_FONT, fontSize: Math.max(9, Math.round(11 * k)), fontWeight: '800', fill: 0xffffff } });
      t.anchor.set(0.5);
      b.addChild(t);
      b.position.set(0, SQ / 2 - bh / 2 - 4 * k);
      this.badges.addChild(b);
    }

    // Summon timer.
    if (piece.summon) {
      this.timer.visible = true;
      this.timerText.text = `${piece.summon.turnsRemaining}`;
      this.glyph.alpha = 0.7;
    } else {
      this.timer.visible = false;
      this.glyph.alpha = locked ? 0.8 : 1;
    }
    if (this.art) this.art.alpha = this.glyph.alpha;

    // Stance lock (not shown for sacrifices, which already have the timer).
    this.lock.visible = locked && !piece.summon;

    // Your piece in a storm: a faint outline only you can see.
    this.alpha = veiled ? 0.38 : 1;
    if (this.art) this.art.tint = veiled ? 0xc8d4ff : 0xffffff;
  }
}
