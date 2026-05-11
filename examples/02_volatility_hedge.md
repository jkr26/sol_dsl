# Volatility Hedge

`PRICE_BETWEEN` turns ClawBond into an insurance or range-trade instrument.

---

## Scenario A — SOL stays range-bound (seller collects premium)

Agent A holds SOL and wants income. They believe SOL will stay between
$150–$250 over the next 100 000 slots (~11 hours at 400ms/slot).
Agent B thinks it will break out. Agent A charges a premium by staking less.

```json
{
  "version": "1",
  "proposer":     "<Agent A pubkey>",
  "counterparty": "<Agent B pubkey>",
  "oracle_feed":  "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6",
  "condition":    "PRICE_BETWEEN",
  "threshold_min": 15000000000,
  "threshold_max": 25000000000,
  "expiry_slot":  530000,
  "proposer_stake":      500000000,
  "counterparty_stake": 1000000000
}
```

- Proposer (Agent A) puts up 0.5 SOL to win 1.5 SOL — like selling a strangle
- Counterparty (Agent B) puts up 1 SOL — betting on a breakout either direction
- If $150 ≤ SOL/USD ≤ $250 at expiry → Agent A wins 1.5 SOL
- If SOL/USD < $150 or > $250 → Agent B wins 1.5 SOL

---

## Scenario B — Downside insurance (buyer pays premium)

Agent A has a large SOL position and wants to hedge a crash below $100.
They pay 0.1 SOL in premium for 1 SOL of crash protection.

Agent A proposes a `PRICE_BELOW` bond where *they win if price crashes*:

```json
{
  "version": "1",
  "proposer":     "<Agent A pubkey>",
  "counterparty": "<Insurance agent pubkey>",
  "oracle_feed":  "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6",
  "condition":    "PRICE_BELOW",
  "threshold":    10000000000,
  "expiry_slot":  550000,
  "proposer_stake":      100000000,
  "counterparty_stake": 1000000000
}
```

- Agent A (proposer) pays 0.1 SOL premium
- Insurance agent stakes 1 SOL
- If SOL < $100 at expiry → Agent A receives 1.1 SOL (crash payout)
- If SOL ≥ $100 → Insurance agent keeps the 0.1 SOL premium

---

## Why `PRICE_BETWEEN` is the most expressive condition

```
PRICE_ABOVE threshold          →  pure directional (bull)
PRICE_BELOW threshold          →  pure directional (bear) or insurance trigger
PRICE_BETWEEN min..max         →  range trade, strangle, premium income
!PRICE_BETWEEN min..max        →  breakout bet (take the counterparty side)
```

Counterparty always wins when proposer's condition is false — so the same
`PRICE_BETWEEN` DSL encodes a range-seller and a breakout-buyer simultaneously.
