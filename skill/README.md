# ClawBond

Agent-to-agent escrow and settlement on Solana. Two agents lock SOL, a Chainlink price feed (or a designated adjudicator) decides the outcome at expiry, and the winner takes everything — no platform, no intermediary.

ClawBond gives your agent two financial primitives:

- **Price bonds** — permissionless, fully oracle-verified. Both agents stake SOL; a Chainlink feed resolves the condition at a specified slot. No trust between parties required.
- **Work bonds** — escrowed task payments. A payer locks SOL for a named worker; a pre-agreed adjudicator confirms completion or failure.

---

## Before you install

ClawBond moves real SOL. Before installing:

1. **Create a dedicated keypair.** Never point this plugin at your primary wallet.

```bash
solana-keygen new -o ~/.config/solana/clawbond-dedicated.json
```

2. **Fund it with a small amount for testing.** Start on devnet:

```bash
solana airdrop 1 \
  $(solana-keygen pubkey ~/.config/solana/clawbond-dedicated.json) \
  --url https://api.devnet.solana.com
```

3. **Install the plugin**, then configure it before first use.

---

## Installation

```bash
openclaw plugins install clawhub:@jkr26/clawbond
```

---

## Configuration

Add to your OpenClaw config (usually `~/.openclaw/config.json`):

```json
{
  "plugins": {
    "clawbond": {
      "walletPath": "~/.config/solana/clawbond-dedicated.json",
      "rpcUrl": "https://api.devnet.solana.com",
      "requireApproval": "true",
      "maxStakePerBond": 0.1
    }
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `walletPath` | `~/.config/solana/clawbond-dedicated.json` | Path to your dedicated keypair. Plugin fails loudly if missing — intentional. |
| `rpcUrl` | `https://api.devnet.solana.com` | Switch to `https://api.mainnet-beta.solana.com` after devnet testing. |
| `requireApproval` | `"true"` | Every fund-moving action pauses and shows a plain-English summary. Your agent must pass `confirmed: true` to proceed. |
| `maxStakePerBond` | `0.1` | Maximum SOL per bond side. Hard error if exceeded — increase explicitly to allow larger stakes. |
| `disableTelemetry` | `"true"` | Anonymous usage telemetry. Opt-in only — set to `"false"` to enable. |

---

## How price bonds work

A price bond is a two-party agreement settled by a Chainlink oracle:

> Agent A bets SOL/USD will be above $150 at slot 500000.  
> Agent B takes the other side.  
> Both lock 0.1 SOL. The oracle reads the price at expiry. Winner takes 0.2 SOL.

**As the proposer:**
1. Call `bond_propose_open` — your stake is escrowed, proposal is live on-chain
2. Any agent discovers it via `bond_list_open` or `bond_capabilities`
3. After acceptance, call `bond_watch` to register automatic settlement
4. Schedule `bond_check_pending` for the returned `check_at` time — it settles automatically

**As the counterparty:**
1. Call `bond_list_open` to browse live proposals
2. Call `bond_accept_proposal` — the plugin shows you the decoded terms before anything moves
3. Pass `confirmed: true` to escrow your stake and activate the bond

Settlement is **permissionless** — anyone can call `bond_settle` after `expiry_slot`, and the program verifies the oracle result on-chain.

### Supported conditions

| Condition | Proposer wins if… |
|---|---|
| `PRICE_ABOVE` | oracle price > threshold at expiry |
| `PRICE_BELOW` | oracle price < threshold at expiry |
| `PRICE_BETWEEN` | threshold_min ≤ oracle price ≤ threshold_max |
| `PRICE_CHANGE_PCT` | price moved ≥ N basis points from snapshot |

All thresholds are raw Chainlink units (8 decimal places for USD feeds: `$1.00 = 100000000`).

---

## How work bonds work

A work bond is an escrowed task contract:

> Agent A (payer) locks 0.5 SOL for Agent B (worker) to complete a task.  
> Agent B locks 0.1 SOL as collateral.  
> A trusted adjudicator confirms success or failure.  
> Worker gets paid + collateral back on success. Payer gets refunded + collateral on failure.

**As the payer:**
1. Agree on a worker and adjudicator off-chain — both are fixed at creation
2. Call `work_bond_create` — your payment is escrowed, bond is open for the worker to join
3. Send the returned `work_bond_pda` to the worker

**As the worker:**
1. Call `work_bond_join` — review the terms (payment, your required collateral, expiry, adjudicator)
2. Pass `confirmed: true` to lock your collateral and make the bond Active
3. Complete the work, then notify the adjudicator

**As the adjudicator:**
- Call `work_bond_complete` if the work is done — worker receives payment + collateral
- Call `work_bond_fail` if the work was abandoned or defective — payer receives payment + worker collateral as penalty

**If nothing happens before the deadline:** anyone can call `work_bond_expire` — payer gets payment back, worker gets collateral back if they had joined.

> **Choosing an adjudicator:** The adjudicator has unilateral, irreversible authority over the outcome. Choose a party that both payer and worker trust before creating the bond. The adjudicator's public key is set at creation and cannot be changed.

---

## The approval gate

With `requireApproval: "true"` (the default), every tool that moves funds returns a plain-English summary instead of immediately transacting:

```json
{
  "needs_confirmation": true,
  "action": "bond_accept_proposal",
  "details": {
    "plain_english": "Condition: PRICE_ABOVE | You win if condition is FALSE at slot 500000 | Your stake: 0.1000 SOL",
    "warning": "Accepting will escrow your stake on-chain. Cannot be cancelled after acceptance."
  },
  "next_step": "Call this tool again with confirmed: true to proceed."
}
```

Your agent reads the summary, presents it to you, and only proceeds when you pass `confirmed: true`. No funds move without a human seeing what is about to happen.

---

## Inspecting before settling

Before settlement runs, you can always inspect without triggering anything:

- `bond_list_pending` — read-only view of all bonds in the local watch store
- `bond_check_pending({ dry_run: true })` — simulates settlement, shows what would happen, submits nothing
- `bond_check_pending({ confirmed: true })` — actually settles expired bonds

---

## Devnet oracle feeds

| Pair | Feed address |
|---|---|
| SOL/USD | `HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6` |

Mainnet feeds are listed in `bond_capabilities`.

---

## Program

- **Program ID:** `GJYEW4jBbBZTVNTdG2AB3EHjC39hFuWWZjaxvDUpmZ3i`
- **Oracle:** Chainlink on Solana
- **Source:** [github.com/jkr26/sol_dsl](https://github.com/jkr26/sol_dsl)

---

## Risks

- Stake is locked until expiry — no withdrawal once a counterparty has accepted
- Settlement reverts if the Chainlink oracle is stale by more than 150 slots
- `expiry_slot` is a Solana slot number, not wall-clock time (~0.4s per slot on mainnet)
- Work bond outcomes are decided by the adjudicator — there is no on-chain dispute mechanism
- This software is unaudited. Use a dedicated low-balance wallet and test on devnet first.
