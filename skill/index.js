"use strict";

/**
 * OpenClaw Plugin: sol-wager
 *
 * Registers the Claw-DSL wager protocol as four agent tools.
 * Agent identity (Solana keypair) is provided by the OpenClaw runtime —
 * no secret key is ever accepted as a tool parameter.
 *
 * Tool surface:
 *   wager_propose   — build DSL + partially-signed tx as the proposer
 *   wager_inspect   — verify a received DSL/tx pair before accepting
 *   wager_accept    — countersign + submit as the counterparty
 *   wager_settle    — settle an expired wager (permissionless)
 */

const {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  NonceProgram,
} = require("@solana/web3.js");
const { Program, AnchorProvider, BN } = require("@coral-xyz/anchor");
const { verifyWagerTransaction } = require("../verify");
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

/**
 * Builds an Anchor Program using the agent's runtime-provided wallet.
 * `runtimeWallet` is the OpenClaw-managed Wallet adapter for this agent.
 */
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
     * `api.runtime.wallet` — the OpenClaw-managed Solana Wallet adapter for
     * this agent instance. It exposes `.publicKey` and `.signTransaction()`
     * without ever surfacing the raw secret key to plugin code.
     *
     * Integration point: replace with the actual runtime accessor once
     * OpenClaw documents the exact property path.
     */
    const wallet = () => api.runtime.wallet;

    // -----------------------------------------------------------------------
    // wager_propose
    // Builds a Claw-DSL object and a durable-nonce transaction partially
    // signed by THIS agent as proposer.  The returned { dsl, tx_hex } bundle
    // is the proposal message — transmit it to the counterparty however you
    // normally communicate.
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
          counterparty: {
            type: "string",
            description: "Base58 public key of the counterparty agent",
          },
          oracle_feed: {
            type: "string",
            description: "Base58 Chainlink on-chain aggregator public key",
          },
          condition: {
            type: "string",
            enum: ["PRICE_BELOW", "PRICE_ABOVE", "PRICE_BETWEEN", "PRICE_CHANGE_PCT"],
          },
          threshold: {
            type: "number",
            description: "Raw Chainlink units — for PRICE_BELOW or PRICE_ABOVE",
          },
          threshold_min: {
            type: "number",
            description: "Raw Chainlink units — lower bound for PRICE_BETWEEN",
          },
          threshold_max: {
            type: "number",
            description: "Raw Chainlink units — upper bound for PRICE_BETWEEN",
          },
          change_pct: {
            type: "number",
            description: "Signed basis points (100 = 1%) — for PRICE_CHANGE_PCT",
          },
          snapshot_price: {
            type: "number",
            description: "Reference price in raw Chainlink units — for PRICE_CHANGE_PCT",
          },
          expiry_slot: {
            type: "number",
            description: "Absolute Solana slot at which the wager is evaluated",
          },
          proposer_stake: {
            type: "number",
            description: "Lamports you are staking",
          },
          counterparty_stake: {
            type: "number",
            description: "Lamports you require the counterparty to stake",
          },
          nonce_account: {
            type: "string",
            description:
              "Base58 durable nonce account public key — keeps the tx valid " +
              "while the counterparty reviews. Must be owned by you (proposer).",
          },
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
        // Durable nonce: AdvanceNonce must be first instruction
        tx.add(
          SystemProgram.nonceAdvance({
            noncePubkey: noncePk,
            authorizedPubkey: proposerPk,
          })
        );
        tx.add(ix);
        tx.recentBlockhash = nonceAccountInfo.nonce;
        tx.feePayer = proposerPk;

        // Proposer signs first; counterparty adds their signature via wager_accept
        const signedTx = await w.signTransaction(tx);
        const tx_hex = signedTx
          .serialize({ requireAllSignatures: false })
          .toString("hex");

        return {
          dsl,
          tx_hex,
          wager_pda: wagerPda.toBase58(),
          instructions:
            "Send this entire object to the counterparty. They should call " +
            "wager_inspect(dsl, tx_hex) before deciding whether to accept.",
        };
      },
    });

    // -----------------------------------------------------------------------
    // wager_inspect
    // Pure verification — no identity or signing required.
    // Any agent receiving a proposal MUST call this before wager_accept.
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "wager_inspect",
      description:
        "Verify that a received tx_hex was deterministically compiled from the " +
        "accompanying DSL. Always call this before wager_accept.",
      schema: {
        type: "object",
        required: ["dsl", "tx_hex"],
        properties: {
          dsl: { type: "object", description: "The Claw-DSL object from the proposer" },
          tx_hex: { type: "string", description: "Hex-encoded transaction from the proposer" },
        },
      },

      async execute({ dsl, tx_hex }) {
        const result = verifyWagerTransaction(tx_hex, dsl);

        const summary = result.ok
          ? [
              `Condition: ${dsl.condition} (you win as counterparty if condition is FALSE at slot ${dsl.expiry_slot})`,
              `Oracle: ${dsl.oracle_feed}`,
              `Proposer stakes: ${dsl.proposer_stake} lamports`,
              `Your stake if you accept: ${dsl.counterparty_stake} lamports`,
              `Wager PDA: derived from proposer + counterparty keys ✓`,
            ].join("\n")
          : `VERIFICATION FAILED — do not accept.\n${result.errors.join("\n")}`;

        return {
          verified: result.ok,
          errors: result.errors,
          summary,
        };
      },
    });

    // -----------------------------------------------------------------------
    // wager_accept
    // Counterparty adds their signature and submits the transaction.
    // Both stakes are atomically escrowed on-chain in a single transaction.
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "wager_accept",
      description:
        "Countersign a verified wager proposal as counterparty and submit it " +
        "to Solana. Both stakes are escrowed atomically. " +
        "Only call this after wager_inspect returns verified: true.",
      schema: {
        type: "object",
        required: ["tx_hex"],
        properties: {
          tx_hex: {
            type: "string",
            description: "The tx_hex from the proposer's wager bundle",
          },
        },
      },

      async execute({ tx_hex }) {
        const w = wallet();
        const connection = getConnection();

        const tx = Transaction.from(Buffer.from(tx_hex, "hex"));

        // Counterparty adds their signature
        const signedTx = await w.signTransaction(tx);

        const signature = await connection.sendRawTransaction(
          signedTx.serialize(),
          { skipPreflight: false }
        );
        await connection.confirmTransaction(signature, "confirmed");

        return {
          signature,
          message: `Wager accepted and escrowed. Both stakes are locked on-chain.`,
          explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
        };
      },
    });

    // -----------------------------------------------------------------------
    // wager_settle
    // Permissionless — any agent may call this after expiry_slot.
    // The on-chain program reads the Chainlink feed and verifies `winner`;
    // it reverts if the supplied winner address is incorrect.
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "wager_settle",
      description:
        "Settle an expired wager. Supply the address you believe won based on " +
        "the current oracle price — the program verifies on-chain and reverts " +
        "if wrong. Permissionless: either agent may call this.",
      schema: {
        type: "object",
        required: ["wager_pda", "proposer", "counterparty", "winner", "oracle_feed"],
        properties: {
          wager_pda: {
            type: "string",
            description: "Base58 wager PDA — from the original proposal bundle",
          },
          proposer: {
            type: "string",
            description: "Base58 proposer public key — from the DSL",
          },
          counterparty: {
            type: "string",
            description: "Base58 counterparty public key — from the DSL",
          },
          winner: {
            type: "string",
            description:
              "Base58 public key of who you believe won. Must be proposer or counterparty. " +
              "Evaluate the oracle condition yourself first — the contract verifies this.",
          },
          oracle_feed: {
            type: "string",
            description: "Base58 Chainlink aggregator account — from the DSL",
          },
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

        return {
          signature,
          winner,
          message: `Wager settled. All escrowed lamports transferred to winner: ${winner}`,
          explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
        };
      },
    });
  },
});
