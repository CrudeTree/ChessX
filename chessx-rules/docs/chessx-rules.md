# ChessX rules (owner's current draft)

Source: Djabooty, 2026-10-05. This is the rules baseline to design, playtest, and balance against.

## Game layout

- **Board:** 8x8 grid (files a to h, ranks 1 to 8). Rank 1 is Player One's back row, rank 8 is Player Two's.
- **Setup:** Kings on d1 and d8. Each side also starts with 3 Initiates from outside the deck, in front of its King (c2, d2, e2 for White; c7, d7, e7 for Black). Players draw 3 cards. Each player starts with 2 mana. White takes the first turn.
- **Resources:** Gain 1 mana per turn (no cap). Draw 1 card per turn. Play as many cards as your mana pays for, and make one move per turn.
- **Turn sequence (changed by Djabooty, 2026-10-10):** Gain mana, draw a card, then play as many cards from your hand as your mana pays for: summon pieces to the back row, seal pieces, and cast spells, in any order. Playing a card does not end the turn. Then move a piece. The move ends the turn, and every turn ends with a move. Only when no legal move is left, and only after you have played a card that turn, does End turn close the turn instead, so there is still no pass. This replaces one spell, then one action (msg-034).
- **Under check (changed by Djabooty, 2026-10-10):** Nothing you play may leave your own King in check. If your King is in check when your turn starts, your first play must get it out: a move (which ends the turn), or a summon to the back row that blocks the check. No spell can answer a check, so spells wait until the King is safe. Example: a Wyrmling hatches on d6 and Black's King on d8 is in check, so Black may not cast Insight or Dispel first. Once the King is safe, the rest of the turn goes on as usual.
- **Summoning:** Costs mana. Pieces have summoning sickness: no capture on the turn they appear. They still attack squares, so they give check at once. A summoned piece also cannot move until your next turn (changed by Djabooty, 2026-10-10).
- **Sealing:** Costs mana. Place a card face down on a piece to create a seal. Seals cannot move or capture and can be destroyed by an enemy. A seal's timer counts down on each of your turns. When it hits 0, the new piece hatches on that square.
- **Winning:** Checkmate the enemy King. Normal chess check rules apply.

## What was removed

- **Attack and defense stats.** Combat is pure chess capture: move into a square to take it. No ATK/DEF comparison and no hit points.
- **Piece-generated mana.** The only mana source is a fixed +1 per turn from your King.
- **Traditional starting pieces.** No starting pawns, rooks, knights, bishops, or queens. Each player starts with a King and 3 Initiates and summons the rest of the army.
- **Mana cap.** Mana can be banked without limit.
- **Tribute cost.** Summoning costs mana. Tributing a piece is no longer a cost. It is now the placement choice for the seal mechanic.
- **Pieces sharing a square.** One piece per square, always.

## Rulings (decided by Djabooty, 2026-10-05)

- **Hatching:** A seal hatches into the card that was placed face down. The choice is made when the seal is created, not when it hatches. That makes a seal a readable, predictable threat the opponent can plan around for its whole timer.
- **Sealed piece:** The piece underneath is consumed. It is removed from play and does not return. This is the cost of sealing: you gain position (summoning deep) and tempo (the new piece appears on a timer, in place), but lose the body you sacrificed.
- **Destroying a seal:** Capturing the seal's square destroys it. An enemy piece moves onto that square, and both the seal token and the card underneath go to the discard pile. A seal is a piece and a sitting duck, and that is its weakness. A spell may destroy seals only if that spell says so. It is not a general rule.
- **Summoning sickness:** Summoned and hatched pieces have it. They wait until their owner's next turn to capture. A summoned piece also waits until then to move, while a hatched piece may move at once (changed by Djabooty, 2026-10-10). The 3 starting Initiates do not have it. They count as already on the board before the game began and can act normally on turn 1.
- **Check is a board fact (changed by Djabooty, 2026-10-08):** A sick piece cannot capture, but it still attacks the squares it reaches. It gives check the moment it appears, and the enemy King cannot step into its reach. Example: a Wyrmling hatches on d6, Black must answer check on d8 at once, and no King step into the Wyrmling's reach is legal. The same holds for back-row summons. This replaces the 10-05 ruling that sick pieces cannot give check.
- **Starting pieces (changed by Djabooty, 2026-10-08):** Each side gets 3 Initiates from outside the deck, placed on c2, d2 and e2 (White) or c7, d7 and e7 (Black) before turn 1, with no summoning sickness. They shield the King from instant check and leave the back row free for summoning. Players keep their whole opening hand. The starter deck keeps 2 Initiates as mid-game free bodies, and the other 2 became Squires. This replaces the opening where players deployed 3 zero-cost pieces from their hand to the back row.
- **Opening hand (changed by Djabooty, 2026-10-10):** Players draw 3 cards before the game instead of 7. The draw of 1 card at the start of every turn is unchanged, so White holds 4 cards on its first turn. Hands were piling up: a player who kept every card held 17 on their 10th turn, and now holds 13.
- **Costs:** Any piece card in hand can be summoned or sealed. The cost is the mana value printed on the card. Mana grows by only +1 per turn, so that growth is the pacing of the game. A 3-cost piece is a mid-game investment and a 5-cost piece is a game-defining play that takes several turns of saving.
- **No legal action (changed by Djabooty, 2026-10-10):** Stalemate. A player cannot pass. If a player has no legal move and no card they can play when their turn starts, and their King is not in check, the game is a draw by stalemate. If the King is in check and nothing resolves it, that is checkmate. A player who can still play a card is not stalemated: they play it, and End turn closes the turn if no move is left.
- **Where a seal can go:** Only on one of your own non-King pieces. A King can never be sealed, because it is your win condition and cannot be sacrificed or used as a resource.
- **Timer length:** The timer is printed on the card. It is a core balancing lever. A cheap, low-impact piece might have a timer of 1, while a game-changing piece might have a timer of 3, giving the opponent more time to respond.
- **Blocking:** A seal blocks movement and lines of attack exactly like any other piece. It is an occupying piece on the board, which is its main defensive use and why sealing a front-line piece is risky but rewarding.
- **Stalemate test (changed by Djabooty, 2026-10-10):** A seal is a piece for blocking squares and for being captured, but it has no legal move and does not count as a piece that can act. If a player's only pieces are the King and one or more seals, the King has no legal move, and they have no card they can play, that player is in stalemate.
- **Hatching timing:** A piece cannot hatch onto a square an enemy has moved onto. The seal must survive until the start of its owner's turn, when the timer resolves. If an enemy captures the seal's square first, the seal and its card are lost. The piece only hatches if the seal's square is still under its owner's control at that moment.
- **Timer timing:** A seal's timer counts down at the start of each of its owner's turns, and the piece hatches when it reaches 0. A timer of 1 hatches at the start of the owner's next turn, so the opponent gets exactly one move in between.
- **Empty deck (changed by congress, msg-033, 2026-10-10):** When a deck runs out, the draw is skipped. There is no deck-out loss; checkmate stays the only win.
- **No promotion (changed by congress, msg-033, 2026-10-10):** A piece that reaches the far rank stays as it is. It can still be sealed like any other piece. Sealing is the crown: a Squire that reaches e8 can be sealed to an Eclipse Knight (cost 4, timer 3).

## Open questions

None right now.
