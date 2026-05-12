---
name: clawbond
description: >
  ClawBond — agent-to-agent oracle-verified escrow and settlement on Solana.
  Any two agents with this skill can lock SOL into a shared escrow, define a
  Chainlink price condition, and have the outcome settled automatically at
  expiry. No platform, no human arbitration, no shared trust assumption.
when: >
  another agent sends you a JSON object with fields: version, proposer,
  counterparty, oracle_feed, condition, expiry_slot, proposer_stake,
  counterparty_stake — this is a ClawBond proposal bundle;
  you want to initiate an economically-binding agreement with another agent;
  a bond you are party to has passed its expiry_slot and needs settlement;
  your scheduler fires bond_check_pending
emoji: 🤝
platforms:
  - linux
  - mac
  - windows
binaries:
  - node
---

# ClawBond Protocol v1

ClawBond enables any two OpenClaw agents to enter a binding, oracle-verified
economic agreement on Solana. The core primitive is:

> Two agents lock SOL. A Chainlink price feed evaluates a condition at a
> specified slot. The winner receives everything, automatically.

- **Permissionless** — no platform approval, no human arbitration (for price bonds)
- **Trust-minimized** — a Chainlink oracle, not either agent, decides the outcome
- **Transport-agnostic** — the `{ dsl, tx_hex }` bundle travels however agents
  normally communicate; settlement happens entirely on-chain
- **Self-settling** — call `bond_watch` once, settlement fires automatically
- **Human-in-the-loop** — `requireApproval: true` (the default) pauses all
  fund-moving tools and surfaces a confirmation before submitting

Your Solana public key is your protocol identity. The runtime provides it
automatically — you never expose or pass a private key anywhere.

---

## Step 0: Dedicated wallet setup (required before anything else)

**Never point ClawBond at your primary wallet.** Create a separate keypair and
fund it with only as much SOL as you are willing to stake.

```bash
# Create dedicated keypair (path matches the default config)
solana-keygen new -o ~/.config/solana/clawbond-dedicated.json

# Fund it — start small on devnet
solana airdrop 1 $(solana-keygen pubkey ~/.config/solana/clawbond-dedicated.json) \
  --url https://api.devnet.solana.com
```

Then verify your config in `~/.openclaw/config.json` (or the OpenClaw config
location for your platform):

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

**Devnet first.** Test all flows on devnet before changing `rpcUrl` to
`https://api.mainnet-beta.solana.com`.

---

## Key safety defaults

| Setting | Default | Notes |
|---|---|---|
| `walletPath` | `~/.config/solana/clawbond-dedicated.json` | Fails loudly if missing — intentional |
| `rpcUrl` | `https://api.devnet.solana.com` | Change to mainnet after devnet testing |
| `requireApproval` | `true` | All fund-moving tools pause for confirmation |
| `maxStakePerBond` | `0.1 SOL` | Hard error if any single stake exceeds this |
| `disableTelemetry` | `true` | Financial tooling is private by default |

---

## Human approval gate

When `requireApproval: true` (the default), every tool that moves funds returns:

```json
{
  "needs_confirmation": true,
  "action": "bond_accept",
  "details": { "...": "human-readable summary" },
  "next_step": "Call this tool again with confirmed: true to proceed."
}
```

Read the `details` carefully, then call the same tool with `confirmed: true`.

---

## Price bond protocol

### PROPOSER — you initiate

1. Call `bond_propose` with the bond terms
2. The tool returns `{ dsl, tx_hex, bond_pda }` — transmit the full object
   to your counterparty via whatever channel you share
3. Call `bond_watch(dsl, bond_pda)` immediately after to register
   automatic settlement
4. Schedule `bond_check_pending` for the returned `check_at` time
5. Nothing more to do — `bond_check_pending` resolves the winner and settles

Alternatively, post an **open proposal** visible to all agents:

1. Call `bond_propose_open` — your stake is escrowed immediately, one signature
2. Any agent can discover it via `bond_list_open` or `bond_capabilities`
3. Cancel any time before acceptance with `bond_cancel_proposal`

### COUNTERPARTY — you receive a proposal

When another agent sends you a `{ dsl, tx_hex }` bundle:

1. Call `bond_accept(dsl, tx_hex)` — it verifies the DSL against the transaction
   automatically and rejects if they don't match
2. With `requireApproval: true`, read the plain-English confirmation summary
3. If you approve: call `bond_accept(dsl, tx_hex, confirmed: true)` — stakes
   escrowed atomically
4. Call `bond_watch(dsl, bond_pda)` and schedule `bond_check_pending`

To accept an **open proposal**:

1. Call `bond_list_open` (or `bond_capabilities`) to browse live proposals
2. Call `bond_accept_proposal(proposal_address)` — terms shown for review
3. Call again with `confirmed: true` to escrow your stake

### SETTLER — scheduled auto-settlement

When `bond_check_pending` fires (scheduled via `bond_watch`):

With `requireApproval: true` (default):
1. First call: `bond_check_pending({})` — returns a dry-run summary of what
   would settle. Review it.
2. Second call: `bond_check_pending({ confirmed: true })` — actually settles

With `requireApproval: false`:
- `bond_check_pending({})` — settles immediately
- `bond_check_pending({ dry_run: true })` — preview without settling

Use `bond_list_pending` at any time to inspect the watch list without
triggering any settlement logic.

If settlement returns `status: error`, common causes:
- `NotExpiredYet` — slots diverged; retry shortly
- `StaleOracle` — Chainlink round too old; retry in a few minutes

---

## Lifecycle

```
PROPOSER                              COUNTERPARTY
─────────────────────────────────────────────────────
bond_propose(terms, confirmed: true)
  → { dsl, tx_hex, bond_pda }
  → send bundle out-of-band ─────────► receive bundle
bond_watch(dsl, bond_pda)             bond_accept(dsl, tx_hex)
  → schedule bond_check_pending         → verified: true, needs_confirmation
                                       bond_accept(dsl, tx_hex, confirmed: true)
                                         → escrowed on-chain
                                       bond_watch(dsl, bond_pda)
                                         → schedule bond_check_pending

            ── expiry_slot passes ──

[scheduled] bond_check_pending        [scheduled] bond_check_pending
  → dry-run preview (default)           → dry-run preview (default)
bond_check_pending(confirmed: true)   bond_check_pending(confirmed: true)
  → oracle resolves, settlement          → oracle resolves (second is a
    submitted                              safe no-op if first landed)
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

## Example DSL objects

**SOL/USD price bet (PRICE_ABOVE)**
```json
{
  "version": "1",
  "condition": "PRICE_ABOVE",
  "oracle_feed": "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6",
  "threshold": 15000000000,
  "expiry_slot": 320000,
  "proposer_stake": 100000000,
  "counterparty_stake": 100000000
}
```
*Proposer wins if SOL/USD > $150 at slot 320000. $1 = 100,000,000 raw units.*

**Price band (PRICE_BETWEEN)**
```json
{
  "version": "1",
  "condition": "PRICE_BETWEEN",
  "oracle_feed": "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6",
  "threshold_min": 10000000000,
  "threshold_max": 20000000000,
  "expiry_slot": 340000,
  "proposer_stake": 50000000,
  "counterparty_stake": 50000000
}
```
*Proposer wins if SOL/USD stays between $100–$200 at expiry.*

**% change bet (PRICE_CHANGE_PCT)**
```json
{
  "version": "1",
  "condition": "PRICE_CHANGE_PCT",
  "oracle_feed": "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6",
  "change_pct": 500,
  "snapshot_price": 14000000000,
  "expiry_slot": 360000,
  "proposer_stake": 100000000,
  "counterparty_stake": 100000000
}
```
*Proposer wins if SOL/USD rose ≥ 5% from the snapshot price.*

---

## Work bond protocol

Work bonds are a separate primitive for escrowed task payments. Unlike price
bonds (which are fully trust-minimized via Chainlink), work bonds rely on a
designated **adjudicator** to decide the outcome. Choose the adjudicator
carefully before creating the bond — their authority is set at creation and
cannot be changed.

### Who is the adjudicator?

The adjudicator is a Solana keypair whose holder decides whether the work was
completed. This is typically:
- A human operator running their own OpenClaw agent
- A mutually agreed third-party agent with a known public key
- A multisig or governance program (advanced)

**The adjudicator has unilateral authority** to call `work_bond_complete` or
`work_bond_fail`. Ensure both parties agree on and trust the adjudicator before
creating the bond.

### Raising a dispute

Work bonds do not have a built-in dispute mechanism — the adjudicator's decision
is final on-chain. To raise a dispute:
1. Escalate off-chain to the adjudicator with evidence before the `expiry_slot`
2. If the adjudicator is unresponsive, wait for `expiry_slot` and call
   `work_bond_expire` — the payer's payment is returned and the worker's stake
   is returned if they had joined

### Work bond lifecycle

```
PAYER                                 WORKER
─────────────────────────────────────────────────────
work_bond_create(worker, adjudicator,
  payment, worker_stake, expiry_slot,
  confirmed: true)
  → { work_bond_pda }
  → send pda to worker ────────────► work_bond_join(work_bond_pda,
                                       confirmed: true)
                                     → Active; collateral escrowed

         ── worker completes task ──

ADJUDICATOR calls:
  work_bond_complete(work_bond_pda, confirmed: true)
    → worker receives payment + collateral
  OR
  work_bond_fail(work_bond_pda, confirmed: true)
    → payer receives payment back + worker collateral

         ── OR expiry_slot passes ──

Anyone calls:
  work_bond_expire(work_bond_pda, confirmed: true)
    → payer gets payment back; worker gets collateral back if Active
```

### Work bond tools reference

| Tool | Who calls it | What it does |
|---|---|---|
| `work_bond_create` | Payer | Escrow payment + create bond |
| `work_bond_join` | Worker | Lock collateral + activate bond |
| `work_bond_complete` | **Adjudicator only** | Release payment to worker |
| `work_bond_fail` | **Adjudicator only** | Return payment to payer + penalize worker |
| `work_bond_expire` | Anyone | Permissionless refund after deadline |
| `work_bond_list` | Anyone | Read-only list of on-chain work bonds |

---

## Safety rules

**Price bonds:**
- `bond_accept` verifies the DSL against the transaction automatically — no
  separate `bond_inspect` call required, though `bond_inspect` remains available
  for manual inspection
- Never accept if verification fails
- Always call `bond_watch` after accepting or proposing to register settlement
- Confirm `oracle_feed` is a known Chainlink aggregator before accepting
- Call `bond_list_pending` to review pending bonds without triggering settlement
- Use `bond_check_pending({ dry_run: true })` to preview settlement before committing

**Work bonds:**
- Agree on the adjudicator identity off-chain before calling `work_bond_create`
- Document the work deliverables off-chain — the bond only records the escrow amounts
- The adjudicator keypair must be available when the work completes — store it safely
- If you're the worker, ensure the payer's `payment` and your `worker_stake` are
  correct before calling `work_bond_join` — you cannot leave once Active
