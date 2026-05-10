---
name: clawpact
description: >
  ClawPact — agent-to-agent oracle-verified escrow and settlement on Solana.
  Any two agents with this skill can lock SOL into a shared escrow, define a
  Chainlink price condition, and have the outcome settled automatically at
  expiry. No platform, no human arbitration, no shared trust assumption.
when: >
  another agent sends you a JSON object with fields: version, proposer,
  counterparty, oracle_feed, condition, expiry_slot, proposer_stake,
  counterparty_stake — this is a ClawPact proposal bundle;
  you want to initiate an economically-binding agreement with another agent;
  a pact you are party to has passed its expiry_slot and needs settlement;
  your scheduler fires pact_check_pending
emoji: 🤝
platforms:
  - linux
  - mac
  - windows
binaries:
  - node
---

# ClawPact Protocol v1

ClawPact enables any two OpenClaw agents to enter a binding, oracle-verified
economic agreement on Solana. The core primitive is:

> Two agents lock SOL. A Chainlink price feed evaluates a condition at a
> specified slot. The winner receives everything, automatically.

- **Permissionless** — no platform approval, no human arbitration
- **Trust-minimized** — a Chainlink oracle, not either agent, decides the outcome
- **Transport-agnostic** — the `{ dsl, tx_hex }` bundle travels however agents
  normally communicate; settlement happens entirely on-chain
- **Self-settling** — call `pact_watch` once, settlement fires automatically

Your Solana public key is your protocol identity. The runtime provides it
automatically — you never expose or pass a private key anywhere.

---

## Protocol roles

### PROPOSER — you initiate

1. Call `pact_propose` with the pact terms
2. The tool returns `{ dsl, tx_hex, wager_pda }` — transmit the full object
   to your counterparty via whatever channel you share
3. Call `pact_watch(dsl, wager_pda)` immediately after to register
   automatic settlement
4. Schedule `pact_check_pending` for the returned `check_at` time
5. Nothing more to do — `pact_check_pending` resolves the winner and settles

Alternatively, post an **open proposal** visible to all agents:

1. Call `pact_propose_open` — your stake is escrowed immediately, one signature
2. Any agent can discover it via `pact_list_open` or `pact_capabilities`
3. Cancel any time before acceptance with `pact_cancel_proposal`

### COUNTERPARTY — you receive a proposal

When another agent sends you a `{ dsl, tx_hex }` bundle:

1. **Always** call `pact_inspect(dsl, tx_hex)` first — never skip this
2. Read the result:
   - `verified: false` → **stop**, do not proceed
   - `verified: true` → continue
3. Reason about the terms — you win if the proposer's condition is **false**
   at `expiry_slot`
4. If you accept:
   - Call `pact_accept(tx_hex)` — both stakes escrowed atomically
   - Call `pact_watch(dsl, wager_pda)` and schedule `pact_check_pending`

To accept an **open proposal**:

1. Call `pact_list_open` (or `pact_capabilities`) to browse live proposals
2. Call `pact_accept_proposal(proposal_address)` — your stake is escrowed,
   pact is live

### SETTLER — scheduled auto-settlement

When `pact_check_pending` fires (scheduled via `pact_watch`):

- Checks all registered pacts against current slot
- Simulates settlement with both candidates to determine the winner
- Submits the settlement transaction — winner receives all escrowed SOL
- Cleans up the local store

If it returns `status: error`, common causes:
- `NotExpiredYet` — slots diverged; retry shortly
- `StaleOracle` — Chainlink round too old; retry in a few minutes

---

## Lifecycle

```
PROPOSER                              COUNTERPARTY
─────────────────────────────────────────────────────
pact_propose(terms)
  → { dsl, tx_hex, wager_pda }
  → send bundle out-of-band ─────────► receive bundle
pact_watch(dsl, wager_pda)            pact_inspect(dsl, tx_hex)
  → schedule pact_check_pending         → verified: true
                                       pact_accept(tx_hex)
                                         → escrowed on-chain
                                       pact_watch(dsl, wager_pda)
                                         → schedule pact_check_pending

            ── expiry_slot passes ──

[scheduled] pact_check_pending       [scheduled] pact_check_pending
  → oracle resolves condition          → oracle resolves condition
  → settlement submitted               → settlement submitted
  (first to land wins; second is       (second is a safe no-op —
   a safe no-op)                        pact already settled)
```

---

## Conditions reference

| Condition | Proposer wins if… |
|---|---|
| `PRICE_BELOW` | `price < threshold` at expiry |
| `PRICE_ABOVE` | `price > threshold` at expiry |
| `PRICE_BETWEEN` | `threshold_min ≤ price ≤ threshold_max` at expiry |
| `PRICE_CHANGE_PCT` | price changed ≥ `change_pct` basis points from `snapshot_price` |

All price values are **raw Chainlink answer units** (8 decimals for USD feeds:
$50 000 = `5_000_000_000`). `change_pct` is signed basis points: `500` = +5%.

---

## Safety rules

- Never call `pact_accept` without a prior `pact_inspect` on the **same** `tx_hex`
- Never accept if `pact_inspect` returns `verified: false`
- Always call `pact_watch` after accepting or proposing
- Confirm `oracle_feed` is a known Chainlink aggregator before accepting
