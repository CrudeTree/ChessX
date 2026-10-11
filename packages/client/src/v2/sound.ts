// The game's sound: the effects (sfx.ts) and battle music, each with an on/off switch that is remembered.
// Browsers only allow sound once the player has clicked or pressed a key, so it all starts on the first one.

import clashDefiant from './music/clash-defiant.mp3';
import darkling from './music/darkling.mp3';
import theDescent from './music/the-descent.mp3';
import { createMixer, MUSIC_LEVEL, type Sfx } from './sfx.js';

/**
 * By Kevin MacLeod (incompetech.com), licensed under Creative Commons: By Attribution 4.0
 * (http://creativecommons.org/licenses/by/4.0/), so the game shows that credit while they are on.
 * Trimmed, levelled to -18 LUFS and re-encoded.
 */
export const TRACKS = [
  { title: 'Clash Defiant', src: clashDefiant },
  { title: 'Darkling', src: darkling },
  { title: 'The Descent', src: theDescent },
] as const;

export type Track = (typeof TRACKS)[number];

const PREFS_KEY = 'chessx.sound';
/** How quickly the music fades in or out: the time constant, in seconds (it is all but there after three). */
const FADE = 0.5;

interface Prefs {
  effects: boolean;
  music: boolean;
}

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { effects: saved.effects !== false, music: saved.music !== false };
  } catch {
    return { effects: true, music: true };
  }
}

class GameSound {
  private readonly prefs = loadPrefs();
  private ctx: AudioContext | null = null;
  private effects: Sfx | null = null;
  private musicIn: GainNode | null = null;
  private player: HTMLAudioElement | null = null;
  /** Set when the browser would not let the music through Web Audio; it then plays at a fixed volume. */
  private direct = false;
  private trackIndex = Math.floor(Math.random() * TRACKS.length);
  private battle = false;
  /** Pauses the music once it has faded out; 0 when no fade-out is under way. */
  private stopTimer = 0;
  private readonly listeners = new Set<() => void>();

  constructor() {
    // iOS only counts some of these as permission to play, and can take it back (a call, the lock screen),
    // so every one of them is a chance to start or resume.
    const wake = (): void => this.wake();
    for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) window.addEventListener(type, wake, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => this.updateMusic());
  }

  get effectsOn(): boolean {
    return this.prefs.effects;
  }

  get musicOn(): boolean {
    return this.prefs.music;
  }

  /** The sound effects, while they are on and can be heard; null otherwise. */
  get sfx(): Sfx | null {
    return this.prefs.effects && !document.hidden && this.ctx?.state === 'running' ? this.effects : null;
  }

  /** The track playing, or the one that will. */
  get track(): Track {
    return TRACKS[this.trackIndex]!;
  }

  setEffects(on: boolean): void {
    this.prefs.effects = on;
    this.save();
    this.emit();
  }

  setMusic(on: boolean): void {
    this.prefs.music = on;
    this.save();
    this.updateMusic();
    this.emit();
  }

  /** Called whenever a switch flips or the track changes. */
  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** Whether a game is on. Its music plays while one is (if wanted), and fades out when it ends or is left. */
  setBattle(on: boolean): void {
    if (on === this.battle) return;
    this.battle = on;
    this.updateMusic();
  }

  /** The notification chime: unlike `sfx`, also while the tab is hidden, which is when it matters most. */
  chime(): void {
    if (this.prefs.effects && this.ctx?.state === 'running') this.effects?.chime();
  }

  private wake(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
      const mixer = createMixer(this.ctx);
      this.effects = mixer.sfx;
      this.musicIn = mixer.music;
    }
    if (this.ctx.state === 'running') this.updateMusic();
    else this.ctx.resume().then(() => this.updateMusic(), () => {});
  }

  /** Play the music while a game is on, it is wanted and the tab is in view; fade it out otherwise. */
  private updateMusic(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicIn) return;
    if (!(this.battle && this.prefs.music && !document.hidden)) {
      this.fadeOut(ctx);
      return;
    }
    // A play() refused for want of a click is tried again on the next one.
    if (ctx.state !== 'running') return;
    const player = this.player ?? this.makePlayer(ctx);
    clearTimeout(this.stopTimer);
    this.stopTimer = 0;
    this.fadeTo(ctx, MUSIC_LEVEL);
    if (player.paused) player.play().then(() => this.emit(), () => {});
  }

  private fadeOut(ctx: AudioContext): void {
    const player = this.player;
    if (!player || player.paused || this.stopTimer) return;
    if (this.direct) {
      player.pause();
      return;
    }
    this.fadeTo(ctx, 0);
    this.stopTimer = window.setTimeout(() => {
      this.stopTimer = 0;
      player.pause();
    }, FADE * 4000);
  }

  private fadeTo(ctx: AudioContext, level: number): void {
    if (this.direct) {
      if (this.player) this.player.volume = level;
      return;
    }
    const gain = this.musicIn!.gain;
    const now = ctx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.setTargetAtTime(level, now, FADE);
  }

  private makePlayer(ctx: AudioContext): HTMLAudioElement {
    const player = new Audio(this.track.src);
    player.preload = 'auto';
    player.addEventListener('ended', () => {
      this.trackIndex = (this.trackIndex + 1) % TRACKS.length;
      player.src = this.track.src;
      this.emit();
      if (this.battle && this.prefs.music && !document.hidden) player.play().catch(() => {});
    });
    try {
      ctx.createMediaElementSource(player).connect(this.musicIn!);
    } catch {
      this.direct = true;
    }
    this.player = player;
    return player;
  }

  private save(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      /* private browsing: the switches last until the page closes */
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const sound = new GameSound();
