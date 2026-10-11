// The chat's emoji picker. Only emoji from Unicode 12 (2019) or older, so Windows 10 draws them too.

interface EmojiGroup {
  id: string;
  label: string;
  /** Shown on the group's tab. */
  icon: string;
  emoji: string[];
}

/** Symbols that default to plain text (❤, ☀, ♟...) need the emoji form asked for. */
const asEmoji = (e: string): string => (/\p{Emoji_Presentation}|\uFE0F|\u200D/u.test(e) ? e : `${e}\uFE0F`);
const list = (s: string): string[] => s.split(/\s+/).filter(Boolean).map(asEmoji);

const GROUPS: EmojiGroup[] = [
  {
    id: 'smileys',
    label: 'Smileys',
    icon: '😀',
    emoji: list(`😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶
      😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨
      😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠ 💩 🤡 👹 👺 👻 👽 👾 🤖`),
  },
  {
    id: 'gestures',
    label: 'Gestures',
    icon: '👍',
    emoji: list(`👍 👎 👏 🙌 👐 🤲 🤝 🙏 ✌ 🤞 🤟 🤘 👌 🤏 👈 👉 👆 👇 ☝ ✋ 🤚 🖐 🖖 👋 🤙 💪 🦾 ✊ 👊 🤛 🤜
      ✍ 💅 🤳 🙋 🙅 🙆 🤷 🤦 🙇 💁`),
  },
  {
    id: 'hearts',
    label: 'Hearts & symbols',
    icon: '❤',
    emoji: list(`❤ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 💔 ❣ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 💬 💭 💤 ✨ ⭐ 🌟 🔥 ⚡
      🌈 ☀ 🌙 ❄ ✅ ❌ ❓ ❗ ‼ ⁉ 🆗 🆒 🆕 🆙`),
  },
  {
    id: 'battle',
    label: 'Battle & game',
    icon: '⚔',
    emoji: list(`♟ 👑 🏰 🗡 ⚔ 🛡 🏹 🪓 🔮 🧙 🧝 🧛 🧟 🧞 🐉 🐲 🦄 🧪 💎 📜 🎲 🎯 🏆 🥇 🥈 🥉 🏅 ⏳ ⌛ ⏰ 💣 🧨
      💰 🎉 🎊 🎁 🃏 🎮 🧠 👀 🙈 🙉 🙊 🤺 🚀 💡 🔔 🎵`),
  },
  {
    id: 'animals',
    label: 'Animals',
    icon: '🐶',
    emoji: list(`🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦅 🦉 🦇 🐺 🐗 🐴 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🦎
      🦖 🐙 🦑 🦀 🐠 🐬 🐳 🦈 🐊 🐘 🦒 🦓 🦍 🐐 🦌 🐑 🦙 🦥 🦦 🦩`),
  },
  {
    id: 'food',
    label: 'Food & drink',
    icon: '🍕',
    emoji: list(`🍕 🍔 🍟 🌭 🍿 🥓 🥚 🍳 🧇 🥞 🧈 🍞 🥐 🥨 🧀 🍗 🍖 🌮 🌯 🥗 🍝 🍜 🍣 🍱 🍤 🍙 🍰 🎂 🧁 🍩 🍪 🍫
      🍬 🍭 🍦 🍎 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥑 🌶 🥕 🌽 ☕ 🍵 🧃 🥤 🍺 🍻 🥂 🍷 🧉`),
  },
];

const RECENT_KEY = 'chessx.emoji.recent';
const RECENT_MAX = 24;

function loadRecent(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((e): e is string => typeof e === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** A panel of emoji in groups, one scrolling grid; the tabs jump to a group. Stays open while you pick several. */
export class EmojiPicker {
  readonly el = el('div', 'chat-pop chat-emoji hidden');
  /** Called with each emoji picked. */
  onPick: (emoji: string) => void = () => {};

  private readonly tabs = el('div', 'chat-emoji-tabs');
  private readonly grid = el('div', 'chat-emoji-grid');
  private recent = loadRecent();
  private sections: { id: string; head: HTMLElement; tab: HTMLButtonElement }[] = [];

  constructor() {
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Emoji');
    this.el.append(this.tabs, this.grid);
    this.grid.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-e]');
      if (!btn) return;
      const emoji = btn.dataset.e!;
      this.recent = [emoji, ...this.recent.filter((r) => r !== emoji)].slice(0, RECENT_MAX);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
      } catch {
        /* private mode: recents just are not kept */
      }
      this.onPick(emoji);
    });
    this.grid.addEventListener('scroll', () => this.markTab(), { passive: true });
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }

  open(): void {
    // Built on open so the recent row is fresh, but not on each pick, so the grid never jumps under the pointer.
    this.build();
    this.el.classList.remove('hidden');
    this.grid.scrollTop = 0;
    this.markTab();
  }

  close(): void {
    this.el.classList.add('hidden');
  }

  private build(): void {
    const groups: EmojiGroup[] = this.recent.length ? [{ id: 'recent', label: 'Recently used', icon: '🕘', emoji: this.recent }, ...GROUPS] : GROUPS;
    this.tabs.replaceChildren();
    this.grid.replaceChildren();
    this.sections = [];
    for (const g of groups) {
      const tab = el('button', 'chat-emoji-tab', g.icon);
      tab.type = 'button';
      tab.title = g.label;
      tab.setAttribute('aria-label', g.label);
      const head = el('div', 'chat-emoji-head', g.label);
      tab.onclick = () => {
        this.grid.scrollTop = head.offsetTop;
      };
      const cells = el('div', 'chat-emoji-cells');
      for (const e of g.emoji) {
        const b = el('button', 'chat-emoji-cell', e);
        b.type = 'button';
        b.dataset.e = e;
        cells.append(b);
      }
      this.tabs.append(tab);
      this.grid.append(head, cells);
      this.sections.push({ id: g.id, head, tab });
    }
  }

  /** Light up the tab of the group at the top of the grid (the grid is positioned, so offsets are inside it). */
  private markTab(): void {
    const top = this.grid.scrollTop + 4;
    let current = this.sections[0];
    for (const s of this.sections) if (s.head.offsetTop <= top) current = s;
    for (const s of this.sections) s.tab.classList.toggle('active', s === current);
  }
}
