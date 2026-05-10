---
name: sol-wager
description: Enables OpenClaw agents to propose, inspect, and settle peer-to-peer SOL wagers backed by Chainlink oracle feeds on Solana
when: agent needs to create a wager, inspect or countersign a proposed wager, or settle an expired wager
emoji: 🎲
platforms:
  - linux
  - mac
  - windows
binaries:
  - node
---

# Solana Agent Wager Skill

This skill lets you participate in on-chain, oracle-verified wagers against another agent. Each wager is governed by a **Claw-DSL** JSON object and settled by a live Chainlink price feed — no human arbitration required.

## Workflow

### Proposing a wager

Call `propose_wager` with:
- The counterparty's public key
- The Chainlink feed public key you want to use as the oracle
- Your chosen condition: `PRICE_BELOW`, `PRICE_ABOVE`, `PRICE_BETWEEN`, or `PRICE_CHANGE_PCT`
- Threshold value(s) in raw Chainlink units (check the feed's decimal precision)
- The Solana slot at which the wager expires (`expiry_slot`)
- Both stake amounts in lamports (`proposer_stake` and `counterparty_stake`)
- A durable nonce account public key (`nonce_account`) — create one first with `create_nonce_account`

The tool returns:
- A `dsl` object (the canonical Claw-DSL for this wager)
- A `tx_hex` string: a partially-signed, durable-nonce transaction ready for counterparty review

Send `dsl` and `tx_hex` to the counterparty agent out-of-band.

### Inspecting and countersigning

When you receive a `dsl` + `tx_hex` pair from a proposing agent:

1. Call `inspect_wager` with both. It runs the verification function and confirms the hex was compiled deterministically from the DSL. Review the returned summary carefully.
2. If you accept, call `countersign_wager` with the `tx_hex` and your private key. This adds your signature and returns the fully-signed `signed_tx_hex`.
3. Submit `signed_tx_hex` to the Solana network.

### Settling an expired wager

After `expiry_slot` has passed:

1. Read the current Chainlink price for the feed in the DSL.
2. Evaluate the condition off-chain to determine the winner.
3. Call `settle_wager` with the wager PDA address, the winner's public key, and the feed account. The program verifies your determination; it reverts if wrong.

## Safety rules

- **Never countersign** without running `inspect_wager` first.
- Do not countersign if `inspect_wager` returns any errors.
- Confirm `expiry_slot` is far enough in the future that both agents have time to sign before the nonce advances.
- All price thresholds must be in **raw Chainlink units** for the specific feed (e.g., BTC/USD has 8 decimals, so $50,000 = 5_000_000_000).
- `change_pct` is in **basis points** (100 = 1%). Positive means price-up bet; negative means price-down bet.
