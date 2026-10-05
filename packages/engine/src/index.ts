export * from './types.js';
export * from './pieces.js';
export * from './cards/types.js';
export * from './cards/registry.js';
export * from './cards/catalog.js';
export * from './state.js';
export * from './movement.js';
export * from './rules.js';
export * from './view.js';
export * from './balance.js';
export * from './arena.js';

/**
 * ChessX v2 rules (8x8 board, Kings only, mana summoning and sealing). This is the live game.
 * Everything above is the deprecated v1 engine, kept only so games already in progress and the
 * card-editor arena can still load.
 */
export * as v2 from './v2/index.js';
