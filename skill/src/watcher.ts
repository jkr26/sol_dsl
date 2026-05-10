import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";

export interface PendingWager {
  wager_pda: string;
  proposer: string;
  counterparty: string;
  oracle_feed: string;
  expiry_slot: number;
  registered_at: string;
}

// Solana targets ~400 ms/slot; 450 ms is a conservative scheduling estimate
const MS_PER_SLOT = 450;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureDir(storePath: string): void {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadPendingWagers(storePath: string): PendingWager[] {
  ensureDir(storePath);
  if (!fs.existsSync(storePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(storePath, "utf8")) as PendingWager[];
  } catch {
    return [];
  }
}

export function savePendingWager(storePath: string, entry: PendingWager): void {
  const wagers = loadPendingWagers(storePath).filter(
    (w) => w.wager_pda !== entry.wager_pda
  );
  wagers.push(entry);
  fs.writeFileSync(storePath, JSON.stringify(wagers, null, 2));
}

export function removePendingWager(storePath: string, wagerPda: string): void {
  const wagers = loadPendingWagers(storePath).filter(
    (w) => w.wager_pda !== wagerPda
  );
  fs.writeFileSync(storePath, JSON.stringify(wagers, null, 2));
}

// ---------------------------------------------------------------------------
// Slot → time estimate
// ---------------------------------------------------------------------------

/**
 * Returns the estimated Date at which to run wager_check_pending.
 * Adds a 60-second buffer so the oracle round is fresh on arrival.
 */
export function estimateCheckAt(currentSlot: number, expirySlot: number): Date {
  const slotsRemaining = Math.max(0, expirySlot - currentSlot);
  const msUntilExpiry = slotsRemaining * MS_PER_SLOT;
  return new Date(Date.now() + msUntilExpiry + 60_000);
}

// ---------------------------------------------------------------------------
// Winner resolution via simulation
// ---------------------------------------------------------------------------

/**
 * Determines the winner by simulating settle_wager with each candidate in turn.
 * The on-chain program reads the oracle and evaluates the condition — we don't
 * replicate that logic off-chain.
 *
 * Returns the base58 public key of the winner, or throws if neither simulation
 * succeeds (wager not yet expired, stale oracle, already settled, etc.).
 */
export async function resolveWinner(
  program: Program,
  wager: PendingWager,
  chainlinkProgramId: PublicKey
): Promise<string> {
  const systemProgram = new PublicKey("11111111111111111111111111111111");
  const candidates = [wager.proposer, wager.counterparty];

  for (const candidate of candidates) {
    try {
      await (program.methods as any)
        .settleWager()
        .accounts({
          wager: new PublicKey(wager.wager_pda),
          proposer: new PublicKey(wager.proposer),
          counterparty: new PublicKey(wager.counterparty),
          winner: new PublicKey(candidate),
          chainlinkFeed: new PublicKey(wager.oracle_feed),
          chainlinkProgram: chainlinkProgramId,
          systemProgram,
        })
        .simulate();

      return candidate; // simulation passed — this is the winner
    } catch (e: unknown) {
      const msg = String(e);
      // WrongWinner means the other candidate wins — try the next one
      if (msg.includes("WrongWinner")) continue;
      // Any other error is a hard stop (NotExpiredYet, StaleOracle, etc.)
      throw new Error(`settle_wager simulation failed: ${msg}`);
    }
  }

  throw new Error(
    "Neither candidate passed simulation — check expiry slot and oracle freshness"
  );
}

export function resolveStorePath(raw: string): string {
  return raw.replace("~", process.env.HOME ?? os.homedir());
}
