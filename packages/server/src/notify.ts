// Web Push notifications: "your move", "you've been challenged", etc., delivered
// by the browser even when the site is closed. Uses the standard VAPID scheme;
// the key pair is generated once and kept in the database, so no third-party
// service is involved.

import webpush, { WebPushError, type PushSubscription } from 'web-push';
import type { Db } from './db.js';

export interface PushPayload {
  title: string;
  body: string;
  /** Where clicking the notification should take the player. */
  url: string;
  /** Notifications with the same tag replace each other (one per game). */
  tag: string;
}

export class Notifier {
  readonly publicKey: string;
  /** Skip pushing to players who currently have the site open (they see it live). */
  isOnline: (userId: string) => boolean = () => false;

  constructor(
    private db: Db,
    contact: string,
  ) {
    let pub = db.getKv('vapid_public');
    let priv = db.getKv('vapid_private');
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      db.setKv('vapid_public', pub);
      db.setKv('vapid_private', priv);
      console.log('  generated new Web Push (VAPID) keys');
    }
    this.publicKey = pub;
    webpush.setVapidDetails(contact, pub, priv);
  }

  subscribe(userId: string, sub: PushSubscription): void {
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Malformed push subscription.');
    this.db.savePushSubscription(userId, sub.endpoint, JSON.stringify(sub));
  }

  unsubscribe(endpoint: string): void {
    this.db.deletePushSubscription(endpoint);
  }

  /** Send to every device the user has registered. Dead subscriptions are pruned. */
  async push(userId: string, payload: PushPayload, opts: { evenIfOnline?: boolean } = {}): Promise<void> {
    if (!opts.evenIfOnline && this.isOnline(userId)) return;
    const subs = this.db.pushSubscriptionsFor(userId);
    if (!subs.length) return;
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (json) => {
        const sub = JSON.parse(json) as PushSubscription;
        try {
          await webpush.sendNotification(sub, body, { TTL: 60 * 60 * 24, urgency: 'normal' });
        } catch (e) {
          if (e instanceof WebPushError && (e.statusCode === 404 || e.statusCode === 410)) {
            this.db.deletePushSubscription(sub.endpoint); // browser dropped it
          } else {
            console.warn('push failed:', e instanceof Error ? e.message : e);
          }
        }
      }),
    );
  }
}
