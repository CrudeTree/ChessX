# ChessX rules (owner's current draft)

Source: Djabooty, 2026-10-05. This is the rules baseline to design, playtest, and balance against.

## Game layout

- **Board:** 6x8 grid. Rank 1 is Player One's back row, rank 8 is Player Two's.
- **Setup:** Kings on d1 and d8. Players draw 7 cards. Players take turns deploying 3 zero-cost pieces to their back row. Each player starts with 2 mana.
- **Resources:** One action per turn. Gain 1 mana per turn (no cap). Draw 1 card per turn.
- **Turn sequence:** Gain mana, draw a card, take one action (move a piece, summon a piece to the back row, or seal a piece onto another), play one spell.
- **Summoning:** Costs mana. Pieces have summoning sickness: no capture on the turn they appear. They still attack squares, so they give check at once.
- **Sealing:** Costs mana and your action. Place a card face down on a piece to create a seal. Seals cannot move or capture and can be destroyed by an enemy. A seal's timer counts down on each of your turns. When it hits 0, the new piece hatches on that square.
- **Winning:** Checkmate the enemy King. Normal chess check rules apply.

## What was removed

- **Attack and defense stats.** Combat is pure chess capture: move into a square to take it. No ATK/DEF comparison and no hit points.
- **Piece-generated mana.** The only mana source is a fixed +1 per turn from your King.
- **Traditional starting pieces.** No starting pawns, rooks, knights, bishops, or queens. Each player starts with only a King and summons the whole army.
- **Mana cap.** Mana can be banked without limit.
- **Tribute cost.** Summoning costs mana. Tributing a piece is no longer a cost. It is now the placement choice for the seal mechanic.
- **8x8 board.** The board is 6x8 so the first clash comes sooner.
- **Pieces sharing a square.** One piece per square, always.

## Rulings (decided by Djabooty, 2026-10-05)

- **Hatching:** A seal hatches into the card that was placed face down. The choice is made when the seal is created, not when it hatches. That makes a seal a readable, predictable threat the opponent can plan around for its whole timer.
- **Sealed piece:** The piece underneath is consumed. It is removed from play and does not return. This is the cost of sealing: you gain position (summoning deep) and tempo (the new piece appears on a timer, in place), but lose the body you sacrificed.
- **Destroying a seal:** Capturing the seal's square destroys it. An enemy piece moves onto that square, and both the seal token and the card underneath go to the discard pile. A seal is a piece and a sitting duck, and that is its weakness. A spell may destroy seals only if that spell says so. It is not a general rule.
- **Summoning sickness:** Summoned and hatched pieces have it. They wait until their owner's next turn to capture. The 3 starting zero-cost pieces do not. They count as already on the board before the game began and can act normally on turn 1.
- **Check is a board fact (changed by Djabooty, 2026-10-08):** A sick piece cannot capture, but it still attacks the squares it reaches. It gives check the moment it appears, and the enemy King cannot step into its reach. Example: a Wyrmling hatches on d6, Black must answer check on d8 at once, and no King step into the Wyrmling's reach is legal. The same holds for back-row summons. This replaces the 10-05 ruling that sick pieces cannot give check.
- **Costs:** Any piece card in hand can be summoned or sealed. The cost is the mana value printed on the card. Mana grows by only +1 per turn, so that growth is the pacing of the game. A 3-cost piece is a mid-game investment and a 5-cost piece is a game-defining play that takes several turns of saving.
- **No legal action:** Stalemate. A player cannot pass. If a player has no legal action on their turn (no moves, no mana to summon, no legal square to seal) and their King is not in check, the game is a draw by stalemate. If the King is in check and nothing resolves it, that is checkmate.
- **Where a seal can go:** Only on one of your own non-King pieces. A King can never be sealed, because it is your win condition and cannot be sacrificed or used as a resource.
- **Timer length:** The timer is printed on the card. It is a core balancing lever. A cheap, low-impact piece might have a timer of 1, while a game-changing piece might have a timer of 3, giving the opponent more time to respond.
- **Blocking:** A seal blocks movement and lines of attack exactly like any other piece. It is an occupying piece on the board, which is its main defensive use and why sealing a front-line piece is risky but rewarding.
- **Stalemate test:** A seal is a piece for blocking squares and for being captured, but it has no legal move and does not count as a piece that can act. If a player's only pieces are the King and one or more seals, and the King has no legal move (and cannot summon or seal), that player is in stalemate.
- **Hatching timing:** A piece cannot hatch onto a square an enemy has moved onto. The seal must survive until the start of its owner's turn, when the timer resolves. If an enemy captures the seal's square first, the seal and its card are lost. The piece only hatches if the seal's square is still under its owner's control at that moment.
- **Timer timing:** A seal's timer counts down at the start of each of its owner's turns, and the piece hatches when it reaches 0. A timer of 1 hatches at the start of the owner's next turn, so the opponent gets exactly one move in between.

## Open questions

None right now.
