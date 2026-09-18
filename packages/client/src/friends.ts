// Friends panel + challenge cards on the home page.

import type { ClientMessage, Social, UserSearchResult } from '@chessx/protocol';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function searchUsers(q: string): Promise<UserSearchResult[]> {
  const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
  if (!res.ok) return [];
  return ((await res.json()) as { results: UserSearchResult[] }).results;
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export class FriendsPanel {
  private social: Social | null = null;

  constructor(
    private send: (msg: ClientMessage) => void,
    /** Deck slot the player has selected on the home page, or null (with an error already shown). */
    private chosenDeck: () => number | null,
  ) {
    $<HTMLFormElement>('friend-search-form').onsubmit = async (e) => {
      e.preventDefault();
      const q = $<HTMLInputElement>('friend-search').value.trim();
      if (q.length < 2) return;
      this.renderResults(await searchUsers(q));
    };
  }

  update(social: Social): void {
    this.social = social;
    $('my-code').textContent = social.myFriendCode;
    this.renderRequests();
    this.renderFriends();
    this.renderChallenges();
    // Refresh any search results so their buttons reflect the new relationship.
    const q = $<HTMLInputElement>('friend-search').value.trim();
    if (q.length >= 2 && $('friend-results').children.length) void searchUsers(q).then((r) => this.renderResults(r));
  }

  private row(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'friend-row';
    return el;
  }

  private btn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = cls;
    b.onclick = onClick;
    return b;
  }

  private renderResults(results: UserSearchResult[]): void {
    const box = $('friend-results');
    box.innerHTML = '';
    if (!results.length) {
      const none = this.row();
      none.innerHTML = '<span class="fname" style="color:var(--muted);font-weight:400">No players found.</span>';
      box.appendChild(none);
      return;
    }
    for (const r of results) {
      const el = this.row();
      el.innerHTML = `<span class="fname">${r.name}</span><span class="flvl">Lv ${r.level} · ${r.friendCode}</span>`;
      if (r.relation === 'none') el.appendChild(this.btn('Add', 'go', () => this.send({ type: 'friendRequest', userId: r.id })));
      else if (r.relation === 'requestedYou') el.appendChild(this.btn('Accept', 'go', () => this.send({ type: 'friendAccept', userId: r.id })));
      else if (r.relation === 'requested') el.appendChild(this.btn('Requested', 'x', () => this.send({ type: 'friendRemove', userId: r.id })));
      else if (r.relation === 'friend') el.insertAdjacentHTML('beforeend', '<span class="flvl">Friend</span>');
      else el.insertAdjacentHTML('beforeend', '<span class="flvl">You</span>');
      box.appendChild(el);
    }
  }

  private renderRequests(): void {
    const s = this.social!;
    const box = $('friend-requests');
    box.innerHTML = '';
    if (s.incomingRequests.length) {
      box.insertAdjacentHTML('beforeend', '<div class="sub-title">Friend requests</div>');
      for (const f of s.incomingRequests) {
        const el = this.row();
        el.innerHTML = `<span class="fname">${f.name}</span><span class="flvl">Lv ${f.level}</span>`;
        el.append(
          this.btn('Accept', 'go', () => this.send({ type: 'friendAccept', userId: f.id })),
          this.btn('✕', 'x', () => this.send({ type: 'friendRemove', userId: f.id })),
        );
        box.appendChild(el);
      }
    }
    if (s.outgoingRequests.length) {
      box.insertAdjacentHTML('beforeend', '<div class="sub-title">Sent</div>');
      for (const f of s.outgoingRequests) {
        const el = this.row();
        el.innerHTML = `<span class="fname">${f.name}</span><span class="flvl">pending</span>`;
        el.appendChild(this.btn('Cancel', 'x', () => this.send({ type: 'friendRemove', userId: f.id })));
        box.appendChild(el);
      }
    }
  }

  private renderFriends(): void {
    const s = this.social!;
    const list = $('friend-list');
    list.innerHTML = '';
    if (s.friends.length) list.insertAdjacentHTML('beforeend', '<div class="sub-title">Your friends</div>');
    for (const f of s.friends) {
      const el = this.row();
      el.innerHTML = `<span class="fdot ${f.online ? 'on' : ''}" title="${f.online ? 'Online' : 'Offline'}"></span><span class="fname">${f.name}</span><span class="flvl">Lv ${f.level}</span>`;
      const pending = s.outgoingChallenges.some((c) => c.to.id === f.id);
      const challenge = this.btn(pending ? 'Challenged' : 'Challenge', 'go', () => {
        const deckSlot = this.chosenDeck();
        if (deckSlot !== null) this.send({ type: 'challenge', friendId: f.id, deckSlot });
      });
      challenge.disabled = pending;
      const remove = this.btn('✕', 'x', () => {
        if (confirm(`Remove ${f.name} from your friends?`)) this.send({ type: 'friendRemove', userId: f.id });
      });
      remove.title = 'Unfriend';
      el.append(challenge, remove);
      list.appendChild(el);
    }
  }

  private renderChallenges(): void {
    const s = this.social!;
    const sec = $('sec-challenges');
    const box = $('challenges');
    box.innerHTML = '';
    const any = s.incomingChallenges.length + s.outgoingChallenges.length > 0;
    sec.classList.toggle('hidden', !any);
    for (const c of s.incomingChallenges) {
      const el = document.createElement('div');
      el.className = 'challenge';
      el.innerHTML = `<div class="ctext"><b>${c.from.name}</b> challenged you to a game! <div class="cwhen">${ago(c.createdAt)}</div></div>`;
      el.append(
        this.btn('Accept', 'go', () => {
          const deckSlot = this.chosenDeck();
          if (deckSlot !== null) this.send({ type: 'acceptChallenge', challengeId: c.id, deckSlot });
        }),
        this.btn('Decline', 'x', () => this.send({ type: 'declineChallenge', challengeId: c.id })),
      );
      box.appendChild(el);
    }
    for (const c of s.outgoingChallenges) {
      const el = document.createElement('div');
      el.className = 'challenge outgoing';
      el.innerHTML = `<div class="ctext">Waiting for <b>${c.to.name}</b> to accept your challenge… <div class="cwhen">${ago(c.createdAt)}</div></div>`;
      el.appendChild(this.btn('Withdraw', 'x', () => this.send({ type: 'declineChallenge', challengeId: c.id })));
      box.appendChild(el);
    }
  }
}
