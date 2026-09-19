# ChessX

Chess meets a trading-card game. Captures are one hit, like chess; Defense is a stack of absorb charges that only summons and grants can give. Each player brings a deck that can summon creatures or play spells. Two players, online, in the browser.

## Running it

```bash
npm install
npm run dev          # server on :8080 + hot-reloading client on :5173
```

Open http://localhost:5173, create an account (email + password works out of the box), then **New game** → send the 5-letter invite code to a friend → they **Join** with it. Your home page lists every game you're in with a live board thumbnail, the opponent's name, both clocks, and a gold highlight on the ones where it's your move. Open a game and everything comes back: board, hands, log and chat. **Practice** starts a throwaway game where you play both sides: it is never saved or listed, gives no XP or rewards, and disappears the moment you leave it.

To test with two accounts on one machine, use a normal window and a private/incognito window (accounts are cookie sessions, so two tabs in the same window share one sign-in).

### Accounts and sign-in

Email/password needs no setup. Google and Facebook sign-in switch on when their keys are present in the server's environment:

| variable | purpose |
| --- | --- |
| `PUBLIC_URL` | The URL players use, e.g. `https://playchessx.com` (dev default `http://localhost:5173`). Used to build OAuth redirect URIs. |
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

ChessX has a real server (websockets, accounts, a SQLite database), so unlike a static game it **cannot be hosted on GitHub Pages**. It needs a small always-on Node host with a persistent disk for the database.

**Your own VPS / droplet** (recommended if you have one): everything is in `deploy/`.

```bash
git clone https://github.com/CrudeTree/ChessX.git /opt/chessx
cp /opt/chessx/deploy/.env.example /opt/chessx/deploy/.env   # set PUBLIC_URL to your domain
/opt/chessx/deploy/deploy.sh                                  # builds the image, starts the container
```

The container listens on `127.0.0.1:8080` only. Point your existing reverse proxy at it — `deploy/nginx.conf.example` (with the WebSocket headers and Cloudflare real-IP settings) or `deploy/Caddyfile.example`. Re-run `deploy.sh` to update. The database lives in the `chessx_data` Docker volume.

DNS on Cloudflare for `playchessx.com`: an **A** record `@` → droplet IP and a **CNAME** `www` → `playchessx.com`, both proxied (orange cloud). Under SSL/TLS pick **Full (strict)** and either install a Cloudflare Origin Certificate in the proxy or use certbot; WebSockets are on by default in Cloudflare's Network settings.

Managed hosts, if you'd rather not run it yourself:

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

**Board and pieces.** Standard chess setup. Castling, en passant and promotion (to queen by default) all work. Standard pieces never start with Defense.

**A turn** is cards and stance changes, then one move that ends the turn:

- **Cards**: as many as you can afford (summons or spells).
- **Leave Defense**: any piece that currently has Defense charges. That piece is frozen for the rest of the turn.
- **Move**: move or attack with one piece. The move ends the turn.
- **Pass** (`End Turn`) is only allowed when you have no legal move at all. You may **not** pass while in check.

**Combat.** Capturing is chess: land on an undefended enemy and it dies; the attacker takes the square. There is no HP or ATK.

**Defense** is a charge count on a piece, not a shield bar. A piece with `defense > 0` is in Defense mode: it cannot move or attack, and it does not give check. A capture against it **destroys Defense** and **repels** the attacker (the piece stays and may act on its next turn). Only leaving Defense yourself skips that piece for the rest of the turn. Charges still stack from grants. Only summons and grants put a piece into Defense — you cannot toggle a standard piece into it. **Battle Trance** drops Defense to 0 and lets that piece act this turn (no skip).

**Kings.** Any piece reaching the king's square captures it. **Royal strike**: the King's own capture destroys any piece, including one in Defense.

**Hex** is a spell that destroys a target enemy Tier 1 piece. It ignores Defense.

**Inspecting.** Click any piece (yours or the opponent's) to see its card on the left: Defense charges if any, movement, lock/summon status. The button is **Leave Defense** when the piece has charges.

**Check and checkmate.** A move may never leave your own king in check. A piece in Defense does not give check. Capturing the checking piece (or Hexing it) resolves the check. While in check you may still play spells and leave Defense, but you cannot end the turn. Checkmate = in check with no single action that gets the king out. A player with no possible move simply passes, so there is no stalemate.

**Deck and hand.** 18–40 cards, max 3 copies of any card. Draw 7 at the start. A green timer ring around your deck fills one segment per turn you take; on your 5th, 10th, 15th… turn it closes and pulses, and you **must click your deck to draw** before doing anything else that turn. Drawing does not use the turn. Cards can also grant extra draws directly. Your deck sits at the bottom-right of the board, the opponent's at the top-left (their right), and you can watch their ring fill too.

**Summon cards.** Pieces have tiers: Pawn = 1, Knight/Bishop = 2, Rook = 3, Queen = 4, King = 6 (never sacrificable). A tier-N summon card is played by dropping it on one of your pieces of tier N−1, which becomes the sacrifice. A void opens beneath it with a timer. While the timer runs the sacrificed piece cannot move or attack. The timer ticks down at the start of each of your turns; when it reaches 0 the piece is replaced by the summoned creature. If the sacrifice is destroyed first, the summon fails and the card is lost.

**Spell cards** resolve immediately: destroy, draw, hasten a summon, or drop Defense (Battle Trance). Kings can't be targeted unless a card says so.

### Progression, collection and decks

- Every account starts with **3 copies of each of the 7 starter cards** and **Deck 1** built from them.
- Finishing a two-player match gives **20 XP**; winning gives **30 more**. Levels need 100, 200, 300… XP each. Practice games don't count.
- Your **first finished match** (win or lose) unlocks a brand-new reward card. After that, every win by **checkmate** rolls a reward: a 50/50 between a reward card you don't own yet and a spare copy of a card you do.
- The **Binder** shows your whole collection (new cards are flagged) and holds up to **3 named decks**. Click a card to add it, use −/+ in the deck list, rename, Save. A deck needs 18–40 cards, max 3 copies of anything, and only cards you own. Pick which deck to play with on the home page before creating, joining or practising.

### Phones

The whole site is responsive. In a game on a phone the board fills the width, your hand is a swipeable strip beneath it (swipe sideways to scroll, drag a card up onto the board to play it, tap it to read it), and the side panels become bottom sheets behind the **Card / Game / Chat** tabs. Tap a piece, then tap a highlighted square to move — it's easier than dragging on a small screen, and both work.

### Notifications

- **While the site is open**: toasts for challenges, friend requests and acceptances; the home page and Friends panel update live. If the tab is in the background, the title flashes ("(1) Your move — ChessX"), the app badge is set, and a soft chime plays.
- **When the site is closed**: browser push notifications for *your move*, *challenge received/accepted*, *friend request*, *chat message* and *game over*. A banner on the home page asks once to turn them on; tapping a notification opens the right game. This uses standard Web Push with a VAPID key pair generated by the server on first run (stored in the database) — no third-party service. On iPhone, notifications require adding ChessX to the home screen first (Apple's rule); the site ships a web-app manifest so that works.

### Friends and challenges

Find people by display name, email, or their 6-character **friend code** (shown on your home page), send a request, and once accepted you'll see them in the Friends panel with an online dot. **Challenge** a friend and a game is created with you seated; they get a notification and an Accept/Decline card on their home page. Accepting starts the game with their chosen deck — no invite codes needed. Declining (or withdrawing) removes the pending game.

### Cards

Cards live in `packages/engine/src/cards/catalog.ts` and are pure data. Starter set:

| card           | type   | effect                                                                  |
| -------------- | ------ | ----------------------------------------------------------------------- |
| The Ox         | Summon | Tier 2, 3 turns. Moves ≤2 orthogonally.                                 |
| Stone Sentinel | Summon | Tier 2, 2 turns. Moves 1 any direction. Starts with 1 Defense.          |
| War Chariot    | Summon | Tier 3, 3 turns. Moves like Rook or Knight.                             |
| Elder Wyrm     | Summon | Tier 4, 4 turns, **costs a Tier 4** (a beefed-up Queen). Moves ≤3 any direction. |
| Foresight      | Spell  | Draw 2                                                                  |
| Hex            | Spell  | Destroy target enemy Tier 1 piece                                       |
| Dark Ritual    | Spell  | A friendly summon timer drops by 2                                      |

Reward cards (unlocked through play):

| card            | type   | effect                                                                           |
| --------------- | ------ | -------------------------------------------------------------------------------- |
| Thornback Boar  | Summon | Tier 2, 2 turns. Charges ≤2 forward or 1 sideways.                                |
| Frost Owl       | Summon | Tier 2, 2 turns. Knight jumps or 1 diagonal.                                      |
| Iron Golem      | Summon | Tier 3, 3 turns. 1 orthogonal. Starts with 1 Defense.                             |
| Shadow Panther  | Summon | Tier 3, 2 turns. ≤3 diagonal or 1 orthogonal.                                     |
| Ancient Treant  | Summon | Tier 3, 3 turns. 1 any direction. Starts with 1 Defense.                           |
| Storm Drake     | Summon | Tier 4, 4 turns. Knight jumps or ≤2 orthogonal.                                   |
| Battle Trance   | Spell  | Friendly piece in Defense mode → Attack mode, and it may still act this turn      |

### Adding a card

Add an entry to `CATALOG`. A summon card carries its creature's `PieceDef`, whose `movement` is data: `leaps` (knight-style jumps), `slides` (rook/bishop-style rays with optional `range`), or `pawn`. Set `relative: true` to make "forward" depend on the owner's colour. Spells are a `target` rule plus a list of `effects`. New effect kinds go in `cards/types.ts` and `rules.ts → applyEffect`.
