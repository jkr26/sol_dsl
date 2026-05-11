# Work Contract

The most important use case for an agentic economy: Agent A pays Agent B to do
work. Payment is conditional on completion. Both parties have skin in the game.

---

## The problem with price-feed bonds for work

Price conditions are objective and on-chain. Work completion is subjective and
off-chain. You cannot ask a Chainlink price feed "did Agent B write a good blog
post?"

The solution is a **WorkBond** — a 3-party adjudicated contract:

```
Payer (Agent A)     Worker (Agent B)     Adjudicator (Agent C or human)
      │                    │                          │
      │── create_work_bond ►│                          │
      │   payment escrowed  │                          │
      │   worker stake req  │                          │
      │◄── join_work_bond ──│                          │
      │   worker stake      │                          │
      │   escrowed          │                          │
      │                     │── [does the work] ──────►│
      │                     │                          │
      │◄────────────── adjudicate_work_bond ───────────│
      │                     │   (worker_succeeded: bool)
      │                     │                          │
      │  success: worker gets payment + stake back     │
      │  failure: payer gets payment back + worker's   │
      │           stake as penalty                     │
```

**WorkBond is not yet implemented on-chain** — it is the next planned primitive.
The examples below show the intended DSL and tool interface.

---

## Scenario A — Agent hires agent to generate a report

Agent A (data consumer) pays 2 SOL for a market analysis report.
Agent B (analyst agent) stakes 0.5 SOL as quality collateral.
Agent C (judge agent) attests delivery and quality.

**Intended DSL (WorkBond):**
```json
{
  "version": "1",
  "type":         "work",
  "payer":        "<Agent A pubkey>",
  "worker":       "<Agent B pubkey>",
  "adjudicator":  "<Agent C pubkey>",
  "payment":      2000000000,
  "worker_stake":  500000000,
  "expiry_slot":  700000,
  "description":  "SOL ecosystem weekly market analysis, >500 words, published to <endpoint>"
}
```

- Payer locks 2 SOL payment
- Worker locks 0.5 SOL collateral (disincentivises abandonment)
- Adjudicator signs `adjudicate_work_bond(worker_succeeded: true)`:
  - Worker receives 2.5 SOL (payment + collateral)
- Adjudicator signs `adjudicate_work_bond(worker_succeeded: false)`:
  - Payer receives 2.5 SOL (payment back + penalty from worker)
- If `expiry_slot` passes with no adjudication: payer gets everything back

---

## Scenario B — Agent compute market (AI inference)

Agent A needs an image described. Agent B runs a vision model.
Tiny stakes make microtransactions viable.

```json
{
  "version": "1",
  "type":         "work",
  "payer":        "<Agent A pubkey>",
  "worker":       "<Agent B pubkey>",
  "adjudicator":  "<Agent A pubkey>",
  "payment":      5000000,
  "worker_stake": 1000000,
  "expiry_slot":  435200,
  "description":  "Describe image at <ipfs-cid> in <200 words"
}
```

Note: payer-as-adjudicator is the simplest model but means the worker must
trust the payer. For a trustless version, use a neutral third-party judge agent.

---

## Scenario C — Agent SLA (uptime guarantee)

Agent B claims to offer a reliable data service. Agent A wants an SLA.
Agent B stakes 5 SOL; Agent A pays 0.1 SOL premium.
Judge monitors the service and slashes if it goes down.

```json
{
  "version": "1",
  "type":         "work",
  "payer":        "<Agent A pubkey>",
  "worker":       "<Agent B pubkey>",
  "adjudicator":  "<Monitor agent pubkey>",
  "payment":      100000000,
  "worker_stake": 5000000000,
  "expiry_slot":  1000000,
  "description":  "99.9% uptime SLA for data feed at <endpoint> over 100k slots"
}
```

---

## Approximating work contracts today (without WorkBond)

Until WorkBond is on-chain, a bilateral price bond can approximate a work
contract if both parties accept an adjudicator-as-oracle pattern:

1. Both parties agree off-band that Agent C is the adjudicator
2. Agent C holds a known keypair and will call `bond_settle` with the correct
   winner once the work is evaluated
3. Use a near-future `expiry_slot` so the oracle price at that slot is known
   (but this couples payment to price — fragile)

**This is a workaround.** WorkBond is the correct primitive for work markets.

---

## WorkBond vs price bond

| | Price Bond | Work Bond |
|---|---|---|
| Settlement | Chainlink oracle (permissionless) | Adjudicator signs |
| Objective | Price condition at a slot | Task completion |
| Trust model | Oracle, not parties | Adjudicator — choose carefully |
| Good for | Speculation, hedging, prediction | Labor, compute, data, SLAs |
| Planned | ✓ implemented | Roadmap |

---

## What Chainlink Functions would unlock

Chainlink Functions (currently EVM-only) can call any HTTP API on-chain:
- `GET /api/work/{id}/status == "complete"` → deterministic settlement
- GitHub PR merged, uptime check passed, email delivered
- This would make WorkBond trustless — the adjudicator becomes a URL, not an agent

When Chainlink Functions comes to Solana, WorkBond can be extended with a
`FUNCTION_RESULT` condition that calls a user-supplied URL.
