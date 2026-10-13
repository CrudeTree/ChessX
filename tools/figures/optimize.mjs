// Shrinks the generated models for the web: tools/figures/work/raw/<name>.glb (or work/trimmed/<name>.glb, cut
// off its slab by trim.py) becomes packages/client/public/figures/<name>.glb, listed in figures/index.json beside
// the cut-outs.
//
//     node tools/figures/optimize.mjs [name ...]

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const raw = join(here, 'work', 'raw');
const trimmed = join(here, 'work', 'trimmed');
const out = join(here, '..', '..', 'packages', 'client', 'public', 'figures');
mkdirSync(out, { recursive: true });

const names = process.argv.length > 2
  ? process.argv.slice(2)
  : readdirSync(raw).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4));

for (const name of names) {
  const src = [join(trimmed, `${name}.glb`), join(raw, `${name}.glb`)].find(existsSync);
  if (!src) {
    console.log(`${name}: no model yet`);
    continue;
  }
  const dst = join(out, `${name}.glb`);
  execSync(
    `npx -y @gltf-transform/cli@4 optimize "${src}" "${dst}" --compress meshopt --texture-compress webp ` +
      '--texture-size 1024 --simplify-error 0.001',
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  console.log(`${name}: ${Math.round(statSync(src).size / 1024)} KB -> ${Math.round(statSync(dst).size / 1024)} KB`);
}

// Same as write_index() in figures.py.
const listed = (ext) => readdirSync(out).filter((f) => f.endsWith(`.${ext}`)).map((f) => f.slice(0, -ext.length - 1)).sort();
writeFileSync(join(out, 'index.json'), `${JSON.stringify({ standees: listed('webp'), models: listed('glb') })}\n`);
console.log(`${listed('glb').length} models listed`);
