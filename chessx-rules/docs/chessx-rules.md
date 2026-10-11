# ChessX rules (owner's current draft)

Source: Djabooty, 2026-10-05. This is the rules baseline to design, playtest, and balance against.

## Game layout

- **Board:** 8x8 grid (files a to h, ranks 1 to 8). Rank 1 is Player One's back row, rank 8 is Player Two's.
- **Setup:** Kings on d1 and d8. Each side also starts with 3 Initiates from outside the deck, in front of its King (c2, d2, e2 for White; c7, d7, e7 for Black). Players draw 3 cards. Each player starts with 2 mana. White takes the first turn.
- **Resources:** Gain 1 mana per turn (no cap). Draw 1 card per turn. Play as many cards as your mana pays for, and make one move per turn.
- **Turn sequence (changed by Djabooty, 2026-10-10 and 2026-10-11):** Gain mana, draw a card, then play as many cards from your hand as your mana pays for: summon pieces to the back row, sacrifice pieces for new ones, evolve pieces, and cast spells, in any order. Playing a card does not end the turn. Then move a piece. The move ends the turn, and every turn ends with a move. Only when no legal move is left, and only after you have played a card that turn, does End turn close the turn instead, so there is still no pass. This replaces one spell, then one action (msg-034).
- **Under check (changed by Djabooty, 2026-10-10):** Nothing you play may leave your own King in check. If your King is in check when your turn starts, your first play must get it out: a move (which ends the turn), or a summon to the back row that blocks the check. No spell can answer a check, so spells wait until the King is safe. Example: a Wyrmling arrives on d6 and Black's King on d8 is in check, so Black may not cast Insight or Dispel first. Once the King is safe, the rest of the turn goes on as usual.
- **Summoning:** Costs mana. Pieces have summoning sickness: no capture on the turn they appear. They still attack squares, so they give check at once. A summoned piece also cannot move until your next turn (changed by Djabooty, 2026-10-10).
- **Sacrificing (changed by Djabooty, 2026-10-11):** Costs mana. Place a card face down on one of your pieces to sacrifice that piece for it. The face-down card is the sacrifice: it cannot move or capture and can be destroyed by an enemy. Its timer counts down on each of your turns. When it hits 0, the new piece arrives on that square. This was called sealing; players asked what a seal was, so it is now a sacrifice.
- **Evolving (changed by Djabooty, 2026-10-11):** Costs mana. Level 2 and level 3 cards of an evolution line each name the card they evolve from. Play one onto your piece of that card and the piece changes into it at once, on the same square. Only a piece that was already on the board when your turn began can evolve. The evolved piece waits like a summoned one: no move or capture until your next turn, though it gives check at once. Evolution cards are only ever played this way, never summoned or sacrificed for.
- **Winning:** Checkmate the enemy King. Normal chess check rules apply.

## Evolution lines (Djabooty, 2026-10-11)

The rook, bishop, knight and queen are the top of a line, never a card you summon. Level 1 is summoned or sacrificed for like any piece; levels 2 and 3 only evolve from the level below. The weaker the first level, the stronger the last. Costs are placeholders to playtest.

**Costs (changed by Djabooty, 2026-10-11):** Pieces were too easy to get, so the costs went up and a Paladin now costs at least 4. Every level costs more than the one below it. A first level that leaps off the back row (Colt, Wyrmling) costs 2; one that steps (Recruit, Apprentice) costs 1.

- **Warrior (the rook):** Recruit (1 mana, steps 1 square straight), then Warrior (4, slides up to 3 squares straight), then Warlord (6, slides straight any distance).
- **Mage (the bishop):** Apprentice (1, steps 1 square diagonally), then Mage (3, slides up to 3 squares diagonally), then Archmage (4, slides diagonally any distance).
- **Paladin (the knight):** Colt (2, knight leaps that go forward), then Paladin (4, leaps like a knight), then Dawn Paladin (7, a knight leap or 1 square straight) or Eclipse Knight (7, a knight leap or 1 square diagonally).
- **Dragon (the queen):** Wyrmling (2, leaps exactly 2 squares straight), then Mystic Dragon (6, slides any direction up to 3 squares), then Ancient Mystic Dragon (10, slides any direction any distance).
- **How soon:** A player who saves for nothing else can have a Paladin on turn 4 at the earliest, an Archmage on turn 6, a Warlord on turn 9, a Dawn Paladin or Eclipse Knight on turn 11 and an Ancient Mystic Dragon on turn 16.
- **No line:** Initiate and Squire are the pawns and do not evolve. Duskfang has no line, so it costs 15 to make up for it.
- **Where the old cards went:** Page became the Recruit, Hopper the Paladin, Cathedral Runner the Archmage and Tower the Warlord. Dawnfang moved exactly like Eclipse Knight and was folded into it. Games already in progress keep the cards they started with.
- **Starter deck:** 24 cards: 2 Initiates and 1 Squire; for each line two level 1 cards and one of every higher level (both Paladin final forms); 1 Duskfang; 2 Insight and 1 Dispel.

## Card faces (Djabooty, 2026-10-11)

Every card has two faces: a light face for the player with White and a dark face for the player with Black. Owning a card gives you both. The light face looks holy, majestic and noble (think Gandalf the White); the dark face looks mighty, powerful and dark (think Sauron). Every current card has both faces, and its pictures show how strong it is: first levels such as the Squire, Recruit, Apprentice, Colt and Wyrmling look humble, final forms look mighty, and the Ancient Mystic Dragon outshines them all (changed by Djabooty, 2026-10-11). The Initiate is a grown man in a plain hooded robe with a staff, a stern zealot for White and a sinister cultist for Black: plainly equipped but threatening, never a child (changed by Djabooty, 2026-10-11). A new card that has only one picture shows it to both sides until it gets its second face.

## What was removed

- **Attack and defense stats.** Combat is pure chess capture: move into a square to take it. No ATK/DEF comparison and no hit points.
- **Piece-generated mana.** The only mana source is a fixed +1 per turn from your King.
- **Traditional starting pieces.** No starting pawns, rooks, knights, bishops, or queens. Each player starts with a King and 3 Initiates and summons the rest of the army.
- **Summoning a finished chess piece (changed by Djabooty, 2026-10-11).** The Tower, Cathedral Runner and Hopper could be summoned outright. The rook, bishop, knight and queen now sit at the top of evolution lines, and only their first level is summoned.
- **Mana cap.** Mana can be banked without limit.
- **Tribute cost.** Summoning costs mana. Tributing a piece is no longer a cost. It is now the placement choice for the sacrifice mechanic.
- **Pieces sharing a square.** One piece per square, always.

## Rulings (decided by Djabooty, 2026-10-05)

- **Arriving:** A sacrifice turns into the card that was placed face down. The choice is made when the sacrifice is made, not when the piece arrives. That makes a sacrifice a readable, predictable threat the opponent can plan around for its whole timer.
- **Sacrificed piece:** The piece underneath is consumed. It is removed from play and does not return. This is the cost of sacrificing: you gain position (summoning deep) and tempo (the new piece appears on a timer, in place), but lose the body you sacrificed.
- **Destroying a sacrifice:** Capturing the sacrifice's square destroys it. An enemy piece moves onto that square, and the face-down card goes to the discard pile. A sacrifice is a piece and a sitting duck, and that is its weakness. A spell may destroy sacrifices only if that spell says so. It is not a general rule.
- **Summoning sickness:** Summoned, evolved and arrived pieces have it. They wait until their owner's next turn to capture. A summoned or evolved piece also waits until then to move, while a piece that arrived from a sacrifice may move at once (changed by Djabooty, 2026-10-10; evolved pieces added 2026-10-11). The 3 starting Initiates do not have it. They count as already on the board before the game began and can act normally on turn 1.
- **Check is a board fact (changed by Djabooty, 2026-10-08):** A sick piece cannot capture, but it still attacks the squares it reaches. It gives check the moment it appears, and the enemy King cannot step into its reach. Example: a Wyrmling arrives on d6, Black must answer check on d8 at once, and no King step into the Wyrmling's reach is legal. The same holds for back-row summons and for evolved pieces. This replaces the 10-05 ruling that sick pieces cannot give check.
- **Starting pieces (changed by Djabooty, 2026-10-08):** Each side gets 3 Initiates from outside the deck, placed on c2, d2 and e2 (White) or c7, d7 and e7 (Black) before turn 1, with no summoning sickness. They shield the King from instant check and leave the back row free for summoning. Players keep their whole opening hand. The starter deck keeps 2 Initiates as mid-game free bodies. This replaces the opening where players deployed 3 zero-cost pieces from their hand to the back row.
- **Opening hand (changed by Djabooty, 2026-10-10):** Players draw 3 cards before the game instead of 7. The draw of 1 card at the start of every turn is unchanged, so White holds 4 cards on its first turn. Hands were piling up: a player who kept every card held 17 on their 10th turn, and now holds 13.
- **Costs (changed by Djabooty, 2026-10-11):** Any piece card in hand can be summoned or sacrificed for, except an evolution card, which can only evolve a piece. The cost is the mana value printed on the card. Mana grows by only +1 per turn, so that growth is the pacing of the game. A 3-cost piece is a mid-game investment and a 5-cost piece is a game-defining play that takes several turns of saving. A line spreads its top piece over several turns: a Wyrmling, a Mystic Dragon and an Ancient Mystic Dragon cost 18 mana in all.
- **No legal action (changed by Djabooty, 2026-10-10):** Stalemate. A player cannot pass. If a player has no legal move and no card they can play when their turn starts, and their King is not in check, the game is a draw by stalemate. If the King is in check and nothing resolves it, that is checkmate. A player who can still play a card is not stalemated: they play it, and End turn closes the turn if no move is left.
- **Where a sacrifice can go:** Only on one of your own non-King pieces. A King can never be sacrificed, because it is your win condition and cannot be used as a resource.
- **Timer length:** The timer is printed on the card. It is a core balancing lever. A cheap, low-impact piece might have a timer of 1, while a game-changing piece might have a timer of 3, giving the opponent more time to respond. Evolution cards have no timer (Djabooty, 2026-10-11).
- **Blocking:** A sacrifice blocks movement and lines of attack exactly like any other piece. It is an occupying piece on the board, which is its main defensive use and why sacrificing a front-line piece is risky but rewarding.
- **Stalemate test (changed by Djabooty, 2026-10-10):** A sacrifice is a piece for blocking squares and for being captured, but it has no legal move and does not count as a piece that can act. If a player's only pieces are the King and one or more sacrifices, the King has no legal move, and they have no card they can play, that player is in stalemate.
- **Arrival timing:** A piece cannot arrive onto a square an enemy has moved onto. The sacrifice must survive until the start of its owner's turn, when the timer resolves. If an enemy captures the sacrifice's square first, the sacrifice and its card are lost. The piece only arrives if the square is still under its owner's control at that moment.
- **Timer timing:** A sacrifice's timer counts down at the start of each of its owner's turns, and the piece arrives when it reaches 0. A timer of 1 arrives at the start of the owner's next turn, so the opponent gets exactly one move in between.
- **Evolving in place (Djabooty, 2026-10-11):** Evolving is instant. The old piece leaves play and the new one stands on its square, with no timer and nothing for the enemy to destroy. A piece climbs at most one level per turn, because a piece that evolved this turn was not on the board when the turn began. Evolving never answers a check: the square stays occupied, so the King stays attacked.
- **Branching line (Djabooty, 2026-10-11):** A Paladin can become either a Dawn Paladin or an Eclipse Knight. The card you play decides.
- **Empty deck (changed by congress, msg-033, 2026-10-10):** When a deck runs out, the draw is skipped. There is no deck-out loss; checkmate stays the only win.
- **No promotion (changed by congress, msg-033, 2026-10-10; example changed by Djabooty, 2026-10-11):** A piece that reaches the far rank stays as it is. It can still be sacrificed like any other piece. Sacrifice is the crown: a Squire that reaches e8 can be sacrificed for a Wyrmling (cost 2, timer 1), which can then evolve into a Mystic Dragon and an Ancient Mystic Dragon, the queen.

## Open questions

- **Duskfang at 15 mana:** it still only steps 1 square diagonally and captures with a knight leap. Should a card that costs 15 move more strongly?
- **A fifth line (Djabooty's idea, 2026-10-11):** a first level that moves like a King, whose final form is a queen that reaches only 5 squares in every direction.
