import { describe, expect, it } from 'vitest';
import { join, sep } from 'node:path';
import { clientPathFor } from '../src/static.js';

const DIST = join('/srv', 'app', 'packages', 'client', 'dist');

describe('static file containment', () => {
  it('serves files inside the built client', () => {
    // A request for the directory itself resolves to it (with a trailing separator on Windows), which the caller then
    // turns into index.html.
    expect(clientPathFor(DIST, '/')).toBe(join(DIST, sep));
    expect(clientPathFor(DIST, '/index.html')).toBe(join(DIST, 'index.html'));
    expect(clientPathFor(DIST, '/assets/index-abc12345.js')).toBe(join(DIST, 'assets', 'index-abc12345.js'));
  });

  it('refuses to climb out with ..', () => {
    for (const attack of ['/../../etc/passwd', '/assets/../../../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
      expect(clientPathFor(DIST, attack), attack).toBeNull();
    }
  });

  it('refuses a sibling directory that merely shares the dist prefix', () => {
    // A bare `startsWith(dist)` check would have allowed this, since '/…/dist-backup' begins with '/…/dist'.
    expect(clientPathFor(DIST, '/../dist-backup/secret.txt')).toBeNull();
    expect(clientPathFor(DIST, '/../dist.bak/secret.txt')).toBeNull();
  });
});
