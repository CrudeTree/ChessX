/** What every number drawn adds to the generator's state, so a game's seed can be worked out from where it got to. */
export const RNG_STEP = 0x6d2b79f5;

/** Small seeded generator (mulberry32). State is a plain number so game state stays serialisable. */
export function nextRandom(state: number): { value: number; state: number } {
  const next = (state + RNG_STEP) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: next };
}
