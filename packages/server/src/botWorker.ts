// The bot's planner on its own thread (see `workerThinker`).

import { v2 } from '@chessx/engine';
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', (msg: { id: number; state: v2.GameState; level: v2.BotLevel; seed: number }) => {
  try {
    parentPort!.postMessage({ id: msg.id, actions: v2.planTurn(msg.state, msg.level, msg.seed) });
  } catch (error) {
    parentPort!.postMessage({ id: msg.id, error: error instanceof Error ? error.message : String(error) });
  }
});
