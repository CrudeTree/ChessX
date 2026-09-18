# ChessX

Chess meets a trading-card game. Every piece has Attack, Defense and HP; each player brings a 30-card deck that can buff pieces or summon new creatures onto the board. Two players, online, in the browser.

## Running it

```bash
npm install
npm run dev          # server on :8080 + hot-reloading client on :5173
```

Open http://localhost:5173, create a game, send the 5-letter invite code to a friend, they join with it. To test alone, open a second tab and join your own code.

Other scripts:

| command             | what it does                                            |
| ------------------- | ------------------------------------------------------- |
| `npm test`          | engine unit tests (vitest)                              |
| `npm run typecheck` | type-checks all four packages                           |
| `npm run build`     | builds the client into `packages/client/dist`           |
| `npm start`         | production server: serves the built client + websocket on `PORT` (default 8080) |

To play over the internet, deploy `npm start` to any Node host (Fly.io, Render, Railway, a $5 VPS) and share the URL. The server is a single process with no database; rooms live in memory.

## Project layout

```
packages/
  engine/    Pure TypeScript rules engine. No UI, no network. Shared by server + client.
  protocol/  Message types exchanged over the websocket.
  server/    Node + ws. Rooms by invite code, authoritative game state, reconnect tokens.
  client/    Vite + PixiJS. Board, hand, drag-and-drop, animations.
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

**Deck and hand.** 30 cards, max 3 copies of any card. Draw 7 at the start. A green timer ring around your deck fills one segment per turn you take; on your 5th, 10th, 15th… turn it closes and pulses, and you **must click your deck to draw** before doing anything else that turn. Drawing does not use the turn. Cards can also grant extra draws directly. Your deck sits at the bottom-right of the board, the opponent's at the top-left (their right), and you can watch their ring fill too.

**Summon cards.** Pieces have tiers: Pawn = 1, Knight/Bishop = 2, Rook = 3, Queen = 4. A tier-N summon card is played by dropping it on one of your pieces of tier N−1, which becomes the sacrifice. A void opens beneath it with a timer. While the timer runs the sacrificed piece cannot move or attack. The timer ticks down at the start of each of your turns; when it reaches 0 the piece is replaced by the summoned creature. If the sacrifice is destroyed first, the summon fails and the card is lost.

**Spell cards** resolve immediately: stat buffs, damage, heals, draws, and hastening a summon. Kings can't be targeted unless a card says so.

### Sample cards

These are placeholders to exercise the engine — they live in `packages/engine/src/cards/catalog.ts` and are pure data.

| card           | type   | effect                                                                  |
| -------------- | ------ | ----------------------------------------------------------------------- |
| The Ox         | Summon | Tier 2, 3 turns. Moves ≤2 orthogonally. 2 ATK / 0 DEF / 2 HP           |
| Stone Sentinel | Summon | Tier 2, 2 turns. Moves 1 any direction. 1 ATK / 1 DEF / 3 HP           |
| War Chariot    | Summon | Tier 3, 3 turns. Moves like Rook or Knight. 2 ATK / 0 DEF / 2 HP       |
| Elder Wyrm     | Summon | Tier 4, 4 turns. Moves ≤3 any direction. 3 ATK / 1 DEF / 3 HP          |
| Iron Hide      | Spell  | Friendly piece +2 HP                                                    |
| Whetstone      | Spell  | Friendly piece +1 ATK (kings allowed)                                   |
| Shield Wall    | Spell  | Friendly piece +1 DEF                                                   |
| Foresight      | Spell  | Draw 2                                                                  |
| Hex            | Spell  | 1 damage to an enemy piece                                              |
| Dark Ritual    | Spell  | A friendly summon timer drops by 2                                      |

Both players currently use the same starter deck (3 of each). A deck builder is the natural next step.

### Adding a card

Add an entry to `CATALOG`. A summon card carries its creature's `PieceDef`, whose `movement` is data: `leaps` (knight-style jumps), `slides` (rook/bishop-style rays with optional `range`), or `pawn`. Set `relative: true` to make "forward" depend on the owner's colour. Spells are a `target` rule plus a list of `effects`. New effect kinds go in `cards/types.ts` and `rules.ts → applyEffect`.
