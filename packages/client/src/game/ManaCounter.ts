import { Container, Graphics, Text } from 'pixi.js';
import { COLORS, UI_FONT } from './layout.js';
import type { Tweens } from './tween.js';

/**
 * A player's mana pool: a big blue number with a label and the income they will
 * collect at the end of their turn ("+32 / turn"). `countTo` rolls the number
 * up rapidly for the end-of-turn animation; `set` snaps it (e.g. a card's cost).
 */
export class ManaCounter extends Container {
  tweens: Tweens | null = null;
  private value: Text;
  private income: Text;
  private glow: Graphics;
  private cap: Text;
  private shown = 0;
  private target = 0;
  private rolling = false;

  constructor(private size: number, label: string, private showIncome = true) {
    super();
    this.glow = new Graphics().circle(0, 0, size * 1.1).fill({ color: COLORS.mana, alpha: 0.25 });
    this.glow.alpha = 0;
    this.addChild(this.glow);

    this.cap = new Text({ text: label, style: { fontFamily: UI_FONT, fontSize: Math.max(8, size * 0.28), fontWeight: '700', fill: COLORS.mana, letterSpacing: 1 } });
    this.cap.anchor.set(0.5, 1);
    this.cap.position.set(0, -size * 0.5);
    this.cap.alpha = 0.85;
    this.addChild(this.cap);

    this.value = new Text({ text: '0', style: { fontFamily: UI_FONT, fontSize: size, fontWeight: '900', fill: COLORS.mana, stroke: { color: 0x061020, width: Math.max(2, size / 8) } } });
    this.value.anchor.set(0.5);
    this.addChild(this.value);

    this.income = new Text({ text: '', style: { fontFamily: UI_FONT, fontSize: Math.max(8, size * 0.32), fontWeight: '700', fill: COLORS.mana } });
    this.income.anchor.set(0.5, 0);
    this.income.position.set(0, size * 0.55);
    this.income.alpha = 0.7;
    this.income.visible = showIncome;
    this.addChild(this.income);
  }

  set caption(text: string) {
    if (this.cap.text !== text) this.cap.text = text;
  }

  /** Snap to the real total (unless a count-up animation is about to show it). */
  set(mana: number, income: number, animating: boolean): void {
    this.income.text = `+${income} / turn`;
    this.target = mana;
    if (animating && this.tweens) return; // countTo() will bring the display up
    this.shown = mana;
    this.value.text = `${mana}`;
  }

  /** Roll the displayed number up to `to` over `duration` ms after `delay` ms. */
  countTo(to: number, delay: number, duration: number): void {
    if (!this.tweens) {
      this.shown = to;
      this.value.text = `${to}`;
      return;
    }
    const from = this.shown;
    this.target = to;
    this.rolling = true;
    this.tweens.run(duration, (t) => {
      const eased = 1 - Math.pow(1 - t, 3);
      this.shown = Math.round(from + (to - from) * eased);
      this.value.text = `${this.shown}`;
      const pop = Math.sin(t * Math.PI);
      this.value.scale.set(1 + 0.18 * pop);
      this.glow.alpha = pop;
      this.glow.scale.set(1 + 0.6 * t);
    }, {
      delay,
      done: () => {
        this.rolling = false;
        this.shown = this.target;
        this.value.text = `${this.target}`;
        this.value.scale.set(1);
        this.glow.alpha = 0;
        this.glow.scale.set(1);
      },
    });
  }

  get isRolling(): boolean {
    return this.rolling;
  }
}
