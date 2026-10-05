import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { Auth, configFromEnv, parseCookieDomain } from '../src/auth.js';
import type { Db, UserRow } from '../src/db.js';

function fakeRes() {
  const headers: Record<string, unknown> = {};
  const res = {
    getHeader: (k: string) => headers[k],
    setHeader: (k: string, v: unknown) => {
      headers[k] = v;
    },
  } as unknown as ServerResponse;
  return { res, cookies: () => (headers['Set-Cookie'] as string[]) ?? [] };
}

const db = { createSession: () => 'tok', deleteSession: () => {} } as unknown as Db;
const user = { id: 'u1' } as UserRow;

describe('COOKIE_DOMAIN', () => {
  it('is off by default: host-only cookie, no Domain attribute', () => {
    const cfg = configFromEnv({ PUBLIC_URL: 'https://playchessx.com' });
    expect(cfg.cookieDomain).toBeUndefined();
    const { res, cookies } = fakeRes();
    new Auth(db, cfg).signIn(res, user);
    expect(cookies()).toHaveLength(1);
    expect(cookies()[0]).not.toContain('Domain=');
  });

  it('adds Domain to the session cookie and clears any old host-only cookie', () => {
    const cfg = configFromEnv({ PUBLIC_URL: 'https://playchessx.com', COOKIE_DOMAIN: '.PlayChessX.com' });
    expect(cfg.cookieDomain).toBe('playchessx.com');
    const { res, cookies } = fakeRes();
    new Auth(db, cfg).signIn(res, user);
    const [set, clearOld] = cookies();
    expect(set).toContain('chessx_session=tok');
    expect(set).toContain('Domain=playchessx.com');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Secure');
    expect(clearOld).toContain('Max-Age=0');
    expect(clearOld).not.toContain('Domain=');
  });

  it('sign-out clears both the host-only and the domain cookie', () => {
    const cfg = configFromEnv({ PUBLIC_URL: 'https://playchessx.com', COOKIE_DOMAIN: 'playchessx.com' });
    const { res, cookies } = fakeRes();
    new Auth(db, cfg).signOut({ headers: { cookie: 'chessx_session=tok' } } as never, res);
    expect(cookies()).toHaveLength(2);
    expect(cookies().every((c) => c.includes('Max-Age=0'))).toBe(true);
    expect(cookies().some((c) => c.includes('Domain=playchessx.com'))).toBe(true);
  });

  it('ignores values that are not a plain hostname', () => {
    for (const bad of ['', 'com', 'a b.com', 'x.com; Path=/evil', 'http://x.com', '-x.com']) {
      expect(parseCookieDomain(bad)).toBeUndefined();
    }
  });
});
