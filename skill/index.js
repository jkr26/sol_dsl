"use strict";

/**
 * OpenClaw Plugin: sol-wager
 *
 * Six agent tools covering the full wager lifecycle:
 *
 *   wager_propose        — build DSL + partially-signed tx as proposer
 *   wager_inspect        — verify a received DSL/tx pair before accepting
 *   wager_accept         — countersign + submit as counterparty
 *   wager_settle         — settle an expired wager (permissionless)
 *   wager_watch          — register a wager for automatic settlement tracking
 *   wager_check_pending  — check all watched wagers; settle any that have expired
 *
 * Agent identity (Solana keypair) is provided by the OpenClaw runtime.
 * No secret key is ever accepted as a tool parameter.
 */

const {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} = require("@solana/web3.js");
const { Program, AnchorProvider, BN } = require("@coral-xyz/anchor");
const { verifyWagerTransaction } = require("../verify");
const {
  savePendingWager,
  loadPendingWagers,
  removePendingWager,
  estimateCheckAt,
  resolveWinner,
} = require("./watcher");
const { definePluginEntry } = require("@openclaw/plugin-sdk");
const IDL = require("./idl.json");

const PROGRAM_ID = new PublicKey(
  process.env.SOL_WAGER_PROGRAM_ID ||
    "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
);

const CHAINLINK_PROGRAM_ID = new PublicKey(
  "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConnection() {
  return new Connection(
    process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
}

function getProgram(runtimeWallet) {
  const provider = new AnchorProvider(getConnection(), runtimeWallet, {
    commitment: "confirmed",
  });
  return new Program(IDL, PROGRAM_ID, provider);
}

function deriveWagerPda(proposerPk, counterpartyPk) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("wager"), proposerPk.toBuffer(), counterpartyPk.toBuffer()],
    PROGRAM_ID
  );
}

function dslConditionToAnchor(condition) {
  const map = {
    PRICE_BELOW: { priceBelow: {} },
    PRICE_ABOVE: { priceAbove: {} },
    PRICE_BETWEEN: { priceBetween: {} },
    PRICE_CHANGE_PCT: { priceChangePct: {} },
  };
  const variant = map[condition];
  if (!variant) throw new Error(`Unknown condition: ${condition}`);
  return variant;
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

module.exports = definePluginEntry({
  register(api) {
    /**
     * api.runtime.wallet — the OpenClaw-managed Solana Wallet adapter.
     * Exposes .publicKey and .signTransaction() without surfacing the raw key.
     * Integration point: replace with the actual runtime accessor path once
     * OpenClaw documents it.
     */
    const wallet = () => api.runtime.wallet;

    // -----------------------------------------------------------------------
    // wager_propose
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "wager_propose",
      description:
        "Generate a Claw-DSL wager proposal and a durable-nonce transaction " +
        "pre-signed by you as proposer. Send the returned bundle to the counterparty.",
      schema: {
        type: "object",
        required: [
          "counterparty",
          "oracle_feed",
          "condition",
          "expiry_slot",
          "proposer_stake",
          "counterparty_stake",
          "nonce_account",
        ],
        properties: {
          counterparty: { type: "string" },
          oracle_feed: { type: "string" },
          condition: {
            type: "string",
            enum: ["PRICE_BELOW", "PRICE_ABOVE", "PRICE_BETWEEN", "PRICE_CHANGE_PCT"],
          },
          threshold: { type: "number" },
          threshold_min: { type: "number" },
          threshold_max: { type: "number" },
          change_pct: { type: "number", description: "Signed basis points" },
          snapshot_price: { type: "number" },
          expiry_slot: { type: "number" },
          proposer_stake: { type: "number", description: "Lamports" },
          counterparty_stake: { type: "number", description: "Lamports" },
          nonce_account: { type: "string" },
        },
      },

      async execute(args) {
        const w = wallet();
        const proposerPk = w.publicKey;
        const counterpartyPk = new PublicKey(args.counterparty);
        const feedPk = new PublicKey(args.oracle_feed);
        const noncePk = new PublicKey(args.nonce_account);

        const connection = getConnection();
        const nonceAccountInfo = await connection.getNonce(noncePk);
        if (!nonceAccountInfo) {
          throw new Error("Nonce account not found — create one first with the Solana CLI");
        }

        const [wagerPda] = deriveWagerPda(proposerPk, counterpartyPk);

        const dsl = {
          version: "1",
          proposer: proposerPk.toBase58(),
          counterparty: args.counterparty,
          oracle_feed: args.oracle_feed,
          condition: args.condition,
          threshold: args.threshold ?? 0,
          threshold_min: args.threshold_min ?? 0,
          threshold_max: args.threshold_max ?? 0,
          change_pct: args.change_pct ?? 0,
          snapshot_price: args.snapshot_price ?? 0,
          expiry_slot: args.expiry_slot,
          proposer_stake: args.proposer_stake,
          counterparty_stake: args.counterparty_stake,
          nonce_account: args.nonce_account,
          nonce_authority: proposerPk.toBase58(),
          created_at: new Date().toISOString(),
        };

        const params = {
          condition: dslConditionToAnchor(args.condition),
          threshold: new BN(args.threshold ?? 0),
          thresholdMin: new BN(args.threshold_min ?? 0),
          thresholdMax: new BN(args.threshold_max ?? 0),
          changePct: args.change_pct ?? 0,
          snapshotPrice: new BN(args.snapshot_price ?? 0),
          expirySlot: new BN(args.expiry_slot),
          proposerStake: new BN(args.proposer_stake),
          counterpartyStake: new BN(args.counterparty_stake),
        };

        const program = getProgram(w);
        const ix = await program.methods
          .initializeWager(params)
          .accounts({
            proposer: proposerPk,
            counterparty: counterpartyPk,
            wager: wagerPda,
            chainlinkFeed: feedPk,
            systemProgram: SystemProgram.programId,
          })
          .instruction();

        const tx = new Transaction();
        tx.add(
          SystemProgram.nonceAdvance({
            noncePubkey: noncePk,
            authorizedPubkey: proposerPk,
          })
        );
        tx.add(ix);
        tx.recentBlockhash = nonceAccountInfo.nonce;
        tx.feePayer = proposerPk;

        const signedTx = await w.signTransaction(tx);
        const tx_hex = signedTx
          .serialize({ requireAllSignatures: false })
          .toString("hex");

        return {
          dsl,
          tx_hex,
          wager_pda: wagerPda.toBase58(),
          next_step:
            "Send this bundle to the counterparty. Also call wager_watch " +
            "so you will automatically settle if they accept and the slot passes.",
        };
      },
    });

    // -----------------------------------------------------------------------
    // wager_inspect
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "wager_inspect",
      description:
        "Verify that a received tx_hex was compiled from the accompanying DSL. " +
        "Always call this before wager_accept.",
      schema: {
        type: "object",
        required: ["dsl", "tx_hex"],
        properties: {
          dsl: { type: "object" },
          tx_hex: { type: "string" },
        },
      },

      async execute({ dsl, tx_hex }) {
        const result = verifyWagerTransaction(tx_hex, dsl);

        const summary = result.ok
          ? [
              `Condition: ${dsl.condition} — you win as counterparty if condition is FALSE at slot ${dsl.expiry_slot}`,
              `Oracle feed: ${dsl.oracle_feed}`,
              `Proposer stakes: ${dsl.proposer_stake} lamports`,
              `Your stake if you accept: ${dsl.counterparty_stake} lamports`,
              `PDA derivation: ✓`,
            ].join("\n")
          : `VERIFICATION FAILED — do not accept.\n${result.errors.join("\n")}`;

        return { verified: result.ok, errors: result.errors, summary };
      },
    });

    // -----------------------------------------------------------------------
    // wager_accept
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "wager_accept",
      description:
        "Countersign a verified wager proposal as counterparty and submit it. " +
        "Both stakes are escrowed atomically. " +
        "Only call after wager_inspect returns verified: true.",
      schema: {
        type: "object",
        required: ["tx_hex"],
        properties: {
          tx_hex: { type: "string" },
        },
      },

      async execute({ tx_hex }) {
        const w = wallet();
        const connection = getConnection();

        const tx = Transaction.from(Buffer.from(tx_hex, "hex"));
        const signedTx = await w.signTransaction(tx);

        const signature = await connection.sendRawTransaction(
          signedTx.serialize(),
          { skipPreflight: false }
        );
        await connection.confirmTransaction(signature, "confirmed");

        return {
          signature,
          next_step:
            "Wager escrowed. Now call wager_watch with the DSL to register " +
            "automatic settlement tracking.",
          explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
        };
      },
    });

    // -----------------------------------------------------------------------
    // wager_settle
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "wager_settle",
      description:
        "Settle an expired wager. Supply the address you believe won — the " +
        "program verifies on-chain and reverts if wrong. Permissionless.",
      schema: {
        type: "object",
        required: ["wager_pda", "proposer", "counterparty", "winner", "oracle_feed"],
        properties: {
          wager_pda: { type: "string" },
          proposer: { type: "string" },
          counterparty: { type: "string" },
          winner: { type: "string" },
          oracle_feed: { type: "string" },
        },
      },

      async execute({ wager_pda, proposer, counterparty, winner, oracle_feed }) {
        const w = wallet();
        const program = getProgram(w);

        const signature = await program.methods
          .settleWager()
          .accounts({
            wager: new PublicKey(wager_pda),
            proposer: new PublicKey(proposer),
            counterparty: new PublicKey(counterparty),
            winner: new PublicKey(winner),
            chainlinkFeed: new PublicKey(oracle_feed),
            chainlinkProgram: CHAINLINK_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();

        removePendingWager(wager_pda);

        return {
          signature,
          winner,
          explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
        };
      },
    });

    // -----------------------------------------------------------------------
    // wager_watch
    // Registers a wager in the local store and returns a wake-up schedule.
    // Call this after wager_accept (counterparty) or wager_propose (proposer).
    // Schedule wager_check_pending at the returned check_at time.
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "wager_watch",
      description:
        "Register a wager for automatic settlement tracking. Returns a check_at " +
        "timestamp — schedule wager_check_pending for that time so settlement " +
        "happens automatically without further action.",
      schema: {
        type: "object",
        required: ["dsl", "wager_pda"],
        properties: {
          dsl: {
            type: "object",
            description: "The Claw-DSL object for this wager",
          },
          wager_pda: {
            type: "string",
            description: "Base58 wager PDA address from the proposal bundle",
          },
        },
      },

      async execute({ dsl, wager_pda }) {
        const connection = getConnection();
        const currentSlot = await connection.getSlot();
        const checkAt = estimateCheckAt(currentSlot, dsl.expiry_slot);

        savePendingWager({
          wager_pda,
          proposer: dsl.proposer,
          counterparty: dsl.counterparty,
          oracle_feed: dsl.oracle_feed,
          expiry_slot: dsl.expiry_slot,
          registered_at: new Date().toISOString(),
        });

        const slotsRemaining = Math.max(0, dsl.expiry_slot - currentSlot);

        return {
          registered: true,
          wager_pda,
          expiry_slot: dsl.expiry_slot,
          current_slot: currentSlot,
          slots_remaining: slotsRemaining,
          check_at: checkAt.toISOString(),
          check_in_seconds: Math.ceil((checkAt - Date.now()) / 1000),
          next_step:
            `Schedule wager_check_pending at ${checkAt.toISOString()}. ` +
            `No further action needed until then.`,
        };
      },
    });

    // -----------------------------------------------------------------------
    // wager_check_pending
    // Iterates the local store. For each wager past its expiry_slot:
    //   1. Checks the PDA exists on-chain (drops it if not — never accepted)
    //   2. Resolves the winner by simulating settle_wager with each candidate
    //   3. Submits the real settlement transaction
    //   4. Removes the wager from the store
    // Safe to call multiple times — already-settled wagers are auto-dropped.
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "wager_check_pending",
      description:
        "Check all watched wagers and settle any that have passed their expiry_slot. " +
        "This is called automatically by the schedule set up via wager_watch.",
      schema: {
        type: "object",
        properties: {},
      },

      async execute() {
        const w = wallet();
        const connection = getConnection();
        const program = getProgram(w);
        const currentSlot = await connection.getSlot();
        const pending = loadPendingWagers();

        if (pending.length === 0) {
          return { message: "No pending wagers.", results: [] };
        }

        const results = [];

        for (const wager of pending) {
          // Not expired yet — report remaining slots
          if (currentSlot < wager.expiry_slot) {
            const slotsLeft = wager.expiry_slot - currentSlot;
            results.push({
              wager_pda: wager.wager_pda,
              status: "pending",
              slots_remaining: slotsLeft,
              estimated_seconds: Math.ceil(slotsLeft * 0.45),
            });
            continue;
          }

          // Check whether the wager PDA exists (counterparty may never have accepted)
          const pdaInfo = await connection.getAccountInfo(
            new PublicKey(wager.wager_pda)
          );
          if (!pdaInfo || pdaInfo.lamports === 0) {
            removePendingWager(wager.wager_pda);
            results.push({
              wager_pda: wager.wager_pda,
              status: "dropped",
              reason: "PDA not found on-chain — wager was never accepted or already settled",
            });
            continue;
          }

          // Resolve winner via simulation, then settle
          try {
            const winner = await resolveWinner(
              program,
              wager,
              CHAINLINK_PROGRAM_ID
            );

            const signature = await program.methods
              .settleWager()
              .accounts({
                wager: new PublicKey(wager.wager_pda),
                proposer: new PublicKey(wager.proposer),
                counterparty: new PublicKey(wager.counterparty),
                winner: new PublicKey(winner),
                chainlinkFeed: new PublicKey(wager.oracle_feed),
                chainlinkProgram: CHAINLINK_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
              })
              .rpc();

            removePendingWager(wager.wager_pda);
            results.push({
              wager_pda: wager.wager_pda,
              status: "settled",
              winner,
              signature,
              explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
            });
          } catch (e) {
            results.push({
              wager_pda: wager.wager_pda,
              status: "error",
              error: e.message,
            });
          }
        }

        const settled = results.filter((r) => r.status === "settled").length;
        const stillPending = results.filter((r) => r.status === "pending").length;

        return {
          current_slot: currentSlot,
          checked: pending.length,
          settled,
          still_pending: stillPending,
          results,
        };
      },
    });
  },
});
