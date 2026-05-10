"use strict";

/**
 * OpenClaw Plugin: sol-wager
 * Registers four agent tools for the full wager lifecycle:
 *   propose_wager → inspect_wager → countersign_wager → settle_wager
 */

const {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  Keypair,
  NonceProgram,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const { Program, AnchorProvider, Wallet, BN } = require("@coral-xyz/anchor");
const { verifyWagerTransaction } = require("../verify");
const IDL = require("./idl.json");
const { definePluginEntry } = require("@openclaw/plugin-sdk");

const PROGRAM_ID = new PublicKey(
  process.env.SOL_WAGER_PROGRAM_ID ||
    "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
);

const CHAINLINK_PROGRAM_ID = new PublicKey(
  "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
);

function getConnection() {
  const rpc =
    process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  return new Connection(rpc, "confirmed");
}

function getProgram(signerKeypair) {
  const connection = getConnection();
  const wallet = new Wallet(signerKeypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program(IDL, PROGRAM_ID, provider);
}

/** Derives the wager PDA from proposer + counterparty keys. */
function deriveWagerPda(proposerPk, counterpartyPk) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("wager"),
      proposerPk.toBuffer(),
      counterpartyPk.toBuffer(),
    ],
    PROGRAM_ID
  );
}

/** Maps DSL condition string to Anchor enum variant. */
function dslConditionToAnchor(condition) {
  return {
    PRICE_BELOW: { priceBelow: {} },
    PRICE_ABOVE: { priceAbove: {} },
    PRICE_BETWEEN: { priceBetween: {} },
    PRICE_CHANGE_PCT: { priceChangePct: {} },
  }[condition];
}

module.exports = definePluginEntry({
  register(api) {
    // -----------------------------------------------------------------------
    // Tool 1: propose_wager
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "propose_wager",
      description:
        "Generate a Claw-DSL wager object and a durable-nonce transaction for the counterparty to inspect and sign",
      schema: {
        type: "object",
        required: [
          "proposerSecretKey",
          "counterparty",
          "oracle_feed",
          "condition",
          "expiry_slot",
          "proposer_stake",
          "counterparty_stake",
          "nonce_account",
        ],
        properties: {
          proposerSecretKey: {
            type: "array",
            items: { type: "number" },
            description: "Proposer keypair as a byte array (kept in agent memory, never transmitted in DSL)",
          },
          counterparty: { type: "string", description: "Base58 public key of the counterparty agent" },
          oracle_feed: { type: "string", description: "Base58 Chainlink aggregator account public key" },
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
          nonce_account: { type: "string", description: "Base58 durable nonce account public key" },
        },
      },

      async execute(args) {
        const proposerKeypair = Keypair.fromSecretKey(
          Uint8Array.from(args.proposerSecretKey)
        );
        const proposerPk = proposerKeypair.publicKey;
        const counterpartyPk = new PublicKey(args.counterparty);
        const feedPk = new PublicKey(args.oracle_feed);
        const noncePk = new PublicKey(args.nonce_account);

        const [wagerPda] = deriveWagerPda(proposerPk, counterpartyPk);
        const connection = getConnection();

        // Fetch nonce account for its current blockhash value
        const nonceAccountInfo = await connection.getNonce(noncePk);
        if (!nonceAccountInfo) {
          throw new Error("Nonce account not found or uninitialised");
        }
        const nonceBlockhash = nonceAccountInfo.nonce;

        // Build Claw-DSL
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

        // Build WagerParams for the instruction
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

        const program = getProgram(proposerKeypair);

        // Build the initialize_wager instruction
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

        // Construct the durable-nonce transaction:
        // 1st instruction must advance the nonce so the blockhash stays valid
        const tx = new Transaction();
        tx.add(
          SystemProgram.nonceAdvance({
            noncePubkey: noncePk,
            authorizedPubkey: proposerPk,
          })
        );
        tx.add(ix);

        tx.recentBlockhash = nonceBlockhash;
        tx.feePayer = proposerPk;

        // Proposer signs first
        tx.sign(proposerKeypair);

        const tx_hex = tx.serialize({ requireAllSignatures: false }).toString("hex");

        return {
          dsl,
          tx_hex,
          wager_pda: wagerPda.toBase58(),
          message: "Share dsl and tx_hex with the counterparty for inspection and countersigning",
        };
      },
    });

    // -----------------------------------------------------------------------
    // Tool 2: inspect_wager
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "inspect_wager",
      description:
        "Verify that a transaction hex was compiled from the provided DSL before countersigning. Always run this before countersign_wager.",
      schema: {
        type: "object",
        required: ["tx_hex", "dsl"],
        properties: {
          tx_hex: { type: "string" },
          dsl: { type: "object" },
        },
      },

      async execute({ tx_hex, dsl }) {
        const result = verifyWagerTransaction(tx_hex, dsl);

        return {
          verified: result.ok,
          errors: result.errors,
          summary: result.ok
            ? `DSL verified: ${dsl.condition} wager, proposer=${dsl.proposer.slice(0, 8)}…, counterparty=${dsl.counterparty.slice(0, 8)}…, expiry_slot=${dsl.expiry_slot}`
            : `Verification FAILED — do not sign. Errors: ${result.errors.join("; ")}`,
        };
      },
    });

    // -----------------------------------------------------------------------
    // Tool 3: countersign_wager
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "countersign_wager",
      description:
        "Add the counterparty signature to a verified wager transaction and return the fully-signed hex ready for submission",
      schema: {
        type: "object",
        required: ["tx_hex", "counterpartySecretKey"],
        properties: {
          tx_hex: { type: "string" },
          counterpartySecretKey: {
            type: "array",
            items: { type: "number" },
            description: "Counterparty keypair as a byte array",
          },
        },
      },

      async execute({ tx_hex, counterpartySecretKey }) {
        const counterpartyKeypair = Keypair.fromSecretKey(
          Uint8Array.from(counterpartySecretKey)
        );
        const tx = Transaction.from(Buffer.from(tx_hex, "hex"));
        tx.partialSign(counterpartyKeypair);

        const signed_tx_hex = tx
          .serialize({ requireAllSignatures: true })
          .toString("hex");

        return {
          signed_tx_hex,
          message: "Transaction fully signed. Submit signed_tx_hex to the Solana network.",
        };
      },
    });

    // -----------------------------------------------------------------------
    // Tool 4: settle_wager
    // -----------------------------------------------------------------------
    api.registerTool({
      name: "settle_wager",
      description:
        "Settle an expired wager by supplying the winner account. The program reads the Chainlink feed and reverts if the winner is incorrect.",
      schema: {
        type: "object",
        required: ["callerSecretKey", "wager_pda", "proposer", "counterparty", "winner", "oracle_feed"],
        properties: {
          callerSecretKey: {
            type: "array",
            items: { type: "number" },
            description: "Caller keypair (either agent) as a byte array",
          },
          wager_pda: { type: "string", description: "Base58 wager PDA address" },
          proposer: { type: "string" },
          counterparty: { type: "string" },
          winner: { type: "string", description: "Base58 public key of who you believe won" },
          oracle_feed: { type: "string" },
        },
      },

      async execute({ callerSecretKey, wager_pda, proposer, counterparty, winner, oracle_feed }) {
        const callerKeypair = Keypair.fromSecretKey(
          Uint8Array.from(callerSecretKey)
        );
        const program = getProgram(callerKeypair);

        const txSig = await program.methods
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
          signature: txSig,
          message: `Wager settled. Winner: ${winner}. Explorer: https://explorer.solana.com/tx/${txSig}?cluster=devnet`,
        };
      },
    });
  },
});
