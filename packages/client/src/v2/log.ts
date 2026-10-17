import { v2 } from '@chessx/engine';

export interface LogLine {
  text: string;
  color?: v2.Color;
  important?: boolean;
}

/** What the screen remembers about every piece it has seen, so captured pieces can still be named. */
export type PieceMemory = Map<string, { name: string; owner: v2.Color }>;

/**
 * Remembers the pieces `events` name. Events carry the names pieces had at the time, so a log rebuilt from a saved
 * game can name pieces long gone; events saved before they did fall back to what the screen has seen.
 */
function learn(events: v2.GameEvent[], memory: PieceMemory): void {
  for (const e of events) {
    switch (e.type) {
      case 'deployed':
      case 'summoned':
      case 'hatched':
        if (e.name) memory.set(e.pieceId, { name: e.name, owner: e.color });
        break;
      case 'evolved':
        if (e.name) memory.set(e.pieceId, { name: e.name, owner: e.color });
        if (e.fromName) memory.set(e.fromPieceId, { name: e.fromName, owner: e.color });
        break;
      case 'moved':
      case 'captured':
        if (e.name && e.owner) memory.set(e.pieceId, { name: e.name, owner: e.owner });
        break;
      case 'sealed':
        if (e.consumedName) memory.set(e.consumedPieceId, { name: e.consumedName, owner: e.color });
        break;
      case 'lava':
      case 'raised':
      case 'shielded':
        memory.set(e.pieceId, { name: e.name, owner: e.color });
        break;
      case 'frozen':
      case 'destroyed':
        memory.set(e.pieceId, { name: e.name, owner: e.owner });
        break;
      default:
        break;
    }
  }
}

/** Turn the events of one action into human-readable log lines. */
export function describeEvents(
  events: v2.GameEvent[],
  view: v2.PlayerView,
  names: Record<v2.Color, string>,
  memory: PieceMemory,
): LogLine[] {
  learn(events, memory);
  const lines: LogLine[] = [];
  const pieceName = (id: string): string => memory.get(id)?.name ?? 'piece';
  const ownerOf = (id: string): v2.Color | undefined => memory.get(id)?.owner;
  const cardName = (id: string): string => view.cards[id]?.name ?? id;
  const captures = new Map<string, Extract<v2.GameEvent, { type: 'captured' }>>(); // mover id -> what it captured
  for (const e of events) {
    if (e.type === 'captured') captures.set(e.by, e);
  }

  for (const e of events) {
    switch (e.type) {
      case 'deployed':
        lines.push({ text: `${names[e.color]} deploys ${pieceName(e.pieceId)} on ${v2.squareName(e.square)}`, color: e.color });
        break;
      case 'turnStarted': {
        const gain = e.income === undefined ? `${e.mana} mana` : `+${e.income} mana, ${e.mana} in all`;
        lines.push({ text: `— ${names[e.color]}, turn ${e.turn} (${gain}) —`, color: e.color });
        // Against the same cap: a game begun before income stopped at +2 still rises to +4.
        if (e.income !== undefined && e.turn > 1 && e.income > v2.incomeFor(e.turn - 1, e.income)) {
          lines.push({ text: `${names[e.color]}'s income rises to +${e.income} mana a turn.`, color: e.color, important: true });
        }
        break;
      }
      case 'drew':
        lines.push({ text: `${names[e.color]} draws ${e.count} card${e.count > 1 ? 's' : ''}.`, color: e.color });
        break;
      case 'moved': {
        const owner = e.owner ?? ownerOf(e.pieceId);
        const taken = captures.get(e.pieceId);
        const capture = taken ? `, captures ${pieceName(taken.pieceId)}${taken.bounty ? ` (+${taken.bounty} mana)` : ''}` : '';
        lines.push({
          text: `${names[owner ?? 'white']}: ${pieceName(e.pieceId)} ${v2.squareName(e.from)} → ${v2.squareName(e.to)}${capture}`,
          color: owner,
        });
        break;
      }
      case 'sealDestroyed':
        lines.push({ text: `The sacrifice on ${v2.squareName(e.square)} (${cardName(e.cardId)}) is destroyed.`, important: true });
        break;
      case 'summoned':
        lines.push({ text: `${names[e.color]} summons ${pieceName(e.pieceId)} on ${v2.squareName(e.square)}`, color: e.color });
        break;
      case 'sealed': {
        const cardId = e.cardId ?? view.seals.find((s) => s.id === e.sealId)?.cardId;
        lines.push({
          text: `${names[e.color]} sacrifices ${pieceName(e.consumedPieceId)} on ${v2.squareName(e.square)}${cardId ? ` for ${cardName(cardId)}` : ''} — it arrives in ${e.timer} turn${e.timer > 1 ? 's' : ''}`,
          color: e.color,
        });
        break;
      }
      case 'hatched':
        lines.push({ text: `${pieceName(e.pieceId)} arrives on ${v2.squareName(e.square)}!`, color: e.color, important: true });
        break;
      case 'evolved': {
        const cardId = e.cardId ?? view.pieces.find((p) => p.id === e.pieceId)?.cardId;
        const final = (cardId ? view.cards[cardId]?.level : undefined) === 3;
        if (e.promoted) {
          lines.push({
            text: `${names[e.color]} promotes ${pieceName(e.fromPieceId)} into ${pieceName(e.pieceId)} on ${v2.squareName(e.square)}!`,
            color: e.color,
            important: true,
          });
          break;
        }
        lines.push({
          text: `${names[e.color]} evolves ${pieceName(e.fromPieceId)} into ${pieceName(e.pieceId)} on ${v2.squareName(e.square)}${final ? '!' : ''}`,
          color: e.color,
          important: final,
        });
        break;
      }
      case 'spellPlayed':
        lines.push({
          text: `${names[e.color]} plays ${cardName(e.cardId)}${e.target !== undefined ? ` on ${v2.squareName(e.target)}` : ''}`,
          color: e.color,
        });
        break;
      case 'learned':
        lines.push({ text: `${e.name} learns ${v2.ABILITIES[e.ability].name}!`, color: e.color, important: true });
        break;
      case 'manaGained':
        lines.push({ text: `${names[e.color]} gains ${e.mana} mana.`, color: e.color });
        break;
      case 'raised':
        lines.push({ text: `${names[e.color]} raises ${e.name} from their discard pile on ${v2.squareName(e.square)}!`, color: e.color, important: true });
        break;
      case 'shielded':
        lines.push({ text: `${e.name} on ${v2.squareName(e.square)} is shielded until ${names[e.color]}'s next turn.`, color: e.color });
        break;
      case 'frozen':
        lines.push({ text: `${names[e.owner]}'s ${e.name} on ${v2.squareName(e.square)} is frozen for a turn.`, color: e.color, important: true });
        break;
      case 'destroyed':
        lines.push({ text: `${names[e.owner]}'s ${e.name} on ${v2.squareName(e.square)} is destroyed!`, color: e.color, important: true });
        break;
      case 'pitched':
        lines.push({ text: `${names[e.color]} pitches ${cardName(e.cardId)} for +${e.mana} mana.`, color: e.color });
        break;
      case 'lava':
        lines.push({ text: `${names[e.color]}: ${e.name} spits lava onto ${v2.squareName(e.square)}!`, color: e.color, important: true });
        break;
      case 'lavaCooled':
        lines.push({ text: `The lava on ${v2.squareName(e.square)} cools.` });
        break;
      case 'check':
        lines.push({ text: `${names[e.color]} is in check!`, important: true });
        break;
      case 'gameOver': {
        const s = e.status;
        const winner = 'winner' in s ? names[s.winner] : '';
        const text =
          s.kind === 'checkmate' ? `Checkmate! ${winner} wins.`
          : s.kind === 'stalemate' ? 'Stalemate — the game is a draw.'
          : s.kind === 'resigned' ? `${winner} wins by resignation.`
          : s.kind === 'timeout' ? `${winner} wins on time.`
          : '';
        if (text) lines.push({ text, important: true });
        break;
      }
      default:
        break;
    }
  }
  return lines;
}
