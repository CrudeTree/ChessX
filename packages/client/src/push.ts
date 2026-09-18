// Browser push notifications ("Your move", "Bob challenged you") via the
// service worker. The browser only lets us ask permission from a user gesture,
// so we show a small banner with a button rather than prompting on load.

const DISMISSED_KEY = 'chessx.pushDismissed';

export const pushSupported = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  return reg;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Subscribe this browser and hand the subscription to the server. */
export async function enablePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const reg = await registration();
  const { publicKey } = (await (await fetch('/api/push/vapid', { credentials: 'same-origin' })).json()) as { publicKey: string };
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource }));
  await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });
  return true;
}

/**
 * On each visit: if permission was already granted, make sure the server has
 * this browser's subscription (it can change). Otherwise show the banner,
 * unless the player dismissed it before.
 */
export async function initPush(banner: HTMLElement, enableBtn: HTMLElement, dismissBtn: HTMLElement): Promise<void> {
  if (!pushSupported()) return;
  // Register the worker early so notification clicks can focus this tab.
  registration().catch(() => {});

  if (Notification.permission === 'granted') {
    enablePush().catch(() => {});
    return;
  }
  if (Notification.permission === 'denied' || localStorage.getItem(DISMISSED_KEY)) return;

  banner.classList.remove('hidden');
  enableBtn.onclick = async () => {
    const ok = await enablePush().catch(() => false);
    banner.classList.add('hidden');
    if (!ok) localStorage.setItem(DISMISSED_KEY, '1');
  };
  dismissBtn.onclick = () => {
    banner.classList.add('hidden');
    localStorage.setItem(DISMISSED_KEY, '1');
  };
}

/** Messages from the service worker (notification clicks). */
export function onServiceWorkerMessage(handler: (msg: { type: string; url?: string }) => void): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e) => handler(e.data as { type: string; url?: string }));
}
