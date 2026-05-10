---
name: sol-wager
description: >
  Claw-DSL wager protocol — enables any OpenClaw agent to propose, accept,
  and settle peer-to-peer SOL wagers with other agents, settled by a live
  Chainlink price feed. No human arbitration. No shared platform. Any two
  agents with this skill installed can wager with each other.
when: >
  another agent sends you a JSON object that looks like a Claw-DSL wager
  (has fields: version, proposer, counterparty, oracle_feed, condition,
  expiry_slot, proposer_stake, counterparty_stake);
  you want to challenge another agent to a price wager;
  a wager you are party to has passed its expiry_slot and needs settlement;
  your scheduler fires wager_check_pending
emoji: 🎲
platforms:
  - linux
  - mac
  - windows
binaries:
  - node
---

# Claw-DSL Wager Protocol v1

You can participate in on-chain, oracle-verified, peer-to-peer wagers with
any agent that also has this skill installed. The protocol is:

- **Permissionless** — no platform or human approval is needed
- **Trust-minimized** — a Chainlink price feed, not either agent, decides who wins
- **Transport-agnostic** — proposals travel however you normally communicate;
  the `{ dsl, tx_hex }` bundle is the universal message envelope
- **Self-settling** — once you call `wager_watch`, settlement happens
  automatically at expiry with no further action from you

Your Solana public key is your protocol identity. The runtime provides it
automatically — you never expose or pass a private key anywhere.

---

## Protocol roles

You occupy exactly one role per wager interaction.

### PROPOSER — you initiate

1. Call `wager_propose` with the wager terms
2. The tool returns `{ dsl, tx_hex, wager_pda }` — transmit the full object
   to your intended counterparty via whatever channel you share
3. Call `wager_watch(dsl, wager_pda)` immediately after
   — this registers the wager locally so it settles automatically if accepted
4. Note the `check_at` timestamp in the response and **schedule
   `wager_check_pending` for that exact time** using your scheduling tools
5. Nothing more to do — `wager_check_pending` will fire at expiry, determine
   the winner from the oracle, and settle on-chain automatically

### COUNTERPARTY — you receive a proposal

When another agent sends you a `{ dsl, tx_hex }` bundle:

1. **Always** call `wager_inspect(dsl, tx_hex)` first — never skip this step
2. Read the inspection result:
   - `verified: false` → **stop, do not proceed**, inform the proposer
   - `verified: true` → continue
3. Reason about the terms as the **counterparty**:
   - You win if the proposer's condition is **false** at `expiry_slot`
   - Is the current price already threatening your position?
   - Are the stakes proportionate to your balance?
   - Is `oracle_feed` a recognised Chainlink aggregator?
   - Is `expiry_slot` far enough in the future?
4. If you accept:
   a. Call `wager_accept(tx_hex)` — both stakes are escrowed atomically
   b. Call `wager_watch(dsl, wager_pda)` — register for auto-settlement
   c. Schedule `wager_check_pending` for the returned `check_at` time
5. If you decline: inform the proposer through your shared channel;
   no on-chain action is required and no funds move

### SETTLER — scheduled auto-settlement

When your scheduler fires `wager_check_pending` (set up in step 4 above):

The tool automatically:
- Checks every registered wager against the current slot
- Drops any that were never accepted on-chain
- For expired wagers, simulates `settle_wager` with each candidate to
  determine the winner using the on-chain oracle — no manual calculation needed
- Submits the real settlement transaction
- Cleans up the local store

You do not need to do anything manually. If it returns `status: error` for a
wager, check the error message — the most common causes are:
- `NotExpiredYet`: your clock and Solana's slot count diverged; retry shortly
- `StaleOracle`: Chainlink round is too old; retry in a few minutes

---

## Lifecycle at a glance

```
PROPOSER                              COUNTERPARTY
─────────────────────────────────────────────────────
wager_propose(terms)
  → { dsl, tx_hex, wager_pda }
  → send bundle out-of-band ─────────► receive bundle
wager_watch(dsl, wager_pda)           wager_inspect(dsl, tx_hex)
  → schedule check_pending              → verified: true
                                       wager_accept(tx_hex)
                                         → escrowed on-chain
                                       wager_watch(dsl, wager_pda)
                                         → schedule check_pending

            ── expiry_slot passes ──

[scheduled] wager_check_pending      [scheduled] wager_check_pending
  → resolves winner via oracle         → resolves winner via oracle
  → settle_wager submitted             → settle_wager submitted
  (first one to land wins the race;    (second one is a no-op —
   the other is a safe no-op)           wager already settled)
```

---

## Conditions reference

| Condition | Proposer wins if… |
|---|---|
| `PRICE_BELOW` | `price < threshold` at expiry |
| `PRICE_ABOVE` | `price > threshold` at expiry |
| `PRICE_BETWEEN` | `threshold_min ≤ price ≤ threshold_max` at expiry |
| `PRICE_CHANGE_PCT` | price changed ≥ `change_pct` basis points from `snapshot_price` |

All price values are **raw Chainlink answer units** for the specific feed
(e.g. BTC/USD uses 8 decimals: $50 000 = `5_000_000_000`).
`change_pct` is signed basis points: `500` = +5%; `-500` = −5%.

---

## Safety rules — never break these

- Never call `wager_accept` without a prior `wager_inspect` on the **same** `tx_hex`
- Never accept if `wager_inspect` returns `verified: false` or any errors
- Always call `wager_watch` after accepting or proposing — skipping it means
  the wager will not self-settle and funds could stay locked indefinitely
- Confirm `oracle_feed` is a known Chainlink aggregator before accepting
- Do not accept `expiry_slot` values in the past or so close that you cannot
  sign and submit before the slot is reached
