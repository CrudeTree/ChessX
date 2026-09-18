// Friends and challenges.
//
//  Friend requests: A asks B (row A->B 'pending'); B accepts (rows A->B and
//  B->A both 'accepted'). Declining/cancelling/unfriending deletes both rows.
//
//  Challenges: the challenger's game is created immediately (they are seated),
//  and a pending challenge points at it. Accepting joins that game with the
//  invitee's chosen deck; declining or cancelling removes the game again.

import { levelFor, type ChallengeInfo, type FriendInfo, type Social, type UserSearchResult } from '@chessx/protocol';
import { newId, type Db, type UserRow } from './db.js';

export class SocialError extends Error {}

export class SocialService {
  /** Who currently has a socket open (for the online dot). */
  isOnline: (userId: string) => boolean = () => false;

  constructor(private db: Db) {}

  private info(u: UserRow): FriendInfo {
    return { id: u.id, name: u.name, avatarUrl: u.avatar_url, online: this.isOnline(u.id), level: levelFor(u.xp) };
  }

  social(user: UserRow): Social {
    const rows = this.db.friendRows(user.id);
    const friends: FriendInfo[] = [];
    const incomingRequests: FriendInfo[] = [];
    const outgoingRequests: FriendInfo[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const otherId = r.user_id === user.id ? r.friend_id : r.user_id;
      const other = this.db.userById(otherId);
      if (!other) continue;
      if (r.status === 'accepted') {
        if (!seen.has(otherId)) {
          seen.add(otherId);
          friends.push(this.info(other));
        }
      } else if (r.user_id === user.id) outgoingRequests.push(this.info(other));
      else incomingRequests.push(this.info(other));
    }
    friends.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

    const challenges = this.db.pendingChallengesFor(user.id).map((c): ChallengeInfo | null => {
      const from = this.db.userById(c.from_user);
      const to = this.db.userById(c.to_user);
      if (!from || !to) return null;
      return { id: c.id, from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, gameId: c.game_id, createdAt: c.created_at };
    });
    const live = challenges.filter((c): c is ChallengeInfo => !!c);
    return {
      myFriendCode: this.db.friendCodeFor(user),
      friends,
      incomingRequests,
      outgoingRequests,
      incomingChallenges: live.filter((c) => c.to.id === user.id),
      outgoingChallenges: live.filter((c) => c.from.id === user.id),
    };
  }

  // ----------------------------------------------------------------- search

  search(me: UserRow, q: string): UserSearchResult[] {
    q = q.trim();
    if (q.length < 2) return [];
    const found = new Map<string, UserRow>();
    const byCode = this.db.userByFriendCode(q);
    if (byCode) found.set(byCode.id, byCode);
    if (q.includes('@')) {
      const byEmail = this.db.userByEmail(q);
      if (byEmail) found.set(byEmail.id, byEmail);
    }
    for (const u of this.db.searchUsersByName(q)) found.set(u.id, u);
    return [...found.values()].slice(0, 10).map((u) => ({
      id: u.id,
      name: u.name,
      friendCode: this.db.friendCodeFor(u),
      level: levelFor(u.xp),
      relation: this.relation(me.id, u.id),
    }));
  }

  private relation(meId: string, otherId: string): UserSearchResult['relation'] {
    if (meId === otherId) return 'you';
    const mine = this.db.friendRow(meId, otherId);
    const theirs = this.db.friendRow(otherId, meId);
    if (mine?.status === 'accepted' || theirs?.status === 'accepted') return 'friend';
    if (mine?.status === 'pending') return 'requested';
    if (theirs?.status === 'pending') return 'requestedYou';
    return 'none';
  }

  // --------------------------------------------------------------- requests

  /** Returns the other user (so callers can notify them). */
  request(me: UserRow, otherId: string): UserRow {
    const other = this.db.userById(otherId);
    if (!other) throw new SocialError('No such player.');
    if (other.id === me.id) throw new SocialError("That's you.");
    const rel = this.relation(me.id, other.id);
    if (rel === 'friend') throw new SocialError(`You and ${other.name} are already friends.`);
    if (rel === 'requested') throw new SocialError('Request already sent.');
    if (rel === 'requestedYou') return this.accept(me, other.id); // they asked first: just accept
    this.db.upsertFriend(me.id, other.id, 'pending');
    return other;
  }

  accept(me: UserRow, otherId: string): UserRow {
    const other = this.db.userById(otherId);
    if (!other) throw new SocialError('No such player.');
    const theirs = this.db.friendRow(other.id, me.id);
    if (theirs?.status !== 'pending') throw new SocialError('No pending request from that player.');
    this.db.upsertFriend(other.id, me.id, 'accepted');
    this.db.upsertFriend(me.id, other.id, 'accepted');
    return other;
  }

  remove(me: UserRow, otherId: string): UserRow {
    const other = this.db.userById(otherId);
    if (!other) throw new SocialError('No such player.');
    this.db.deleteFriendPair(me.id, other.id);
    return other;
  }

  areFriends(a: string, b: string): boolean {
    return this.relation(a, b) === 'friend';
  }

  // ------------------------------------------------------------- challenges

  createChallenge(fromId: string, toId: string, gameId: string): string {
    const id = newId(9);
    this.db.insertChallenge({ id, from_user: fromId, to_user: toId, game_id: gameId, status: 'pending', created_at: Date.now() });
    return id;
  }

  pendingChallenge(id: string) {
    const c = this.db.challengeById(id);
    if (!c || c.status !== 'pending') throw new SocialError('That challenge is no longer open.');
    return c;
  }

  resolveChallenge(id: string, status: 'accepted' | 'declined'): void {
    this.db.setChallengeStatus(id, status);
  }
}
