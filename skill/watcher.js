"use strict";

/**
 * Watcher — local persistence and winner-resolution for pending wagers.
 *
 * Each agent instance keeps a JSON store of wagers it is party to.
 * When wager_check_pending runs, it:
 *   1. Skips wagers that haven't reached expiry_slot yet
 *   2. Drops wagers whose PDA no longer exists on-chain (never accepted / already settled)
 *   3. Resolves the winner by simulating settle_wager with each candidate —
 *      the on-chain program's own condition logic determines who won
 *   4. Submits the real settle_wager transaction and removes the wager from the store
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { PublicKey } = require("@solana/web3.js");

const STORE_PATH =
  process.env.SOL_WAGER_STORE_PATH ||
  path.join(os.homedir(), ".openclaw", "sol-wager", "pending.json");

// Solana targets ~400ms per slot; 450ms is a conservative estimate for scheduling
const MS_PER_SLOT = 450;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureStoreDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadPendingWagers() {
  ensureStoreDir();
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return [];
  }
}

function savePendingWager(entry) {
  const wagers = loadPendingWagers().filter((w) => w.wager_pda !== entry.wager_pda);
  wagers.push(entry);
  fs.writeFileSync(STORE_PATH, JSON.stringify(wagers, null, 2));
}

function removePendingWager(wagerPda) {
  const wagers = loadPendingWagers().filter((w) => w.wager_pda !== wagerPda);
  fs.writeFileSync(STORE_PATH, JSON.stringify(wagers, null, 2));
}

// ---------------------------------------------------------------------------
// Slot → time estimate
// ---------------------------------------------------------------------------

/**
 * Converts a slot difference into an estimated wake-up Date.
 * Adds a 60-second buffer so the oracle round is fresh when we arrive.
 */
function estimateCheckAt(currentSlot, expirySlot) {
  const slotsRemaining = Math.max(0, Number(expirySlot) - Number(currentSlot));
  const msUntilExpiry = slotsRemaining * MS_PER_SLOT;
  const bufferMs = 60_000;
  return new Date(Date.now() + msUntilExpiry + bufferMs);
}

// ---------------------------------------------------------------------------
// Winner resolution via simulation
// ---------------------------------------------------------------------------

/**
 * Determines the winner by simulating settle_wager with each candidate.
 * The on-chain program reads the oracle and evaluates the condition — we
 * don't need to replicate that logic off-chain.
 *
 * Returns the base58 public key of the winner, or throws if neither
 * candidate succeeds (wager not yet expired, stale oracle, etc.).
 */
async function resolveWinner(program, wager, chainlinkProgramId) {
  const candidates = [wager.proposer, wager.counterparty];

  for (const candidate of candidates) {
    try {
      await program.methods
        .settleWager()
        .accounts({
          wager: new PublicKey(wager.wager_pda),
          proposer: new PublicKey(wager.proposer),
          counterparty: new PublicKey(wager.counterparty),
          winner: new PublicKey(candidate),
          chainlinkFeed: new PublicKey(wager.oracle_feed),
          chainlinkProgram: chainlinkProgramId,
          systemProgram: new PublicKey("11111111111111111111111111111111"),
        })
        .simulate();

      return candidate; // simulation passed — this is the correct winner
    } catch (e) {
      const msg = e?.toString() ?? "";
      // WrongWinner means the other candidate wins — continue
      if (msg.includes("WrongWinner")) continue;
      // Any other error (NotExpiredYet, StaleOracle, AlreadySettled) is a hard stop
      throw new Error(`settle_wager simulation failed: ${msg}`);
    }
  }

  throw new Error("Neither candidate passed simulation — check expiry slot and oracle freshness");
}

module.exports = {
  loadPendingWagers,
  savePendingWager,
  removePendingWager,
  estimateCheckAt,
  resolveWinner,
};
