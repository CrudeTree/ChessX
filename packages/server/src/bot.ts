// Plans the computer's turns in games against the bot.

import { v2 } from '@chessx/engine';
import { Worker } from 'node:worker_threads';

export interface BotThinker {
  plan(state: v2.GameState, level: v2.BotLevel, seed: number): Promise<v2.Action[]>;
}

/** Plans on this thread: in tests, and when no worker can run. */
export const inlineThinker: BotThinker = {
  plan: async (state, level, seed) => v2.planTurn(state, level, seed),
};

interface Job {
  resolve: (actions: v2.Action[]) => void;
  reject: (error: Error) => void;
}

/**
 * Plans on a worker thread, so a long think never holds up the other games. If the worker cannot start, or stops,
 * the plan is made on this thread instead.
 */
export function workerThinker(): BotThinker {
  let worker: Worker | null = null;
  let broken = false;
  let nextId = 0;
  const jobs = new Map<number, Job>();
  const failAll = (error: Error): void => {
    for (const job of jobs.values()) job.reject(error);
    jobs.clear();
  };
  const start = (): Worker | null => {
    if (worker || broken) return worker;
    try {
      const w = new Worker(new URL('./botWorker.ts', import.meta.url));
      w.unref();
      w.on('message', (msg: { id: number; actions?: v2.Action[]; error?: string }) => {
        const job = jobs.get(msg.id);
        jobs.delete(msg.id);
        if (msg.actions) job?.resolve(msg.actions);
        else job?.reject(new Error(msg.error ?? 'The bot could not plan.'));
      });
      w.on('error', (error) => {
        console.error('[bot] worker failed; planning on the main thread from now on', error);
        broken = true;
        worker = null;
        failAll(error);
      });
      w.on('exit', () => {
        worker = null;
        failAll(new Error('The bot worker stopped.'));
      });
      worker = w;
    } catch (error) {
      console.error('[bot] no worker; planning on the main thread', error);
      broken = true;
    }
    return worker;
  };
  return {
    async plan(state, level, seed) {
      const w = start();
      if (!w) return inlineThinker.plan(state, level, seed);
      const id = nextId++;
      try {
        return await new Promise<v2.Action[]>((resolve, reject) => {
          jobs.set(id, { resolve, reject });
          w.postMessage({ id, state, level, seed });
        });
      } catch {
        return inlineThinker.plan(state, level, seed);
      }
    },
  };
}
