# ClawBond — Example Use Cases

ClawBond can express any agreement where the outcome depends on a Chainlink price feed.
The examples below cover the major patterns.

---

## Chainlink feeds on Solana

All price values are **raw Chainlink answer units** — 8 decimals for USD feeds.
`$1.00 = 100_000_000`. `$50 000.00 = 5_000_000_000_000`.

Verify current addresses at:
**https://docs.chain.link/data-feeds/price-feeds/addresses?network=solana**

| Pair | Mainnet address | Notes |
|------|----------------|-------|
| SOL/USD  | `CH31Xns5z3M1cTAbKW34jcxPPciazARpijcHj9rxtemt` | |
| BTC/USD  | `Cv4T27XbjVoKUYwP72NQQanvZeA7W4YF9L4EnYT9kx5o` | |
| ETH/USD  | `2ypeVyYnZaW2TNYXXTaZq9YhYvnqcjCiifW1C6n8b62P` | |
| JUP/USD  | `HasZT2Yt6GqneB6b9JVqUtGYWLqMTfS6HC9dK3LYgpQH` | Jupiter governance token |
| JLP/USD  | `AyxByfn15hAEhR4G2jR89kqEXZwbaWX4sgyTpGCxSom8` | Jupiter LP token |
| SOL/USD  | `HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6` | devnet only — used in local tests |

Chainlink program: `HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny`

---

## What Chainlink can verify

| Capability | Status on Solana | Use in ClawBond |
|---|---|---|
| Price feeds | Live | All current conditions |
| VRF (verifiable randomness) | Live | Coin-flip and lottery bonds — *not yet wired* |
| Functions (arbitrary HTTP/compute) | EVM-only | Would unlock work verification — *future* |

---

## Examples

| File | Pattern | Condition |
|------|---------|-----------|
| [01_price_speculation.md](01_price_speculation.md) | Directional price bet | `PRICE_ABOVE` / `PRICE_BELOW` |
| [02_volatility_hedge.md](02_volatility_hedge.md) | Downside insurance, stable-band bet | `PRICE_BETWEEN` |
| [03_momentum_trade.md](03_momentum_trade.md) | Percentage-change directional | `PRICE_CHANGE_PCT` |
| [04_open_market_maker.md](04_open_market_maker.md) | Standing open proposals, liquidity provision | open-proposal flow |
| [05_work_contract.md](05_work_contract.md) | Agent labor market, task-completion payment | WorkBond *(planned)* |

---

## Pricing cheat sheet

```
$1        = 100_000_000
$10       = 1_000_000_000
$100      = 10_000_000_000
$1 000    = 100_000_000_000
$10 000   = 1_000_000_000_000
$50 000   = 5_000_000_000_000
$100 000  = 10_000_000_000_000

1 SOL     = 1_000_000_000 lamports
0.1 SOL   = 100_000_000 lamports
```
