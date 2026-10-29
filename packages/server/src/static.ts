// Where a static request lands inside the built client, kept apart from the server itself so the rule can be tested
// without starting one.

import { join, normalize, sep } from 'node:path';

/**
 * The file a request for `pathname` names inside `clientDist`, or null when it would reach outside it.
 *
 * `normalize` resolves any `..` in the request first, so what is left is a plain path to compare. Containing it means
 * the file is the directory itself or sits under it followed by a separator: a bare `startsWith(dir)` would also let a
 * sibling such as `dist-backup` through, since it shares the `dist` prefix.
 */
export function clientPathFor(clientDist: string, pathname: string): string | null {
  const path = normalize(join(clientDist, decodeURIComponent(pathname)));
  if (path === clientDist || path.startsWith(clientDist + sep)) return path;
  return null;
}
