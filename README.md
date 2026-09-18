# ChessX

Chess meets a trading-card game. Every piece has Attack, Defense and HP; each player brings a 30-card deck that can buff pieces or summon new creatures onto the board. Two players, online, in the browser.

## Running it

```bash
npm install
npm run dev          # server on :8080 + hot-reloading client on :5173
```

Open http://localhost:5173, create an account (email + password works out of the box), then **New game** → send the 5-letter invite code to a friend → they **Join** with it. Your home page lists every game you're in with a live board thumbnail, the opponent's name, both clocks, and a gold highlight on the ones where it's your move. Open a game and everything comes back: board, hands, log and chat. **Practice** starts a game where you play both sides.

To test with two accounts on one machine, use a normal window and a private/incognito window (accounts are cookie sessions, so two tabs in the same window share one sign-in).

### Accounts and sign-in

Email/password needs no setup. Google and Facebook sign-in switch on when their keys are present in the server's environment:

| variable | purpose |
| --- | --- |
| `PUBLIC_URL` | The URL players use, e.g. `https://chessx.example.com` (dev default `http://localhost:5173`). Used to build OAuth redirect URIs. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → OAuth client (Web). Add `PUBLIC_URL/api/auth/google/callback` as an authorised redirect URI. |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | From [Meta for Developers](https://developers.facebook.com/) → app → Facebook Login. Add `PUBLIC_URL/api/auth/facebook/callback` as a valid OAuth redirect URI. |
| `DB_PATH` | SQLite file location (default `packages/server/data/chessx.sqlite`). |
| `PORT` | Server port (default 8080). |

If a Google/Facebook account shares an email with an existing password account, they are linked to the same player.

### Turn clocks

Each player has **3 days** per game. Your clock only runs while it's your turn, whether or not you're online. Run out and you lose on time; the server checks clocks on every load and every 30 seconds, so a timed-out game is settled even if nobody has it open.

Other scripts:

| command             | what it does                                            |
| ------------------- | ------------------------------------------------------- |
| `npm test`          | engine unit tests (vitest)                              |
| `npm run typecheck` | type-checks all four packages                           |
| `npm run build`     | builds the client into `packages/client/dist`           |
| `npm start`         | production server: serves the built client + websocket on `PORT` (default 8080) |

## Putting it online

ChessX has a real server (websockets, accounts, a SQLite database), so unlike a static game it **cannot be hosted on GitHub Pages**. It needs a small always-on Node host with a persistent disk for the database. The repo ships ready-to-go configs for two:

**Render** (simplest): dashboard → *New* → *Blueprint* → pick this repo; `render.yaml` sets up a Docker web service with a 1 GB persistent disk. Set `PUBLIC_URL` to the URL Render assigns (e.g. `https://chessx.onrender.com`). Needs the Starter plan (~$7/mo) because the free tier's disk is wiped whenever it spins down, which would erase everyone's games.

**Fly.io** (cheapest, ~$2–3/mo): install `flyctl`, then

```bash
fly launch --no-deploy        # creates the app; keep the generated settings from fly.toml
fly volumes create chessx_data --size 1
fly secrets set PUBLIC_URL=https://chessx.fly.dev
fly deploy
```

Any other Docker host or a plain VPS works too: build the `Dockerfile`, mount a volume at `/data`, set `PUBLIC_URL`. Add the Google/Facebook keys as secrets when you want those sign-in buttons.

## Project layout

```
packages/
  engine/    Pure TypeScript rules engine. No UI, no network. Shared by server + client.
  protocol/  Message types: HTTP (accounts) and websocket (games).
  server/    Node + ws + SQLite (node:sqlite, no native deps). Accounts, persistent games,
             turn clocks, chat history. Authoritative game state.
  client/    Vite + PixiJS. Sign-in, home page, board, hand, drag-and-drop, animations, chat.
```

The server is authoritative: the client only ever offers the player actions from the `legalActions` list the server sends, and the server re-validates everything.

## Rules as implemented

**Board and pieces.** Standard chess setup. Every piece starts with **1 ATK / 0 DEF / 1 HP**. Castling, en passant and promotion (to queen by default) all work.

**A turn** is a sequence of actions that you close with **End Turn**:

- **One major action**: move/attack a piece **or** play a summon card. Never both.
- **Spells**: as many as you like.
- **Stance switches**: as many pieces as you like, in either direction. A piece that switched this turn is frozen (can't move or switch again) until the turn ends.
- You may end your turn without moving. You may **not** end it while in check.

**Combat.** Moving onto an enemy piece attacks it for the attacker's full ATK. If the defender is in **Defense mode**, its DEF acts as a shield that absorbs damage first; whatever is left comes off HP. In Attack mode DEF does nothing. If HP hits 0 the defender is destroyed and the attacker takes its square. If the defender survives, it stays and the attacker returns to its original square (the turn is still used). **Kings ignore HP**: any piece reaching the king's square captures it.

Example: DEF 3 / HP 1 in Defense mode, hit by ATK 4 → shield wiped out, 1 damage reaches HP, piece destroyed. Depleted DEF does not regenerate on its own.

**Stance.** Every piece starts in Attack mode. Switching stance (via the button under the zoomed card) is free and unlimited, but the piece is frozen for the rest of that turn. A piece in Defense mode cannot move or attack at all (so it never gives check) until you switch it back to Attack mode; after switching back it can act from your next turn. Kings and pieces being sacrificed cannot change stance.

**Inspecting.** Click any piece (yours or the opponent's) to see its full card on the left: stats, stance, movement, lock/summon status.

**Check and checkmate.** A move may never leave your own king in check. Because pieces can survive attacks, "capturing" the checking piece does not resolve check unless the capture actually destroys it. While in check you may still play spells and switch stances (a Hex that kills the attacker is a fine answer), but you cannot summon and you cannot end the turn. Checkmate = in check with no single action that gets the king out. There is no stalemate: a player who is not in check may simply end the turn.

**Deck and hand.** 25–40 cards, max 3 copies of any card. Draw 7 at the start. A green timer ring around your deck fills one segment per turn you take; on your 5th, 10th, 15th… turn it closes and pulses, and you **must click your deck to draw** before doing anything else that turn. Drawing does not use the turn. Cards can also grant extra draws directly. Your deck sits at the bottom-right of the board, the opponent's at the top-left (their right), and you can watch their ring fill too.

**Summon cards.** Pieces have tiers: Pawn = 1, Knight/Bishop = 2, Rook = 3, Queen = 4. A tier-N summon card is played by dropping it on one of your pieces of tier N−1, which becomes the sacrifice. A void opens beneath it with a timer. While the timer runs the sacrificed piece cannot move or attack. The timer ticks down at the start of each of your turns; when it reaches 0 the piece is replaced by the summoned creature. If the sacrifice is destroyed first, the summon fails and the card is lost.

**Spell cards** resolve immediately: stat buffs, damage, heals, draws, and hastening a summon. Kings can't be targeted unless a card says so.

### Progression, collection and decks

- Every account starts with **3 copies of each of the 10 starter cards** and **Deck 1** built from them.
- Finishing a two-player match gives **20 XP**; winning gives **30 more**. Levels need 100, 200, 300… XP each. Practice games don't count.
- Your **first finished match** (win or lose) unlocks a brand-new reward card. After that, every win by **checkmate** rolls a reward: a 50/50 between a reward card you don't own yet and a spare copy of a card you do.
- The **Binder** shows your whole collection (new cards are flagged) and holds up to **3 named decks**. Click a card to add it, use −/+ in the deck list, rename, Save. A deck needs 25–40 cards, max 3 copies of anything, and only cards you own. Pick which deck to play with on the home page before creating, joining or practising.

### Cards

Cards live in `packages/engine/src/cards/catalog.ts` and are pure data. Starter set:

| card           | type   | effect                                                                  |
| -------------- | ------ | ----------------------------------------------------------------------- |
| The Ox         | Summon | Tier 2, 3 turns. Moves ≤2 orthogonally. 2 ATK / 0 DEF / 2 HP           |
| Stone Sentinel | Summon | Tier 2, 2 turns. Moves 1 any direction. 1 ATK / 1 DEF / 3 HP           |
| War Chariot    | Summon | Tier 3, 3 turns. Moves like Rook or Knight. 2 ATK / 0 DEF / 2 HP       |
| Elder Wyrm     | Summon | Tier 4, 4 turns, **costs a Tier 4** (a beefed-up Queen). Moves ≤3 any direction. 3 ATK / 1 DEF / 3 HP |
| Iron Hide      | Spell  | Friendly piece +2 HP                                                    |
| Whetstone      | Spell  | Friendly piece +1 ATK (kings allowed)                                   |
| Shield Wall    | Spell  | Friendly piece +1 DEF                                                   |
| Foresight      | Spell  | Draw 2                                                                  |
| Hex            | Spell  | 1 damage to an enemy piece                                              |
| Dark Ritual    | Spell  | A friendly summon timer drops by 2                                      |

Reward cards (unlocked through play):

| card            | type   | effect                                                                           |
| --------------- | ------ | -------------------------------------------------------------------------------- |
| Thornback Boar  | Summon | Tier 2, 2 turns. Charges ≤2 forward or 1 sideways. 2 ATK / 0 DEF / 1 HP           |
| Frost Owl       | Summon | Tier 2, 2 turns. Knight jumps or 1 diagonal. 1 ATK / 0 DEF / 2 HP                 |
| Iron Golem      | Summon | Tier 3, 3 turns. 1 orthogonal. 2 ATK / 2 DEF / 3 HP                               |
| Shadow Panther  | Summon | Tier 3, 2 turns. ≤3 diagonal or 1 orthogonal. 3 ATK / 0 DEF / 1 HP                |
| Ancient Treant  | Summon | Tier 3, 3 turns. 1 any direction. 1 ATK / 3 DEF / 4 HP                            |
| Storm Drake     | Summon | Tier 4, 4 turns. Knight jumps or ≤2 orthogonal. 3 ATK / 0 DEF / 2 HP              |
| Battle Cry      | Spell  | All your Pawns +1 ATK                                                             |
| Second Wind     | Spell  | Friendly piece: refill HP and DEF shield                                          |
| Battle Trance   | Spell  | Friendly piece in Defense mode → Attack mode, and it may still act this turn      |
| Smite           | Spell  | 2 damage to an enemy piece                                                        |

### Adding a card

Add an entry to `CATALOG`. A summon card carries its creature's `PieceDef`, whose `movement` is data: `leaps` (knight-style jumps), `slides` (rook/bishop-style rays with optional `range`), or `pawn`. Set `relative: true` to make "forward" depend on the owner's colour. Spells are a `target` rule plus a list of `effects`. New effect kinds go in `cards/types.ts` and `rules.ts → applyEffect`.
