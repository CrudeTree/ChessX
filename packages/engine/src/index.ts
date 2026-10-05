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
 * ChessX v2 rules (6x8 board, Kings only, mana summoning and sealing). Everything above is the
 * original (v1) engine, kept as-is for games already in progress; v2 lives under this namespace.
 */
export * as v2 from './v2/index.js';
