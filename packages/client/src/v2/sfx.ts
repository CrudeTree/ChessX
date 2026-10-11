// Sound effects, made on the spot with the Web Audio API rather than recorded: booms, whooshes, ringing steel,
// breaking glass, bells, horns and drums. GameScreen says what happened and when (in step with the board effects
// in fx.ts); this only makes the noise. White's magic rings in D major, Black's an octave lower in D minor.

import type { v2 } from '@chessx/engine';
import { BURST_MS, CARD_DIVE_MS, HATCH_T0_MS } from './fx.js';

type Color = v2.Color;

/** How loud the effects and the music sit in the mix. */
export const EFFECTS_LEVEL = 0.8;
export const MUSIC_LEVEL = 0.45;

/** Frequency of a MIDI note number (60 is middle C, 62 the D above it). */
const hz = (note: number): number => 440 * 2 ** ((note - 69) / 12);

/** A summoning circle's chord: D major for White, D minor an octave lower for Black. */
const CHORDS: Record<Color, readonly number[]> = { white: [74, 78, 81, 86], black: [62, 65, 69, 74] };
/** A seal's uneasy chord: D, F, A flat and B. */
const SEAL_CHORD = [50, 53, 56, 59];

export interface Mixer {
  sfx: Sfx;
  /** Where the music goes in; fade it with this gain, from 0 up to MUSIC_LEVEL. */
  music: GainNode;
}

/**
 * The effects (dry, and into a hall reverb) and the music, through a compressor that holds back the loudest
 * moments, such as a summon landing on top of a fanfare, so they never clip.
 */
export function createMixer(ctx: BaseAudioContext): Mixer {
  const master = ctx.createDynamicsCompressor();
  master.threshold.value = -10;
  master.knee.value = 8;
  master.ratio.value = 6;
  master.attack.value = 0.003;
  master.release.value = 0.3;
  master.connect(ctx.destination);
  const effects = ctx.createGain();
  effects.gain.value = EFFECTS_LEVEL;
  effects.connect(master);
  const hall = ctx.createConvolver();
  hall.buffer = hallImpulse(ctx);
  const send = ctx.createGain();
  send.gain.value = 0.5;
  send.connect(hall).connect(effects);
  const music = ctx.createGain();
  music.gain.value = 0;
  music.connect(master);
  return { sfx: new Sfx(ctx, effects, send), music };
}

/** A big stone hall: 2.4 seconds of fading noise that darkens as it goes, a little different in each ear. */
function hallImpulse(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * 2.4);
  const onset = rate * 0.012;
  const buffer = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // A lowpass that closes as the tail goes on: high notes die first, as in a real room.
      low += (Math.random() * 2 - 1 - low) * (0.9 - 0.75 * t);
      data[i] = low * (1 - t) ** 2.6 * Math.min(1, i / onset);
    }
  }
  return buffer;
}

/** Three seconds of noise; sounds start somewhere in the first 0.6, so none longer than 2.4 hears it loop. */
function noiseBuffer(ctx: BaseAudioContext, brown: boolean): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 3);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = brown ? last * 3.5 : white;
  }
  return buffer;
}

/** When a sound starts (seconds from now), how its loudness rises, holds and dies away, and where it sits. */
interface Shape {
  at: number;
  peak: number;
  attack?: number;
  hold?: number;
  decay: number;
  /** -1 (left) to 1 (right). */
  pan?: number;
  /** How much of it also goes into the hall, 0 to 1. */
  room?: number;
}

/** A filter whose cutoff glides from `freq` to `to` over `time` seconds, then to `end` by the time the sound stops. */
interface Sweep {
  type: BiquadFilterType;
  freq: number;
  to?: number;
  time?: number;
  end?: number;
  q?: number;
}

interface Tone extends Shape {
  wave?: OscillatorType;
  freq: number;
  /** Glide to this pitch over `glide` seconds. */
  to?: number;
  glide?: number;
  /** Cents. */
  detune?: number;
  /** A pitch wobble, `depth` cents at `rate` Hz. */
  wobble?: { rate: number; depth: number };
  /** Distortion: 1 is warm, 3 is gritty. */
  drive?: number;
  filter?: Sweep;
}

interface Noise extends Shape {
  brown?: boolean;
  filter?: Sweep;
}

export class Sfx {
  private readonly white: AudioBuffer;
  private readonly brown: AudioBuffer;
  private readonly curves = new Map<number, Float32Array<ArrayBuffer>>();

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly hall: AudioNode,
  ) {
    this.white = noiseBuffer(ctx, false);
    this.brown = noiseBuffer(ctx, true);
  }

  // ------------------------------------------------------------------- cards

  /** A card is picked up from the hand. */
  cardLift(): void {
    this.noise({ at: 0, attack: 0.006, decay: 0.07, peak: 0.6, filter: { type: 'bandpass', freq: 2600, to: 5200, time: 0.06, q: 0.7 } });
  }

  /** A held card flies into its square. */
  cardDrop(): void {
    this.whoosh(0, 0.24, 3000, 700, 0.35);
  }

  /** A held spell is flung onto the board. */
  cardCast(): void {
    this.whoosh(0, 0.28, 700, 4200, 0.26);
  }

  /** A held card that cannot go there floats back to the hand. */
  cardReturn(): void {
    this.whoosh(0, 0.18, 1200, 2600, 0.2);
  }

  /** New cards slide into the hand one after another, 90 ms apart as they appear. */
  deal(count: number): void {
    for (let i = 0; i < Math.min(count, 5); i++) {
      this.noise({ at: i * 0.09, attack: 0.07, decay: 0.09, peak: 0.23, pan: i % 2 ? 0.2 : -0.2, filter: { type: 'bandpass', freq: 1400, to: 4600, time: 0.14, q: 1.1 } });
    }
  }

  // ------------------------------------------------------------------ pieces

  /** A piece is picked up to move. */
  select(): void {
    this.tone({ at: 0, wave: 'triangle', freq: 1300, to: 900, glide: 0.03, decay: 0.05, peak: 0.3 });
    this.noise({ at: 0, attack: 0.001, decay: 0.015, peak: 0.3, filter: { type: 'highpass', freq: 3000 } });
  }

  /** A piece slides to its square (300 ms on screen) and sets down with a knock. */
  move(): void {
    this.noise({ at: 0, brown: true, attack: 0.18, decay: 0.1, peak: 0.18, room: 0.1, filter: { type: 'bandpass', freq: 350, to: 900, time: 0.26, q: 0.9 } });
    const land = 0.27;
    this.tone({ at: land, wave: 'triangle', freq: 200, to: 85, glide: 0.08, decay: 0.16, peak: 0.3, room: 0.2 });
    this.noise({ at: land, attack: 0.001, decay: 0.05, peak: 0.2, room: 0.15, filter: { type: 'bandpass', freq: 1500, q: 3 } });
    this.tone({ at: land, freq: 60, decay: 0.3, peak: 0.2 });
  }

  /** Steel rings and the taken piece breaks apart. */
  capture(delayMs: number): void {
    const at = delayMs / 1000;
    this.steel(at, 1.3);
    this.boom(at, 0.6);
    this.crackle(at + 0.05, 0.3, 0.3);
  }

  /**
   * A piece is summoned: its card dives in (unless the player dropped it there), a circle opens on a rising chord
   * and the piece lands with a boom as heavy as `force` (0 to 1). The dearest pieces bring a braam as well.
   */
  summon(owner: Color, dive: boolean, force: number, delayMs = 0): void {
    let at = delayMs / 1000;
    if (dive) {
      this.whoosh(at, CARD_DIVE_MS / 1000, 2800, 600, 0.15);
      at += CARD_DIVE_MS / 1000;
    }
    const land = at + BURST_MS / 1000;
    this.whoosh(at, 0.3, 300, 2800, 0.13);
    this.bells(at, CHORDS[owner], 0.05, 0.06);
    this.boom(land, force);
    this.bells(land, CHORDS[owner].map((n) => n + 12), 0, 0.03);
    if (force >= 0.75) this.braam(land, 2, 0.3 * force);
  }

  /** A card falls face down onto a piece and seals it: a dark swirl, the piece sinking, an uneasy chord. */
  seal(dropped: boolean): void {
    let at = 0;
    if (!dropped) {
      this.whoosh(0, 0.25, 2400, 600, 0.13);
      at = 0.2;
    }
    this.boom(at + 0.06, 0.15);
    this.noise({ at, attack: 0.4, decay: 0.6, peak: 0.12, room: 0.6, filter: { type: 'bandpass', freq: 250, to: 1600, time: 0.7, end: 300, q: 4 } });
    this.tone({ at: at + 0.08, wave: 'triangle', freq: 520, to: 65, glide: 0.6, decay: 0.6, peak: 0.1, room: 0.45 });
    for (const note of SEAL_CHORD) {
      this.tone({ at: at + 0.1, wave: 'triangle', freq: hz(note), attack: 0.25, decay: 1.3, peak: 0.03, room: 0.7, wobble: { rate: 4.5, depth: 15 } });
    }
  }

  /** A seal's timer goes down: a clock's tick and a faint bell. */
  tick(delayMs: number): void {
    const at = delayMs / 1000;
    this.tone({ at, wave: 'triangle', freq: 720, to: 540, glide: 0.03, decay: 0.08, peak: 0.34, room: 0.2 });
    this.tone({ at, freq: hz(93), decay: 0.6, peak: 0.08, room: 0.6 });
  }

  /** A seal cracks open and its piece rises out of it. */
  hatch(owner: Color, delayMs: number): void {
    const at = delayMs / 1000;
    const open = at + HATCH_T0_MS / 1000;
    this.crackle(at, HATCH_T0_MS / 1000, 0.3);
    this.glass(open, 0.45, 14);
    this.whoosh(open, 0.3, 300, 2800, 0.12);
    this.bells(open, CHORDS[owner], 0.05, 0.05);
    this.boom(open + BURST_MS / 1000, 0.6);
  }

  /** A seal is destroyed. */
  shatter(delayMs: number): void {
    const at = delayMs / 1000;
    this.glass(at, 1.4);
    this.boom(at, 0.5);
  }

  /** A spell is cast: a rising rush and a chord, unsettling for Dispel and bright for the rest. */
  spell(cardId: string): void {
    this.whoosh(0, 0.5, 400, 4500, 0.14);
    if (cardId === 'dispel') {
      this.bells(0.3, [74, 80, 86], 0.04, 0.06);
      this.tone({ at: 0.35, wave: 'sawtooth', freq: 2400, to: 160, glide: 0.4, decay: 0.45, peak: 0.05, room: 0.5, filter: { type: 'bandpass', freq: 1800, q: 4 } });
    } else {
      this.bells(0.3, [81, 85, 88, 93, 97], 0.055, 0.05);
    }
    this.boom(0.4, 0.2);
  }

  // ---------------------------------------------------------------- the game

  /** The game begins: a gong, a rolling drum and the brass. */
  battle(): void {
    this.gong(0, 0.2);
    this.roll(0.15, 0.9, 38, 0.04, 0.3);
    this.cymbal(1.1, 0.06, 0.6);
    this.drum(1.1, 38, 0.6, 1.6);
    for (const note of [38, 50, 57, 62]) this.horn(1.1, note, 0.5, 0.07);
  }

  /** Check: a braam over a drum and a cymbal. */
  check(delayMs: number): void {
    const at = delayMs / 1000;
    this.braam(at, 2.4, 0.4);
    this.drum(at, 38, 0.6);
    this.cymbal(at, 0.06);
  }

  /** A fanfare after a drum roll. */
  victory(delayMs: number): void {
    const at = delayMs / 1000;
    this.roll(at, 0.65, 38, 0.06, 0.32);
    const fanfare: [number, number[], number][] = [
      [0.7, [50, 54, 57, 62], 0.22],
      [0.98, [50, 54, 57, 62], 0.12],
      [1.14, [55, 59, 62, 67], 0.32],
      [1.5, [57, 61, 64, 69], 0.32],
      [1.86, [50, 54, 57, 62, 66], 2.2],
    ];
    for (const [t, chord, len] of fanfare) {
      for (const note of chord) this.horn(at + t, note, len, 0.06);
      this.drum(at + t, chord[0]! - 12, 0.4);
    }
    this.cymbal(at + 1.86, 0.08, 0.5);
    this.bells(at + 1.86, [74, 78, 81, 86, 90, 93], 0.06, 0.035);
  }

  /** A gong and a falling minor lament. */
  defeat(delayMs: number): void {
    const at = delayMs / 1000;
    this.gong(at, 0.22);
    const lament = [
      [50, 53, 57],
      [46, 50, 53],
      [45, 49, 52],
      [38, 45, 50, 53],
    ];
    lament.forEach((chord, i) => {
      for (const note of chord) this.horn(at + 0.5 + i * 0.85, note, i === lament.length - 1 ? 2 : 0.7, 0.055);
    });
    this.drum(at + 0.5 + 3 * 0.85, 38, 0.45, 2);
  }

  /** A draw: an open chord that never resolves. */
  stalemate(delayMs: number): void {
    const at = delayMs / 1000;
    for (const note of [50, 55, 57, 62]) this.horn(at, note, 1.4, 0.055);
    this.drum(at, 38, 0.35, 1.8);
    this.cymbal(at, 0.04);
  }

  /** The notification chime, also your turn in a game against someone: two quick notes. */
  chime(delayMs = 0): void {
    const at = delayMs / 1000;
    this.tone({ at, freq: 660, attack: 0.02, decay: 0.33, peak: 0.2 });
    this.tone({ at: at + 0.14, freq: 880, attack: 0.02, decay: 0.33, peak: 0.2 });
  }

  // ------------------------------------------------------------- instruments

  /** Something heavy lands, `force` from 0 to 1: a falling sub thump, a knock and a burst of rumble. */
  private boom(at: number, force: number): void {
    const f = Math.min(1, Math.max(0, force));
    this.tone({ at, freq: 110 + 40 * f, to: 38, glide: 0.35, decay: 0.6 + 0.8 * f, peak: 0.45 + 0.4 * f, room: 0.2 });
    this.tone({ at, wave: 'triangle', freq: 240, to: 80, glide: 0.1, decay: 0.18, peak: 0.2 + 0.15 * f, room: 0.15 });
    this.noise({ at, brown: true, decay: 0.35 + 0.4 * f, peak: 0.3 + 0.4 * f, room: 0.4, filter: { type: 'lowpass', freq: 1600, to: 180, time: 0.3 } });
    if (f > 0.4) this.noise({ at, attack: 0.002, decay: 0.12, peak: 0.1 + 0.1 * f, room: 0.3, filter: { type: 'bandpass', freq: 2800, to: 900, time: 0.12, q: 0.8 } });
  }

  /** Air rushing past: noise swept from `from` to `to` Hz, loudest near its end. */
  private whoosh(at: number, dur: number, from: number, to: number, peak: number): void {
    this.noise({ at, attack: dur * 0.75, decay: dur * 0.4, peak, room: 0.25, filter: { type: 'bandpass', freq: from, to, time: dur, q: 1.6 } });
  }

  /** Bells struck one after another, `step` seconds apart, ringing out into the hall. */
  private bells(at: number, notes: readonly number[], step: number, peak: number): void {
    notes.forEach((note, i) => {
      const t = at + i * step;
      const pan = i % 2 ? 0.3 : -0.3;
      this.tone({ at: t, freq: hz(note), decay: 1.2, peak, pan, room: 0.6 });
      this.tone({ at: t, freq: hz(note) * 2.76, decay: 0.3, peak: peak * 0.3, pan, room: 0.6 });
      this.tone({ at: t, freq: hz(note) * 5.4, decay: 0.12, peak: peak * 0.12, pan, room: 0.6 });
    });
  }

  /** A brass note: two detuned saws through a filter that blares open, then settles. */
  private horn(at: number, note: number, len: number, peak: number): void {
    const f = hz(note);
    for (const detune of [-6, 6]) {
      this.tone({
        at,
        wave: 'sawtooth',
        freq: f,
        detune,
        attack: 0.06,
        hold: Math.max(0, len - 0.06),
        decay: 0.3,
        peak: peak / 2,
        pan: detune / 30,
        room: 0.45,
        wobble: { rate: 5, depth: 7 },
        filter: { type: 'lowpass', freq: f * 1.5, to: f * 6, time: 0.08, end: f * 3, q: 3 },
      });
    }
  }

  /** The trailer horn: low brass in octaves, driven hard, with a filter that tears open and slowly shuts. */
  private braam(at: number, len: number, peak: number): void {
    const root = hz(26);
    [1, 2, 3, 4].forEach((harmonic, i) => {
      for (const detune of [-12, 0, 12]) {
        this.tone({
          at,
          wave: 'sawtooth',
          freq: root * harmonic,
          detune,
          attack: 0.04,
          hold: len * 0.3,
          decay: len * 0.7,
          peak: peak / (3 * (1 + i * 0.4)),
          room: 0.5,
          drive: 2.5,
          filter: { type: 'lowpass', freq: 120, to: 1600, time: 0.25, end: 220, q: 6 },
        });
      }
    });
  }

  /** A timpani stroke. */
  private drum(at: number, note: number, peak: number, decay = 1.3): void {
    const f = hz(note);
    this.tone({ at, freq: f * 1.08, to: f, glide: 0.06, decay, peak, room: 0.35 });
    this.tone({ at, freq: f * 1.5, decay: decay * 0.45, peak: peak * 0.35, room: 0.35 });
    this.tone({ at, freq: f * 1.99, decay: decay * 0.25, peak: peak * 0.15, room: 0.35 });
    this.noise({ at, brown: true, attack: 0.002, decay: 0.08, peak: peak * 0.7, room: 0.3, filter: { type: 'lowpass', freq: 1000 } });
  }

  /** A timpani roll swelling from `from` to `to`. */
  private roll(at: number, dur: number, note: number, from: number, to: number): void {
    const hits = Math.max(2, Math.round(dur / 0.06));
    for (let i = 0; i < hits; i++) this.drum(at + i * 0.06 + Math.random() * 0.01, note, from + ((to - from) * i) / (hits - 1), 0.35);
  }

  /** A cymbal crash, swelling up out of nothing for `swell` seconds before it if asked. */
  private cymbal(at: number, peak: number, swell = 0): void {
    if (swell) this.noise({ at: at - swell, attack: swell, decay: 0.05, peak: peak * 0.5, room: 0.4, filter: { type: 'highpass', freq: 4500 } });
    this.noise({ at, attack: 0.002, decay: 2, peak, pan: 0.25, room: 0.35, filter: { type: 'highpass', freq: 3500 } });
    this.noise({ at, attack: 0.002, decay: 1.2, peak: peak * 0.6, pan: -0.25, room: 0.35, filter: { type: 'bandpass', freq: 6500, q: 0.7 } });
  }

  /** A great gong: out-of-tune partials that bloom one after another and shimmer for seconds. */
  private gong(at: number, peak: number): void {
    [1, 1.47, 2.09, 2.56, 2.98, 3.53, 4.25, 5.12].forEach((ratio, i) => {
      this.tone({ at, freq: 78 * ratio, attack: 0.02 + i * 0.04, decay: 3.6 - i * 0.3, peak: peak / (1 + i * 0.5), pan: i % 2 ? 0.25 : -0.25, room: 0.55, wobble: { rate: 0.7 + i * 0.35, depth: 8 } });
    });
    this.noise({ at, brown: true, attack: 0.003, decay: 0.3, peak: peak * 0.8, room: 0.5, filter: { type: 'lowpass', freq: 1500 } });
  }

  /** Blades meeting: a bright out-of-tune ring, a scrape and the click of contact. */
  private steel(at: number, peak: number): void {
    const base = 780 + Math.random() * 160;
    [1, 1.41, 1.93, 2.58, 3.3, 4.12, 5.27].forEach((ratio, i) => {
      this.tone({ at, freq: base * ratio, detune: Math.random() * 20 - 10, attack: 0.002, decay: 1.1 - i * 0.12, peak: (peak * 0.18) / (1 + i * 0.3), pan: Math.random() * 0.6 - 0.3, room: 0.4 });
    });
    this.noise({ at, attack: 0.002, decay: 0.22, peak: peak * 0.35, room: 0.3, filter: { type: 'bandpass', freq: 7500, to: 2500, time: 0.18, q: 2 } });
    this.noise({ at, attack: 0.001, decay: 0.025, peak: peak * 0.5, filter: { type: 'highpass', freq: 2000 } });
  }

  /** Something breaking: a crack, then shards ringing as they scatter. */
  private glass(at: number, peak: number, shards = 22): void {
    this.noise({ at, attack: 0.002, decay: 0.28, peak: peak * 0.35, room: 0.35, filter: { type: 'highpass', freq: 3000 } });
    for (let i = 0; i < shards; i++) {
      this.tone({ at: at + Math.random() ** 1.8 * 0.45, freq: 2300 + Math.random() * 5400, attack: 0.001, decay: 0.05 + Math.random() * 0.25, peak: peak * (0.04 + Math.random() * 0.08), pan: Math.random() * 1.4 - 0.7, room: 0.45 });
    }
  }

  /** Something giving way: clicks that come faster and louder over `dur` seconds. */
  private crackle(at: number, dur: number, peak: number, count = 12): void {
    for (let i = 0; i < count; i++) {
      const p = i / count;
      this.noise({
        at: at + dur * Math.sqrt(p),
        attack: 0.001,
        decay: 0.01 + Math.random() * 0.02,
        peak: peak * (0.35 + 0.65 * p) * (0.6 + Math.random() * 0.4),
        pan: Math.random() * 0.8 - 0.4,
        room: 0.2,
        filter: { type: 'bandpass', freq: 1500 + Math.random() * 3500, q: 2.5 },
      });
    }
  }

  // ---------------------------------------------------------- building blocks

  private tone(t: Tone): void {
    const ctx = this.ctx;
    const start = this.time(t.at);
    const osc = ctx.createOscillator();
    osc.type = t.wave ?? 'sine';
    osc.frequency.setValueAtTime(t.freq, start);
    if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, start + (t.glide ?? 0.1));
    if (t.detune) osc.detune.value = t.detune;
    const nodes: AudioNode[] = [];
    let last: AudioNode = osc;
    if (t.drive) last = link(last, this.shaper(t.drive), nodes);
    if (t.filter) last = link(last, this.filter(t.filter, start, endOf(t, start)), nodes);
    const end = this.emit(osc, last, nodes, t, start);
    if (t.wobble) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = t.wobble.rate;
      depth.gain.value = t.wobble.depth;
      lfo.connect(depth).connect(osc.detune);
      lfo.start(start);
      lfo.stop(end);
      lfo.onended = () => depth.disconnect();
    }
  }

  private noise(n: Noise): void {
    const start = this.time(n.at);
    const src = this.ctx.createBufferSource();
    src.buffer = n.brown ? this.brown : this.white;
    src.loop = true;
    const nodes: AudioNode[] = [];
    let last: AudioNode = src;
    if (n.filter) last = link(last, this.filter(n.filter, start, endOf(n, start)), nodes);
    this.emit(src, last, nodes, n, start, Math.random() * 0.6);
  }

  /** Give a source (already through `last`) its loudness, place and share of the hall; it lets go once played. */
  private emit(src: AudioScheduledSourceNode, last: AudioNode, nodes: AudioNode[], s: Shape, start: number, offset = 0): number {
    const ctx = this.ctx;
    const attack = s.attack ?? 0.004;
    const end = endOf(s, start);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.linearRampToValueAtTime(s.peak, start + attack);
    if (s.hold) amp.gain.setValueAtTime(s.peak, start + attack + s.hold);
    amp.gain.exponentialRampToValueAtTime(0.0001, end);
    let out = link(last, amp, nodes);
    if (s.pan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, s.pan));
      out = link(out, pan, nodes);
    }
    out.connect(this.out);
    if (s.room) {
      const send = ctx.createGain();
      send.gain.value = s.room;
      link(out, send, nodes).connect(this.hall);
    }
    if (src instanceof AudioBufferSourceNode) src.start(start, offset);
    else src.start(start);
    src.stop(end + 0.02);
    src.onended = () => {
      src.disconnect();
      for (const node of nodes) node.disconnect();
    };
    return end;
  }

  private filter(s: Sweep, start: number, end: number): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = s.type;
    if (s.q !== undefined) f.Q.value = s.q;
    f.frequency.setValueAtTime(s.freq, start);
    if (s.to) f.frequency.exponentialRampToValueAtTime(s.to, start + (s.time ?? 0.2));
    if (s.end) f.frequency.exponentialRampToValueAtTime(s.end, end);
    return f;
  }

  /** A soft clipper; `drive` is how hard it is pushed. */
  private shaper(drive: number): WaveShaperNode {
    let curve = this.curves.get(drive);
    if (!curve) {
      curve = new Float32Array(1025);
      for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * drive) / Math.tanh(drive);
      this.curves.set(drive, curve);
    }
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = curve;
    shaper.oversample = '2x';
    return shaper;
  }

  /** Seconds from now in the audio clock, a hair ahead so nothing scheduled "now" loses its start. */
  private time(at: number): number {
    return this.ctx.currentTime + 0.02 + Math.max(0, at);
  }
}

function endOf(s: Shape, start: number): number {
  return start + (s.attack ?? 0.004) + (s.hold ?? 0) + s.decay;
}

function link(from: AudioNode, to: AudioNode, nodes: AudioNode[]): AudioNode {
  from.connect(to);
  nodes.push(to);
  return to;
}
