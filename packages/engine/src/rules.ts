import { getCardDef } from './cards/registry.js';
import type { CardInstance, Effect, SummonCardDef, TargetRule } from './cards/types.js';
import { isInCheck, lastRank, pseudoMoves, type MoveCandidate } from './movement.js';
import { getPieceDef, REGENT, SOVEREIGN } from './pieces.js';
import { shuffleInPlace } from './rng.js';
import { addPiece, cloneState, drawCards, findKing, freshTurnInfo, manaFrom, pieceAt, piecesOf, stormAt, type GameState } from './state.js';
import {
  fileOf,
  inBounds,
  opposite,
  rankOf,
  sq,
  squareName,
  type Action,
  type Color,
  type Piece,
  type PieceAbility,
  type PromotionKind,
  type Square,
} from './types.js';

export class IllegalActionError extends Error {}

const PROMOTIONS: PromotionKind[] = ['queen', 'rook', 'bishop', 'knight'];

// ---------------------------------------------------------------------------
// Public API

/**
 * Every legal action for `color` (defaults to side to move) at this point in
 * the turn. A turn has phases:
 *
 *  1. Draw — if the draw timer completed, the only legal action is `draw`.
 *  2. Main — play any number of cards (summons or spells) you have the mana for,
 *     switch any pieces' stance (a piece that switched is frozen for the turn),
 *     and use creature board abilities (once per turn unless the ability says otherwise).
 *  3. Move — move or attack with one piece. The move ends the turn automatically.
 *
 * `endTurn` is only a *pass*: legal when you have no legal move at all (and are
 * not in check — with no move and no card that helps, that is checkmate).
 *
 * Moves may never leave your own king in check. Cards, stance changes and
 * abilities cannot expose your king, so they are not filtered.
 */
export function legalActions(state: GameState, color: Color = state.turn): Action[] {
  if (state.status.kind !== 'playing' || color !== state.turn) return [];
  // The draw phase comes first: while a draw is owed nothing else is allowed.
  if (state.players[color].pendingDraws > 0) return [{ type: 'draw' }];
  if (state.pendingGrant) return grantChoiceActions(state);

  const out: Action[] = [];
  const inCheck = isInCheck(state, color);
  const frozen = new Set(state.turnInfo.stanceChanged);
  let canMove = false;

  for (const piece of piecesOf(state, color)) {
    if (frozen.has(piece.id)) continue;
    for (const cand of pseudoMoves(state, piece)) {
      const moves: Action[] = cand.promotion
        ? PROMOTIONS.map((promotion) => ({ type: 'move', from: cand.from, to: cand.to, promotion }))
        : [{ type: 'move', from: cand.from, to: cand.to }];
      for (const m of moves) {
        if (leavesKingSafe(state, m, color)) {
          out.push(m);
          canMove = true;
        }
      }
    }
  }

  for (const inst of state.players[color].hand) {
    const card = getCardDef(inst.cardId);
    if (card.cost > state.players[color].mana) continue;
    if (card.type === 'spell' && card.firstTurnOnly && state.players[color].turnsTaken !== 1) continue;
    if (card.type === 'spell' && card.effects.some((e) => e.kind === 'schism') && !canPlaySchism(state, color)) continue;
    if (card.type === 'spell' && card.effects.some((e) => e.kind === 'swap')) {
      const squares = cardTargets(state, inst, color).filter((t): t is Square => t !== undefined);
      for (const a of squares) {
        for (const b of squares) {
          if (a === b) continue;
          out.push({ type: 'playCard', cardInstanceId: inst.instanceId, target: a, target2: b });
        }
      }
      continue;
    }
    for (const target of cardTargets(state, inst, color)) {
      out.push({ type: 'playCard', cardInstanceId: inst.instanceId, target });
    }
  }

  for (const piece of piecesOf(state, color)) {
    if (canChangeStance(piece) && !frozen.has(piece.id)) {
      out.push({ type: 'setStance', square: piece.square, stance: 'attack' });
    }
  }

  for (const piece of piecesOf(state, color)) {
    if (piece.summon || frozen.has(piece.id)) continue;
    const abilities = getPieceDef(piece.kind).abilities ?? [];
    for (let i = 0; i < abilities.length; i++) {
      const ability = abilities[i]!;
      if (abilityLocksTurn(ability) && state.turnInfo.abilitiesUsed.includes(piece.id)) continue;
      if (ability.kind === 'stormCloud') {
        const cost = ability.manaCost ?? 50;
        if (state.players[color].mana < cost) continue;
        for (let to = 0; to < 64; to++) {
          out.push(abilities.length > 1 ? { type: 'useAbility', from: piece.square, to, index: i } : { type: 'useAbility', from: piece.square, to });
        }
        continue;
      }
      for (const n of neighborsOf(piece.square)) {
        const target = pieceAt(state, n);
        if (!target || !matchesAbilityTarget(piece, target, ability)) continue;
        out.push(abilities.length > 1 ? { type: 'useAbility', from: piece.square, to: n, index: i } : { type: 'useAbility', from: piece.square, to: n });
      }
    }
  }

  // A turn ends with a move. Only when no move exists at all may the turn be passed.
  if (!inCheck && !canMove) out.push({ type: 'endTurn' });
  return out;
}

/** Why `endTurn` (passing) is not allowed right now, for error messages. */
function endTurnBlocker(state: GameState, color: Color): string | null {
  if (state.players[color].pendingDraws > 0) return 'Draw a card first (click your deck).';
  if (isInCheck(state, color)) return 'You cannot end your turn while in check.';
  if (legalActions(state, color).some((a) => a.type === 'move')) return 'Move a piece to end your turn.';
  return null;
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

    case 'endTurn': {
      const blocker = endTurnBlocker(next, color);
      if (blocker) throw new IllegalActionError(blocker);
      endTurn(next);
      return next;
    }

    default:
      break;
  }

  if (player.pendingDraws > 0) throw new IllegalActionError('Draw a card first (click your deck).');
  if (next.pendingGrant && action.type !== 'useAbility') {
    throw new IllegalActionError('Choose which adjacent piece receives the grant.');
  }

  if (action.type === 'playCard') {
    const inst = player.hand.find((c) => c.instanceId === action.cardInstanceId);
    if (inst && getCardDef(inst.cardId).cost > player.mana) {
      const card = getCardDef(inst.cardId);
      throw new IllegalActionError(`Not enough mana: ${card.name} costs ${card.cost}, you have ${player.mana}.`);
    }
  }
  const frozenSquare =
    action.type === 'move' || action.type === 'useAbility' ? action.from
    : action.type === 'setStance' ? action.square
    : undefined;
  if (frozenSquare !== undefined && isFrozenThisTurn(next, frozenSquare)) {
    throw new IllegalActionError('That piece changed stance this turn and cannot act again until your next turn.');
  }

  performAction(next, action, color); // throws a descriptive IllegalActionError if malformed

  if (action.type === 'move') {
    if (!kingSafe(next, color)) {
      throw new IllegalActionError(
        isInCheck(state, color) ? 'You must get your King out of check.' : 'That would leave your King in check.',
      );
    }
    // The move is the last thing you do: it ends the turn (unless it ended the game).
    if (next.status.kind === 'playing') endTurn(next);
  }

  if (next.status.kind !== 'playing' && !next.events.some((e) => e.type === 'gameOver')) {
    next.events.push({ type: 'gameOver', status: next.status });
  }
  return next;
}

function isFrozenThisTurn(state: GameState, square: Square): boolean {
  const id = state.board[square];
  return !!id && state.turnInfo.stanceChanged.includes(id);
}

/** Only a piece that is actually in Defense can leave it. */
export function canChangeStance(piece: Piece): boolean {
  return piece.kind !== 'king' && !piece.summon && piece.stance === 'defense' && piece.defense > 0;
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
  if (card.effects.some((e) => e.kind === 'swap')) {
    return Object.values(state.pieces).map((p) => p.square);
  }
  if (card.effects.some((e) => e.kind === 'spawnPawn')) {
    return emptyBackRankSquares(state, color);
  }
  if (card.effects.some((e) => e.kind === 'castlePush')) {
    return castlePushSquares(state, color);
  }
  if (card.target === 'none') return [undefined];
  return Object.values(state.pieces)
    .filter((p) => matchesTarget(p, card.target, color, card.allowKing ?? false))
    .filter((p) => card.targetTier === undefined || getPieceDef(p.kind).tier === card.targetTier)
    .map((p) => p.square);
}

function ownBackRank(color: Color): number {
  return color === 'white' ? 0 : 7;
}

export function emptyBackRankSquares(state: GameState, color: Color): Square[] {
  const rank = ownBackRank(color);
  const out: Square[] = [];
  for (let file = 0; file < 8; file++) {
    const square = sq(file, rank);
    if (!pieceAt(state, square)) out.push(square);
  }
  return out;
}

/** King on the c- or g-file of its back rank after moving — the usual castle seats. */
function isCastled(state: GameState, color: Color): boolean {
  const king = findKing(state, color);
  if (!king || !king.hasMoved) return false;
  if (rankOf(king.square) !== ownBackRank(color)) return false;
  const f = fileOf(king.square);
  return f === 2 || f === 6;
}

function pawnForward(pawn: Piece): Square | undefined {
  const f = fileOf(pawn.square);
  const r = rankOf(pawn.square) + (pawn.owner === 'white' ? 1 : -1);
  if (!inBounds(f, r)) return undefined;
  return sq(f, r);
}

export function castlePushSquares(state: GameState, color: Color): Square[] {
  const enemy = opposite(color);
  if (!isCastled(state, enemy)) return [];
  const king = findKing(state, enemy)!;
  const out: Square[] = [];
  for (const n of neighborsOf(king.square)) {
    const pawn = pieceAt(state, n);
    if (!pawn || pawn.kind !== 'pawn') continue;
    const ahead = pawnForward(pawn);
    if (ahead === undefined || pieceAt(state, ahead)) continue;
    out.push(pawn.square);
  }
  return out;
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
      return p.owner === color && p.defense > 0 && !p.summon;
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
    case 'useAbility':
      performAbility(state, action, color);
      break;
    case 'draw':
    case 'endTurn':
    case 'resign':
      break; // handled in applyAction
  }
}

/**
 * Leave Defense: drop all charges. The piece skips the rest of this turn
 * (and cannot re-enter Defense except by a grant).
 */
function performStance(state: GameState, action: Extract<Action, { type: 'setStance' }>, color: Color): void {
  const piece = pieceAt(state, action.square);
  if (!piece) throw new IllegalActionError(`No piece on ${squareName(action.square)}.`);
  if (piece.owner !== color) throw new IllegalActionError('That is not your piece.');
  if (!canChangeStance(piece)) throw new IllegalActionError(`${getPieceDef(piece.kind).name} cannot leave Defense.`);
  if (action.stance !== 'attack') throw new IllegalActionError('Pieces cannot enter Defense on their own.');
  leaveDefense(state, piece, true);
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
 * Combat is one hit. The King always captures. Otherwise Defense is destroyed
 * and the attacker bounces; no Defense means the target dies. Being broken by
 * an attack does not skip the defender's next turn — only leaving Defense
 * yourself does that.
 */
function attack(state: GameState, attacker: Piece, target: Piece, cand: MoveCandidate): void {
  if (target.kind === 'king') {
    state.events.push({ type: 'kingCaptured', owner: target.owner, square: target.square });
    removePiece(state, target);
    movePiece(state, attacker, cand.to);
    state.status = { kind: 'kingCaptured', winner: attacker.owner };
    return;
  }

  const execution = attacker.kind === 'king';
  state.events.push({
    type: 'attacked',
    attackerId: attacker.id,
    targetId: target.id,
    from: attacker.square,
    to: target.square,
    execution: execution || undefined,
  });

  if (!execution && target.defense > 0) {
    absorbDefense(state, target);
    state.events.push({ type: 'repelled', pieceId: attacker.id, square: attacker.square });
    return;
  }

  destroyPiece(state, target);
  movePiece(state, attacker, cand.to);
  if (cand.promotion) promote(state, attacker, 'queen');
}

function syncStance(piece: Piece): void {
  piece.stance = piece.defense > 0 ? 'defense' : 'attack';
}

function markSkip(state: GameState, piece: Piece): void {
  if (piece.owner === state.turn) {
    if (!state.turnInfo.stanceChanged.includes(piece.id)) state.turnInfo.stanceChanged.push(piece.id);
    return;
  }
  if (!state.skipTurn.includes(piece.id)) state.skipTurn.push(piece.id);
}

function leaveDefense(state: GameState, piece: Piece, skip: boolean): void {
  piece.defense = 0;
  piece.stance = 'attack';
  state.events.push({ type: 'stanceChanged', pieceId: piece.id, square: piece.square, stance: 'attack' });
  if (skip) markSkip(state, piece);
}

function absorbDefense(state: GameState, target: Piece): void {
  target.defense = 0;
  syncStance(target);
  state.events.push({ type: 'defenseAbsorbed', pieceId: target.id, square: target.square, remaining: 0 });
  state.events.push({ type: 'stanceChanged', pieceId: target.id, square: target.square, stance: 'attack' });
}

function grantDefense(state: GameState, target: Piece, amount: number): void {
  if (target.kind === 'king' || amount === 0) return;
  target.defense = Math.max(0, target.defense + amount);
  const wasAttack = target.stance === 'attack';
  syncStance(target);
  state.events.push({ type: 'defenseGranted', pieceId: target.id, square: target.square, amount, remaining: target.defense });
  if (wasAttack && target.defense > 0) {
    state.events.push({ type: 'stanceChanged', pieceId: target.id, square: target.square, stance: 'defense' });
  }
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
  const owner = piece.owner;
  const wasVital = !!getPieceDef(piece.kind).vital;
  state.events.push({ type: 'destroyed', pieceId: piece.id, kind: piece.kind, owner: piece.owner, square: piece.square });
  if (piece.summon) {
    state.players[piece.owner].graveyard.push({ instanceId: piece.summon.cardInstanceId, cardId: piece.summon.cardId });
    state.events.push({ type: 'summonFailed', color: piece.owner, cardId: piece.summon.cardId, square: piece.square });
  }
  removePiece(state, piece);
  if (wasVital) evaluateVitalLoss(state, owner);
}

export function evaluateVitalLoss(state: GameState, owner: Color): void {
  if (!state.players[owner].checkImmune) return;
  if (state.status.kind !== 'playing') return;
  const remaining = piecesOf(state, owner).some((p) => getPieceDef(p.kind).vital);
  if (remaining) return;
  state.status = { kind: 'regentsFallen', winner: opposite(owner) };
  if (!state.events.some((e) => e.type === 'gameOver')) {
    state.events.push({ type: 'gameOver', status: state.status });
  }
}

function canPlaySchism(state: GameState, color: Color): boolean {
  if (state.players[color].checkImmune) return false;
  const rooks = piecesOf(state, color).filter((p) => p.kind === 'rook' && !p.summon);
  return rooks.length >= 2 && !!findKing(state, color);
}

function applySchism(state: GameState, color: Color): void {
  const rooks = piecesOf(state, color).filter((p) => p.kind === 'rook' && !p.summon);
  const king = findKing(state, color);
  if (rooks.length < 2 || !king) return;
  state.players[color].checkImmune = true;
  for (const rook of rooks) {
    const from = rook.kind;
    rook.kind = REGENT.kind;
    state.events.push({ type: 'transformed', pieceId: rook.id, square: rook.square, from, to: rook.kind });
  }
  const from = king.kind;
  king.kind = SOVEREIGN.kind;
  state.events.push({ type: 'transformed', pieceId: king.id, square: king.square, from, to: king.kind });
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
  if (card.type === 'spell' && card.effects.some((e) => e.kind === 'swap')) {
    if (action.target2 === undefined || !validTargets.includes(action.target2) || action.target2 === action.target) {
      throw new IllegalActionError(`${card.name} needs two different pieces.`);
    }
  }

  if (card.type === 'spell' && card.firstTurnOnly && player.turnsTaken !== 1) {
    throw new IllegalActionError(`${card.name} can only be played on your first turn.`);
  }
  if (card.type === 'spell' && card.effects.some((e) => e.kind === 'schism') && !canPlaySchism(state, color)) {
    throw new IllegalActionError(`${card.name} needs two Rooks and a King on the board.`);
  }
  if (card.cost > player.mana) throw new IllegalActionError(`Not enough mana: ${card.name} costs ${card.cost}, you have ${player.mana}.`);

  player.hand.splice(idx, 1);
  player.mana -= card.cost;
  state.turnInfo.cardsPlayed++;
  state.events.push({ type: 'cardPlayed', color, cardId: card.id, target: action.target, target2: action.target2 });

  if (card.type === 'summon') {
    beginSummon(state, card, inst, pieceAt(state, action.target!)!);
  } else {
    const target = action.target === undefined ? undefined : pieceAt(state, action.target);
    const other = action.target2 === undefined ? undefined : pieceAt(state, action.target2);
    for (const effect of card.effects) {
      if (effect.kind === 'swap') {
        if (target && other) applySwap(state, target, other);
      } else if (effect.kind === 'spawnPawn') {
        if (action.target !== undefined) applySpawnPawn(state, color, action.target);
      } else if (effect.kind === 'castlePush') {
        if (target) applyCastlePush(state, target);
      } else {
        applyEffect(state, effect, color, target);
      }
    }
    player.graveyard.push(inst);
  }
}

export function applySwap(state: GameState, a: Piece, b: Piece): void {
  if (a.id === b.id) return;
  const fromA = a.square;
  const fromB = b.square;
  state.board[fromA] = b.id;
  state.board[fromB] = a.id;
  a.square = fromB;
  b.square = fromA;
  state.events.push({ type: 'moved', pieceId: a.id, from: fromA, to: fromB });
  state.events.push({ type: 'moved', pieceId: b.id, from: fromB, to: fromA });
}

export function applySpawnPawn(state: GameState, color: Color, square: Square): void {
  if (pieceAt(state, square)) return;
  if (rankOf(square) !== ownBackRank(color)) return;
  const pawn = addPiece(state, 'pawn', color, square, false);
  state.events.push({ type: 'spawned', pieceId: pawn.id, square, kind: 'pawn', owner: color });
}

export function applyCastlePush(state: GameState, pawn: Piece): void {
  if (pawn.kind !== 'pawn') return;
  const ahead = pawnForward(pawn);
  if (ahead === undefined || pieceAt(state, ahead)) return;
  const from = pawn.square;
  state.board[from] = null;
  pawn.square = ahead;
  pawn.hasMoved = true;
  state.board[ahead] = pawn.id;
  state.events.push({ type: 'moved', pieceId: pawn.id, from, to: ahead });
}

export function beginSummon(state: GameState, card: SummonCardDef, inst: CardInstance, sacrifice: Piece): void {
  sacrifice.summon = { cardInstanceId: inst.instanceId, cardId: card.id, turnsRemaining: card.summonTurns };
  state.events.push({ type: 'summonStarted', color: sacrifice.owner, cardId: card.id, square: sacrifice.square, turns: card.summonTurns });
}

export function resolveSummon(state: GameState, sacrifice: Piece): void {
  const pending = sacrifice.summon!;
  const card = getCardDef(pending.cardId) as SummonCardDef;
  const owner = sacrifice.owner;
  const square = sacrifice.square;
  removePiece(state, sacrifice);

  const def = card.piece;
  const defense = Math.max(0, def.defense ?? 0);
  const summoned: Piece = {
    id: `p${state.nextId++}`,
    kind: def.kind,
    owner,
    square,
    defense,
    hasMoved: true,
    stance: 'attack',
  };
  state.pieces[summoned.id] = summoned;
  state.board[square] = summoned.id;
  state.players[owner].graveyard.push({ instanceId: pending.cardInstanceId, cardId: pending.cardId });
  state.events.push({ type: 'summoned', color: owner, cardId: card.id, pieceId: summoned.id, square });
  offerOnSummonGrant(state, summoned);
}

export function applyEffect(state: GameState, effect: Effect, color: Color, target: Piece | undefined): void {
  switch (effect.kind) {
    case 'freeStance': {
      if (!target || target.kind === 'king' || target.summon) return;
      target.defense = 0;
      target.stance = 'attack';
      state.turnInfo.stanceChanged = state.turnInfo.stanceChanged.filter((id) => id !== target.id);
      state.skipTurn = state.skipTurn.filter((id) => id !== target.id);
      state.events.push({ type: 'stanceChanged', pieceId: target.id, square: target.square, stance: 'attack' });
      return;
    }
    case 'destroy': {
      if (!target || target.kind === 'king') return;
      destroyPiece(state, target);
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
    case 'gainMana': {
      const player = state.players[color];
      player.mana += effect.amount;
      state.events.push({ type: 'manaGained', color, total: effect.amount, mana: player.mana, pieces: [] });
      return;
    }
    case 'scrambleBackRank': {
      scrambleOpponentBackRank(state, color);
      return;
    }
    case 'schism': {
      applySchism(state, color);
      return;
    }
    case 'swap':
    case 'spawnPawn':
    case 'castlePush':
      return;
  }
}

/** The rank the opponent started on (white's far side is 7, black's is 0). */
function opponentBackRank(color: Color): number {
  return color === 'white' ? 7 : 0;
}

/** Permute enemy pieces (and empty squares) on the opponent's back rank. */
function scrambleOpponentBackRank(state: GameState, color: Color): void {
  const rank = opponentBackRank(color);
  const squares: Square[] = [];
  for (let file = 0; file < 8; file++) squares.push(sq(file, rank));

  const movableIdx: number[] = [];
  const occupants: (Piece | null)[] = [];
  for (let i = 0; i < squares.length; i++) {
    const piece = pieceAt(state, squares[i]!);
    if (piece && piece.owner === color) continue;
    movableIdx.push(i);
    occupants.push(piece ?? null);
  }
  if (occupants.length < 2) return;
  shuffleInPlace(occupants, state);

  for (const piece of occupants) {
    if (piece) state.board[piece.square] = null;
  }
  for (let k = 0; k < movableIdx.length; k++) {
    const piece = occupants[k];
    if (!piece) continue;
    const from = piece.square;
    const to = squares[movableIdx[k]!]!;
    piece.square = to;
    state.board[to] = piece.id;
    if (from !== to) {
      piece.hasMoved = true;
      state.events.push({ type: 'moved', pieceId: piece.id, from, to });
    }
  }
}

// ---------------------------------------------------------------------------
// Creature board abilities

export function neighborsOf(square: Square): Square[] {
  const f = fileOf(square);
  const r = rankOf(square);
  const out: Square[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      if (inBounds(f + df, r + dr)) out.push(sq(f + df, r + dr));
    }
  }
  return out;
}

function abilityLocksTurn(ability: PieceAbility): boolean {
  return ability.kind === 'stormCloud' ? ability.oncePerTurn === true : ability.oncePerTurn !== false;
}

function matchesAbilityTarget(user: Piece, target: Piece, ability: PieceAbility): boolean {
  if (target.id === user.id || target.kind === 'king') return false;
  const mine = target.owner === user.owner;
  const rule = ability.kind === 'grantAdjacent' ? (ability.target ?? 'ownAdjacent') : 'ownAdjacent';
  if (rule === 'ownAdjacent') return mine;
  if (rule === 'enemyAdjacent') return !mine;
  return true;
}

function grantChoiceActions(state: GameState): Action[] {
  const pending = state.pendingGrant;
  if (!pending) return [];
  const piece = state.pieces[pending.pieceId];
  if (!piece) return [];
  const ability = getPieceDef(piece.kind).abilities?.[pending.index];
  if (!ability) return [];
  const out: Action[] = [];
  for (const to of pending.targets) {
    const target = pieceAt(state, to);
    if (!target || !matchesAbilityTarget(piece, target, ability)) continue;
    out.push({ type: 'useAbility', from: piece.square, to, index: pending.index });
  }
  return out;
}

/**
 * After a creature appears: grantAdjacent auto-fires if exactly one valid
 * neighbour, otherwise the owner must pick among the flashing targets.
 */
export function offerOnSummonGrant(state: GameState, piece: Piece): void {
  const abilities = getPieceDef(piece.kind).abilities ?? [];
  for (let i = 0; i < abilities.length; i++) {
    const ability = abilities[i]!;
    if (ability.kind !== 'grantAdjacent') continue;
    const targets = neighborsOf(piece.square)
      .map((n) => pieceAt(state, n))
      .filter((t): t is Piece => !!t && matchesAbilityTarget(piece, t, ability));
    if (targets.length === 1) {
      performAbility(state, { type: 'useAbility', from: piece.square, to: targets[0]!.square, index: i }, piece.owner);
      return;
    }
    if (targets.length > 1) {
      state.pendingGrant = {
        pieceId: piece.id,
        from: piece.square,
        targets: targets.map((t) => t.square),
        index: i,
      };
      return;
    }
  }
}

/** Ability targets, ignoring turn and once-per-turn (arena overlay). */
export function previewAbilities(state: Pick<GameState, 'board' | 'pieces'>, piece: Piece): Extract<Action, { type: 'useAbility' }>[] {
  const abilities = getPieceDef(piece.kind).abilities ?? [];
  const out: Extract<Action, { type: 'useAbility' }>[] = [];
  for (let i = 0; i < abilities.length; i++) {
    const ability = abilities[i]!;
    if (ability.kind === 'stormCloud') {
      for (let to = 0; to < 64; to++) {
        out.push(abilities.length > 1 ? { type: 'useAbility', from: piece.square, to, index: i } : { type: 'useAbility', from: piece.square, to });
      }
      continue;
    }
    for (const n of neighborsOf(piece.square)) {
      const target = pieceAt(state as GameState, n);
      if (!target || !matchesAbilityTarget(piece, target, ability)) continue;
      out.push(abilities.length > 1 ? { type: 'useAbility', from: piece.square, to: n, index: i } : { type: 'useAbility', from: piece.square, to: n });
    }
  }
  return out;
}

/** Apply a board ability without the once-per-turn lock (sandbox). */
export function applySandboxAbility(state: GameState, from: Square, to: Square, index = 0): void {
  const piece = pieceAt(state, from);
  if (!piece) throw new IllegalActionError(`No piece on ${squareName(from)}.`);
  state.turnInfo.abilitiesUsed = state.turnInfo.abilitiesUsed.filter((id) => id !== piece.id);
  performAbility(state, { type: 'useAbility', from, to, index }, piece.owner);
}

function performAbility(state: GameState, action: Extract<Action, { type: 'useAbility' }>, color: Color): void {
  const piece = pieceAt(state, action.from);
  if (!piece) throw new IllegalActionError(`No piece on ${squareName(action.from)}.`);
  if (piece.owner !== color) throw new IllegalActionError('That is not your piece.');
  if (piece.summon) throw new IllegalActionError('A piece being sacrificed cannot use abilities.');

  const def = getPieceDef(piece.kind);
  const index = action.index ?? 0;
  const ability = def.abilities?.[index];
  if (!ability) throw new IllegalActionError(`${def.name} has no such ability.`);
  if (abilityLocksTurn(ability) && state.turnInfo.abilitiesUsed.includes(piece.id)) {
    throw new IllegalActionError(`${def.name} already used its ability this turn.`);
  }

  if (ability.kind === 'stormCloud') {
    const cost = ability.manaCost ?? 50;
    const duration = ability.duration ?? 3;
    if (!inBounds(fileOf(action.to), rankOf(action.to))) {
      throw new IllegalActionError(`${def.name} cannot cover ${squareName(action.to)}.`);
    }
    const player = state.players[color];
    if (player.mana < cost) {
      throw new IllegalActionError(`Not enough mana: a storm cloud costs ${cost}, you have ${player.mana}.`);
    }
    player.mana -= cost;
    const existing = stormAt(state, action.to);
    const reset = !!existing;
    if (existing) {
      existing.turnsRemaining = duration;
      existing.owner = color;
    } else {
      state.storms.push({ square: action.to, owner: color, turnsRemaining: duration });
    }
    if (abilityLocksTurn(ability)) state.turnInfo.abilitiesUsed.push(piece.id);
    state.pendingGrant = undefined;
    state.events.push({ type: 'stormCloud', square: action.to, turnsRemaining: duration, reset });
    return;
  }

  const target = pieceAt(state, action.to);
  if (!target) throw new IllegalActionError(`Nothing on ${squareName(action.to)} to use the ability on.`);
  if (!neighborsOf(piece.square).includes(action.to) || !matchesAbilityTarget(piece, target, ability)) {
    throw new IllegalActionError(`${def.name} cannot use that ability on ${squareName(action.to)}.`);
  }

  const granted = ability.kind === 'grantAdjacent' ? (ability.defense ?? 1) : 1;
  if (ability.kind === 'grantAdjacent') grantDefense(state, target, granted);
  if (abilityLocksTurn(ability)) state.turnInfo.abilitiesUsed.push(piece.id);
  state.pendingGrant = undefined;
  state.events.push({
    type: 'abilityUsed',
    pieceId: piece.id,
    from: action.from,
    to: action.to,
    targetId: target.id,
    defense: granted,
  });
}

export function tickStorms(state: GameState, owner: Color): void {
  const kept: typeof state.storms = [];
  for (const cloud of state.storms) {
    if (cloud.owner !== owner) {
      kept.push(cloud);
      continue;
    }
    cloud.turnsRemaining--;
    if (cloud.turnsRemaining <= 0) {
      state.events.push({ type: 'stormExpired', square: cloud.square });
    } else {
      kept.push(cloud);
      state.events.push({ type: 'stormTick', square: cloud.square, turnsRemaining: cloud.turnsRemaining });
    }
  }
  state.storms = kept;
}

// ---------------------------------------------------------------------------
// Turn flow

/**
 * Hand the turn over (after a move, or a pass). The mover collects mana income
 * first. Then, at the start of the new player's turn:
 *  1. their pending summon timers tick down (resolving at 0),
 *  2. on every `drawEvery`th turn the draw timer completes and they owe a draw
 *     (taken by clicking the deck; nothing else is legal until then),
 *  3. check / checkmate is evaluated (after the draw, if one is owed, since the
 *     drawn card might be the answer to check).
 */
function endTurn(state: GameState): void {
  collectMana(state, state.turn);
  state.events.push({ type: 'turnEnded', color: state.turn });
  // A double pawn push this turn is capturable en passant during the opponent's turn only.
  state.enPassant = state.turnInfo.enPassant;
  state.turnInfo = freshTurnInfo();

  state.turn = opposite(state.turn);
  state.ply++;
  const color = state.turn;
  const player = state.players[color];
  player.turnsTaken++;

  const stillSkip: string[] = [];
  for (const id of state.skipTurn) {
    const piece = state.pieces[id];
    if (!piece) continue;
    if (piece.owner === color) {
      if (!state.turnInfo.stanceChanged.includes(id)) state.turnInfo.stanceChanged.push(id);
    } else {
      stillSkip.push(id);
    }
  }
  state.skipTurn = stillSkip;

  for (const piece of piecesOf(state, color)) {
    if (!piece.summon) continue;
    piece.summon.turnsRemaining--;
    if (piece.summon.turnsRemaining <= 0) resolveSummon(state, piece);
    else state.events.push({ type: 'summonTick', square: piece.square, turnsRemaining: piece.summon.turnsRemaining });
  }
  tickStorms(state, color);

  if (player.turnsTaken % state.rules.drawEvery === 0 && player.deck.length > 0) {
    player.pendingDraws++;
    state.events.push({ type: 'drawReady', color });
  }

  if (isInCheck(state, color)) state.events.push({ type: 'check', color });
  if (player.pendingDraws === 0) evaluateMate(state);
}

/**
 * End-of-turn income: every piece `color` has on the board produces its tier in
 * mana (Pawn 1 … Queen 4, King 6; a full army makes 32). Pieces being
 * sacrificed still count until they are gone. Losing pieces therefore slows
 * down how often cards can be played.
 */
function collectMana(state: GameState, color: Color): void {
  const pieces = piecesOf(state, color).map((p) => ({ square: p.square, amount: manaFrom(p) }));
  const total = pieces.reduce((sum, p) => sum + p.amount, 0);
  const player = state.players[color];
  player.mana += total;
  state.events.push({ type: 'manaGained', color, total, mana: player.mana, pieces });
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
