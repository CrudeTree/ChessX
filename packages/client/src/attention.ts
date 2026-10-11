// Get the player's attention when something happens while the tab is in the
// background: flash the title, set the app badge, play a soft chime.

import { sound } from './v2/sound.js';

const BASE_TITLE = 'ChessX';
let unread = 0;
let latest = '';
let flashTimer = 0;

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

/** Something happened. If the tab is hidden, make noise about it. */
export function notice(text: string, opts: { sound?: boolean } = {}): void {
  if (opts.sound !== false) sound.chime();
  if (!document.hidden) return;
  unread++;
  latest = text;
  render();
}

export function initAttention(): void {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      unread = 0;
      render();
    }
  });
}
