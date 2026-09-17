import { getCardDef, getPieceDef, squareName, type GameEvent, type PlayerView } from '@chessx/engine';

export interface LogLine {
  text: string;
  color?: 'white' | 'black';
  important?: boolean;
}

/** Turn the engine's events for one action into human-readable log lines. */
export function describeEvents(view: PlayerView, names: Record<'white' | 'black', string>): LogLine[] {
  const lines: LogLine[] = [];
  const pieceName = (id: string, fallbackKind?: string): string => {
    const p = view.pieces[id];
    const kind = p?.kind ?? fallbackKind;
    return kind ? getPieceDef(kind).name : 'piece';
  };
  const destroyedKinds = new Map<string, string>();
  for (const e of view.events) if (e.type === 'destroyed') destroyedKinds.set(e.pieceId, e.kind);
  const ownerOf = (id: string): 'white' | 'black' | undefined => {
    const p = view.pieces[id];
    if (p) return p.owner;
    const d = view.events.find((e) => e.type === 'destroyed' && e.pieceId === id);
    return d && d.type === 'destroyed' ? d.owner : undefined;
  };

  const attacks = new Set<string>();
  for (const e of view.events) {
    switch (e.type) {
      case 'moved': {
        if (attacks.has(e.pieceId) || e.castle) break;
        const owner = ownerOf(e.pieceId);
        lines.push({ text: `${names[owner ?? 'white']}: ${pieceName(e.pieceId)} ${squareName(e.from)} → ${squareName(e.to)}`, color: owner });
        break;
      }
      case 'attacked': {
        attacks.add(e.attackerId);
        const owner = ownerOf(e.attackerId);
        const targetKind = destroyedKinds.get(e.targetId);
        const killed = !!targetKind;
        const target = pieceName(e.targetId, targetKind);
        const hit = view.events.find((x) => x.type === 'damaged' && x.pieceId === e.targetId);
        const shield = hit && hit.type === 'damaged' && hit.shield > 0 ? ` (shield absorbs ${hit.shield})` : '';
        lines.push({
          text: `${names[owner ?? 'white']}: ${pieceName(e.attackerId)} ${squareName(e.from)} attacks ${target} on ${squareName(e.to)} for ${e.damage}${shield} — ${killed ? 'destroyed!' : 'it survives'}`,
          color: owner,
        });
        break;
      }
      case 'stanceChanged': {
        const owner = ownerOf(e.pieceId);
        lines.push({
          text: `${names[owner ?? 'white']}: ${pieceName(e.pieceId)} ${squareName(e.square)} switches to ${e.stance === 'defense' ? 'Defense' : 'Attack'} mode`,
          color: owner,
        });
        break;
      }
      case 'cardPlayed': {
        const card = getCardDef(e.cardId);
        const where = e.target !== undefined ? ` on ${squareName(e.target)}` : '';
        lines.push({ text: `${names[e.color]} plays ${card.name}${where}`, color: e.color });
        break;
      }
      case 'summoned':
        lines.push({ text: `${getCardDef(e.cardId).name} rises on ${squareName(e.square)}!`, color: e.color, important: true });
        break;
      case 'summonFailed':
        lines.push({ text: `${names[e.color]}'s summon of ${getCardDef(e.cardId).name} failed — the sacrifice was destroyed.`, color: e.color, important: true });
        break;
      case 'drew':
        lines.push({ text: `${names[e.color]} draws ${e.count} card${e.count > 1 ? 's' : ''}.`, color: e.color });
        break;
      case 'promoted':
        lines.push({ text: `Pawn promoted to ${getPieceDef(e.to).name} on ${squareName(e.square)}.`, important: true });
        break;
      case 'check':
        lines.push({ text: `${names[e.color]} is in check!`, important: true });
        break;
      case 'gameOver': {
        const s = e.status;
        const winnerName = 'winner' in s ? names[s.winner] : null;
        const text =
          s.kind === 'checkmate' ? `Checkmate! ${winnerName} wins.` :
          s.kind === 'kingCaptured' ? `King captured! ${winnerName} wins.` :
          s.kind === 'resigned' ? `${winnerName} wins by resignation.` :
          s.kind === 'stalemate' ? 'Stalemate.' : '';
        if (text) lines.push({ text, important: true });
        break;
      }
      default:
        break;
    }
  }
  // Castling shows up as two 'moved' events; collapse to one line.
  const castle = view.events.find((e): e is Extract<GameEvent, { type: 'moved' }> => e.type === 'moved' && !!e.castle);
  if (castle) {
    const owner = ownerOf(castle.pieceId);
    lines.unshift({ text: `${names[owner ?? 'white']} castles.`, color: owner });
  }
  return lines;
}
