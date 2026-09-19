import { Container, Graphics, Text } from 'pixi.js';
import { SQ, UI_FONT } from './layout.js';

const CLOUD = 0x07060c;
const RIM = 0x1a1628;
const FLASH = 0xfff3a0;
const BOLT = 0xfffce8;

function hash(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** One storm-covered square: a black cloud that occasionally flickers with lightning. */
export class StormTile extends Container {
  private puffs = new Graphics();
  private glow = new Graphics();
  private bolts = new Graphics();
  private timer: Text;
  private age = 0;
  private nextFlash: number;
  private flashUntil = 0;
  private seed: number;

  constructor(square: number, turns: number) {
    super();
    this.eventMode = 'none';
    this.seed = square * 17 + 3;
    this.nextFlash = 0.4 + hash(this.seed) * 1.8;
    this.addChild(this.puffs, this.glow, this.bolts);
    this.timer = new Text({
      text: `${turns}`,
      style: {
        fontFamily: UI_FONT,
        fontSize: Math.round(SQ * 0.36),
        fontWeight: '900',
        fill: 0xf4f0ff,
        stroke: { color: 0x050308, width: 5 },
      },
    });
    this.timer.anchor.set(0.5);
    this.addChild(this.timer);
    this.drawCloud(0);
  }

  setTurns(n: number): void {
    this.timer.text = `${n}`;
  }

  tick(dt: number): void {
    this.age += dt / 1000;
    this.drawCloud(this.age);
    if (this.age >= this.nextFlash) {
      this.flashUntil = this.age + 0.09 + hash(this.age + this.seed) * 0.08;
      this.nextFlash = this.age + 1.1 + hash(this.age * 9 + this.seed) * 2.4;
      this.drawBolt();
    }
    const flashing = this.age < this.flashUntil;
    const flicker = flashing && hash(Math.floor(this.age * 40) + this.seed) > 0.22;
    this.bolts.visible = flicker;
    this.glow.alpha = flicker ? 0.55 + 0.35 * hash(this.age * 30) : 0;
    this.timer.alpha = flicker ? 0.55 : 1;
  }

  private drawCloud(t: number): void {
    const k = SQ / 72;
    const w = SQ / 2 - 3;
    const wobble = (i: number) => Math.sin(t * (1.1 + i * 0.17) + this.seed) * 2.2 * k;
    this.puffs.clear();
    this.puffs.roundRect(-w, -w, w * 2, w * 2, 10 * k).fill({ color: CLOUD, alpha: 0.88 });
    const blobs: [number, number, number, number][] = [
      [0, -6 * k, 28 * k, 16 * k],
      [-16 * k, 2 * k, 20 * k, 14 * k],
      [16 * k, 3 * k, 19 * k, 13 * k],
      [0, 12 * k, 24 * k, 12 * k],
      [-8 * k, -14 * k, 16 * k, 10 * k],
      [10 * k, -12 * k, 14 * k, 9 * k],
    ];
    for (let i = 0; i < blobs.length; i++) {
      const [x, y, rx, ry] = blobs[i]!;
      this.puffs.ellipse(x + wobble(i), y + wobble(i + 3), rx, ry).fill({ color: i % 2 ? 0x0c0b14 : CLOUD, alpha: 0.92 });
    }
    this.puffs.roundRect(-w, -w, w * 2, w * 2, 10 * k).stroke({ width: 2, color: RIM, alpha: 0.7 });

    this.glow.clear();
    this.glow.roundRect(-w, -w, w * 2, w * 2, 10 * k).fill({ color: FLASH, alpha: 1 });
  }

  private drawBolt(): void {
    const k = SQ / 72;
    this.bolts.clear();
    const startX = (hash(this.age + this.seed) - 0.5) * 22 * k;
    const startY = -20 * k;
    let x = startX;
    let y = startY;
    this.bolts.moveTo(x, y);
    const segs = 4;
    for (let i = 1; i <= segs; i++) {
      x += (hash(this.age * 7 + i * 13 + this.seed) - 0.5) * 14 * k;
      y += 10 * k;
      this.bolts.lineTo(x, y);
    }
    this.bolts.stroke({ width: 2.4 * k, color: BOLT, alpha: 0.95 });
    this.bolts.moveTo(startX + 1 * k, startY + 2 * k);
    x = startX + 1 * k;
    y = startY + 2 * k;
    for (let i = 1; i <= segs; i++) {
      x += (hash(this.age * 5 + i * 19 + this.seed) - 0.45) * 10 * k;
      y += 9 * k;
      this.bolts.lineTo(x, y);
    }
    this.bolts.stroke({ width: 1.2 * k, color: FLASH, alpha: 0.7 });
  }
}
