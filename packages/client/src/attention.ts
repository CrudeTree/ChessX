// Get the player's attention when something happens while the tab is in the
// background: flash the title, set the app badge, play a soft chime.

const BASE_TITLE = 'ChessX';
let unread = 0;
let latest = '';
let flashTimer = 0;
let audio: AudioContext | null = null;

function render(): void {
  if (unread === 0) {
    document.title = BASE_TITLE;
    clearInterval(flashTimer);
    flashTimer = 0;
    (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => {});
    return;
  }
  (navigator as Navigator & { setAppBadge?: (n: number) => Promise<void> }).setAppBadge?.(unread).catch(() => {});
  if (!flashTimer) {
    let on = true;
    flashTimer = window.setInterval(() => {
      document.title = on ? `(${unread}) ${latest} — ${BASE_TITLE}` : BASE_TITLE;
      on = !on;
    }, 1200);
    document.title = `(${unread}) ${latest} — ${BASE_TITLE}`;
  }
}

/** Two quick notes; created lazily so it only ever runs after a user gesture unlocked audio. */
export function chime(): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') return; // browser has not let us make sound yet
    const t0 = audio.currentTime;
    for (const [freq, at] of [
      [660, 0],
      [880, 0.14],
    ] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.4);
    }
  } catch {
    /* no audio available */
  }
}

/** Something happened. If the tab is hidden, make noise about it. */
export function notice(text: string, opts: { sound?: boolean } = {}): void {
  if (opts.sound !== false) chime();
  if (!document.hidden) return;
  unread++;
  latest = text;
  render();
}

/** Unlock audio on the first interaction so chimes can play later. */
export function initAttention(): void {
  const unlock = () => {
    audio ??= new AudioContext();
    void audio.resume();
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      unread = 0;
      render();
    }
  });
}
