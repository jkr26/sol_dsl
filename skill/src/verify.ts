import { Transaction, PublicKey } from "@solana/web3.js";
import { BorshCoder } from "@coral-xyz/anchor";
import * as crypto from "crypto";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const IDL = require("../idl.json");

const PROGRAM_ID = new PublicKey(
  process.env.CLAWBOND_PROGRAM_ID || IDL.address
);

const CONDITION_BORSH: Record<string, string> = {
  PRICE_BELOW:      "PriceBelow",
  PRICE_ABOVE:      "PriceAbove",
  PRICE_BETWEEN:    "PriceBetween",
  PRICE_CHANGE_PCT: "PriceChangePct",
};

export function instructionDiscriminator(name: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .slice(0, 8);
}

export function verifyBondTransaction(
  txHex: string,
  dsl: Record<string, any>
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(txHex, "hex"));
  } catch (e: any) {
    return { ok: false, errors: [`Failed to deserialise transaction: ${e.message}`] };
  }

  const discriminator = instructionDiscriminator("initialize_bond");
  const ix = tx.instructions.find(
    (i) =>
      i.programId.equals(PROGRAM_ID) &&
      i.data.slice(0, 8).equals(discriminator)
  );

  if (!ix) {
    return {
      ok: false,
      errors: ["No initialize_bond instruction found for the expected program"],
    };
  }

  const [proposerKey, counterpartyKey, bondKey, feedKey] = ix.keys.map(
    (k) => k.pubkey.toBase58()
  );

  if (proposerKey !== dsl.proposer)
    errors.push(`proposer mismatch: tx=${proposerKey} dsl=${dsl.proposer}`);
  if (counterpartyKey !== dsl.counterparty)
    errors.push(`counterparty mismatch: tx=${counterpartyKey} dsl=${dsl.counterparty}`);
  if (feedKey !== dsl.oracle_feed)
    errors.push(`oracle_feed mismatch: tx=${feedKey} dsl=${dsl.oracle_feed}`);

  const [expectedPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("bond"),
      new PublicKey(dsl.proposer).toBuffer(),
      new PublicKey(dsl.counterparty).toBuffer(),
    ],
    PROGRAM_ID
  );
  if (bondKey !== expectedPda.toBase58())
    errors.push(`bond PDA mismatch: tx=${bondKey} expected=${expectedPda.toBase58()}`);

  const coder = new BorshCoder(IDL);
  let params: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params = (coder.instruction.decode(ix.data) as any).data.params;
  } catch (e: any) {
    errors.push(`Failed to decode instruction data: ${e.message}`);
    return { ok: errors.length === 0, errors };
  }

  const conditionKey = Object.keys(params.condition)[0];
  const expectedConditionKey = CONDITION_BORSH[dsl.condition];
  if (conditionKey !== expectedConditionKey)
    errors.push(`condition mismatch: tx=${conditionKey} dsl=${expectedConditionKey}`);

  const bnCheck = (field: string, txVal: any) => {
    const dslVal = BigInt(dsl[field] ?? 0);
    if (BigInt(txVal.toString()) !== dslVal)
      errors.push(`${field} mismatch: tx=${txVal} dsl=${dslVal}`);
  };

  bnCheck("threshold",         params.threshold);
  bnCheck("threshold_min",     params.threshold_min);
  bnCheck("threshold_max",     params.threshold_max);
  bnCheck("snapshot_price",    params.snapshot_price);
  bnCheck("expiry_slot",       params.expiry_slot);
  bnCheck("proposer_stake",    params.proposer_stake);
  bnCheck("counterparty_stake",params.counterparty_stake);

  if (params.change_pct !== (dsl.change_pct ?? 0))
    errors.push(`change_pct mismatch: tx=${params.change_pct} dsl=${dsl.change_pct ?? 0}`);

  if (dsl.nonce_account) {
    const nonceIx = tx.instructions[0];
    if (!nonceIx || nonceIx.programId.toBase58() !== "11111111111111111111111111111111") {
      errors.push("Expected AdvanceNonceAccount as first instruction when nonce_account is set");
    } else {
      const nonceAccountInIx = nonceIx.keys[0]?.pubkey.toBase58();
      if (nonceAccountInIx !== dsl.nonce_account)
        errors.push(`nonce_account mismatch: tx=${nonceAccountInIx} dsl=${dsl.nonce_account}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
