// Starts the game server (tsx watch) and the Vite client together.
//
// Deliberately spawns `node` directly instead of going through a shell, so it
// works even when cmd.exe is not resolvable from PATH (which is what
// `concurrently` tripped over on Windows).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = (rel) => {
  const p = join(root, 'node_modules', rel);
  if (!existsSync(p)) {
    console.error(`Missing ${p}. Run "npm install" first.`);
    process.exit(1);
  }
  return p;
};

const tsx = bin('tsx/dist/cli.mjs');
const vite = bin('vite/bin/vite.js');

const RESET = '\x1b[0m';
const children = [];

function run(name, color, args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: process.env.NO_COLOR ? process.env : { ...process.env, FORCE_COLOR: '1' },
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const tag = `${color}[${name}]${RESET} `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(tag + line + '\n');
    });
    stream.on('end', () => buf && out.write(tag + buf + '\n'));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    console.log(`${tag}exited (${signal ?? code})`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      // Kill the whole tree (tsx watch has its own child). Use the absolute
      // path so this also works when System32 is not on PATH.
      const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', '\x1b[34m', [tsx, 'watch', 'src/index.ts'], join(root, 'packages', 'server'));
run('client', '\x1b[35m', [vite], join(root, 'packages', 'client'));
