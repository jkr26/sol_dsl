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
  a wager you are party to has passed its expiry_slot and needs settlement
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
- **Transport-agnostic** — proposals travel however you normally communicate
  (DM, post, webhook, email). The `{ dsl, tx_hex }` bundle is the message

Your Solana public key is your protocol identity. The runtime provides it
automatically — you never expose or pass a private key anywhere.

---

## Protocol roles

You occupy exactly one role per wager interaction.

### PROPOSER — you initiate

1. Call `wager_propose` with the wager terms (see tool schema for fields)
2. The tool returns `{ dsl, tx_hex, wager_pda }` — transmit the full object
   to your intended counterparty via whatever channel you share
3. Wait. If the counterparty accepts, they sign and submit — you will see
   the wager PDA appear on-chain. If they decline or ignore, nothing happens
   and your funds are never escrowed

### COUNTERPARTY — you receive a proposal

When another agent sends you a `{ dsl, tx_hex }` bundle:

1. **Always** call `wager_inspect(dsl, tx_hex)` first — never skip this step
2. Read the inspection result carefully:
   - `verified: false` → **stop, do not proceed**, inform the proposer
   - `verified: true` → continue to step 3
3. Reason about the terms as the **counterparty**:
   - You win if the proposer's condition is **false** at `expiry_slot`
   - Is the current price already threatening your position?
   - Are the stakes proportionate to your balance?
   - Is the oracle feed a recognised Chainlink aggregator for the stated asset?
   - Is `expiry_slot` far enough in the future that you have time to sign?
4. If you accept: call `wager_accept(tx_hex)` — this adds your signature and
   submits the transaction atomically. Both stakes are escrowed on-chain.
5. If you decline: tell the proposer through your shared channel; no on-chain
   action is required and no funds move

### SETTLER — you close an expired wager

Any party (proposer or counterparty) may settle once `expiry_slot` has passed.
Whoever calls it first collects no extra reward — but the winner's lamports are
released the moment settlement lands.

1. Read the Chainlink feed for the asset in `dsl.oracle_feed`
2. Evaluate the condition yourself to determine the winner's address
3. Call `wager_settle(wager_pda, proposer, counterparty, winner, oracle_feed)`
4. The program reads the oracle on-chain and **reverts** if your `winner`
   argument is wrong — you cannot steal funds by passing the wrong address

---

## Conditions reference

| Condition | Proposer wins if… |
|---|---|
| `PRICE_BELOW` | `price < threshold` at expiry |
| `PRICE_ABOVE` | `price > threshold` at expiry |
| `PRICE_BETWEEN` | `threshold_min ≤ price ≤ threshold_max` at expiry |
| `PRICE_CHANGE_PCT` | price changed by ≥ `change_pct` basis points from `snapshot_price` |

All price values are **raw Chainlink answer units** for the specific feed
(e.g. BTC/USD uses 8 decimals, so $50 000 = `5_000_000_000`).
`change_pct` is signed basis points: `500` = +5 % (price went up); `-500` = −5 %.

---

## Safety rules — never break these

- Never call `wager_accept` without a prior `wager_inspect` on the **same** `tx_hex`
- Never accept if `wager_inspect` returns `verified: false` or any errors
- Confirm `oracle_feed` is a known Chainlink aggregator before accepting any wager
- Do not accept `expiry_slot` values in the past or so soon that you cannot sign in time
