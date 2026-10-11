// The game chat. One box serves both game screens (main.ts moves it into place): messages as bubbles, an emoji
// picker, and GIFs from KLIPY when the server has a key for them.

import type { Color } from '@chessx/engine';
import { isKlipyMediaUrl, type ChatGif, type ChatMessage } from '@chessx/protocol';
import { EmojiPicker } from './emoji.js';
import { GifPicker } from './klipy.js';

/** The server's limit, in UTF-16 units like the input's maxlength. */
const MAX_LEN = 240;
/** Older bubbles are dropped from the page past this many (the server keeps 100). */
const KEEP = 150;
/** Messages from one player this close together share a name and time. */
const GROUP_MS = 5 * 60_000;
/** A GIF bubble's largest size, in CSS pixels. */
const GIF_MAX_W = 220;
const GIF_MAX_H = 160;

export interface ChatSeat {
  you: Color | null;
  solo: boolean;
  /** The other player's name, once someone has joined. */
  opponent: string | null;
}

const SMILE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.3" fill="currentColor"/><circle cx="15" cy="10" r="1.3" fill="currentColor"/><path d="M8 14.2a4.6 4.6 0 0 0 8 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const SEND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11.2 20 4l-6.6 16.5-2.6-6.8z" fill="currentColor"/></svg>';
const BUBBLE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D\uFE0F\u20E3\s]+$/u;

/** A few emoji and nothing else get shown big, without a bubble. */
function isJumbo(text: string): boolean {
  if (!text || text.length > 40 || !EMOJI_ONLY.test(text) || !/\p{Extended_Pictographic}/u.test(text)) return false;
  const compact = text.replace(/\s/g, '');
  const count = graphemes ? [...graphemes.segment(compact)].length : [...compact].length;
  return count <= 6;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const iconButton = (cls: string, label: string, html: string): HTMLButtonElement => {
  const b = el('button', cls);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = html;
  return b;
};

export class Chat {
  /** Send a line: text, a GIF, or both. */
  onSend: (text: string, gif?: ChatGif) => void = () => {};
  /** The header's close button (only phones show it). */
  onClose: () => void = () => {};

  private readonly withEl = el('span', 'chat-with');
  private readonly log = el('div', 'chat-log');
  private readonly emptyEl = el('div', 'chat-empty');
  private readonly jumpBtn = el('button', 'chat-jump hidden', 'New messages ↓');
  private readonly form = el('form', 'chat-form');
  private readonly input = el('input');
  private readonly emojiBtn = iconButton('chat-tool', 'Emoji', SMILE_ICON);
  private readonly gifBtn = iconButton('chat-tool chat-gif-btn hidden', 'Send a GIF', '<span>GIF</span>');
  private readonly sendBtn = iconButton('chat-send', 'Send', SEND_ICON);
  private readonly emoji = new EmojiPicker();
  private readonly gifs = new GifPicker();
  private seat: ChatSeat = { you: null, solo: false, opponent: null };
  /** The newest message on the page, so the next one from the same player can join its group. */
  private last: { from: Color; at: number } | null = null;
  private count = 0;

  constructor(readonly root: HTMLElement) {
    root.classList.add('chat');
    root.setAttribute('aria-label', 'Game chat');

    const head = el('div', 'chat-head');
    const icon = el('span', 'chat-head-icon');
    icon.innerHTML = BUBBLE_ICON;
    const close = iconButton('chat-close', 'Close chat', '✕');
    close.onclick = () => this.onClose();
    head.append(icon, el('span', 'chat-title', 'Chat'), this.withEl, close);

    const body = el('div', 'chat-body');
    this.log.id = 'chat-log';
    this.log.setAttribute('role', 'log');
    this.log.setAttribute('aria-live', 'polite');
    this.log.append(this.emptyEl);
    this.log.addEventListener('scroll', () => {
      if (this.nearEnd()) this.jumpBtn.classList.add('hidden');
    }, { passive: true });
    this.jumpBtn.type = 'button';
    this.jumpBtn.onclick = () => this.scrollToEnd();
    body.append(this.log, this.jumpBtn, this.emoji.el, this.gifs.el);

    const input = this.input;
    input.id = 'chat-input';
    input.maxLength = MAX_LEN;
    input.autocomplete = 'off';
    input.enterKeyHint = 'send';
    input.setAttribute('aria-label', 'Message');
    input.addEventListener('input', () => this.updateSend());
    this.form.id = 'chat-form';
    this.form.autocomplete = 'off';
    this.sendBtn.type = 'submit';
    this.form.append(this.emojiBtn, this.gifBtn, input, this.sendBtn);
    this.form.onsubmit = (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      this.onSend(text);
      input.value = '';
      this.updateSend();
      this.closePickers();
    };

    this.emojiBtn.onclick = () => this.togglePicker('emoji');
    this.gifBtn.onclick = () => this.togglePicker('gif');
    this.emoji.onPick = (emoji) => this.insert(emoji);
    this.gifs.onPick = (gif) => {
      this.onSend('', gif);
      this.closePickers();
    };

    root.replaceChildren(head, body, this.form);
    document.addEventListener('pointerdown', (e) => {
      if (!root.contains(e.target as Node)) this.closePickers();
    });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.emoji.isOpen || this.gifs.isOpen) {
        e.stopPropagation();
        this.closePickers();
        input.focus();
      } else (document.activeElement as HTMLElement | null)?.blur();
    });
    this.updateSend();
    this.renderSeat();
  }

  /** The KLIPY key from the server's welcome; the GIF button only shows with one. */
  setGifKey(key: string | null | undefined): void {
    this.gifs.setKey(key || null);
    this.gifBtn.classList.toggle('hidden', !this.gifs.available);
    if (!this.gifs.available) this.gifs.close();
  }

  setSeat(seat: ChatSeat): void {
    this.seat = seat;
    this.renderSeat();
  }

  /** Messages from the server: the whole history when a game opens, then one at a time. */
  add(messages: ChatMessage[]): void {
    if (!messages.length) return;
    const stick = messages.length > 1 || this.nearEnd() || messages.every((m) => this.isMine(m));
    for (const m of messages) this.log.append(this.render(m));
    this.count += messages.length;
    while (this.count > KEEP) {
      this.emptyEl.nextElementSibling?.remove();
      this.count--;
    }
    this.emptyEl.classList.add('hidden');
    if (stick) this.scrollToEnd();
    else this.jumpBtn.classList.remove('hidden');
  }

  clear(): void {
    this.log.replaceChildren(this.emptyEl);
    this.emptyEl.classList.remove('hidden');
    this.last = null;
    this.count = 0;
    this.jumpBtn.classList.add('hidden');
    this.input.value = '';
    this.updateSend();
    this.closePickers();
  }

  closePickers(): void {
    this.emoji.close();
    this.gifs.close();
    this.emojiBtn.classList.remove('active');
    this.gifBtn.classList.remove('active');
    this.root.classList.remove('picking');
  }

  /** Keep the newest message in view (after the box was hidden or resized). */
  scrollToEnd(): void {
    this.log.scrollTop = this.log.scrollHeight;
    this.jumpBtn.classList.add('hidden');
  }

  private isMine(m: ChatMessage): boolean {
    return this.seat.solo || m.from === this.seat.you;
  }

  private nearEnd(): boolean {
    const l = this.log;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 48;
  }

  private renderSeat(): void {
    const { solo, opponent } = this.seat;
    this.withEl.textContent = solo ? 'notes to self' : opponent ? `with ${opponent}` : '';
    this.input.placeholder = solo ? 'Write a note…' : opponent ? `Message ${opponent}…` : 'Say something…';
    this.emptyEl.replaceChildren(
      el('div', 'chat-empty-icon', solo ? '📝' : '👋'),
      el('div', '', solo ? 'Practice chat is just for you.' : opponent ? `No messages yet. Say hi to ${opponent}!` : 'No messages yet.'),
    );
  }

  private render(m: ChatMessage): HTMLElement {
    const mine = this.isMine(m);
    const grouped = this.last !== null && this.last.from === m.from && m.at - this.last.at < GROUP_MS;
    this.last = { from: m.from, at: m.at };
    const jumbo = !m.gif && isJumbo(m.text);
    const row = el('div', `chat-msg ${mine ? 'mine' : 'theirs'} ${m.from}${grouped ? '' : ' first'}${jumbo ? ' jumbo' : ''}${m.gif ? ' has-gif' : ''}`);
    if (!grouped) {
      const meta = el('div', 'chat-meta');
      const time = el('time', '', new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
      time.dateTime = new Date(m.at).toISOString();
      meta.append(el('b', '', mine ? 'You' : m.name), time);
      row.append(meta);
    }
    const bubble = el('div', 'chat-bubble');
    if (m.gif) bubble.append(this.gifElement(m.gif));
    if (m.text) bubble.append(el('span', 'chat-text', m.text));
    row.append(bubble);
    return row;
  }

  private gifElement(gif: ChatGif): HTMLElement {
    if (!isKlipyMediaUrl(gif.url)) return el('span', 'chat-gif-missing', 'GIF unavailable');
    const scale = Math.min(1, GIF_MAX_W / gif.width, GIF_MAX_H / gif.height);
    const img = el('img', 'chat-gif');
    img.src = gif.url;
    img.alt = gif.title || 'GIF';
    img.title = gif.title;
    img.decoding = 'async';
    img.style.width = `${Math.round(gif.width * scale)}px`;
    img.style.height = `${Math.round(gif.height * scale)}px`;
    img.addEventListener('error', () => img.replaceWith(el('span', 'chat-gif-missing', gif.title ? `GIF: ${gif.title}` : 'GIF unavailable')), { once: true });
    return img;
  }

  private togglePicker(which: 'emoji' | 'gif'): void {
    const picker = which === 'emoji' ? this.emoji : this.gifs;
    const opening = !picker.isOpen;
    this.closePickers();
    if (!opening) return;
    picker.open();
    (which === 'emoji' ? this.emojiBtn : this.gifBtn).classList.add('active');
    this.root.classList.add('picking');
  }

  /** An emoji goes in at the cursor, if it still fits. */
  private insert(emoji: string): void {
    const input = this.input;
    if (input.value.length + emoji.length > MAX_LEN) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(emoji, start, end, 'end');
    this.updateSend();
    // On a phone, focusing would bring up the keyboard over the picker.
    if (matchMedia('(pointer: fine)').matches) input.focus();
  }

  private updateSend(): void {
    this.sendBtn.disabled = !this.input.value.trim();
  }
}
