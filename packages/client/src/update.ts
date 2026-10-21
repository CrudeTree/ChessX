// A tab left open keeps running the code it loaded, however many deploys go by (on a phone, for days). This notices a
// newer build on the server and loads it when that costs nothing: on coming back to the tab, or on going to a screen.

declare const __BUILD_ID__: string;

const CHECK_MS = 5 * 60_000;
/** The build this tab last reloaded for: if the reload still brought the old page, it does not try again. */
const RELOADED_KEY = 'chessx.reloadedFor';

let newer: string | null = null;

async function check(): Promise<void> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    const { build } = (await res.json()) as { build?: unknown };
    if (typeof build === 'string' && build !== __BUILD_ID__) newer = build;
  } catch {
    // Offline, or mid-deploy: the next check will do.
  }
}

/** A newer build is on the server, and this tab has not already reloaded for it. */
export function updateWaiting(): boolean {
  return newer !== null && sessionStorage.getItem(RELOADED_KEY) !== newer;
}

/** Load the newer build: at `path`, the screen being gone to, or else the page as it is. */
export function loadUpdate(path?: string): void {
  if (!newer) return;
  sessionStorage.setItem(RELOADED_KEY, newer);
  if (path) location.assign(path);
  else location.reload();
}

export function watchForUpdates(): void {
  if (__BUILD_ID__ === 'dev') return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    void check().then(() => {
      if (updateWaiting()) loadUpdate();
    });
  });
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void check();
  }, CHECK_MS);
}
