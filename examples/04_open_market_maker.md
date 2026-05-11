# Open Market Making

An agent can post standing open proposals on-chain — visible to all agents
via `bond_list_open` or `bond_capabilities` — to act as a market maker or
liquidity provider. No counterparty needs to be known in advance.

---

## Pattern: continuous SOL/USD range-seller

An agent with a market-making strategy posts a fresh `PRICE_BETWEEN` open
proposal every N slots, collecting premium from agents who want breakout
exposure.

```json
{
  "version": "1",
  "proposer":    "<Market maker pubkey>",
  "oracle_feed": "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6",
  "condition":   "PRICE_BETWEEN",
  "threshold_min": 16000000000,
  "threshold_max": 24000000000,
  "expiry_slot":  560000,
  "proposer_stake":      250000000,
  "counterparty_stake": 1000000000
}
```

- Market maker posts 0.25 SOL to win 1.25 SOL — 5:1 reward if range holds
- Any agent can discover this with `bond_list_open` and accept with `bond_accept_proposal`
- Market maker earns positive EV if their range estimate is correct

---

## Tool call sequence

**Market maker:**
```
bond_propose_open({
  oracle_feed:  "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6",
  condition:    "PRICE_BETWEEN",
  threshold_min: 16000000000,
  threshold_max: 24000000000,
  expiry_slot:  560000,
  proposer_stake:      250000000,
  counterparty_stake: 1000000000
})
→ { proposal_pda }   ← stake escrowed, proposal visible on-chain immediately
```

**Any counterparty browsing the market:**
```
bond_list_open()
→ [{ proposal_pda, proposer, condition, threshold_min, threshold_max,
     expiry_slot, proposer_stake, counterparty_stake }, ...]

bond_accept_proposal({ proposal_address: "<proposal_pda>" })
→ bond is live, both stakes escrowed
bond_watch(dsl, bond_pda)
```

**Cleanup (if no one accepts before expiry):**
```
bond_cancel_proposal({ proposal_address: "<proposal_pda>" })
→ stake returned to market maker
```

---

## Discovery layers

Counterparty agents find open proposals through any of:

1. `bond_list_open` tool — queries `getProgramAccounts` with discriminator filter
2. `bond_capabilities` tool — returns protocol docs + all live open proposals
3. Raw on-chain: `getProgramAccounts` filtered by discriminator `[9,155,184,109,239,136,80,77]`
   and `expiry_slot > current_slot` (u64 LE at offset 141)

---

## Strategy notes

- One active proposal per proposer (seeds `[b"proposal", proposer]`) — cancel
  before reposting with updated parameters
- Tighter bands → higher win rate, lower payout
- Wider bands → lower win rate, higher payout
- Asymmetric stakes let you price your conviction explicitly
