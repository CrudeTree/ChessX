import type { Ticker } from 'pixi.js';

export type Ease = (t: number) => number;
export const easeOutCubic: Ease = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutQuad: Ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeOutBack: Ease = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

interface Tween {
  elapsed: number;
  duration: number;
  ease: Ease;
  update: (t: number) => void;
  done?: () => void;
}

/** Minimal tween runner driven by the Pixi ticker. Enough for piece moves, flashes and pops. */
export class Tweens {
  private list: Tween[] = [];

  constructor(ticker: Ticker) {
    ticker.add((tk) => this.step(tk.deltaMS));
  }

  run(duration: number, update: (t: number) => void, opts: { ease?: Ease; done?: () => void; delay?: number } = {}): void {
    const tween: Tween = { elapsed: -(opts.delay ?? 0), duration, ease: opts.ease ?? easeOutCubic, update, done: opts.done };
    this.list.push(tween);
  }

  private step(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const tw = this.list[i]!;
      tw.elapsed += dt;
      if (tw.elapsed < 0) continue;
      const t = Math.min(1, tw.elapsed / tw.duration);
      // A throwing callback (e.g. touching a sprite destroyed by a game reset) must not stop
      // the ticker or leave anything awaiting `done` hanging: drop the tween and finish it.
      let failed = false;
      try {
        tw.update(tw.ease(t));
      } catch (err) {
        failed = true;
        console.warn('tween update failed; finishing early', err);
      }
      if (t >= 1 || failed) {
        this.list.splice(i, 1);
        try {
          tw.done?.();
        } catch (err) {
          console.warn('tween done() failed', err);
        }
      }
    }
  }
}
