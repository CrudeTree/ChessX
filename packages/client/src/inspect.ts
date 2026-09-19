// The left-hand "zoomed card" panel: shows a piece on the board or a card in hand.

import {
  allCards,
  describeAbility,
  getCardDef,
  getPieceDef,
  movementPattern,
  STANDARD_PIECES,
  type Color,
  type MovementSpec,
  type Piece,
  type PlayerView,
  type SummonCardDef,
} from '@chessx/engine';
import type { GameView, InspectTarget } from './game/GameView.js';

export interface InspectContext {
  gameView: GameView;
  /** Practice game: one person controls both sides. */
  solo: () => boolean;
  names: () => Record<Color, string>;
  view: () => PlayerView | null;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const summonCardFor = (kind: string): SummonCardDef | undefined =>
  allCards().find((c): c is SummonCardDef => c.type === 'summon' && c.piece.kind === kind);

export class InspectPanel {
  private zoomEl = $('zoom');
  private stanceBtn = $<HTMLButtonElement>('stance');
  private stanceHint = $('stance-hint');

  constructor(private ctx: InspectContext) {
    this.stanceBtn.onclick = () => ctx.gameView.toggleInspectedStance();
    ctx.gameView.onInspect = (t) => this.render(t);
  }

  render(target: InspectTarget | null): void {
    if (!target) {
      this.zoomEl.className = 'zoom empty';
      this.zoomEl.innerHTML = '<div class="zoom-empty">Click a piece, or hover a card, to see it here.</div>';
      this.resetStanceButton();
      return;
    }
    if (target.kind === 'card') this.renderCard(target.cardId);
    else this.renderPiece(target.piece);
  }

  private resetStanceButton(hint = ''): void {
    this.stanceBtn.disabled = true;
    this.stanceBtn.className = '';
    this.stanceBtn.textContent = 'Switch to Defense mode';
    this.stanceHint.textContent = hint;
  }

  private flash(): void {
    this.zoomEl.classList.add('fresh');
    setTimeout(() => this.zoomEl.classList.remove('fresh'), 180);
  }

  /** Zoomed view of a card in hand. Summon cards also show the creature's stats and movement. */
  private renderCard(cardId: string): void {
    const card = getCardDef(cardId);
    const isSummon = card.type === 'summon';
    const typeLine = isSummon
      ? `Summon · Tier ${card.tier} · arrives in ${card.summonTurns} turn${card.summonTurns === 1 ? '' : 's'}`
      : `Spell · ${describeTarget(card.target)}`;
    const stats = isSummon
      ? `<div class="zoom-stats">
          <div class="stat atk">ATK<b>${card.piece.atk}</b></div>
          <div class="stat def">DEF<b>${card.piece.def === 0 ? '—' : card.piece.def}</b></div>
          <div class="stat hp">HP<b>${card.piece.hp}</b></div>
        </div>`
      : '';
    const needs = isSummon ? `Sacrifice one of your Tier ${card.sacrificeTier ?? card.tier - 1} pieces to summon.` : '';

    this.zoomEl.className = `zoom ${isSummon ? 'summon' : 'basic'} card`;
    this.zoomEl.innerHTML = `
      <div class="zoom-head">
        <div class="zoom-name">${esc(card.name)}</div>
        <div class="zoom-owner">${isSummon ? 'CREATURE' : 'SPELL'}</div>
      </div>
      <div class="zoom-type">${esc(typeLine)}</div>
      <div class="zoom-cost"><span class="mana-gem">${card.cost}</span> mana to play${this.manaNote(card.cost)}</div>
      ${artBanner(card.art)}
      ${isSummon ? movementMap(card.piece.movement, `<span class="glyph emoji">${card.piece.glyph}</span>`) : card.art ? '' : `<div class="zoom-art"><span class="glyph emoji">${card.glyph}</span></div>`}
      ${stats}
      <div class="zoom-text">${esc(card.text)}</div>
      <div class="zoom-status">${esc(needs)}</div>
    `;
    this.flash();
    this.resetStanceButton('Drag the card onto a highlighted target to play it.');
  }

  /** " · you have N" / how many more turns of income are needed, when we know the viewer's pool. */
  private manaNote(cost: number): string {
    const view = this.ctx.view();
    if (!view || this.ctx.solo()) return '';
    const me = view.players[view.you];
    if (me.mana >= cost) return ` · <span class="ok">you have ${me.mana}</span>`;
    const turns = me.manaIncome > 0 ? Math.ceil((cost - me.mana) / me.manaIncome) : Infinity;
    return ` · <span class="short">you have ${me.mana}${Number.isFinite(turns) ? ` (about ${turns} more turn${turns === 1 ? '' : 's'})` : ''}</span>`;
  }

  private renderPiece(piece: Piece): void {
    const { gameView } = this.ctx;
    const solo = this.ctx.solo();
    const currentView = this.ctx.view();
    const def = getPieceDef(piece.kind);
    const isBasic = piece.kind in STANDARD_PIECES;
    const card = isBasic ? undefined : summonCardFor(piece.kind);
    const isKing = piece.kind === 'king';
    const ownerName = solo ? (piece.owner === 'white' ? 'White' : 'Black') : this.ctx.names()[piece.owner];

    const typeLine = `${isKing ? `Tier ${def.tier} · royal piece` : card ? `Tier ${def.tier} creature · summoned by ${card.name}` : `Tier ${def.tier} · basic piece`} · +${def.manaYield ?? def.tier} mana / turn`;

    const status: string[] = [];
    if (piece.summon) {
      const c = summonCardFor(piece.summon.cardId) ?? allCards().find((x) => x.id === piece.summon!.cardId);
      status.push(`Being sacrificed: ${c?.name ?? 'summon'} arrives in ${piece.summon.turnsRemaining} turn${piece.summon.turnsRemaining === 1 ? '' : 's'}.`);
    } else if (piece.stance === 'defense') {
      status.push('Cannot move or attack while in Defense mode. Switch it back to Attack mode to free it (it can act from the following turn).');
      if (piece.maxDef === 0) status.push('No DEF to shield with — raise DEF (e.g. Shield Wall) to make Defense mode count.');
    }
    if (currentView?.turnInfo.stanceChanged.includes(piece.id)) {
      status.push('Changed stance this turn: cannot act or switch again until the turn ends.');
    }
    for (const ability of def.abilities ?? []) {
      const used = currentView?.turnInfo.abilitiesUsed.includes(piece.id);
      const text = describeAbility(ability);
      if (!text) continue;
      if (currentView?.pendingGrant?.pieceId === piece.id) {
        status.push('Choose a highlighted neighbour to grant +1 DEF.');
      } else if (used) status.push(`Already used its ability this turn (${text.replace(/\.$/, '')}).`);
      else if (piece.summon) status.push('Cannot use its ability while being sacrificed.');
      else status.push(`${text.charAt(0).toUpperCase()}${text.slice(1)}`);
    }

    this.zoomEl.className = `zoom ${card ? 'summon' : 'basic'} owner-${piece.owner}`;
    this.zoomEl.innerHTML = `
      <div class="zoom-head">
        <div class="zoom-name">${esc(def.name)}</div>
        <div class="zoom-owner">${esc(ownerName)}</div>
      </div>
      <div class="zoom-type">${esc(typeLine)}</div>
      ${artBanner(card?.art)}
      ${movementMap(def.movement, `<span class="glyph ${isBasic ? 'chess' : 'emoji'} ${piece.owner}">${def.glyph}</span>`)}
      <div class="zoom-stats">
        <div class="stat atk">ATK<b>${piece.atk}</b></div>
        <div class="stat def">DEF<b>${piece.maxDef === 0 ? '—' : `${piece.def}/${piece.maxDef}`}</b></div>
        <div class="stat hp">HP<b>${isKing ? '—' : `${piece.hp}/${piece.maxHp}`}</b></div>
      </div>
      ${isKing ? '' : `<div class="zoom-stance ${piece.stance}">${piece.stance === 'defense' ? '🛡 Defense mode — DEF shields HP' : '⚔ Attack mode'}</div>`}
      <div class="zoom-text">${esc(card?.text ?? def.description ?? '')}</div>
      <div class="zoom-status">${status.map(esc).join('<br>')}</div>
    `;
    this.flash();

    const action = gameView.stanceActionFor(piece.id);
    const toDefense = piece.stance === 'attack';
    this.stanceBtn.textContent = toDefense ? 'Switch to Defense mode' : 'Switch to Attack mode';
    this.stanceBtn.className = toDefense ? 'to-defense' : 'to-attack';
    this.stanceBtn.disabled = !action;
    if (action) {
      this.stanceHint.textContent = toDefense
        ? 'Free action. The piece is frozen until you switch it back (from a later turn).'
        : 'Free action. The piece sits out the rest of this turn, then may act as normal.';
    } else if (isKing) {
      this.stanceHint.textContent = 'The King cannot change stance.';
    } else if (piece.summon) {
      this.stanceHint.textContent = 'A piece being sacrificed cannot change stance.';
    } else if (currentView?.turnInfo.stanceChanged.includes(piece.id)) {
      this.stanceHint.textContent = 'Already switched this turn.';
    } else if (currentView && currentView.turn !== piece.owner) {
      this.stanceHint.textContent = solo ? `It is not ${ownerName}'s turn.` : 'Not your piece or not your turn.';
    } else if (currentView && currentView.status.kind !== 'playing') {
      this.stanceHint.textContent = 'The game is over.';
    } else if (currentView && currentView.players[currentView.turn].pendingDraws > 0) {
      this.stanceHint.textContent = 'Draw a card first.';
    } else {
      this.stanceHint.textContent = '';
    }
  }
}

const artBanner = (url: string | undefined): string => (url ? `<div class="zoom-banner"><img src="${url}" alt=""></div>` : '');

/**
 * 7x7 mini board with the piece in the middle and dots on every square it
 * could reach on an empty board. Black dot = move, red dot = attack-only.
 */
export function movementMap(spec: MovementSpec, glyphHtml: string): string {
  const R = 3;
  const { moves, attacks, unbounded } = movementPattern(spec, R);
  const key = (df: number, dr: number) => `${df},${dr}`;
  const moveSet = new Set(moves.map(([f, r]) => key(f, r)));
  const attackSet = new Set(attacks.map(([f, r]) => key(f, r)));
  let cells = '';
  for (let dr = R; dr >= -R; dr--) {
    for (let df = -R; df <= R; df++) {
      const light = (df + dr + 2 * R) % 2 === 0;
      const isCenter = df === 0 && dr === 0;
      const k = key(df, dr);
      const dot = isCenter ? glyphHtml : moveSet.has(k) ? '<i class="dot"></i>' : attackSet.has(k) ? '<i class="dot atk"></i>' : '';
      cells += `<div class="cell ${light ? 'l' : 'd'}${isCenter ? ' c' : ''}">${dot}</div>`;
    }
  }
  const legend = `<div class="map-legend">${attacks.length ? '<span><i class="dot"></i> move</span><span><i class="dot atk"></i> attack</span>' : '<span><i class="dot"></i> move / attack</span>'}${unbounded ? '<span>… continues to the edge</span>' : ''}</div>`;
  return `<div class="minimap">${cells}</div>${legend}`;
}

function describeTarget(rule: string): string {
  switch (rule) {
    case 'none': return 'no target';
    case 'ownPiece': return 'targets a friendly piece';
    case 'enemyPiece': return 'targets an enemy piece';
    case 'anyPiece': return 'targets any piece';
    case 'ownSummoning': return 'targets a friendly piece being sacrificed';
    default: return rule;
  }
}
