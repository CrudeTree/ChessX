import { v2 } from '@chessx/engine';

export interface LogLine {
  text: string;
  color?: v2.Color;
  important?: boolean;
}

/** What the screen remembers about every piece it has seen, so captured pieces can still be named. */
export type PieceMemory = Map<string, { name: string; owner: v2.Color }>;

/** Turn the events of one action into human-readable log lines. */
export function describeEvents(view: v2.PlayerView, names: Record<v2.Color, string>, memory: PieceMemory): LogLine[] {
  const lines: LogLine[] = [];
  const pieceName = (id: string): string => memory.get(id)?.name ?? 'piece';
  const ownerOf = (id: string): v2.Color | undefined => memory.get(id)?.owner;
  const cardName = (id: string): string => view.cards[id]?.name ?? id;
  const captures = new Map<string, string>(); // mover id -> what it captured
  for (const e of view.events) {
    if (e.type === 'captured') captures.set(e.by, pieceName(e.pieceId));
  }

  for (const e of view.events) {
    switch (e.type) {
      case 'deployed':
        lines.push({ text: `${names[e.color]} deploys ${pieceName(e.pieceId)} on ${v2.squareName(e.square)}`, color: e.color });
        break;
      case 'turnStarted':
        lines.push({ text: `— ${names[e.color]}, turn ${e.turn} (${e.mana} mana) —`, color: e.color });
        break;
      case 'drew':
        lines.push({ text: `${names[e.color]} draws ${e.count} card${e.count > 1 ? 's' : ''}.`, color: e.color });
        break;
      case 'moved': {
        const owner = ownerOf(e.pieceId);
        const taken = captures.get(e.pieceId);
        lines.push({
          text: `${names[owner ?? 'white']}: ${pieceName(e.pieceId)} ${v2.squareName(e.from)} → ${v2.squareName(e.to)}${taken ? `, captures ${taken}` : ''}`,
          color: owner,
        });
        break;
      }
      case 'sealDestroyed':
        lines.push({ text: `The seal on ${v2.squareName(e.square)} (${cardName(e.cardId)}) is destroyed.`, important: true });
        break;
      case 'summoned':
        lines.push({ text: `${names[e.color]} summons ${pieceName(e.pieceId)} on ${v2.squareName(e.square)}`, color: e.color });
        break;
      case 'sealed':
        lines.push({
          text: `${names[e.color]} seals ${pieceName(e.consumedPieceId)} on ${v2.squareName(e.square)} — hatches in ${e.timer} turn${e.timer > 1 ? 's' : ''}`,
          color: e.color,
        });
        break;
      case 'hatched':
        lines.push({ text: `${pieceName(e.pieceId)} hatches on ${v2.squareName(e.square)}!`, color: e.color, important: true });
        break;
      case 'spellPlayed':
        lines.push({
          text: `${names[e.color]} plays ${cardName(e.cardId)}${e.target !== undefined ? ` on ${v2.squareName(e.target)}` : ''}`,
          color: e.color,
        });
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
