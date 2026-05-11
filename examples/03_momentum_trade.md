# Momentum Trade

`PRICE_CHANGE_PCT` lets agents bet on percentage moves from a known reference
price, rather than an absolute level. Useful for trending markets, earnings-style
events, or any scenario where direction matters more than absolute price.

---

## Scenario A — ETH up 10% from now

Agent A believes ETH will rally 10%+ over the next 50 000 slots (~6 hours).
Current ETH/USD price: $3 200.00 = `320_000_000_000` raw units.
10% in basis points: `1000` bps.

```json
{
  "version": "1",
  "proposer":     "<Agent A pubkey>",
  "counterparty": "<Agent B pubkey>",
  "oracle_feed":  "2ypeVyYnZaW2TNYXXTaZq9YhYvnqcjCiifW1C6n8b62P",
  "condition":    "PRICE_CHANGE_PCT",
  "change_pct":   1000,
  "snapshot_price": 320000000000,
  "expiry_slot":  480000,
  "proposer_stake":     1000000000,
  "counterparty_stake": 1000000000
}
```

- `change_pct` is signed basis points: `1000` = +10%, `-500` = -5%
- `snapshot_price` is the reference (typically current price at proposal time)
- Proposer wins if `(final_price - snapshot) / snapshot ≥ change_pct / 10000`
- i.e., if ETH/USD ≥ $3 520.00 ($3 200 × 1.10) at expiry

---

## Scenario B — BTC down 5% (bearish momentum)

Negative `change_pct`: proposer wins if price falls by at least 5%.

```json
{
  "version": "1",
  "proposer":     "<Agent A pubkey>",
  "counterparty": "<Agent B pubkey>",
  "oracle_feed":  "CzZQBrJCLqjXRfMjRN3fhbxur2QYHUzkpaRwkWsiPqbJ",
  "condition":    "PRICE_CHANGE_PCT",
  "change_pct":   -500,
  "snapshot_price": 6500000000000,
  "expiry_slot":  520000,
  "proposer_stake":     1000000000,
  "counterparty_stake": 1000000000
}
```

- `snapshot_price`: `6_500_000_000_000` = $65 000.00
- Proposer wins if BTC/USD ≤ $61 750.00 ($65 000 × 0.95) at expiry
- `change_pct: -500` = proposer needs a −5% move or worse

---

## `change_pct` quick reference

| `change_pct` | Meaning |
|---|---|
| `100` | +1% |
| `500` | +5% |
| `1000` | +10% |
| `-100` | −1% |
| `-500` | −5% |
| `-1000` | −10% |
| `10000` | +100% (double) |

---

## Agent workflow: snapshot_price

The proposing agent should read the current oracle price before calling
`bond_propose` and use it as `snapshot_price`. The counterparty can verify
this value via `bond_inspect` — the verifier checks that `snapshot_price`
is encoded correctly in the transaction.

Neither party controls what the price will be at expiry — only the Chainlink
feed does.
