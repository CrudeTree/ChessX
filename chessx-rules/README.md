# ChessX v2 rules engine

A standalone, pure-TypeScript implementation of the new ChessX foundation rules (see `docs/chessx-rules.md`). It has no UI, no server and no dependencies beyond TypeScript and vitest. It is the reference being ported into the real ChessX `packages/engine`.

```
cd chessx-rules
npm install
npm test          # 20 rule tests
npm run typecheck
```

## What is implemented

- 6x8 board (6 files, 8 ranks). Kings start on d1 and d8, each with 3 Initiates in front.
- Deck, discard, opening hand of 3, one draw per turn.
- Mana: starts at 2, +1 at the start of each of your turns, no cap.
- Setup: each side starts with 3 Initiates from outside the deck in front of its King (c2, d2, e2 / c7, d7, e7). They can act immediately. White moves first.
- Each turn: any cards the mana pays for (summon, seal, spell), then one move, which ends the turn. End turn only when no move is left, after a card. No passing.
- Summon: pay the card's cost, place on your back row. Summoned pieces cannot move or capture until your next turn, but they still give check at once.
- Seal: turn one of your own non-King pieces into a seal. The piece is consumed, the mana cost is paid, and the seal hatches after the timer printed on the card. A seal blocks lines like any piece and can be captured. Capturing a seal sends the card to its owner's discard and stops the hatch.
- Pure chess capture: no attack or defense stats, one piece per square.
- Check, checkmate and stalemate. Seals and sick pieces do not count as pieces that can act.
- Spells: Draw (Insight) and Dispel (destroy a seal) as starter examples.
- Deterministic seeded RNG, so games are replayable. State is plain JSON.

API: `newGame`, `legalActions`, `applyLegalAction`, `isInCheck`. See `src/index.ts`.

## Placeholder content

`src/catalog.ts` contains five pieces and two spells with made-up costs and timers. They only exist so the rules can be tested. Real cards should replace them.

## Assumptions to confirm

1. A hatching seal does nothing if its square is held by an enemy piece (per the rulings, no hatching onto an enemy-occupied seal square).
2. Checkmate or stalemate is evaluated at the start of the player's turn, after the mana and draw.
3. A turn with no legal move but a card to play is not stalemate: the card is played, then End turn.
4. Empty deck: no draw, no penalty.
5. White's first turn has 3 mana, as it gets the normal +1.
