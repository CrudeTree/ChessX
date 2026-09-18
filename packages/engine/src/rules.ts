import { getCardDef } from './cards/registry.js';
import type { CardInstance, Effect, SummonCardDef, TargetRule } from './cards/types.js';
import { isInCheck, lastRank, pseudoMoves, type MoveCandidate } from './movement.js';
import { getPieceDef } from './pieces.js';
import { cloneState, drawCards, freshTurnInfo, pieceAt, piecesOf, type GameState } from './state.js';
import {
  opposite,
  rankOf,
  squareName,
  type Action,
  type Color,
  type Piece,
  type PromotionKind,
  type Square,
} from './types.js';

export class IllegalActionError extends Error {}

const PROMOTIONS: PromotionKind[] = ['queen', 'rook', 'bishop', 'knight'];

// ---------------------------------------------------------------------------
// Public API

/**
 * Every legal action for `color` (defaults to side to move) at this point in
 * the turn. A turn is a sequence of actions closed by `endTurn`:
 *
 *  - one *major action*: move/attack a piece OR play a summon card,
 *  - any number of spells,
 *  - any number of stance switches (a piece that switched is frozen for the rest of the turn),
 *  - `endTurn`, which is refused while in check or while a draw is owed.
 *
 * Moves may never leave your own king in check. Cards and stance changes
 * cannot expose your king, so they are not filtered.
 */
export function legalActions(state: GameState, color: Color = state.turn): Action[] {
  if (state.status.kind !== 'playing' || color !== state.turn) return [];
  // The draw phase comes first: while a draw is owed nothing else is allowed.
  if (state.players[color].pendingDraws > 0) return [{ type: 'draw' }];

  const out: Action[] = [];
  const inCheck = isInCheck(state, color);
  const { majorAction, stanceChanged } = state.turnInfo;
  const frozen = new Set(stanceChanged);

  if (majorAction === null) {
    for (const piece of piecesOf(state, color)) {
      if (frozen.has(piece.id)) continue;
      for (const cand of pseudoMoves(state, piece)) {
        const moves: Action[] = cand.promotion
          ? PROMOTIONS.map((promotion) => ({ type: 'move', from: cand.from, to: cand.to, promotion }))
          : [{ type: 'move', from: cand.from, to: cand.to }];
        for (const m of moves) if (leavesKingSafe(state, m, color)) out.push(m);
      }
    }
  }

  for (const inst of state.players[color].hand) {
    const card = getCardDef(inst.cardId);
    // Summoning is the major action, and while in check the move must stay available.
    if (card.type === 'summon' && (majorAction !== null || inCheck)) continue;
    for (const target of cardTargets(state, inst, color)) {
      out.push({ type: 'playCard', cardInstanceId: inst.instanceId, target });
    }
  }

  for (const piece of piecesOf(state, color)) {
    if (canChangeStance(piece) && !frozen.has(piece.id)) {
      out.push({ type: 'setStance', square: piece.square, stance: piece.stance === 'attack' ? 'defense' : 'attack' });
    }
  }

  if (!inCheck) out.push({ type: 'endTurn' });
  return out;
}

export function legalMoves(state: GameState, color: Color = state.turn): Extract<Action, { type: 'move' }>[] {
  return legalActions(state, color).filter((a): a is Extract<Action, { type: 'move' }> => a.type === 'move');
}

/**
 * Apply an action for the side to move and return the new state. Throws
 * IllegalActionError if the action is not legal. The input is not mutated.
 */
export function applyAction(state: GameState, action: Action): GameState {
  if (state.status.kind !== 'playing') throw new IllegalActionError('Game is over.');
  const next = cloneState(state);
  next.events = [];
  next.seq++;
  const color = next.turn;
  const player = next.players[color];

  switch (action.type) {
    case 'resign':
      next.status = { kind: 'resigned', winner: opposite(color) };
      next.events.push({ type: 'gameOver', status: next.status });
      return next;

    case 'draw':
      if (player.pendingDraws <= 0) throw new IllegalActionError('You have no card to draw right now.');
      player.pendingDraws--;
      drawCards(next, color, 1);
      // Once the draw phase is over we know whether the player is mated.
      if (player.pendingDraws === 0) evaluateMate(next);
      return next;

    case 'endTurn':
      if (player.pendingDraws > 0) throw new IllegalActionError('Draw a card first (click your deck).');
      if (isInCheck(next, color)) throw new IllegalActionError('You cannot end your turn while in check.');
      endTurn(next);
      return next;

    default:
      break;
  }

  if (player.pendingDraws > 0) throw new IllegalActionError('Draw a card first (click your deck).');

  // Turn-structure limits.
  if (action.type === 'move' && next.turnInfo.majorAction !== null) {
    throw new IllegalActionError(
      next.turnInfo.majorAction === 'summon' ? 'You already summoned this turn, so you cannot move a piece.' : 'You already moved this turn.',
    );
  }
  if (action.type === 'playCard') {
    const inst = player.hand.find((c) => c.instanceId === action.cardInstanceId);
    if (inst && getCardDef(inst.cardId).type === 'summon') {
      if (next.turnInfo.majorAction !== null) {
        throw new IllegalActionError(
          next.turnInfo.majorAction === 'move' ? 'You already moved this turn, so you cannot summon.' : 'Only one summon per turn.',
        );
      }
      if (isInCheck(next, color)) throw new IllegalActionError('You cannot summon while in check.');
    }
  }
  if ((action.type === 'move' || action.type === 'setStance') && isFrozenThisTurn(next, action.type === 'move' ? action.from : action.square)) {
    throw new IllegalActionError('That piece changed stance this turn and cannot act again until your next turn.');
  }

  performAction(next, action, color); // throws a descriptive IllegalActionError if malformed

  if (action.type === 'move' && !kingSafe(next, color)) {
    throw new IllegalActionError(
      isInCheck(state, color) ? 'You must get your King out of check.' : 'That would leave your King in check.',
    );
  }

  if (next.status.kind !== 'playing') next.events.push({ type: 'gameOver', status: next.status });
  return next;
}

function isFrozenThisTurn(state: GameState, square: Square): boolean {
  const id = state.board[square];
  return !!id && state.turnInfo.stanceChanged.includes(id);
}

/** Kings have no HP so Defense mode is meaningless for them; sacrifices are frozen. */
export function canChangeStance(piece: Piece): boolean {
  return piece.kind !== 'king' && !piece.summon;
}

/** Squares a card may target (or [undefined] for untargeted cards). Empty if unplayable. */
export function cardTargets(state: GameState, inst: CardInstance, color: Color): (Square | undefined)[] {
  const card = getCardDef(inst.cardId);
  if (card.type === 'summon') {
    const needTier = card.sacrificeTier ?? card.tier - 1;
    return piecesOf(state, color)
      .filter((p) => p.kind !== 'king' && !p.summon && getPieceDef(p.kind).tier === needTier)
      .map((p) => p.square);
  }
  if (card.target === 'none') return [undefined];
  return Object.values(state.pieces)
    .filter((p) => matchesTarget(p, card.target, color, card.allowKing ?? false))
    .map((p) => p.square);
}

function matchesTarget(p: Piece, rule: TargetRule, color: Color, allowKing: boolean): boolean {
  if (p.kind === 'king' && !allowKing) return false;
  switch (rule) {
    case 'none':
      return false;
    case 'ownPiece':
      return p.owner === color;
    case 'enemyPiece':
      return p.owner !== color;
    case 'anyPiece':
      return true;
    case 'ownSummoning':
      return p.owner === color && !!p.summon;
    case 'ownDefending':
      return p.owner === color && p.stance === 'defense' && !p.summon;
  }
}

function leavesKingSafe(state: GameState, action: Action, color: Color): boolean {
  if (action.type === 'resign') return true;
  const sim = cloneState(state);
  try {
    performAction(sim, action, color);
  } catch (e) {
    if (e instanceof IllegalActionError) return false;
    throw e;
  }
  return kingSafe(sim, color);
}

/** After `color` has acted: did they capture the enemy king, or at least leave their own king out of check? */
function kingSafe(after: GameState, color: Color): boolean {
  if (after.status.kind === 'kingCaptured') return after.status.winner === color;
  return !isInCheck(after, color);
}

// ---------------------------------------------------------------------------
// Performing actions (mutates the given state, no end-of-turn processing)

function performAction(state: GameState, action: Action, color: Color): void {
  switch (action.type) {
    case 'move':
      performMove(state, action, color);
      break;
    case 'playCard':
      performCard(state, action, color);
      break;
    case 'setStance':
      performStance(state, action, color);
      break;
    case 'draw':
    case 'endTurn':
    case 'resign':
      break; // handled in applyAction
  }
}

/**
 * Switching stance is free (any number per turn), but the piece is frozen for
 * the rest of the turn. A piece in Defense mode cannot move or attack until it
 * is switched back to Attack mode.
 */
function performStance(state: GameState, action: Extract<Action, { type: 'setStance' }>, color: Color): void {
  const piece = pieceAt(state, action.square);
  if (!piece) throw new IllegalActionError(`No piece on ${squareName(action.square)}.`);
  if (piece.owner !== color) throw new IllegalActionError('That is not your piece.');
  if (!canChangeStance(piece)) throw new IllegalActionError(`${getPieceDef(piece.kind).name} cannot change stance.`);
  if (piece.stance === action.stance) throw new IllegalActionError(`Already in ${action.stance} mode.`);

  piece.stance = action.stance;
  state.turnInfo.stanceChanged.push(piece.id);
  state.events.push({ type: 'stanceChanged', pieceId: piece.id, square: piece.square, stance: piece.stance });
}

function performMove(state: GameState, action: Extract<Action, { type: 'move' }>, color: Color): void {
  const piece = pieceAt(state, action.from);
  if (!piece) throw new IllegalActionError(`No piece on ${squareName(action.from)}.`);
  if (piece.owner !== color) throw new IllegalActionError('That is not your piece.');
  if (piece.summon) throw new IllegalActionError('A piece being sacrificed cannot move.');
  if (piece.stance === 'defense') throw new IllegalActionError('A piece in Defense mode cannot move or attack.');
  const cand = pseudoMoves(state, piece).find((c) => c.to === action.to);
  if (!cand) throw new IllegalActionError(`${getPieceDef(piece.kind).name} cannot move to ${squareName(action.to)}.`);
  if (action.promotion && !cand.promotion) throw new IllegalActionError('Promotion not available for this move.');

  piece.hasMoved = true;
  state.turnInfo.majorAction = 'move';

  switch (cand.kind) {
    case 'move': {
      movePiece(state, piece, cand.to);
      if (piece.kind === 'pawn' && Math.abs(cand.to - cand.from) === 16) {
        state.turnInfo.enPassant = (cand.from + cand.to) / 2;
      }
      if (cand.promotion) promote(state, piece, action.promotion ?? 'queen');
      break;
    }
    case 'castle': {
      const rook = pieceAt(state, cand.rookFrom!)!;
      movePiece(state, piece, cand.to, true);
      movePiece(state, rook, cand.rookTo!, true);
      rook.hasMoved = true;
      break;
    }
    case 'attack':
    case 'enPassant': {
      const target = pieceAt(state, cand.captureSquare ?? cand.to)!;
      attack(state, piece, target, cand);
      break;
    }
  }
}

/**
 * Combat. The attacker deals its ATK. If the defender is in Defense mode its
 * DEF shield absorbs damage first, then HP takes the rest. If HP drops to 0
 * the defender is destroyed and the attacker takes its square; otherwise the
 * attacker stays where it was. The King is the exception: any hit captures it.
 */
function attack(state: GameState, attacker: Piece, target: Piece, cand: MoveCandidate): void {
  if (target.kind === 'king') {
    state.events.push({ type: 'kingCaptured', owner: target.owner, square: target.square });
    removePiece(state, target);
    movePiece(state, attacker, cand.to);
    state.status = { kind: 'kingCaptured', winner: attacker.owner };
    return;
  }

  state.events.push({
    type: 'attacked',
    attackerId: attacker.id,
    targetId: target.id,
    from: attacker.square,
    to: target.square,
    damage: attacker.atk,
  });
  const destroyed = dealDamage(state, target, attacker.atk);

  if (destroyed) {
    movePiece(state, attacker, cand.to);
    if (cand.promotion) promote(state, attacker, 'queen');
  } else {
    state.events.push({ type: 'repelled', pieceId: attacker.id, square: attacker.square });
  }
}

/** Apply `amount` damage (shield first if in Defense mode). Returns true if the piece was destroyed. */
function dealDamage(state: GameState, target: Piece, amount: number): boolean {
  const shield = target.stance === 'defense' ? Math.min(target.def, amount) : 0;
  target.def -= shield;
  target.hp -= amount - shield;
  state.events.push({
    type: 'damaged',
    pieceId: target.id,
    square: target.square,
    amount,
    shield,
    hp: Math.max(0, target.hp),
    def: target.def,
  });
  if (target.hp <= 0) {
    destroyPiece(state, target);
    return true;
  }
  return false;
}

function movePiece(state: GameState, piece: Piece, to: Square, castle = false): void {
  const from = piece.square;
  state.board[from] = null;
  state.board[to] = piece.id;
  piece.square = to;
  state.events.push({ type: 'moved', pieceId: piece.id, from, to, castle: castle || undefined });
}

function promote(state: GameState, pawn: Piece, to: PromotionKind): void {
  if (rankOf(pawn.square) !== lastRank(pawn.owner)) return;
  pawn.kind = to;
  state.events.push({ type: 'promoted', pieceId: pawn.id, square: pawn.square, to });
}

function removePiece(state: GameState, piece: Piece): void {
  state.board[piece.square] = null;
  delete state.pieces[piece.id];
}

/** Destroy a piece. If it was being sacrificed, the pending summon fails and its card is destroyed. */
function destroyPiece(state: GameState, piece: Piece): void {
  state.events.push({ type: 'destroyed', pieceId: piece.id, kind: piece.kind, owner: piece.owner, square: piece.square });
  if (piece.summon) {
    state.players[piece.owner].graveyard.push({ instanceId: piece.summon.cardInstanceId, cardId: piece.summon.cardId });
    state.events.push({ type: 'summonFailed', color: piece.owner, cardId: piece.summon.cardId, square: piece.square });
  }
  removePiece(state, piece);
}

// ---------------------------------------------------------------------------
// Cards

function performCard(state: GameState, action: Extract<Action, { type: 'playCard' }>, color: Color): void {
  const player = state.players[color];
  const idx = player.hand.findIndex((c) => c.instanceId === action.cardInstanceId);
  if (idx < 0) throw new IllegalActionError('That card is not in your hand.');
  const inst = player.hand[idx]!;
  const card = getCardDef(inst.cardId);

  const validTargets = cardTargets(state, inst, color);
  if (!validTargets.includes(action.target)) {
    throw new IllegalActionError(
      action.target === undefined ? `${card.name} needs a target.` : `${card.name} cannot target ${squareName(action.target)}.`,
    );
  }

  player.hand.splice(idx, 1);
  state.events.push({ type: 'cardPlayed', color, cardId: card.id, target: action.target });

  if (card.type === 'summon') {
    state.turnInfo.majorAction = 'summon';
    beginSummon(state, card, inst, pieceAt(state, action.target!)!);
  } else {
    const target = action.target === undefined ? undefined : pieceAt(state, action.target);
    for (const effect of card.effects) applyEffect(state, effect, color, target);
    player.graveyard.push(inst);
  }
}

function beginSummon(state: GameState, card: SummonCardDef, inst: CardInstance, sacrifice: Piece): void {
  sacrifice.summon = { cardInstanceId: inst.instanceId, cardId: card.id, turnsRemaining: card.summonTurns };
  state.events.push({ type: 'summonStarted', color: sacrifice.owner, cardId: card.id, square: sacrifice.square, turns: card.summonTurns });
}

function resolveSummon(state: GameState, sacrifice: Piece): void {
  const pending = sacrifice.summon!;
  const card = getCardDef(pending.cardId) as SummonCardDef;
  const owner = sacrifice.owner;
  const square = sacrifice.square;
  removePiece(state, sacrifice);

  const def = card.piece;
  const summoned: Piece = {
    id: `p${state.nextId++}`,
    kind: def.kind,
    owner,
    square,
    atk: def.atk,
    def: def.def,
    maxDef: def.def,
    hp: def.hp,
    maxHp: def.hp,
    hasMoved: true,
    stance: 'attack',
  };
  state.pieces[summoned.id] = summoned;
  state.board[square] = summoned.id;
  state.players[owner].graveyard.push({ instanceId: pending.cardInstanceId, cardId: pending.cardId });
  state.events.push({ type: 'summoned', color: owner, cardId: card.id, pieceId: summoned.id, square });
}

function modifyStats(state: GameState, target: Piece, delta: { atk?: number; def?: number; hp?: number }): void {
  target.atk = Math.max(0, target.atk + (delta.atk ?? 0));
  if (delta.def) {
    target.maxDef = Math.max(0, target.maxDef + delta.def);
    target.def = Math.min(target.maxDef, Math.max(0, target.def + delta.def));
  }
  if (target.kind !== 'king' && delta.hp) {
    target.maxHp = Math.max(1, target.maxHp + delta.hp);
    target.hp = Math.min(target.maxHp, Math.max(1, target.hp + delta.hp));
  }
  emitStats(state, target);
}

function applyEffect(state: GameState, effect: Effect, color: Color, target: Piece | undefined): void {
  switch (effect.kind) {
    case 'modifyStats': {
      if (target) modifyStats(state, target, effect);
      return;
    }
    case 'modifyStatsAll': {
      for (const p of piecesOf(state, color)) {
        if (p.kind === 'king') continue;
        if (effect.pieceKind && p.kind !== effect.pieceKind) continue;
        modifyStats(state, p, effect);
      }
      return;
    }
    case 'restore': {
      if (!target || target.kind === 'king') return;
      target.hp = target.maxHp;
      target.def = target.maxDef;
      emitStats(state, target);
      return;
    }
    case 'freeStance': {
      if (!target || target.kind === 'king' || target.summon) return;
      target.stance = 'attack';
      // The piece may still act this turn: not frozen, even if it switched earlier this turn.
      state.turnInfo.stanceChanged = state.turnInfo.stanceChanged.filter((id) => id !== target.id);
      state.events.push({ type: 'stanceChanged', pieceId: target.id, square: target.square, stance: 'attack' });
      return;
    }
    case 'damage': {
      if (!target || target.kind === 'king') return;
      dealDamage(state, target, effect.amount);
      return;
    }
    case 'heal': {
      if (!target || target.kind === 'king') return;
      target.hp = Math.min(target.maxHp, target.hp + effect.amount);
      emitStats(state, target);
      return;
    }
    case 'draw': {
      drawCards(state, color, effect.count);
      return;
    }
    case 'hastenSummon': {
      if (!target?.summon) return;
      target.summon.turnsRemaining -= effect.turns;
      if (target.summon.turnsRemaining <= 0) resolveSummon(state, target);
      else state.events.push({ type: 'summonTick', square: target.square, turnsRemaining: target.summon.turnsRemaining });
      return;
    }
  }
}

function emitStats(state: GameState, p: Piece): void {
  state.events.push({ type: 'statsChanged', pieceId: p.id, square: p.square, atk: p.atk, def: p.def, hp: p.hp, maxHp: p.maxHp });
}

// ---------------------------------------------------------------------------
// Turn flow

/**
 * Hand the turn over. At the start of the new player's turn:
 *  1. their pending summon timers tick down (resolving at 0),
 *  2. on every `drawEvery`th turn the draw timer completes and they owe a draw
 *     (taken by clicking the deck; nothing else is legal until then),
 *  3. check / checkmate is evaluated (after the draw, if one is owed, since the
 *     drawn card might be the answer to check).
 */
function endTurn(state: GameState): void {
  state.events.push({ type: 'turnEnded', color: state.turn });
  // A double pawn push this turn is capturable en passant during the opponent's turn only.
  state.enPassant = state.turnInfo.enPassant;
  state.turnInfo = freshTurnInfo();

  state.turn = opposite(state.turn);
  state.ply++;
  const color = state.turn;
  const player = state.players[color];
  player.turnsTaken++;

  for (const piece of piecesOf(state, color)) {
    if (!piece.summon) continue;
    piece.summon.turnsRemaining--;
    if (piece.summon.turnsRemaining <= 0) resolveSummon(state, piece);
    else state.events.push({ type: 'summonTick', square: piece.square, turnsRemaining: piece.summon.turnsRemaining });
  }

  if (player.turnsTaken % state.rules.drawEvery === 0 && player.deck.length > 0) {
    player.pendingDraws++;
    state.events.push({ type: 'drawReady', color });
  }

  if (isInCheck(state, color)) state.events.push({ type: 'check', color });
  if (player.pendingDraws === 0) evaluateMate(state);
}

/**
 * Checkmate: the side to move is in check and no single legal action gets the
 * king out of it. (Passing is allowed when not in check, so there is no stalemate.)
 */
function evaluateMate(state: GameState): void {
  const color = state.turn;
  if (!isInCheck(state, color)) return;
  for (const action of legalActions(state, color)) {
    if (action.type === 'endTurn' || action.type === 'draw' || action.type === 'resign') continue;
    if (leavesKingSafe(state, action, color)) return; // an escape exists
  }
  state.status = { kind: 'checkmate', winner: opposite(color) };
  state.events.push({ type: 'gameOver', status: state.status });
}
