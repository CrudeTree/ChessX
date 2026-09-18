import { describe, expect, it } from 'vitest';
import { Db } from '../src/db.js';
import { GameManager } from '../src/games.js';
import { Progression } from '../src/progression.js';
import { SocialError, SocialService } from '../src/social.js';

function setup() {
  const db = new Db(':memory:');
  const social = new SocialService(db);
  const progression = new Progression(db);
  const games = new GameManager(db, (id) => db.userById(id)?.name ?? '?');
  const mk = (name: string) =>
    db.createUser({ email: `${name.toLowerCase()}@x.test`, name, password_hash: null, google_id: null, facebook_id: null, avatar_url: null });
  return { db, social, progression, games, alice: mk('Alice'), bob: mk('Bob'), carol: mk('Carol') };
}

describe('friends', () => {
  it('request -> accept makes a mutual friendship; remove undoes it', () => {
    const { social, alice, bob } = setup();
    expect(social.social(alice).friends).toHaveLength(0);

    social.request(alice, bob.id);
    expect(social.social(alice).outgoingRequests.map((f) => f.name)).toEqual(['Bob']);
    expect(social.social(bob).incomingRequests.map((f) => f.name)).toEqual(['Alice']);
    expect(() => social.request(alice, bob.id)).toThrow(SocialError); // already sent

    social.accept(bob, alice.id);
    expect(social.areFriends(alice.id, bob.id)).toBe(true);
    expect(social.social(alice).friends.map((f) => f.name)).toEqual(['Bob']);
    expect(social.social(bob).friends.map((f) => f.name)).toEqual(['Alice']);
    expect(social.social(alice).outgoingRequests).toHaveLength(0);

    social.remove(alice, bob.id);
    expect(social.areFriends(alice.id, bob.id)).toBe(false);
  });

  it('requesting someone who already asked you just accepts', () => {
    const { social, alice, bob } = setup();
    social.request(bob, alice.id);
    social.request(alice, bob.id);
    expect(social.areFriends(alice.id, bob.id)).toBe(true);
  });

  it('search finds by name, friend code and email, with the right relation', () => {
    const { social, db, alice, bob } = setup();
    const code = db.friendCodeFor(bob);
    expect(code).toHaveLength(6);
    expect(social.search(alice, 'bo').map((r) => r.name)).toEqual(['Bob']);
    expect(social.search(alice, code)[0]?.name).toBe('Bob');
    expect(social.search(alice, 'bob@x.test')[0]?.name).toBe('Bob');
    expect(social.search(alice, 'ali')[0]?.relation).toBe('you');
    social.request(alice, bob.id);
    expect(social.search(alice, 'bob')[0]?.relation).toBe('requested');
    expect(social.search(bob, 'alice')[0]?.relation).toBe('requestedYou');
  });

  it('cannot friend yourself or unknown players', () => {
    const { social, alice } = setup();
    expect(() => social.request(alice, alice.id)).toThrow(SocialError);
    expect(() => social.request(alice, 'nope')).toThrow(SocialError);
  });
});

describe('challenges', () => {
  it('challenge creates a waiting game; accepting starts it with both decks', () => {
    const { social, progression, games, alice, bob } = setup();
    social.request(alice, bob.id);
    social.accept(bob, alice.id);

    const deck = progression.deckForPlay(alice.id, 1);
    const game = games.create(alice.id, false, deck);
    const challengeId = social.createChallenge(alice.id, bob.id, game.id);
    expect(social.social(bob).incomingChallenges.map((c) => c.from.name)).toEqual(['Alice']);
    expect(social.social(alice).outgoingChallenges.map((c) => c.to.name)).toEqual(['Bob']);
    expect(games.summariesFor(alice.id)[0]?.waitingForOpponent).toBe(true);

    const c = social.pendingChallenge(challengeId);
    game.join(bob.id, progression.deckForPlay(bob.id, 1));
    social.resolveChallenge(c.id, 'accepted');
    expect(game.state).not.toBeNull();
    expect(game.isParticipant(bob.id)).toBe(true);
    expect(social.social(bob).incomingChallenges).toHaveLength(0);
    expect(() => social.pendingChallenge(challengeId)).toThrow(SocialError);
  });

  it('declining removes the pending game', () => {
    const { social, progression, games, db, alice, bob } = setup();
    const game = games.create(alice.id, false, progression.deckForPlay(alice.id, 1));
    const id = social.createChallenge(alice.id, bob.id, game.id);
    social.resolveChallenge(id, 'declined');
    games.discardUnstarted(game.id);
    expect(db.gameById(game.id)).toBeUndefined();
    expect(games.summariesFor(alice.id)).toHaveLength(0);
  });

  it('a deck that is not ready cannot be used to challenge', () => {
    const { progression, alice } = setup();
    expect(() => progression.deckForPlay(alice.id, 2)).toThrow(/not ready/);
  });
});
