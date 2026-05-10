"use strict";

/**
 * Verification function: deterministically confirms that a serialised
 * Solana Transaction Hex was compiled from a specific Claw-DSL object.
 *
 * Strategy:
 *  1. Deserialise the transaction from hex.
 *  2. Locate the `initialize_wager` instruction by program ID + discriminator.
 *  3. Decode the instruction accounts and Borsh-encoded WagerParams.
 *  4. Compare every field against the DSL, including the wager PDA derivation.
 */

const { Transaction, PublicKey } = require("@solana/web3.js");
const { BorshCoder } = require("@coral-xyz/anchor");
const crypto = require("crypto");
const IDL = require("../skill/idl.json");

const PROGRAM_ID = new PublicKey(
  process.env.SOL_WAGER_PROGRAM_ID || IDL.address
);

// Maps DSL condition string → Borsh PascalCase enum variant key
const CONDITION_BORSH = {
  PRICE_BELOW:      "PriceBelow",
  PRICE_ABOVE:      "PriceAbove",
  PRICE_BETWEEN:    "PriceBetween",
  PRICE_CHANGE_PCT: "PriceChangePct",
};

/**
 * Returns the 8-byte Anchor instruction discriminator for a given name.
 */
function instructionDiscriminator(name) {
  return crypto
    .createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .slice(0, 8);
}

/**
 * Verifies that `txHex` was deterministically compiled from `dsl`.
 *
 * @param {string} txHex - Hex-encoded serialised Solana transaction
 * @param {object} dsl   - Claw-DSL object (validated against schema.json)
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyWagerTransaction(txHex, dsl) {
  const errors = [];

  // --- 1. Deserialise transaction ---
  let tx;
  try {
    tx = Transaction.from(Buffer.from(txHex, "hex"));
  } catch (e) {
    return { ok: false, errors: [`Failed to deserialise transaction: ${e.message}`] };
  }

  // --- 2. Find the initialize_wager instruction ---
  const discriminator = instructionDiscriminator("initialize_wager");
  const ix = tx.instructions.find(
    (i) =>
      i.programId.equals(PROGRAM_ID) &&
      i.data.slice(0, 8).equals(discriminator)
  );

  if (!ix) {
    return {
      ok: false,
      errors: ["No initialize_wager instruction found for the expected program"],
    };
  }

  // --- 3. Verify accounts ---
  // Account order per InitializeWager struct:
  //   [0] proposer, [1] counterparty, [2] wager (PDA), [3] chainlink_feed, [4] system_program
  const [proposerKey, counterpartyKey, wagerKey, feedKey] = ix.keys.map(
    (k) => k.pubkey.toBase58()
  );

  if (proposerKey !== dsl.proposer) {
    errors.push(`proposer mismatch: tx=${proposerKey} dsl=${dsl.proposer}`);
  }
  if (counterpartyKey !== dsl.counterparty) {
    errors.push(
      `counterparty mismatch: tx=${counterpartyKey} dsl=${dsl.counterparty}`
    );
  }
  if (feedKey !== dsl.oracle_feed) {
    errors.push(`oracle_feed mismatch: tx=${feedKey} dsl=${dsl.oracle_feed}`);
  }

  // Verify the wager PDA derivation
  const [expectedPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("wager"),
      new PublicKey(dsl.proposer).toBuffer(),
      new PublicKey(dsl.counterparty).toBuffer(),
    ],
    PROGRAM_ID
  );
  if (wagerKey !== expectedPda.toBase58()) {
    errors.push(
      `wager PDA mismatch: tx=${wagerKey} expected=${expectedPda.toBase58()}`
    );
  }

  // --- 4. Decode instruction data (skip 8-byte discriminator) ---
  const coder = new BorshCoder(IDL);
  let params;
  try {
    // In anchor 0.30, decode returns { name, data: { params: WagerParams } }
    params = coder.instruction.decode(ix.data).data.params;
  } catch (e) {
    errors.push(`Failed to decode instruction data: ${e.message}`);
    return { ok: errors.length === 0, errors };
  }

  // --- 5. Compare WagerParams against DSL ---
  // BorshCoder returns PascalCase enum variants (e.g. "PriceAbove")
  const conditionKey = Object.keys(params.condition)[0];
  const expectedConditionKey = CONDITION_BORSH[dsl.condition];
  if (conditionKey !== expectedConditionKey) {
    errors.push(
      `condition mismatch: tx=${conditionKey} dsl=${expectedConditionKey}`
    );
  }

  const bnCheck = (dslField, txVal) => {
    const dslVal = BigInt(dsl[dslField] ?? 0);
    if (BigInt(txVal.toString()) !== dslVal) {
      errors.push(`${dslField} mismatch: tx=${txVal} dsl=${dslVal}`);
    }
  };

  // BorshCoder returns snake_case field names matching the IDL
  bnCheck("threshold",      params.threshold);
  bnCheck("threshold_min",  params.threshold_min);
  bnCheck("threshold_max",  params.threshold_max);
  bnCheck("snapshot_price", params.snapshot_price);

  if (params.change_pct !== (dsl.change_pct ?? 0)) {
    errors.push(`change_pct mismatch: tx=${params.change_pct} dsl=${dsl.change_pct ?? 0}`);
  }

  bnCheck("expiry_slot",        params.expiry_slot);
  bnCheck("proposer_stake",     params.proposer_stake);
  bnCheck("counterparty_stake", params.counterparty_stake);

  // --- 6. Verify durable nonce (optional) ---
  if (dsl.nonce_account) {
    const nonceIx = tx.instructions[0];
    if (!nonceIx || nonceIx.programId.toBase58() !== "11111111111111111111111111111111") {
      errors.push("Expected AdvanceNonceAccount as first instruction when nonce_account is set");
    } else {
      const nonceAccountInIx = nonceIx.keys[0]?.pubkey.toBase58();
      if (nonceAccountInIx !== dsl.nonce_account) {
        errors.push(
          `nonce_account mismatch: tx=${nonceAccountInIx} dsl=${dsl.nonce_account}`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { verifyWagerTransaction, instructionDiscriminator };
