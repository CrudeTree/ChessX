// Admin card editor. Edits a draft `Balance` (patches on top of the shipped
// catalog) and saves it to the server, which applies it everywhere. Only the
// fields that differ from the code are stored, so untouched numbers keep
// following future code changes.

import {
  allCards,
  applyBalance,
  BASE_RULES,
  baseCardDef,
  basePieceDef,
  cloneMovement,
  currentBalance,
  describeCard,
  describeMovement,
  DIRS,
  isCustomCard,
  patchedCard,
  STANDARD_KINDS,
  validateBalance,
  type Balance,
  type CardDef,
  type CardPatch,
  type CustomCard,
  type Effect,
  type MovementSpec,
  type PiecePatch,
  type RulesPatch,
} from '@chessx/engine';
import { pickImageFile, prepareImage } from './imageprep.js';
import { movementMap } from './inspect.js';
import { ApiError, balanceApi } from './net.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type Selection = { kind: 'card'; id: string } | { kind: 'piece'; id: string } | { kind: 'rules'; id: 'rules' } | { kind: 'custom'; id: string };

function defaultEffect(kind: Effect['kind']): Effect {
  switch (kind) {
    case 'modifyStats':
      return { kind, atk: 1 };
    case 'modifyStatsAll':
      return { kind, atk: 1 };
    case 'damage':
      return { kind, amount: 1 };
    case 'heal':
      return { kind, amount: 1 };
    case 'draw':
      return { kind, count: 1 };
    case 'hastenSummon':
      return { kind, turns: 1 };
    case 'restore':
    case 'freeStance':
      return { kind };
  }
}

const DIRS8: ReadonlyArray<readonly [number, number, string]> = [
  [-1, 1, '↖'], [0, 1, '↑'], [1, 1, '↗'],
  [-1, 0, '←'], [1, 0, '→'],
  [-1, -1, '↙'], [0, -1, '↓'], [1, -1, '↘'],
];

export class BalanceEditor {
  onApplied: (b: Balance) => void = () => {};
  private draft: Balance = { cards: {}, pieces: {} };
  private saved = '';
  private selected: Selection | null = null;
  private filter = '';

  constructor(private back: () => void) {
    $('editor-back').onclick = () => this.leave();
    $('editor-save').onclick = () => void this.save();
    $('editor-reset-all').onclick = () => {
      if (!confirm('Reset every shipped card, piece and rule to the values in the code? Your own created cards are kept. (You still need to press Save.)')) return;
      this.draft = { cards: {}, pieces: {}, ...(this.draft.customCards?.length ? { customCards: this.draft.customCards } : {}) };
      this.refresh();
    };
    $<HTMLInputElement>('editor-search').oninput = (e) => {
      this.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderList();
    };
  }

  open(): void {
    this.draft = clone(currentBalance());
    this.saved = JSON.stringify(this.draft);
    this.selected ??= { kind: 'card', id: allCards()[0]!.id };
    this.refresh();
  }

  private leave(): void {
    if (this.dirty && !confirm('You have unsaved changes. Leave anyway?')) return;
    this.back();
  }

  private get dirty(): boolean {
    return JSON.stringify(this.draft) !== this.saved;
  }

  private refresh(): void {
    this.renderList();
    this.renderForm();
    const problems = validateBalance(this.draft);
    $('editor-msg').textContent = problems.join(' ');
    $('editor-msg').className = `hint editor-msg ${problems.length ? 'error' : ''}`;
    $<HTMLButtonElement>('editor-save').disabled = !this.dirty || problems.length > 0;
    $('editor-dirty').textContent = this.dirty ? 'Unsaved changes' : '';
  }

  private async save(): Promise<void> {
    const btn = $<HTMLButtonElement>('editor-save');
    btn.disabled = true;
    try {
      const applied = await balanceApi.save(this.draft);
      applyBalance(applied);
      this.draft = clone(applied);
      this.saved = JSON.stringify(this.draft);
      this.onApplied(applied);
      $('editor-msg').textContent = 'Saved. Every game is using the new numbers.';
      $('editor-msg').className = 'hint editor-msg ok';
      this.renderList();
      this.renderForm();
      $('editor-dirty').textContent = '';
    } catch (e) {
      $('editor-msg').textContent = e instanceof ApiError ? e.message : 'Could not save.';
      $('editor-msg').className = 'hint editor-msg error';
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------ list

  private renderList(): void {
    const el = $('editor-items');
    el.innerHTML = '';
    const section = (title: string) => {
      const h = document.createElement('div');
      h.className = 'editor-section';
      h.textContent = title;
      el.appendChild(h);
    };
    const item = (sel: Selection, name: string, sub: string, modified: boolean) => {
      if (this.filter && !name.toLowerCase().includes(this.filter) && !sub.toLowerCase().includes(this.filter)) return;
      const b = document.createElement('button');
      b.className = `editor-item ${this.selected && this.selected.kind === sel.kind && this.selected.id === sel.id ? 'active' : ''}`;
      b.innerHTML = `<span class="n">${esc(name)}</span><span class="s">${esc(sub)}</span>${modified ? '<span class="mod" title="Changed from the code">●</span>' : ''}`;
      b.onclick = () => {
        this.selected = sel;
        this.renderList();
        this.renderForm();
      };
      el.appendChild(b);
    };
    section('Game');
    item({ kind: 'rules', id: 'rules' }, 'Game rules', 'starting mana, hand size, draws', !!(this.draft.rules && Object.keys(this.draft.rules).length));
    section('Chess pieces');
    for (const kind of STANDARD_KINDS) {
      const p = basePieceDef(kind);
      item({ kind: 'piece', id: kind }, p.name, `Tier ${p.tier}`, !!this.draft.pieces[kind]);
    }
    // Shipped cards (from the code) and the admin's own cards (from the draft).
    const shipped = allCards()
      .filter((c) => !isCustomCard(c.id))
      .map((c) => baseCardDef(c.id));
    section('Creatures');
    for (const c of shipped.filter((c) => c.type === 'summon').sort((a, b) => a.name.localeCompare(b.name))) {
      item({ kind: 'card', id: c.id }, c.name, `Tier ${(c as Extract<CardDef, { type: 'summon' }>).tier} · ${c.cost} mana`, !!this.draft.cards[c.id]);
    }
    section('Spells');
    for (const c of shipped.filter((c) => c.type === 'spell').sort((a, b) => a.name.localeCompare(b.name))) {
      item({ kind: 'card', id: c.id }, c.name, `${c.cost} mana`, !!this.draft.cards[c.id]);
    }
    section('Your cards');
    for (const c of [...(this.draft.customCards ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
      item({ kind: 'custom', id: c.id }, c.name || '(unnamed)', c.type === 'summon' ? `Creature · Tier ${c.tier} · ${c.cost} mana` : `Spell · ${c.cost} mana`, false);
    }
    const add = document.createElement('button');
    add.className = 'editor-item editor-add';
    add.innerHTML = '<span class="n">+ New card</span><span class="s">creature or spell</span>';
    add.onclick = () => this.newCard();
    el.appendChild(add);
  }

  /** Start a brand-new card with sensible defaults and open it for editing. */
  private newCard(): void {
    const type = confirm('Create a CREATURE card?\n\nOK = creature (summon)\nCancel = spell') ? 'summon' : 'spell';
    const id = `custom_${Math.random().toString(36).slice(2, 8)}`;
    const name = 'New card';
    const card: CustomCard =
      type === 'summon'
        ? {
            id,
            type,
            name,
            glyph: '✨',
            cost: 200,
            tier: 2,
            summonTurns: 2,
            text: '',
            piece: { kind: id, name, glyph: '✨', tier: 2, movement: { leaps: DIRS.ALL.map(([f, r]) => [f, r] as const) }, atk: 1, def: 0, hp: 2 },
            give: 'everyone',
          }
        : { id, type, name, glyph: '✨', cost: 150, target: 'ownPiece', text: '', effects: [{ kind: 'modifyStats', atk: 1 }], give: 'everyone' };
    card.text = describeCard(card);
    (this.draft.customCards ??= []).push(card);
    this.selected = { kind: 'custom', id };
    this.refresh();
  }

  // ------------------------------------------------------------------ form

  private renderForm(): void {
    const form = $('editor-form');
    form.innerHTML = '';
    if (!this.selected) return;
    if (this.selected.kind === 'rules') this.renderRulesForm(form);
    else if (this.selected.kind === 'piece') this.renderPieceForm(form, this.selected.id);
    else if (this.selected.kind === 'custom') {
      const card = this.draft.customCards?.find((c) => c.id === this.selected!.id);
      if (card) this.renderCustomForm(form, card);
      else this.selected = null;
    } else this.renderCardForm(form, this.selected.id);
  }

  // ---- shared: pictures

  /**
   * Picture chooser: shows the current image, uploads a replacement (fitted to
   * 512×512, optionally with the white background knocked out) and lets you go
   * back to the default. `current` is what the card uses now; `def` the code's.
   */
  private imageField(label: string, hint: string, current: string | undefined, def: string | undefined, set: (url: string | undefined) => void): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'eimage';
    const preview = document.createElement('div');
    preview.className = 'epreview-img';
    preview.innerHTML = current ? `<img src="${esc(current)}" alt="">` : '<span class="muted">none</span>';
    const col = document.createElement('div');
    col.className = 'eimage-col';
    col.innerHTML = `<div class="el">${esc(label)}<small>${esc(hint)}</small></div>`;
    const row = document.createElement('div');
    row.className = 'eimage-row';
    const knock = document.createElement('label');
    knock.className = 'eknock';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    knock.append(cb, ' remove white background');
    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = current ? 'Replace image…' : 'Upload image…';
    up.onclick = async () => {
      const file = await pickImageFile();
      if (!file) return;
      up.disabled = true;
      up.textContent = 'Uploading…';
      try {
        const data = await prepareImage(file, { knockoutWhite: cb.checked });
        const url = await balanceApi.upload(data);
        set(url);
        this.refresh();
      } catch (e) {
        $('editor-msg').textContent = e instanceof ApiError ? e.message : 'Could not upload that image.';
        $('editor-msg').className = 'hint editor-msg error';
        up.disabled = false;
        up.textContent = 'Upload image…';
      }
    };
    row.append(up);
    if (def !== undefined && current !== def) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.textContent = 'Use default';
      reset.onclick = () => {
        set(undefined);
        this.refresh();
      };
      row.append(reset);
    } else if (def === undefined && current) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = 'Remove';
      clear.onclick = () => {
        set(undefined);
        this.refresh();
      };
      row.append(clear);
    }
    col.append(row, knock);
    wrap.append(preview, col);
    return wrap;
  }

  // ---- game rules

  private renderRulesForm(form: HTMLElement): void {
    const patch: RulesPatch = this.draft.rules ?? {};
    const clean = () => {
      if (Object.keys(patch).length) this.draft.rules = patch;
      else delete this.draft.rules;
    };
    const setR = <K extends keyof RulesPatch>(k: K) => (v: RulesPatch[K] | undefined) => {
      if (v === undefined) delete patch[k];
      else patch[k] = v;
      clean();
    };
    this.header(form, 'Game rules', 'Numbers every new game starts with', '<span class="glyph">⚙</span>', !!this.draft.rules, () => delete this.draft.rules);
    const g = this.group(form, 'Mana');
    g.appendChild(this.numField('Starting mana', patch.startingMana, BASE_RULES.startingMana, setR('startingMana'), 'each player begins with this much'));
    const cards = this.group(form, 'Cards');
    cards.append(
      this.numField('Opening hand', patch.openingHand, BASE_RULES.openingHand, setR('openingHand'), 'cards drawn at the start'),
      this.numField('Draw every N turns', patch.drawEvery, BASE_RULES.drawEvery, setR('drawEvery'), 'the deck timer fills every Nth turn'),
    );
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Rule changes apply to games created after you save. Games already in progress keep the rules they started with.';
    form.appendChild(note);
  }

  /** A labelled integer input with its code default and a reset button. */
  private numField(label: string, value: number | undefined, def: number, set: (v: number | undefined) => void, hint = ''): HTMLElement {
    const row = document.createElement('label');
    row.className = `efield ${value !== undefined ? 'changed' : ''}`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '1';
    input.value = String(value ?? def);
    input.oninput = () => {
      const n = Number(input.value);
      if (input.value === '' || !Number.isFinite(n)) return;
      set(Math.round(n) === def ? undefined : Math.round(n));
      this.refresh();
    };
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ereset';
    reset.textContent = '↺';
    reset.title = `Back to ${def}`;
    reset.onclick = () => {
      set(undefined);
      this.refresh();
    };
    row.innerHTML = `<span class="el">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span>`;
    const box = document.createElement('span');
    box.className = 'ebox';
    box.append(input);
    if (value !== undefined) {
      const d = document.createElement('small');
      d.className = 'edef';
      d.textContent = `code: ${def}`;
      box.append(d, reset);
    }
    row.appendChild(box);
    return row;
  }

  private header(form: HTMLElement, title: string, sub: string, art: string, modified: boolean, reset: () => void): void {
    const h = document.createElement('div');
    h.className = 'ehead';
    h.innerHTML = `<div class="eart">${art}</div><div class="etitle"><h2>${esc(title)}</h2><div class="muted">${esc(sub)}</div></div>`;
    if (modified) {
      const b = document.createElement('button');
      b.textContent = 'Reset this one';
      b.onclick = () => {
        reset();
        this.refresh();
      };
      h.appendChild(b);
    }
    form.appendChild(h);
  }

  private group(form: HTMLElement, title: string): HTMLElement {
    const g = document.createElement('fieldset');
    g.className = 'egroup';
    g.innerHTML = `<legend>${esc(title)}</legend>`;
    form.appendChild(g);
    return g;
  }

  // ---- pieces

  private renderPieceForm(form: HTMLElement, kind: string): void {
    const base = basePieceDef(kind);
    const patch: PiecePatch = this.draft.pieces[kind] ?? {};
    // Empty patches are removed from the draft, so re-attach before every write.
    const clean = () => {
      if (Object.keys(patch).length) this.draft.pieces[kind] = patch;
      else delete this.draft.pieces[kind];
    };
    const setP = <K extends keyof PiecePatch>(k: K) => (v: PiecePatch[K] | undefined) => {
      if (v === undefined) delete patch[k];
      else patch[k] = v;
      clean();
    };
    this.header(form, base.name, `Standard piece · Tier ${base.tier}`, `<span class="glyph">${base.glyph}</span>`, !!this.draft.pieces[kind], () => delete this.draft.pieces[kind]);

    const stats = this.group(form, 'Stats (new pieces of this kind)');
    stats.append(
      this.numField('ATK', patch.atk, base.atk, setP('atk')),
      this.numField('DEF', patch.def, base.def, setP('def'), 'shield while in Defense mode'),
      this.numField('HP', patch.hp, base.hp, setP('hp')),
      this.numField('Mana per turn', patch.manaYield, base.manaYield ?? base.tier, setP('manaYield'), 'default = tier'),
    );
    if (kind === 'king') {
      const n = document.createElement('p');
      n.className = 'hint';
      n.textContent = 'The King ignores HP and DEF (any hit captures it) and its attack always destroys the target.';
      stats.appendChild(n);
    }
    this.movementEditor(form, base.movement, patch.movement, (m) => {
      setP('movement')(m);
    }, base.glyph, kind === 'king');
  }

  // ---- cards

  private renderCardForm(form: HTMLElement, id: string): void {
    const base = baseCardDef(id);
    const patch: CardPatch = this.draft.cards[id] ?? {};
    const sub: PiecePatch = patch.piece ?? {};
    // Empty patches are removed from the draft, so re-attach before every write.
    const clean = () => {
      if (Object.keys(sub).length) patch.piece = sub;
      else delete patch.piece;
      if (Object.keys(patch).length) this.draft.cards[id] = patch;
      else delete this.draft.cards[id];
    };
    const setC = <K extends keyof CardPatch>(k: K) => (v: CardPatch[K] | undefined) => {
      if (v === undefined) delete patch[k];
      else patch[k] = v;
      clean();
    };
    const live = patchedCard(id, this.draft.cards[id]);
    const art = base.art ? `<img src="${base.art}" alt="">` : `<span class="glyph emoji">${base.glyph}</span>`;
    this.header(form, base.name, base.type === 'summon' ? `Creature card · Tier ${live.type === 'summon' ? live.tier : ''}` : `Spell · ${base.target}`, art, !!this.draft.cards[id], () => delete this.draft.cards[id]);

    const cost = this.group(form, 'Cost');
    cost.appendChild(this.numField('Mana cost', patch.cost, base.cost, setC('cost')));

    const images = this.group(form, 'Pictures');
    images.appendChild(this.imageField('Card image', 'shown on the card in hand, the binder and the inspector', live.art, base.art, setC('art')));
    if (base.type === 'summon') {
      images.appendChild(
        this.imageField('Board sprite', 'the piece on the board; uses the card image unless set', live.type === 'summon' ? live.boardArt ?? live.art : undefined, base.boardArt ?? base.art, (u) => setC('boardArt')(u)),
      );
    }

    if (base.type === 'summon') {
      const setPP = <K extends keyof PiecePatch>(k: K) => (v: PiecePatch[K] | undefined) => {
        if (v === undefined) delete sub[k];
        else sub[k] = v;
        clean();
      };
      const summon = this.group(form, 'Summoning');
      summon.append(
        this.numField('Creature tier', patch.tier, base.tier, setC('tier'), 'also sets the default sacrifice: tier − 1'),
        this.numField('Sacrifice tier', patch.sacrificeTier, base.sacrificeTier ?? base.tier - 1, setC('sacrificeTier'), 'which of your pieces can be sacrificed'),
        this.numField('Turns to summon', patch.summonTurns, base.summonTurns, setC('summonTurns')),
      );
      const stats = this.group(form, 'Creature stats');
      stats.append(
        this.numField('ATK', sub.atk, base.piece.atk, setPP('atk')),
        this.numField('DEF', sub.def, base.piece.def, setPP('def')),
        this.numField('HP', sub.hp, base.piece.hp, setPP('hp')),
        this.numField('Mana per turn', sub.manaYield, base.piece.manaYield ?? (patch.tier ?? base.tier), setPP('manaYield'), 'default = tier'),
      );
      this.movementEditor(form, base.piece.movement, sub.movement, (m) => setPP('movement')(m), base.piece.glyph, false);
    } else {
      if (base.targetTier !== undefined) {
        const t = this.group(form, 'Targeting');
        t.appendChild(this.numField('Target tier', patch.targetTier, base.targetTier, setC('targetTier'), 'only pieces of this tier can be targeted'));
      }
      this.effectsEditor(form, base.effects, patch, clean);
    }

    // Rules text: generated from the numbers unless overridden.
    const textG = this.group(form, 'Card text');
    const generated = describeCard(patchedCard(id, { ...this.draft.cards[id], text: undefined }));
    const ta = document.createElement('textarea');
    ta.rows = 3;
    ta.value = patch.text ?? (this.draft.cards[id] ? generated : base.text);
    ta.oninput = () => {
      const v = ta.value.trim();
      setC('text')(v && v !== generated ? v : undefined);
      $<HTMLButtonElement>('editor-save').disabled = !this.dirty;
      $('editor-dirty').textContent = this.dirty ? 'Unsaved changes' : '';
    };
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.innerHTML = `Generated from the numbers: <i>${esc(generated)}</i>`;
    const useGen = document.createElement('button');
    useGen.textContent = 'Use generated text';
    useGen.onclick = () => {
      setC('text')(undefined);
      this.refresh();
    };
    textG.append(ta, hint, useGen);
  }

  // ---- admin-created cards (edited directly; no code default to fall back on)

  /** A plain integer input for custom cards. */
  private plainNum(label: string, value: number, set: (v: number) => void, hint = ''): HTMLElement {
    const row = document.createElement('label');
    row.className = 'efield';
    row.innerHTML = `<span class="el">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span>`;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '1';
    input.value = String(value);
    input.oninput = () => {
      const n = Math.round(Number(input.value));
      if (input.value === '' || !Number.isFinite(n)) return;
      set(n);
      this.refreshQuiet();
    };
    const box = document.createElement('span');
    box.className = 'ebox';
    box.append(input);
    row.appendChild(box);
    return row;
  }

  private textField(label: string, value: string, set: (v: string) => void, hint = '', maxLength = 24): HTMLElement {
    const row = document.createElement('label');
    row.className = 'efield';
    row.innerHTML = `<span class="el">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span>`;
    const input = document.createElement('input');
    input.maxLength = maxLength;
    input.value = value;
    input.oninput = () => {
      set(input.value);
      this.refreshQuiet();
    };
    row.appendChild(input);
    return row;
  }

  private selectField<T extends string>(label: string, value: T, options: [T, string][], set: (v: T) => void, hint = ''): HTMLElement {
    const row = document.createElement('label');
    row.className = 'efield';
    row.innerHTML = `<span class="el">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span>`;
    const sel = document.createElement('select');
    for (const [v, text] of options) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = text;
      o.selected = v === value;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      set(sel.value as T);
      this.refresh();
    };
    row.appendChild(sel);
    return row;
  }

  /** Validate and update the save button/list without rebuilding the form (keeps focus while typing). */
  private refreshQuiet(): void {
    const problems = validateBalance(this.draft);
    $('editor-msg').textContent = problems.join(' ');
    $('editor-msg').className = `hint editor-msg ${problems.length ? 'error' : ''}`;
    $<HTMLButtonElement>('editor-save').disabled = !this.dirty || problems.length > 0;
    $('editor-dirty').textContent = this.dirty ? 'Unsaved changes' : '';
    this.renderList();
  }

  private renderCustomForm(form: HTMLElement, card: CustomCard): void {
    const art = card.art ? `<img src="${esc(card.art)}" alt="">` : `<span class="glyph emoji">${esc(card.glyph)}</span>`;
    const h = document.createElement('div');
    h.className = 'ehead';
    h.innerHTML = `<div class="eart">${art}</div><div class="etitle"><h2>${esc(card.name || '(unnamed)')}</h2><div class="muted">Your ${card.type === 'summon' ? 'creature' : 'spell'} card · ${esc(card.id)}</div></div>`;
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete card';
    del.onclick = () => {
      if (!confirm(`Delete "${card.name}"? It will be removed from every player's collection and deck, and any copies in games in progress vanish. (Takes effect when you Save.)`)) return;
      this.draft.customCards = (this.draft.customCards ?? []).filter((c) => c.id !== card.id);
      delete this.draft.cards[card.id];
      this.selected = null;
      this.refresh();
    };
    h.appendChild(del);
    form.appendChild(h);

    const basics = this.group(form, 'Card');
    basics.append(
      this.textField('Name', card.name, (v) => {
        card.name = v;
        if (card.type === 'summon') card.piece.name = v;
      }),
      this.textField('Emoji / symbol', card.glyph, (v) => {
        card.glyph = v;
        if (card.type === 'summon') card.piece.glyph = v;
      }, 'fallback when there is no picture', 8),
      this.plainNum('Mana cost', card.cost, (v) => (card.cost = v)),
      this.selectField(
        'Who gets it',
        card.give,
        [
          ['everyone', 'Everyone (3 copies, now)'],
          ['reward', 'Reward pool (won after checkmates)'],
          ['none', 'Nobody yet'],
        ],
        (v) => (card.give = v),
      ),
    );

    const images = this.group(form, 'Pictures');
    images.appendChild(this.imageField('Card image', 'shown on the card in hand, the binder and the inspector', card.art, undefined, (u) => (card.art = u)));
    if (card.type === 'summon') {
      images.appendChild(this.imageField('Board sprite', 'the piece on the board; uses the card image unless set', card.boardArt ?? card.art, card.art, (u) => (card.boardArt = u)));
    }

    if (card.type === 'summon') {
      const summon = this.group(form, 'Summoning');
      summon.append(
        this.plainNum('Creature tier', card.tier, (v) => {
          card.tier = v;
          card.piece.tier = v;
        }, 'also sets the default sacrifice: tier − 1'),
        this.plainNum('Sacrifice tier', card.sacrificeTier ?? card.tier - 1, (v) => (card.sacrificeTier = v), 'which of your pieces can be sacrificed'),
        this.plainNum('Turns to summon', card.summonTurns, (v) => (card.summonTurns = v)),
      );
      const stats = this.group(form, 'Creature stats');
      stats.append(
        this.plainNum('ATK', card.piece.atk, (v) => (card.piece.atk = v)),
        this.plainNum('DEF', card.piece.def, (v) => (card.piece.def = v)),
        this.plainNum('HP', card.piece.hp, (v) => (card.piece.hp = v)),
        this.plainNum('Mana per turn', card.piece.manaYield ?? card.piece.tier, (v) => (card.piece.manaYield = v), 'default = tier'),
      );
      this.movementEditor(form, card.piece.movement, card.piece.movement, (m) => {
        if (m) card.piece.movement = m;
      }, card.piece.glyph, false);
    } else {
      const targeting = this.group(form, 'Targeting');
      targeting.append(
        this.selectField(
          'Target',
          card.target,
          [
            ['none', 'No target (drop anywhere)'],
            ['ownPiece', 'One of your pieces'],
            ['enemyPiece', 'An enemy piece'],
            ['anyPiece', 'Any piece'],
            ['ownSummoning', 'Your piece being sacrificed'],
            ['ownDefending', 'Your piece in Defense mode'],
          ],
          (v) => (card.target = v),
        ),
        this.plainNum('Only tier (0 = any)', card.targetTier ?? 0, (v) => {
          if (v > 0) card.targetTier = v;
          else delete card.targetTier;
        }, 'restrict targets to one tier'),
      );
      const king = document.createElement('label');
      king.className = 'eflag';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!card.allowKing;
      cb.onchange = () => {
        if (cb.checked) card.allowKing = true;
        else delete card.allowKing;
        this.refreshQuiet();
      };
      king.append(cb, ' may target the King');
      targeting.appendChild(king);
      this.customEffectsEditor(form, card);
    }

    // Description: generated from the numbers until you type your own.
    const textG = this.group(form, 'Card text');
    const generated = describeCard(card);
    const ta = document.createElement('textarea');
    ta.rows = 3;
    ta.maxLength = 300;
    ta.value = card.text;
    ta.oninput = () => {
      card.text = ta.value;
      this.refreshQuiet();
    };
    const useGen = document.createElement('button');
    useGen.textContent = 'Use generated text';
    useGen.onclick = () => {
      card.text = generated;
      this.refresh();
    };
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.innerHTML = `Generated from the numbers: <i>${esc(generated)}</i>`;
    textG.append(ta, hint, useGen);
  }

  private customEffectsEditor(form: HTMLElement, card: Extract<CustomCard, { type: 'spell' }>): void {
    const g = this.group(form, 'Effects');
    const KINDS: [Effect['kind'], string][] = [
      ['modifyStats', 'Change target stats (permanent)'],
      ['modifyStatsAll', 'Change stats of all your pieces'],
      ['damage', 'Deal damage'],
      ['heal', 'Heal HP'],
      ['restore', 'Fully restore HP and shield'],
      ['draw', 'Draw cards'],
      ['hastenSummon', 'Speed up a summon'],
      ['freeStance', 'Switch to Attack and still act'],
    ];
    card.effects.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'eeffect';
      row.appendChild(
        this.selectField('Effect', e.kind, KINDS, (kind) => {
          card.effects[i] = defaultEffect(kind);
        }),
      );
      const num = (label: string, key: string, hint = '') => {
        const obj = e as unknown as Record<string, number | undefined>;
        row.appendChild(this.plainNum(label, obj[key] ?? 0, (v) => (obj[key] = v), hint));
      };
      switch (e.kind) {
        case 'modifyStats':
        case 'modifyStatsAll':
          num('ATK change', 'atk');
          num('DEF change', 'def');
          num('HP change', 'hp');
          if (e.kind === 'modifyStatsAll') {
            row.appendChild(
              this.selectField('Which pieces', e.pieceKind ?? '', [['', 'All pieces'], ...STANDARD_KINDS.filter((k) => k !== 'king').map((k) => [k, basePieceDef(k).name + 's'] as [string, string])], (v) => {
                if (v) e.pieceKind = v;
                else delete e.pieceKind;
              }),
            );
          }
          break;
        case 'damage':
        case 'heal':
          num('Amount', 'amount');
          break;
        case 'draw':
          num('Cards drawn', 'count');
          break;
        case 'hastenSummon':
          num('Turns', 'turns');
          break;
        default:
          break;
      }
      if (card.effects.length > 1) {
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '✕ remove';
        del.onclick = () => {
          card.effects.splice(i, 1);
          this.refresh();
        };
        row.appendChild(del);
      }
      g.appendChild(row);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '+ Add effect';
    add.onclick = () => {
      card.effects.push(defaultEffect('damage'));
      this.refresh();
    };
    g.appendChild(add);
  }

  private effectsEditor(form: HTMLElement, baseEffects: Effect[], patch: CardPatch, clean: () => void): void {
    const g = this.group(form, 'Effects');
    const effects: Effect[] = clone(patch.effects ?? baseEffects);
    const commit = () => {
      patch.effects = JSON.stringify(effects) === JSON.stringify(baseEffects) ? undefined : effects;
      if (patch.effects === undefined) delete patch.effects;
      clean();
    };
    effects.forEach((e, i) => {
      const be = baseEffects[i];
      const row = document.createElement('div');
      row.className = 'eeffect';
      row.innerHTML = `<div class="ek">${esc(e.kind)}</div>`;
      const num = <K extends string>(label: string, obj: Record<string, unknown>, key: K, def: number, hint = '') => {
        row.appendChild(
          this.numField(label, (obj[key] as number | undefined) === def ? undefined : (obj[key] as number | undefined), def, (v) => {
            if (v === undefined) {
              if (def === 0 && (key === 'atk' || key === 'def' || key === 'hp')) delete obj[key];
              else obj[key] = def;
            } else obj[key] = v;
            commit();
          }, hint),
        );
      };
      switch (e.kind) {
        case 'modifyStats':
        case 'modifyStatsAll': {
          const b = (be?.kind === e.kind ? be : e) as typeof e;
          num('ATK change', e as never, 'atk', b.atk ?? 0);
          num('DEF change', e as never, 'def', b.def ?? 0);
          num('HP change', e as never, 'hp', b.hp ?? 0);
          break;
        }
        case 'damage':
        case 'heal':
          num('Amount', e as never, 'amount', (be?.kind === e.kind ? be.amount : e.amount));
          break;
        case 'draw':
          num('Cards drawn', e as never, 'count', (be?.kind === 'draw' ? be.count : e.count));
          break;
        case 'hastenSummon':
          num('Turns', e as never, 'turns', (be?.kind === 'hastenSummon' ? be.turns : e.turns));
          break;
        default: {
          const p = document.createElement('p');
          p.className = 'hint';
          p.textContent = 'No numbers on this effect.';
          row.appendChild(p);
        }
      }
      g.appendChild(row);
    });
  }

  // ---- movement

  private movementEditor(form: HTMLElement, base: MovementSpec, patch: MovementSpec | undefined, set: (m: MovementSpec | undefined) => void, glyph: string, isKing: boolean): void {
    const g = this.group(form, 'Movement');
    const m = cloneMovement(patch ?? base) as { pawn?: boolean; relative?: boolean; leaps?: (readonly [number, number])[]; slides?: { dirs: (readonly [number, number])[]; range?: number }[] };
    const direct = patch === base; // custom card: the spec itself is being edited, nothing to "reset" to
    const commit = () => {
      const norm = (x: MovementSpec) => JSON.stringify(cloneMovement(x));
      set(!direct && norm(m) === norm(base) ? undefined : cloneMovement(m));
      this.refresh();
    };
    if (patch && patch !== base) {
      const b = document.createElement('button');
      b.textContent = 'Reset movement';
      b.className = 'ereset-mv';
      b.onclick = () => {
        set(undefined);
        this.refresh();
      };
      g.appendChild(b);
    }

    const wrap = document.createElement('div');
    wrap.className = 'emove';
    // Preview (same minimap the inspector shows players).
    const preview = document.createElement('div');
    preview.className = 'epreview';
    preview.innerHTML = movementMap(m, `<span class="glyph emoji">${glyph}</span>`) + `<p class="hint">${esc(describeMovement(m))}</p>`;

    // Leaps: click squares on a 7×7 grid.
    const leaps = document.createElement('div');
    leaps.innerHTML = '<div class="el">Jumps <small>click squares the piece can jump to (ignores pieces in between)</small></div>';
    const grid = document.createElement('div');
    grid.className = 'egrid';
    const has = (f: number, r: number) => (m.leaps ?? []).some(([a, b]) => a === f && b === r);
    for (let dr = 3; dr >= -3; dr--) {
      for (let df = -3; df <= 3; df++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        const centre = df === 0 && dr === 0;
        cell.className = `ecell ${(df + dr) % 2 === 0 ? 'l' : 'd'} ${has(df, dr) ? 'on' : ''} ${centre ? 'c' : ''}`;
        cell.textContent = centre ? glyph : '';
        cell.disabled = centre;
        cell.onclick = () => {
          m.leaps = has(df, dr) ? (m.leaps ?? []).filter(([a, b]) => !(a === df && b === dr)) : [...(m.leaps ?? []), [df, dr] as const];
          if (!m.leaps.length) delete m.leaps;
          commit();
        };
        grid.appendChild(cell);
      }
    }
    leaps.appendChild(grid);

    // Slides: direction sets with a range.
    const slides = document.createElement('div');
    slides.innerHTML = '<div class="el">Slides <small>rays that stop at the first piece; range blank = to the edge</small></div>';
    (m.slides ?? []).forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'eslide';
      const compass = document.createElement('div');
      compass.className = 'ecompass';
      for (const [f, r, arrow] of DIRS8) {
        const b = document.createElement('button');
        b.type = 'button';
        const on = s.dirs.some(([a, c]) => a === f && c === r);
        b.className = `edir ${on ? 'on' : ''}`;
        b.textContent = arrow;
        b.onclick = () => {
          s.dirs = on ? s.dirs.filter(([a, c]) => !(a === f && c === r)) : [...s.dirs, [f, r] as const];
          commit();
        };
        compass.appendChild(b);
      }
      const range = document.createElement('input');
      range.type = 'number';
      range.min = '1';
      range.max = '7';
      range.placeholder = '∞';
      range.value = s.range === undefined ? '' : String(s.range);
      range.title = 'Range (blank = unlimited)';
      range.oninput = () => {
        const n = Number(range.value);
        if (range.value === '') delete s.range;
        else if (Number.isInteger(n) && n >= 1 && n <= 7) s.range = n;
        else return;
        commit();
      };
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Remove this slide';
      del.onclick = () => {
        m.slides!.splice(i, 1);
        if (!m.slides!.length) delete m.slides;
        commit();
      };
      row.append(compass, range, del);
      slides.appendChild(row);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '+ Add slide';
    add.onclick = () => {
      (m.slides ??= []).push({ dirs: [] });
      set(cloneMovement(m)); // keep the empty group visible until a direction is chosen
      this.refresh();
    };
    slides.appendChild(add);

    // Flags.
    const flags = document.createElement('div');
    flags.className = 'eflags';
    const flag = (label: string, key: 'pawn' | 'relative', hint: string, disabled = false) => {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!m[key];
      cb.disabled = disabled;
      cb.onchange = () => {
        if (cb.checked) m[key] = true;
        else delete m[key];
        commit();
      };
      l.append(cb, ` ${label} `);
      const s = document.createElement('small');
      s.textContent = hint;
      l.appendChild(s);
      flags.appendChild(l);
    };
    flag('Pawn rules', 'pawn', 'forward push, double-step, diagonal attack, en passant, promotion', isKing);
    flag('Forward is toward the enemy', 'relative', 'otherwise ↑ means the same board direction for both sides');

    wrap.append(preview, leaps, slides, flags);
    g.appendChild(wrap);
  }
}
