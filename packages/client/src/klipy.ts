// GIF search for the chat, from KLIPY (klipy.com). Their terms shape this file: requests go straight from the
// browser, media URLs are used exactly as returned, results keep their order, and the search box says "Search KLIPY".

import { isKlipyMediaUrl, type ChatGif } from '@chessx/protocol';

const API = 'https://api.klipy.com/api/v1';
const PER_PAGE = 24;
const SEARCH_DELAY_MS = 450;
const MIN_QUERY = 2;
/** KLIPY's "medium" safety level: nothing past PG. */
const CONTENT_FILTER = 'medium';
/** A test key allows 100 requests an hour for the whole site, so a page fetched once is reused for a while. */
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 40;
const CUSTOMER_KEY = 'chessx.klipy.customer';

interface KlipyFile {
  url: string;
  width: number;
  height: number;
}
type KlipySize = Partial<Record<'gif' | 'webp', KlipyFile>>;
interface KlipyItem {
  slug?: string;
  title?: string;
  blur_preview?: string;
  file?: Partial<Record<'hd' | 'md' | 'sm' | 'xs', KlipySize>>;
}
interface KlipyPage {
  items: KlipyItem[];
  hasNext: boolean;
}

class KlipyError extends Error {}

/** A random id for this browser, which KLIPY uses to personalise results. It is not the player's account. */
function customerId(): string {
  try {
    let id = localStorage.getItem(CUSTOMER_KEY);
    if (!id) {
      id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(CUSTOMER_KEY, id);
    }
    return id;
  } catch {
    return 'anonymous';
  }
}

/** The player's country as KLIPY wants it ("us"), from the browser's language. */
function country(): string | null {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return region && /^[A-Z]{2}$/.test(region) ? region.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function fetchPage(key: string, query: string, page: number, signal: AbortSignal): Promise<KlipyPage> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(PER_PAGE),
    customer_id: customerId(),
    content_filter: CONTENT_FILTER,
    format_filter: 'webp,gif',
  });
  const locale = country();
  if (locale) params.set('locale', locale);
  if (query) params.set('q', query);
  const url = `${API}/${encodeURIComponent(key)}/gifs/${query ? 'search' : 'trending'}?${params}`;
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new KlipyError("Couldn't reach KLIPY. Check your connection and try again.");
  }
  if (res.status === 429) throw new KlipyError('Lots of GIF searches right now. Try again in a few minutes.');
  const body = (await res.json().catch(() => null)) as { result?: boolean; data?: { data?: unknown; has_next?: unknown } } | null;
  if (!res.ok || !body?.result) {
    console.warn('KLIPY refused the request', res.status, body);
    throw new KlipyError(res.status >= 500 ? "KLIPY isn't answering. Try again soon." : 'GIFs are not available right now.');
  }
  return { items: Array.isArray(body.data?.data) ? (body.data.data as KlipyItem[]) : [], hasNext: body.data?.has_next === true };
}

/** Tells KLIPY a GIF was sent, which they use to rank results. Fire and forget. */
function reportShare(key: string, slug: string, query: string): void {
  void fetch(`${API}/${encodeURIComponent(key)}/gifs/share/${encodeURIComponent(slug)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId(), q: query }),
    keepalive: true,
  }).catch(() => {});
}

/** The first of the sizes that has a usable picture, WebP before GIF. */
function pickFile(item: KlipyItem, sizes: ('hd' | 'md' | 'sm' | 'xs')[]): KlipyFile | null {
  for (const size of sizes) {
    for (const format of ['webp', 'gif'] as const) {
      const f = item.file?.[size]?.[format];
      if (f && typeof f.url === 'string' && isKlipyMediaUrl(f.url) && Number.isInteger(f.width) && Number.isInteger(f.height) && f.width > 0 && f.height > 0 && f.width <= 4096 && f.height <= 4096) {
        return f;
      }
    }
  }
  return null;
}

const BLUR_PREVIEW = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

/** Trending GIFs, or a search, in two columns that load more as you scroll. A tap sends one. */
export class GifPicker {
  readonly el = el('div', 'chat-pop chat-gifs hidden');
  onPick: (gif: ChatGif) => void = () => {};

  private key: string | null = null;
  private readonly search = el('input', 'chat-gif-search');
  private readonly results = el('div', 'chat-gif-results');
  private readonly cols = [el('div', 'chat-gif-col'), el('div', 'chat-gif-col')];
  private readonly status = el('div', 'chat-gif-status');
  private colHeights = [0, 0];
  private picks: { slug: string; gif: ChatGif }[] = [];
  /** What is showing: the search ('' is trending), the last page loaded, and whether KLIPY has more. */
  private query = '';
  private page = 0;
  private hasNext = false;
  private loading: AbortController | null = null;
  private searchTimer = 0;
  private readonly cache = new Map<string, { page: KlipyPage; at: number }>();

  constructor() {
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'GIFs');
    const s = this.search;
    s.type = 'search';
    s.placeholder = 'Search KLIPY';
    s.setAttribute('aria-label', 'Search KLIPY');
    s.autocomplete = 'off';
    s.enterKeyHint = 'search';
    s.maxLength = 60;
    s.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => this.run(), SEARCH_DELAY_MS);
    });
    s.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(this.searchTimer);
      this.run();
    });
    const grid = el('div', 'chat-gif-grid');
    grid.append(...this.cols);
    this.results.append(grid, this.status);
    this.results.addEventListener('scroll', () => this.loadMoreIfNear(), { passive: true });
    this.results.addEventListener('click', (e) => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      const pick = tile ? this.picks[Number(tile.dataset.i)] : undefined;
      if (!pick || !this.key) return;
      reportShare(this.key, pick.slug, this.query);
      this.onPick(pick.gif);
    });
    this.el.append(s, this.results, el('div', 'chat-gif-credit', 'Powered by KLIPY'));
  }

  /** The KLIPY app key from the server; without one there are no GIFs. */
  setKey(key: string | null): void {
    if (key === this.key) return;
    this.key = key;
    this.cache.clear();
    this.page = 0;
  }

  get available(): boolean {
    return this.key !== null;
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }

  open(): void {
    this.el.classList.remove('hidden');
    if (this.page === 0 && !this.loading) this.run(true);
    // A phone's keyboard would cover the GIFs, so only a mouse gets the search box focused straight away.
    if (matchMedia('(pointer: fine)').matches) this.search.focus();
  }

  close(): void {
    this.el.classList.add('hidden');
  }

  /** Start over with what is in the search box: a search from two letters, trending otherwise. */
  private run(force = false): void {
    const typed = this.search.value.trim();
    const query = typed.length >= MIN_QUERY ? typed : '';
    if (!force && query === this.query && this.page > 0) return;
    this.query = query;
    this.page = 0;
    this.hasNext = false;
    this.picks = [];
    this.colHeights = [0, 0];
    for (const c of this.cols) c.replaceChildren();
    this.results.scrollTop = 0;
    void this.load();
  }

  private loadMoreIfNear(): void {
    const r = this.results;
    if (this.hasNext && !this.loading && r.scrollTop + r.clientHeight > r.scrollHeight - 240) void this.load();
  }

  private async load(): Promise<void> {
    if (!this.key) return;
    this.loading?.abort();
    const ctl = new AbortController();
    this.loading = ctl;
    const page = this.page + 1;
    const cacheKey = `${this.query}\n${page}`;
    this.setStatus(page === 1 ? 'Loading GIFs…' : 'Loading more…');
    try {
      const hit = this.cache.get(cacheKey);
      const result = hit && Date.now() - hit.at < CACHE_MS ? hit.page : await fetchPage(this.key, this.query, page, ctl.signal);
      if (ctl.signal.aborted) return;
      if (!hit || hit.page !== result) {
        this.cache.set(cacheKey, { page: result, at: Date.now() });
        if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      }
      this.page = page;
      this.hasNext = result.hasNext;
      this.append(result.items);
      this.setStatus(this.picks.length ? '' : this.query ? `No GIFs for “${this.query}”.` : 'No GIFs right now.');
    } catch (err) {
      if (ctl.signal.aborted) return;
      this.setStatus(err instanceof KlipyError ? err.message : "Couldn't load GIFs. Try again.", true);
    } finally {
      if (this.loading === ctl) this.loading = null;
    }
  }

  /** Each GIF goes under the shorter column, which keeps KLIPY's order reading top to bottom. */
  private append(items: KlipyItem[]): void {
    for (const item of items) {
      const thumb = pickFile(item, ['sm', 'xs', 'md']);
      const full = pickFile(item, ['md', 'sm', 'hd']);
      if (!thumb || !full || typeof item.slug !== 'string') continue;
      const title = typeof item.title === 'string' ? item.title.slice(0, 120) : '';
      const index = this.picks.push({ slug: item.slug, gif: { url: full.url, width: full.width, height: full.height, title } }) - 1;
      const tile = el('button', 'chat-gif-tile');
      tile.type = 'button';
      tile.dataset.i = String(index);
      tile.title = title;
      tile.style.aspectRatio = `${thumb.width} / ${thumb.height}`;
      if (typeof item.blur_preview === 'string' && BLUR_PREVIEW.test(item.blur_preview)) tile.style.backgroundImage = `url("${item.blur_preview}")`;
      const img = el('img');
      img.src = thumb.url;
      img.width = thumb.width;
      img.height = thumb.height;
      img.alt = title || 'GIF';
      img.loading = 'lazy';
      img.decoding = 'async';
      tile.append(img);
      const col = this.colHeights[0]! <= this.colHeights[1]! ? 0 : 1;
      this.cols[col]!.append(tile);
      this.colHeights[col]! += thumb.height / thumb.width;
    }
  }

  private setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
    this.status.classList.toggle('hidden', !text);
  }
}
