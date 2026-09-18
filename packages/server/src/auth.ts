// Accounts and sign-in.
//  - Email + password (scrypt hashed).
//  - Google and Facebook via the standard OAuth 2.0 authorization-code flow,
//    enabled only when their client id/secret env vars are present.
//  - Sessions are random tokens in an HttpOnly cookie; only their hash is stored.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthProviders, UserInfo } from '@chessx/protocol';
import type { Db, UserRow } from './db.js';

export const SESSION_COOKIE = 'chessx_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_COOKIE = 'chessx_oauth';

export interface AuthConfig {
  /** Public origin used to build OAuth redirect URIs, e.g. https://chessx.example.com or http://localhost:5173 */
  publicUrl: string;
  google?: { clientId: string; clientSecret: string };
  facebook?: { appId: string; appSecret: string };
  secureCookies: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv): AuthConfig {
  const publicUrl = (env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/$/, '');
  return {
    publicUrl,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : undefined,
    facebook: env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET ? { appId: env.FACEBOOK_APP_ID, appSecret: env.FACEBOOK_APP_SECRET } : undefined,
    secureCookies: publicUrl.startsWith('https://'),
  };
}

/** Set by the server at startup (see admin.ts); until then nobody is an admin. */
let isAdminUser: (u: UserRow) => boolean = () => false;
let isOwnerUser: (u: UserRow) => boolean = () => false;
export function setAdminCheck(admin: (u: UserRow) => boolean, owner: (u: UserRow) => boolean): void {
  isAdminUser = admin;
  isOwnerUser = owner;
}

export const toUserInfo = (u: UserRow): UserInfo => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatar_url, admin: isAdminUser(u), owner: isOwnerUser(u) });

// ---------------------------------------------------------------------------
// Passwords

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---------------------------------------------------------------------------
// Cookies

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res: ServerResponse, name: string, value: string, opts: { maxAgeSec: number; secure: boolean }): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSec}`,
  ];
  if (opts.secure) parts.push('Secure');
  const existing = res.getHeader('Set-Cookie');
  const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('Set-Cookie', [...list, parts.join('; ')]);
}

export class Auth {
  constructor(
    private db: Db,
    readonly config: AuthConfig,
  ) {}

  providers(): AuthProviders {
    return { google: !!this.config.google, facebook: !!this.config.facebook };
  }

  /** The signed-in user for an HTTP request or WebSocket upgrade, if any. */
  userFromRequest(req: IncomingMessage): UserRow | undefined {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return token ? this.db.userBySession(token) : undefined;
  }

  signIn(res: ServerResponse, user: UserRow): void {
    const token = this.db.createSession(user.id, SESSION_TTL_MS);
    setCookie(res, SESSION_COOKIE, token, { maxAgeSec: SESSION_TTL_MS / 1000, secure: this.config.secureCookies });
  }

  signOut(req: IncomingMessage, res: ServerResponse): void {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) this.db.deleteSession(token);
    setCookie(res, SESSION_COOKIE, '', { maxAgeSec: 0, secure: this.config.secureCookies });
  }

  // ----------------------------------------------------------- email/password

  register(email: string, name: string, password: string): UserRow {
    email = email.trim().toLowerCase();
    name = name.trim().slice(0, 24);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Enter a valid email address.');
    if (name.length < 2) throw new AuthError('Pick a display name (2–24 characters).');
    if (password.length < 8) throw new AuthError('Password must be at least 8 characters.');
    if (this.db.userByEmail(email)) throw new AuthError('An account with that email already exists.');
    return this.db.createUser({ email, name, password_hash: hashPassword(password), google_id: null, facebook_id: null, avatar_url: null });
  }

  login(email: string, password: string): UserRow {
    const user = this.db.userByEmail(email.trim().toLowerCase());
    if (!user?.password_hash || !verifyPassword(password, user.password_hash)) {
      throw new AuthError('Wrong email or password.');
    }
    return user;
  }

  // -------------------------------------------------------------------- OAuth

  private redirectUri(provider: 'google' | 'facebook'): string {
    return `${this.config.publicUrl}/api/auth/${provider}/callback`;
  }

  /** Step 1: send the browser to the provider. */
  beginOAuth(provider: 'google' | 'facebook', res: ServerResponse): void {
    const state = randomBytes(16).toString('hex');
    setCookie(res, OAUTH_STATE_COOKIE, `${provider}:${state}`, { maxAgeSec: 600, secure: this.config.secureCookies });
    let url: string;
    if (provider === 'google') {
      if (!this.config.google) throw new AuthError('Google sign-in is not configured.');
      const q = new URLSearchParams({
        client_id: this.config.google.clientId,
        redirect_uri: this.redirectUri('google'),
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      });
      url = `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    } else {
      if (!this.config.facebook) throw new AuthError('Facebook sign-in is not configured.');
      const q = new URLSearchParams({
        client_id: this.config.facebook.appId,
        redirect_uri: this.redirectUri('facebook'),
        state,
        scope: 'email,public_profile',
      });
      url = `https://www.facebook.com/v19.0/dialog/oauth?${q}`;
    }
    res.writeHead(302, { Location: url });
    res.end();
  }

  /** Step 2: the provider sends the browser back with a code; exchange it and sign the user in. */
  async completeOAuth(provider: 'google' | 'facebook', req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const cookies = parseCookies(req.headers.cookie);
    const expected = cookies[OAUTH_STATE_COOKIE];
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!code || !state || expected !== `${provider}:${state}`) throw new AuthError('Sign-in was interrupted. Please try again.');
    setCookie(res, OAUTH_STATE_COOKIE, '', { maxAgeSec: 0, secure: this.config.secureCookies });

    const profile = provider === 'google' ? await this.googleProfile(code) : await this.facebookProfile(code);

    let user = this.db.userByProvider(provider, profile.id);
    if (!user && profile.email) {
      // Same email already registered with a password: link the provider to it.
      user = this.db.userByEmail(profile.email);
      if (user) this.db.linkProvider(user.id, provider, profile.id, profile.avatarUrl);
    }
    if (!user) {
      user = this.db.createUser({
        email: profile.email,
        name: profile.name.slice(0, 24) || 'Player',
        password_hash: null,
        google_id: provider === 'google' ? profile.id : null,
        facebook_id: provider === 'facebook' ? profile.id : null,
        avatar_url: profile.avatarUrl,
      });
    }
    this.signIn(res, user);
    res.writeHead(302, { Location: '/' });
    res.end();
  }

  private async googleProfile(code: string): Promise<{ id: string; email: string | null; name: string; avatarUrl: string | null }> {
    const g = this.config.google!;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: g.clientId,
        client_secret: g.clientSecret,
        redirect_uri: this.redirectUri('google'),
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new AuthError('Google rejected the sign-in.');
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${access_token}` } });
    if (!infoRes.ok) throw new AuthError('Could not read your Google profile.');
    const info = (await infoRes.json()) as { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
    return {
      id: info.sub,
      email: info.email && info.email_verified !== false ? info.email.toLowerCase() : null,
      name: info.name ?? info.email?.split('@')[0] ?? 'Player',
      avatarUrl: info.picture ?? null,
    };
  }

  private async facebookProfile(code: string): Promise<{ id: string; email: string | null; name: string; avatarUrl: string | null }> {
    const f = this.config.facebook!;
    const q = new URLSearchParams({ client_id: f.appId, client_secret: f.appSecret, redirect_uri: this.redirectUri('facebook'), code });
    const tokenRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${q}`);
    if (!tokenRes.ok) throw new AuthError('Facebook rejected the sign-in.');
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const meRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email,picture.type(large)&access_token=${encodeURIComponent(access_token)}`);
    if (!meRes.ok) throw new AuthError('Could not read your Facebook profile.');
    const me = (await meRes.json()) as { id: string; name?: string; email?: string; picture?: { data?: { url?: string } } };
    return { id: me.id, email: me.email?.toLowerCase() ?? null, name: me.name ?? 'Player', avatarUrl: me.picture?.data?.url ?? null };
  }
}

export class AuthError extends Error {}
