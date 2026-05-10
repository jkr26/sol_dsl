# Solana Agent-Wager (Claw-DSL)

Peer-to-peer wager protocol for autonomous agents on Solana. Agents express bets as a JSON **DSL object**, compile it into an on-chain transaction, and settle it permissionlessly against a Chainlink price feed once the expiry slot passes.

---

## How it works

```
Agent A                   On-chain                   Agent B
  │                          │                          │
  │── propose_wager ────────►│  WagerProposal PDA       │
  │   (single sig,           │  (stake escrowed)        │
  │    stake escrowed)       │                          │
  │                          │◄── accept_wager ─────────│
  │                          │  Proposal → Wager PDA    │
  │                          │  (both stakes escrowed)  │
  │                          │                          │
  │                    [expiry slot]                    │
  │                          │                          │
  │── settle_wager ─────────►│  Chainlink oracle read   │
  │   (permissionless)       │  Winner gets everything  │
```

**Two-party mode** (`initialize_wager`): Both agents sign a single durable-nonce transaction atomically. Use this when both parties are online and ready.

**Open-proposal mode** (`propose_wager` → `accept_wager`): Proposer posts a standing offer on-chain with stake escrowed. Any agent that finds it via `getProgramAccounts` can accept. Use this for async matchmaking.

---

## Repository layout

```
programs/sol_wager/src/lib.rs   Anchor program (Rust)
skill/
  idl.json                      Hand-written IDL (Anchor 0.30 format)
  src/tools.ts                  OpenClaw plugin — all agent-facing tools
  src/wallet.ts                 Keypair wallet adapter
  src/watcher.ts                Background settler (polls slot, calls settle_wager)
dsl/
  schema.json                   JSON Schema for the Claw-DSL object
verify/
  index.js                      Deterministic tx ↔ DSL verifier
test/
  integration.js                14-test end-to-end suite against local validator
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| Rust + cargo | stable |
| Solana CLI | 1.18+ |
| `cargo-build-sbf` | (ships with Solana CLI) |
| Node.js | 18+ |
| npm | 9+ |

---

## Build

```bash
# Compile the BPF program
cargo build-sbf

# Build the TypeScript skill
cd skill && npm install && npm run build
```

---

## Deploy (local validator)

Start a validator with the Chainlink program and SOL/USD feed cloned from devnet:

```bash
solana-test-validator \
  --clone HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny \
  --clone HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6 \
  --url devnet \
  --reset
```

Deploy:

```bash
solana program deploy target/deploy/sol_wager.so \
  --url localhost \
  --keypair ~/.config/solana/id.json \
  --program-id target/deploy/sol_wager-keypair.json
```

Program ID: `GJYEW4jBbBZTVNTdG2AB3EHjC39hFuWWZjaxvDUpmZ3i`

---

## Tests

```bash
NODE_PATH=skill/node_modules node test/integration.js
```

14 tests across 5 suites:

| Suite | Coverage |
|-------|----------|
| 1 | `initialize_wager` — state, escrow, validation |
| 2 | `settle_wager` — expiry guard |
| 3 | Full oracle settlement via cloned Chainlink feed |
| 4 | `verify/index.js` — DSL ↔ transaction matching |
| 5 | `propose_wager`, `getProgramAccounts`, `accept_wager`, `cancel_proposal` |

---

## Claw-DSL schema

A wager is described as a plain JSON object validated against `dsl/schema.json`.

```json
{
  "version": "1",
  "proposer":     "<base58 pubkey>",
  "counterparty": "<base58 pubkey>",
  "oracle_feed":  "<base58 Chainlink aggregator>",
  "condition":    "PRICE_ABOVE",
  "threshold":    10000000000,
  "expiry_slot":  500000,
  "proposer_stake":     1000000000,
  "counterparty_stake":  500000000
}
```

### Conditions

| Condition | Proposer wins when… | Required fields |
|-----------|---------------------|-----------------|
| `PRICE_ABOVE` | `price > threshold` at expiry | `threshold` |
| `PRICE_BELOW` | `price < threshold` at expiry | `threshold` |
| `PRICE_BETWEEN` | `threshold_min ≤ price ≤ threshold_max` | `threshold_min`, `threshold_max` |
| `PRICE_CHANGE_PCT` | `(price − snapshot) / snapshot ≥ change_pct` (bps) | `change_pct`, `snapshot_price` |

All price values are raw Chainlink answer units (8 decimals for SOL/USD and BTC/USD — `$100.00` = `10_000_000_000`). `change_pct` is in basis points: `100` = 1%.

### Optional fields

| Field | Purpose |
|-------|---------|
| `nonce_account` | Durable nonce account pubkey — keeps the unsigned tx valid while the counterparty reviews |
| `nonce_authority` | Nonce authority pubkey (typically the proposer) |
| `created_at` | ISO-8601 timestamp (informational) |

---

## Known Chainlink feeds

| Feed | Address | Decimals |
|------|---------|----------|
| SOL/USD | `HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6` | 8 |
| BTC/USD | `CzZQBrJCLqjXRfMjRN3fhbxur2QYHUzkpaRwkWsiPqbJ` | 8 |
| ETH/USD | `2ypeVyYnZaW2TNYXXTaZq9YhYvnqcjCiifW1C6n8b62P` | 8 |

Chainlink program: `HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny`

---

## OpenClaw skill tools

The `skill/` package exposes these tools to an OpenClaw agent:

| Tool | Description |
|------|-------------|
| `wager_build_tx` | Compile a Claw-DSL object into a signed/unsigned transaction hex |
| `wager_verify_tx` | Confirm a transaction hex was compiled from a specific DSL object |
| `wager_settle` | Settle an expired wager and send winnings to the winner |
| `wager_propose_open` | Post a standing open proposal with escrowed stake |
| `wager_accept_proposal` | Accept an open proposal as counterparty |
| `wager_cancel_proposal` | Cancel your own proposal and reclaim stake + rent |
| `wager_list_open` | Fetch all live WagerProposal accounts from the chain |
| `wager_capabilities` | Return this protocol's full capabilities document (for agent discovery) |

---

## Verification

`verify/index.js` lets any party confirm that a hex-encoded transaction was deterministically built from a specific DSL object — without sending it:

```js
const { verifyWagerTransaction } = require("./verify");

const result = verifyWagerTransaction(txHex, dslObject);
// { ok: true, errors: [] }
```

Checks performed: program ID, instruction discriminator, proposer/counterparty/feed accounts, wager PDA derivation, all `WagerParams` fields, and (optionally) the durable nonce account.

---

## On-chain accounts

### `Wager` PDA
Seeds: `["wager", proposer, counterparty]`

Holds both stakes in escrow. Closed (lamports sent to winner) on settlement.

### `WagerProposal` PDA
Seeds: `["proposal", proposer]`

One per proposer. Created by `propose_wager` (proposer's stake escrowed inside). Closed by `accept_wager` (lamports fold into the Wager PDA prize pot) or `cancel_proposal` (lamports returned to proposer).

---

## License

MIT
