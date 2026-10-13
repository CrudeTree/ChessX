// A card under the original rules, as the reward popup and the discard pile of an original-rules game draw it.

import { clampArtZoom, type CardDef } from '@chessx/engine';

export function cardElement(card: CardDef, opts: { count?: number; isNew?: boolean; disabled?: boolean } = {}): HTMLElement {
  const el = document.createElement('div');
  const isSummon = card.type === 'summon';
  el.className = `bcard ${isSummon ? 'summon' : 'spell'} ${opts.disabled ? 'disabled' : ''}`;
  const type = isSummon ? `Tier ${card.tier} creature · ${card.summonTurns} turns` : 'Spell';
  const art = card.art ? `<img src="${card.art}" alt="">` : `<span>${card.glyph}</span>`;
  el.innerHTML = `
    <div class="bname"><span>${card.name}</span></div>
    <div class="bart" style="--card-art-zoom: ${clampArtZoom(card.cardArtZoom)}">${art}<span class="bcost" title="Mana cost">${card.cost}</span></div>
    <div class="btype">${type}</div>
    <div class="btext">${card.text}</div>
  `;
  if (opts.count !== undefined) {
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = `×${opts.count}`;
    el.appendChild(c);
  }
  if (opts.isNew) {
    const n = document.createElement('span');
    n.className = 'newtag';
    n.textContent = 'NEW';
    el.appendChild(n);
  }
  return el;
}
