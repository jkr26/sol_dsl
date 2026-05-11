# ClawBond

Agent-to-agent oracle-verified escrow and settlement on Solana. Two agents lock SOL, define a Chainlink price condition, and settle automatically at a specified slot — no platform, no human arbitration.

Install the OpenClaw plugin:
```bash
openclaw plugins install clawhub:@jkr26/clawbond
```

---

## How it works

```
Agent A                   On-chain                   Agent B
  │                          │                          │
  │── bond_propose_open ────►│  Proposal PDA            │
  │   (single sig,           │  (stake escrowed)        │
  │    stake escrowed)       │                          │
  │                          │◄── bond_accept_proposal ─│
  │                          │  Proposal → Bond PDA     │
  │                          │  (both stakes escrowed)  │
  │                          │                          │
  │                    [expiry slot]                    │
  │                          │                          │
  │── bond_settle ──────────►│  Chainlink oracle read   │
  │   (permissionless)       │  Winner gets everything  │
```

**Two-party mode** (`bond_propose`): Both agents sign a single durable-nonce transaction atomically. Use when both parties are online.

**Open-proposal mode** (`bond_propose_open` → `bond_accept_proposal`): Proposer posts a standing offer on-chain with stake escrowed. Any agent that discovers it can accept. Use for async matchmaking.

---

## Repository layout

```
programs/clawbond/src/lib.rs   Anchor program (Rust)
skill/
  idl.json                     Hand-written IDL (Anchor 0.30 format)
  src/tools.ts                 OpenClaw plugin — all agent-facing tools
  src/verify.ts                Deterministic tx ↔ DSL verifier
  src/wallet.ts                Keypair wallet adapter
  src/watcher.ts               Background settler (polls slot, calls settle)
dsl/
  schema.json                  JSON Schema for the Claw-DSL object
verify/
  index.js                     Standalone verifier (used by integration tests)
.well-known/
  clawbond.json                Static capabilities manifest for cold discovery (served via GitHub Pages)
test/
  integration.js               17-test end-to-end suite against local validator
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

# Build and bundle the OpenClaw plugin
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
solana program deploy target/deploy/clawbond.so \
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

17 tests across 6 suites:

| Suite | Coverage |
|-------|----------|
| 1 | `initialize_bond` — state, escrow, validation |
| 2 | `settle_bond` — expiry guard |
| 3 | Full oracle settlement via cloned Chainlink feed |
| 4 | `verify/index.js` — DSL ↔ transaction matching |
| 5 | `propose_bond`, `getProgramAccounts`, `accept_bond`, `cancel_bond` |
| 6 | `register_protocol` — on-chain capabilities meta PDA |

---

## Claw-DSL schema

A bond is described as a plain JSON object validated against `dsl/schema.json`.

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

All price values are raw Chainlink answer units (8 decimals for USD feeds — `$100.00` = `10_000_000_000`). `change_pct` is in basis points: `100` = 1%.

### Optional fields

| Field | Purpose |
|-------|---------|
| `nonce_account` | Durable nonce account — keeps the unsigned tx valid while the counterparty reviews |
| `nonce_authority` | Nonce authority pubkey (typically the proposer) |
| `created_at` | ISO-8601 timestamp (informational) |

---

## Known Chainlink feeds

| Feed | Address | Network |
|------|---------|---------|
| SOL/USD | `CH31Xns5z3M1cTAbKW34jcxPPciazARpijcHj9rxtemt` | mainnet-beta |
| BTC/USD | `Cv4T27XbjVoKUYwP72NQQanvZeA7W4YF9L4EnYT9kx5o` | mainnet-beta |
| ETH/USD | `2ypeVyYnZaW2TNYXXTaZq9YhYvnqcjCiifW1C6n8b62P` | mainnet-beta |
| JUP/USD | `HasZT2Yt6GqneB6b9JVqUtGYWLqMTfS6HC9dK3LYgpQH` | mainnet-beta |
| JLP/USD | `AyxByfn15hAEhR4G2jR89kqEXZwbaWX4sgyTpGCxSom8` | mainnet-beta |
| SOL/USD | `HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6` | devnet |

All feeds: 8 decimals. `$1.00 = 100_000_000`.

Chainlink program: `HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny`

---

## OpenClaw plugin tools

| Tool | Description |
|------|-------------|
| `bond_propose` | Create a bilateral bond (durable-nonce tx, both parties sign) |
| `bond_inspect` | Verify a received tx matches its DSL before accepting |
| `bond_accept` | Countersign and submit a bilateral bond |
| `bond_settle` | Settle an expired bond — permissionless |
| `bond_watch` | Register a bond for automatic settlement tracking |
| `bond_check_pending` | Settle all expired watched bonds in the local store |
| `bond_propose_open` | Post a public open proposal with stake escrowed (single sig) |
| `bond_accept_proposal` | Accept an open proposal by on-chain address |
| `bond_cancel_proposal` | Cancel your own unaccepted proposal and reclaim stake |
| `bond_list_open` | List all live open proposals on-chain |
| `bond_capabilities` | Full capabilities document + live open proposals |

---

## Discovery

Three layers — any combination works:

| Layer | Mechanism |
|-------|-----------|
| OpenClaw network | `bond_capabilities` tool returns protocol docs + live open proposals |
| HTTP | `.well-known/clawbond.json` served via GitHub Pages at `/.well-known/clawbond.json` |
| On-chain | `ProtocolMeta` PDA at `DsHfsWqQrjzDCNieBKxrPF92bRMopSuCeGmVGXd5G8o6` stores the capabilities URI; any agent can derive it from `seeds=["meta"]` + program ID |

---

## Verification

```js
const { verifyWagerTransaction } = require("./verify");

const result = verifyWagerTransaction(txHex, dslObject);
// { ok: true, errors: [] }
```

Checks: program ID, discriminator, proposer/counterparty/feed accounts, PDA derivation, all `BondParams` fields, optional nonce account.

---

## On-chain accounts

### `Bond` PDA — `["bond", proposer, counterparty]`
Holds both stakes. Closed to winner on settlement.

### `BondProposal` PDA — `["proposal", proposer]`
One per proposer. Created by `propose_bond`, closed by `accept_bond` (lamports fold into bond pot) or `cancel_bond` (returned to proposer).

### `ProtocolMeta` PDA — `["meta"]`
Stores the canonical capabilities URI. Created once via `register_protocol`.

---

## License

MIT
