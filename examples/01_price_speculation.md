# Price Speculation

Two agents disagree about where a price will be at a future slot.
One puts SOL on the line; the other takes the other side.

---

## Scenario A — SOL above $200

Agent A believes SOL will trade above $200 at slot 500 000.
Agent B believes it won't. Both stake 1 SOL.

```json
{
  "version": "1",
  "proposer":     "<Agent A pubkey>",
  "counterparty": "<Agent B pubkey>",
  "oracle_feed":  "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6",
  "condition":    "PRICE_ABOVE",
  "threshold":    20000000000,
  "expiry_slot":  500000,
  "proposer_stake":     1000000000,
  "counterparty_stake": 1000000000
}
```

- `threshold`: `20_000_000_000` = $200.00 in raw Chainlink units (8 decimals)
- If SOL/USD > $200.00 at slot 500 000 → Agent A wins 2 SOL
- If SOL/USD ≤ $200.00 → Agent B wins 2 SOL

---

## Scenario B — BTC below $80 000 (bear bet)

Agent A is bearish. Agent B disagrees. Asymmetric stakes — Agent A pays 2:1.

```json
{
  "version": "1",
  "proposer":     "<Agent A pubkey>",
  "counterparty": "<Agent B pubkey>",
  "oracle_feed":  "CzZQBrJCLqjXRfMjRN3fhbxur2QYHUzkpaRwkWsiPqbJ",
  "condition":    "PRICE_BELOW",
  "threshold":    8000000000000,
  "expiry_slot":  600000,
  "proposer_stake":     2000000000,
  "counterparty_stake": 1000000000
}
```

- `threshold`: `8_000_000_000_000` = $80 000.00
- Proposer risks 2 SOL to win 1 SOL — prices in their higher conviction

---

## Tool call sequence

**Agent A (proposer):**
```
bond_propose({
  counterparty: "<Agent B pubkey>",
  oracle_feed:  "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6",
  condition:    "PRICE_ABOVE",
  threshold:    20000000000,
  expiry_slot:  500000,
  proposer_stake:     1000000000,
  counterparty_stake: 1000000000
})
→ { dsl, tx_hex, bond_pda }   ← send this bundle to Agent B

bond_watch(dsl, bond_pda)     ← register for auto-settlement
```

**Agent B (counterparty):**
```
bond_inspect(dsl, tx_hex)     ← always inspect first
→ { verified: true, ... }

bond_accept(tx_hex)           ← countersign and submit
bond_watch(dsl, bond_pda)     ← register for auto-settlement
```

**At expiry (either agent):**
```
bond_check_pending()          ← settler fires automatically
```
