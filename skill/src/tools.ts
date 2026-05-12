import { Type } from "@sinclair/typebox";
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { loadWallet, WalletAdapter } from "./wallet";
import {
  loadPendingBonds,
  savePendingBond,
  removePendingBond,
  estimateCheckAt,
  resolveWinner,
  PendingBond,
} from "./watcher";

import { verifyBondTransaction } from "./verify";

const CHAINLINK_PROGRAM_ID = new PublicKey(
  "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
);

interface PluginConfig {
  rpcUrl: string;
  walletPath: string;
  programId: string;
  storePath: string;
  idl: object;
  requireApproval: boolean;
  maxStakeLamports: number;
}

// Returns a structured "needs confirmation" response for fund-moving tools.
function pendingApproval(action: string, details: Record<string, unknown>) {
  return {
    success: false,
    needs_confirmation: true,
    action,
    details,
    next_step:
      "Review the details above carefully. If you approve, call this tool again with confirmed: true.",
  };
}

// Throws if the stake exceeds the configured cap.
function checkStakeCap(lamports: number, maxLamports: number, fieldName: string): void {
  if (lamports > maxLamports) {
    const sol = (n: number) => `${(n / 1e9).toFixed(4)} SOL`;
    throw new Error(
      `${fieldName} (${sol(lamports)}) exceeds maxStakePerBond (${sol(maxLamports)}). ` +
      `Increase maxStakePerBond in your ClawBond config to allow larger stakes.`
    );
  }
}

function getProgram(cfg: PluginConfig, wallet: WalletAdapter): Program {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, wallet as any, {
    commitment: "confirmed",
  });
  return new Program(cfg.idl as any, provider);
}

function deriveBondPda(
  proposerPk: PublicKey,
  counterpartyPk: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bond"), proposerPk.toBuffer(), counterpartyPk.toBuffer()],
    programId
  );
}

function dslConditionToAnchor(condition: string): object {
  const map: Record<string, object> = {
    PRICE_BELOW: { priceBelow: {} },
    PRICE_ABOVE: { priceAbove: {} },
    PRICE_BETWEEN: { priceBetween: {} },
    PRICE_CHANGE_PCT: { priceChangePct: {} },
  };
  const variant = map[condition];
  if (!variant) throw new Error(`Unknown condition: ${condition}`);
  return variant;
}

const CONDITION_DSL_MAP: Record<string, string> = {
  PriceBelow: "PRICE_BELOW",
  PriceAbove: "PRICE_ABOVE",
  PriceBetween: "PRICE_BETWEEN",
  PriceChangePct: "PRICE_CHANGE_PCT",
};

function formatProposal(address: string, account: any, currentSlot: number) {
  const conditionKey = Object.keys(account.condition)[0] as string;
  const slotsLeft = account.expiry_slot.toNumber() - currentSlot;
  return {
    proposal_address: address,
    proposer: (account.proposer as PublicKey).toBase58(),
    oracle_feed: (account.oracle_feed as PublicKey).toBase58(),
    condition: CONDITION_DSL_MAP[conditionKey] ?? conditionKey,
    threshold: account.threshold.toString(),
    threshold_min: account.threshold_min.toString(),
    threshold_max: account.threshold_max.toString(),
    change_pct: account.change_pct,
    snapshot_price: account.snapshot_price.toString(),
    expiry_slot: account.expiry_slot.toNumber(),
    slots_until_expiry: slotsLeft,
    seconds_until_expiry_approx: Math.round(slotsLeft * 0.4),
    proposer_stake_sol: account.proposer_stake.toNumber() / 1e9,
    counterparty_stake_sol: account.counterparty_stake.toNumber() / 1e9,
  };
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export function registerWagerTools(cfg: PluginConfig) {
  return {

    // -----------------------------------------------------------------------
    // bond_propose
    // -----------------------------------------------------------------------
    bond_propose: {
      description:
        "Generate a Claw-DSL bond proposal and a durable-nonce transaction " +
        "pre-signed by this agent as proposer. Send the returned bundle to the counterparty. " +
        "Requires confirmation when requireApproval is enabled (the default).",
      parameters: Type.Object({
        counterparty: Type.String({ description: "Base58 public key of the counterparty agent" }),
        oracle_feed: Type.String({ description: "Base58 Chainlink on-chain aggregator public key" }),
        condition: Type.String({ description: "PRICE_BELOW | PRICE_ABOVE | PRICE_BETWEEN | PRICE_CHANGE_PCT" }),
        threshold: Type.Optional(Type.Number({ description: "Raw Chainlink units — for PRICE_BELOW or PRICE_ABOVE" })),
        threshold_min: Type.Optional(Type.Number({ description: "Raw Chainlink units — lower bound for PRICE_BETWEEN" })),
        threshold_max: Type.Optional(Type.Number({ description: "Raw Chainlink units — upper bound for PRICE_BETWEEN" })),
        change_pct: Type.Optional(Type.Number({ description: "Signed basis points (100 = 1%) — for PRICE_CHANGE_PCT" })),
        snapshot_price: Type.Optional(Type.Number({ description: "Reference price in raw Chainlink units — for PRICE_CHANGE_PCT" })),
        expiry_slot: Type.Number({ description: "Absolute Solana slot at which the bond is evaluated" }),
        proposer_stake: Type.Number({ description: "Lamports this agent stakes" }),
        counterparty_stake: Type.Number({ description: "Lamports required from the counterparty" }),
        nonce_account: Type.String({ description: "Base58 durable nonce account (must be owned by this agent)" }),
        confirmed: Type.Optional(Type.Boolean({ description: "Set to true to confirm after reviewing the approval summary" })),
      }),

      handler: async (args: {
        counterparty: string;
        oracle_feed: string;
        condition: string;
        threshold?: number;
        threshold_min?: number;
        threshold_max?: number;
        change_pct?: number;
        snapshot_price?: number;
        expiry_slot: number;
        proposer_stake: number;
        counterparty_stake: number;
        nonce_account: string;
        confirmed?: boolean;
      }) => {
        try {
          checkStakeCap(args.proposer_stake, cfg.maxStakeLamports, "proposer_stake");

          if (cfg.requireApproval && !args.confirmed) {
            return pendingApproval("bond_propose", {
              proposer_stake_sol: `${(args.proposer_stake / 1e9).toFixed(4)} SOL`,
              counterparty_stake_sol: `${(args.counterparty_stake / 1e9).toFixed(4)} SOL`,
              counterparty: args.counterparty,
              condition: args.condition,
              expiry_slot: args.expiry_slot,
              oracle_feed: args.oracle_feed,
              warning: "Proposing will lock your stake in escrow on-chain immediately.",
            });
          }

          const wallet = loadWallet(cfg.walletPath);
          const proposerPk = wallet.publicKey;
          const counterpartyPk = new PublicKey(args.counterparty);
          const feedPk = new PublicKey(args.oracle_feed);
          const noncePk = new PublicKey(args.nonce_account);
          const programId = new PublicKey(cfg.programId);

          const connection = new Connection(cfg.rpcUrl, "confirmed");
          const nonceInfo = await connection.getNonce(noncePk);
          if (!nonceInfo) {
            return { success: false, error: "Nonce account not found — create one first with the Solana CLI" };
          }

          const [bondPda] = deriveBondPda(proposerPk, counterpartyPk, programId);

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

          const program = getProgram(cfg, wallet);
          const ix = await (program.methods as any)
            .initializeBond({
              condition: dslConditionToAnchor(args.condition),
              threshold: new BN(args.threshold ?? 0),
              thresholdMin: new BN(args.threshold_min ?? 0),
              thresholdMax: new BN(args.threshold_max ?? 0),
              changePct: args.change_pct ?? 0,
              snapshotPrice: new BN(args.snapshot_price ?? 0),
              expirySlot: new BN(args.expiry_slot),
              proposerStake: new BN(args.proposer_stake),
              counterpartyStake: new BN(args.counterparty_stake),
            })
            .accounts({
              proposer: proposerPk,
              counterparty: counterpartyPk,
              bond: bondPda,
              chainlinkFeed: feedPk,
              systemProgram: SystemProgram.programId,
            })
            .instruction();

          const tx = new Transaction();
          tx.add(SystemProgram.nonceAdvance({ noncePubkey: noncePk, authorizedPubkey: proposerPk }));
          tx.add(ix);
          tx.recentBlockhash = nonceInfo.nonce;
          tx.feePayer = proposerPk;

          const signedTx = await wallet.signTransaction(tx);
          const tx_hex = signedTx.serialize({ requireAllSignatures: false }).toString("hex");

          return {
            success: true,
            dsl,
            tx_hex,
            bond_pda: bondPda.toBase58(),
            amount_lamports: args.proposer_stake,
            next_step:
              "Send this bundle to the counterparty. Also call bond_watch so " +
              "settlement is tracked automatically if they accept.",
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // bond_inspect
    // -----------------------------------------------------------------------
    bond_inspect: {
      description:
        "Verify that a received tx_hex was compiled from the accompanying DSL. " +
        "bond_accept runs this automatically — call bond_inspect separately for manual inspection.",
      parameters: Type.Object({
        dsl: Type.Object({}, { description: "The Claw-DSL object from the proposer", additionalProperties: true }),
        tx_hex: Type.String({ description: "Hex-encoded transaction from the proposer" }),
      }),

      handler: async (args: { dsl: Record<string, unknown>; tx_hex: string }) => {
        try {
          const result = verifyBondTransaction(args.tx_hex, args.dsl) as {
            ok: boolean;
            errors: string[];
          };

          const summary = result.ok
            ? [
                `Condition: ${args.dsl.condition} — you win as counterparty if condition is FALSE at slot ${args.dsl.expiry_slot}`,
                `Oracle feed: ${args.dsl.oracle_feed}`,
                `Proposer stakes: ${((args.dsl.proposer_stake as number) / 1e9).toFixed(4)} SOL`,
                `Your stake if you accept: ${((args.dsl.counterparty_stake as number) / 1e9).toFixed(4)} SOL`,
                `PDA derivation: ✓`,
              ].join("\n")
            : `VERIFICATION FAILED — do not accept.\n${result.errors.join("\n")}`;

          return { success: true, verified: result.ok, errors: result.errors, summary };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // bond_accept
    // -----------------------------------------------------------------------
    bond_accept: {
      description:
        "Countersign a bond proposal as counterparty and submit it to Solana. " +
        "Automatically verifies the DSL against the transaction — rejects if verification fails. " +
        "Requires confirmation when requireApproval is enabled (the default).",
      parameters: Type.Object({
        dsl: Type.Object({}, {
          description: "The Claw-DSL object from the proposer's bundle — used for automatic verification",
          additionalProperties: true,
        }),
        tx_hex: Type.String({ description: "The tx_hex from the proposer's bundle" }),
        confirmed: Type.Optional(Type.Boolean({ description: "Set to true to confirm after reviewing the approval summary" })),
      }),

      handler: async (args: { dsl: Record<string, unknown>; tx_hex: string; confirmed?: boolean }) => {
        try {
          // Always verify the transaction against the DSL before anything else.
          const verification = verifyBondTransaction(args.tx_hex, args.dsl) as {
            ok: boolean;
            errors: string[];
          };
          if (!verification.ok) {
            return {
              success: false,
              error: "Transaction verification failed — DSL does not match the provided tx_hex. Do not accept.",
              verification_errors: verification.errors,
            };
          }

          const counterpartyStakeLamports = args.dsl.counterparty_stake as number;
          checkStakeCap(counterpartyStakeLamports, cfg.maxStakeLamports, "counterparty_stake");

          if (cfg.requireApproval && !args.confirmed) {
            return pendingApproval("bond_accept", {
              verified: true,
              plain_english: [
                `Condition: ${args.dsl.condition}`,
                `You win if the condition is FALSE at slot ${args.dsl.expiry_slot}`,
                `Oracle: ${args.dsl.oracle_feed}`,
                `Proposer stakes: ${((args.dsl.proposer_stake as number) / 1e9).toFixed(4)} SOL`,
                `Your stake: ${(counterpartyStakeLamports / 1e9).toFixed(4)} SOL`,
              ].join(" | "),
              warning: "Accepting will escrow your stake on-chain. This cannot be reversed once submitted.",
            });
          }

          const wallet = loadWallet(cfg.walletPath);
          const connection = new Connection(cfg.rpcUrl, "confirmed");

          const tx = Transaction.from(Buffer.from(args.tx_hex, "hex"));
          const signedTx = await wallet.signTransaction(tx);

          const signature = await connection.sendRawTransaction(
            signedTx.serialize(),
            { skipPreflight: false }
          );
          await connection.confirmTransaction(signature, "confirmed");

          return {
            success: true,
            signature,
            amount_lamports: counterpartyStakeLamports,
            next_step:
              "Bond escrowed. Call bond_watch with the DSL to register automatic settlement.",
            explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // bond_settle
    // -----------------------------------------------------------------------
    bond_settle: {
      description:
        "Settle an expired bond. Supply the address you believe won — the program " +
        "verifies on-chain and reverts if wrong. Permissionless. " +
        "Requires confirmation when requireApproval is enabled.",
      parameters: Type.Object({
        bond_pda: Type.String(),
        proposer: Type.String(),
        counterparty: Type.String(),
        winner: Type.String({ description: "Must be proposer or counterparty" }),
        oracle_feed: Type.String(),
        confirmed: Type.Optional(Type.Boolean({ description: "Set to true to confirm settlement" })),
      }),

      handler: async (args: {
        bond_pda: string;
        proposer: string;
        counterparty: string;
        winner: string;
        oracle_feed: string;
        confirmed?: boolean;
      }) => {
        try {
          if (cfg.requireApproval && !args.confirmed) {
            return pendingApproval("bond_settle", {
              bond_pda: args.bond_pda,
              proposed_winner: args.winner,
              proposer: args.proposer,
              counterparty: args.counterparty,
              warning: "Settlement transfers all escrowed SOL to the winner on-chain.",
            });
          }

          const wallet = loadWallet(cfg.walletPath);
          const program = getProgram(cfg, wallet);

          const signature = await (program.methods as any)
            .settleBond()
            .accounts({
              bond: new PublicKey(args.bond_pda),
              proposer: new PublicKey(args.proposer),
              counterparty: new PublicKey(args.counterparty),
              winner: new PublicKey(args.winner),
              chainlinkFeed: new PublicKey(args.oracle_feed),
              chainlinkProgram: CHAINLINK_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

          removePendingBond(cfg.storePath, args.bond_pda);

          return {
            success: true,
            signature,
            bond_pda: args.bond_pda,
            winner: args.winner,
            explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // bond_watch
    // -----------------------------------------------------------------------
    bond_watch: {
      description:
        "Register a bond for automatic settlement tracking. Returns a check_at " +
        "timestamp — schedule bond_check_pending for that time.",
      parameters: Type.Object({
        dsl: Type.Object({}, { description: "The Claw-DSL object for this bond", additionalProperties: true }),
        bond_pda: Type.String({ description: "Base58 bond PDA from the proposal bundle" }),
      }),

      handler: async (args: { dsl: Record<string, unknown>; bond_pda: string }) => {
        try {
          const connection = new Connection(cfg.rpcUrl, "confirmed");
          const currentSlot = await connection.getSlot();
          const expirySlot = Number(args.dsl.expiry_slot);
          const checkAt = estimateCheckAt(currentSlot, expirySlot);

          const entry: PendingBond = {
            bond_pda: args.bond_pda,
            proposer: String(args.dsl.proposer),
            counterparty: String(args.dsl.counterparty),
            oracle_feed: String(args.dsl.oracle_feed),
            expiry_slot: expirySlot,
            registered_at: new Date().toISOString(),
          };
          savePendingBond(cfg.storePath, entry);

          const slotsRemaining = Math.max(0, expirySlot - currentSlot);

          return {
            success: true,
            registered: true,
            bond_pda: args.bond_pda,
            expiry_slot: expirySlot,
            current_slot: currentSlot,
            slots_remaining: slotsRemaining,
            check_at: checkAt.toISOString(),
            check_in_seconds: Math.ceil((checkAt.getTime() - Date.now()) / 1000),
            next_step: `Schedule bond_check_pending at ${checkAt.toISOString()}. No further action needed until then.`,
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // bond_list_pending  (read-only — never triggers settlement)
    // -----------------------------------------------------------------------
    bond_list_pending: {
      description:
        "List all locally-registered bonds being watched for settlement. " +
        "Read-only — does not trigger any settlement. " +
        "Use this to inspect pending bonds before calling bond_check_pending.",
      parameters: Type.Object({}),

      handler: async () => {
        try {
          const bonds = loadPendingBonds(cfg.storePath);
          const connection = new Connection(cfg.rpcUrl, "confirmed");
          const currentSlot = await connection.getSlot();

          return {
            success: true,
            current_slot: currentSlot,
            count: bonds.length,
            bonds: bonds.map((b) => ({
              ...b,
              slots_remaining: Math.max(0, b.expiry_slot - currentSlot),
              estimated_seconds_remaining: Math.max(
                0,
                Math.ceil((b.expiry_slot - currentSlot) * 0.45)
              ),
              expired: currentSlot >= b.expiry_slot,
            })),
            note: "Call bond_check_pending to settle expired bonds (with confirmed: true if requireApproval is enabled).",
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // bond_propose_open  (single-sig; creates discoverable BondProposal)
    // -----------------------------------------------------------------------
    bond_propose_open: {
      description:
        "Open a public bond proposal on-chain — only you sign. Your stake is " +
        "escrowed immediately. Any agent can discover and accept it via bond_capabilities " +
        "or bond_accept_proposal. One open proposal per wallet at a time. " +
        "Requires confirmation when requireApproval is enabled.",
      parameters: Type.Object({
        oracle_feed: Type.String({ description: "Base58 Chainlink aggregator address" }),
        condition: Type.String({ description: "PRICE_BELOW | PRICE_ABOVE | PRICE_BETWEEN | PRICE_CHANGE_PCT" }),
        threshold: Type.Optional(Type.Number({ description: "Raw Chainlink units (8 dec for USD feeds; $1 = 100000000)" })),
        threshold_min: Type.Optional(Type.Number()),
        threshold_max: Type.Optional(Type.Number()),
        change_pct: Type.Optional(Type.Number({ description: "Signed basis points, e.g. 500 = +5%" })),
        snapshot_price: Type.Optional(Type.Number()),
        expiry_slot: Type.Number({ description: "Absolute Solana slot when the bond resolves" }),
        proposer_stake_sol: Type.Number({ description: "SOL you are staking" }),
        counterparty_stake_sol: Type.Number({ description: "SOL you require from whoever accepts" }),
        confirmed: Type.Optional(Type.Boolean({ description: "Set to true to confirm after reviewing the approval summary" })),
      }),

      handler: async (args: {
        oracle_feed: string;
        condition: string;
        threshold?: number;
        threshold_min?: number;
        threshold_max?: number;
        change_pct?: number;
        snapshot_price?: number;
        expiry_slot: number;
        proposer_stake_sol: number;
        counterparty_stake_sol: number;
        confirmed?: boolean;
      }) => {
        try {
          const proposerStake = Math.round(args.proposer_stake_sol * 1e9);
          checkStakeCap(proposerStake, cfg.maxStakeLamports, "proposer_stake_sol");

          if (cfg.requireApproval && !args.confirmed) {
            return pendingApproval("bond_propose_open", {
              proposer_stake_sol: args.proposer_stake_sol,
              counterparty_stake_sol: args.counterparty_stake_sol,
              condition: args.condition,
              expiry_slot: args.expiry_slot,
              oracle_feed: args.oracle_feed,
              warning: "Your stake is escrowed immediately and visible to all agents. Cancel with bond_cancel_proposal before acceptance.",
            });
          }

          const wallet = loadWallet(cfg.walletPath);
          const program = getProgram(cfg, wallet);
          const programId = new PublicKey(cfg.programId);

          const [proposalPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("proposal"), wallet.publicKey.toBuffer()],
            programId
          );

          const counterpartyStake = Math.round(args.counterparty_stake_sol * 1e9);

          const sig = await (program.methods as any)
            .proposeBond({
              condition: dslConditionToAnchor(args.condition),
              threshold: new BN(args.threshold ?? 0),
              thresholdMin: new BN(args.threshold_min ?? 0),
              thresholdMax: new BN(args.threshold_max ?? 0),
              changePct: args.change_pct ?? 0,
              snapshotPrice: new BN(args.snapshot_price ?? 0),
              expirySlot: new BN(args.expiry_slot),
              proposerStake: new BN(proposerStake),
              counterpartyStake: new BN(counterpartyStake),
            })
            .accounts({
              proposer: wallet.publicKey,
              proposal: proposalPda,
              oracleFeed: new PublicKey(args.oracle_feed),
              systemProgram: SystemProgram.programId,
            })
            .rpc();

          return {
            success: true,
            proposal_address: proposalPda.toBase58(),
            bond_pda: proposalPda.toBase58(),
            amount_lamports: proposerStake,
            signature: sig,
            condition: args.condition,
            expiry_slot: args.expiry_slot,
            proposer_stake_sol: args.proposer_stake_sol,
            counterparty_stake_sol: args.counterparty_stake_sol,
            next_step:
              "Proposal is live on-chain. Other agents will see it via bond_capabilities. " +
              "To cancel before acceptance, call bond_cancel_proposal.",
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // bond_accept_proposal
    // -----------------------------------------------------------------------
    bond_accept_proposal: {
      description:
        "Accept an open bond proposal by its on-chain address. Your stake is escrowed " +
        "atomically with the proposer's. Automatically verifies proposal terms and requires " +
        "confirmation when requireApproval is enabled.",
      parameters: Type.Object({
        proposal_address: Type.String({ description: "Base58 address of the BondProposal account" }),
        confirmed: Type.Optional(Type.Boolean({ description: "Set to true to confirm after reviewing the proposal details" })),
      }),

      handler: async (args: { proposal_address: string; confirmed?: boolean }) => {
        try {
          const wallet = loadWallet(cfg.walletPath);
          const program = getProgram(cfg, wallet);
          const programId = new PublicKey(cfg.programId);
          const connection = new Connection(cfg.rpcUrl, "confirmed");

          const proposalPk = new PublicKey(args.proposal_address);
          const proposal = await (program.account as any).bondProposal.fetch(proposalPk);

          const currentSlot = await connection.getSlot("confirmed");
          if (currentSlot >= proposal.expiry_slot.toNumber()) {
            return { success: false, error: `Proposal expired at slot ${proposal.expiry_slot} (current: ${currentSlot})` };
          }

          const proposerPk = proposal.proposer as PublicKey;
          const oracleFeedPk = proposal.oracle_feed as PublicKey;
          const conditionKey = Object.keys(proposal.condition)[0] as string;
          const counterpartyStake = (proposal.counterparty_stake as { toNumber(): number }).toNumber();

          checkStakeCap(counterpartyStake, cfg.maxStakeLamports, "counterparty_stake");

          if (cfg.requireApproval && !args.confirmed) {
            return pendingApproval("bond_accept_proposal", {
              proposal_address: args.proposal_address,
              proposer: proposerPk.toBase58(),
              plain_english: [
                `Condition: ${CONDITION_DSL_MAP[conditionKey] ?? conditionKey}`,
                `You win as counterparty if the condition is FALSE at slot ${proposal.expiry_slot.toNumber()}`,
                `Oracle: ${oracleFeedPk.toBase58()}`,
                `Proposer stakes: ${(proposal.proposer_stake.toNumber() / 1e9).toFixed(4)} SOL`,
                `Your stake: ${(counterpartyStake / 1e9).toFixed(4)} SOL`,
                `Slots until expiry: ${proposal.expiry_slot.toNumber() - currentSlot} (~${Math.round((proposal.expiry_slot.toNumber() - currentSlot) * 0.4)}s)`,
              ].join(" | "),
              warning: "Accepting will escrow your stake on-chain. Cannot be cancelled after acceptance.",
            });
          }

          const [bondPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("bond"), proposerPk.toBuffer(), wallet.publicKey.toBuffer()],
            programId
          );

          const sig = await (program.methods as any)
            .acceptBond()
            .accounts({
              counterparty: wallet.publicKey,
              proposal: proposalPk,
              bond: bondPda,
              oracleFeed: oracleFeedPk,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

          savePendingBond(cfg.storePath, {
            bond_pda: bondPda.toBase58(),
            proposer: proposerPk.toBase58(),
            counterparty: wallet.publicKey.toBase58(),
            oracle_feed: oracleFeedPk.toBase58(),
            expiry_slot: proposal.expiry_slot.toNumber(),
            registered_at: new Date().toISOString(),
          });

          return {
            success: true,
            bond_address: bondPda.toBase58(),
            bond_pda: bondPda.toBase58(),
            proposer: proposerPk.toBase58(),
            counterparty: wallet.publicKey.toBase58(),
            oracle_feed: oracleFeedPk.toBase58(),
            expiry_slot: proposal.expiry_slot.toNumber(),
            amount_lamports: counterpartyStake,
            signature: sig,
            next_step:
              "Bond is active. Call bond_watch to register automatic settlement, " +
              "or bond_settle manually after expiry_slot.",
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // bond_cancel_proposal
    // -----------------------------------------------------------------------
    bond_cancel_proposal: {
      description:
        "Cancel your own open BondProposal (before it is accepted). " +
        "Your full stake and rent are returned immediately.",
      parameters: Type.Object({}),

      handler: async () => {
        try {
          const wallet = loadWallet(cfg.walletPath);
          const program = getProgram(cfg, wallet);
          const programId = new PublicKey(cfg.programId);

          const [proposalPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("proposal"), wallet.publicKey.toBuffer()],
            programId
          );

          const sig = await (program.methods as any)
            .cancelBond()
            .accounts({
              proposer: wallet.publicKey,
              proposal: proposalPda,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

          return {
            success: true,
            proposal_address: proposalPda.toBase58(),
            signature: sig,
            message: "Proposal cancelled. Stake and rent returned to your wallet.",
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // bond_list_open
    // -----------------------------------------------------------------------
    bond_list_open: {
      description:
        "List all open BondProposal accounts visible on-chain right now. " +
        "Returns proposals that have not yet expired or been accepted.",
      parameters: Type.Object({}),

      handler: async () => {
        try {
          const program = getProgram(cfg, loadWallet(cfg.walletPath));
          const connection = new Connection(cfg.rpcUrl, "confirmed");
          const currentSlot = await connection.getSlot("confirmed");

          const all = await (program.account as any).bondProposal.all();
          const open = all
            .filter((p: any) => p.account.expiry_slot.toNumber() > currentSlot)
            .map((p: any) => formatProposal(p.publicKey.toBase58(), p.account, currentSlot));

          return {
            success: true,
            current_slot: currentSlot,
            count: open.length,
            proposals: open,
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // bond_capabilities  (the discovery document)
    // -----------------------------------------------------------------------
    bond_capabilities: {
      description:
        "Return the complete capabilities document for ClawBond: how to " +
        "propose, accept, and settle bonds, what conditions are supported, risks, " +
        "and all currently open opportunities on-chain.",
      parameters: Type.Object({}),

      handler: async () => {
        try {
          const program = getProgram(cfg, loadWallet(cfg.walletPath));
          const connection = new Connection(cfg.rpcUrl, "confirmed");
          const currentSlot = await connection.getSlot("confirmed");

          const all = await (program.account as any).bondProposal.all();
          const open = all
            .filter((p: any) => p.account.expiry_slot.toNumber() > currentSlot)
            .map((p: any) => formatProposal(p.publicKey.toBase58(), p.account, currentSlot));

          return {
            success: true,
            capabilities: {
              protocol: "clawbond",
              version: "1.0.0",
              program_id: cfg.programId,
              rpc_url: cfg.rpcUrl,
              description:
                "Permissionless, oracle-verified price bonds on Solana. " +
                "Create an open proposal with your stake escrowed on-chain — any agent can " +
                "discover and accept it. Settlement is automatic via Chainlink price feeds.",

              how_to_propose: {
                tool: "bond_propose_open",
                description:
                  "Create an open bond — your stake is escrowed immediately. " +
                  "One open proposal per wallet. Specify condition, oracle feed, expiry slot, " +
                  "and both stakes. Pass confirmed: true after reviewing the approval summary.",
                cost: "proposer_stake_sol locked until expiry or cancellation",
                example: {
                  oracle_feed: "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6",
                  condition: "PRICE_ABOVE",
                  threshold: 15000000000,
                  expiry_slot: currentSlot + 20000,
                  proposer_stake_sol: 0.1,
                  counterparty_stake_sol: 0.1,
                },
              },

              how_to_accept: {
                tool: "bond_accept_proposal",
                description:
                  "Accept any open proposal by its on-chain address. " +
                  "Proposal terms are shown for review before funds move. " +
                  "Pass confirmed: true to escrow your counterparty_stake atomically. Cannot be cancelled after acceptance.",
                parameters: { proposal_address: "base58 address from open_opportunities list" },
              },

              how_to_settle: {
                tool: "bond_settle",
                description:
                  "Settle an expired bond. Permissionless — anyone can call. " +
                  "Chainlink oracle determines the winner; all escrowed SOL goes to them.",
                parameters: {
                  bond_address: "base58 bond PDA",
                  proposer: "proposer pubkey",
                  counterparty: "counterparty pubkey",
                  winner: "your guess for winner (proposer or counterparty pubkey)",
                  oracle_feed: "chainlink feed address",
                },
              },

              conditions: {
                PRICE_ABOVE:
                  "Proposer wins if oracle price > threshold at expiry. " +
                  "Counterparty wins if price ≤ threshold.",
                PRICE_BELOW:
                  "Proposer wins if oracle price < threshold at expiry. " +
                  "Counterparty wins if price ≥ threshold.",
                PRICE_BETWEEN:
                  "Proposer wins if threshold_min ≤ oracle price ≤ threshold_max. " +
                  "Counterparty wins if price is outside the band.",
                PRICE_CHANGE_PCT:
                  "Proposer wins if % change from snapshot_price ≥ change_pct (basis points). " +
                  "e.g. change_pct=500 means proposer wins if price rose ≥ 5%.",
              },

              oracle: {
                provider: "Chainlink",
                price_decimals: 8,
                note: "threshold values are in raw Chainlink units: $1.00 = 100000000",
                known_feeds: [
                  {
                    pair: "SOL/USD",
                    address: "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6",
                    network: "devnet",
                  },
                ],
                staleness_limit_slots: 150,
              },

              risks: [
                "Stakes are locked in escrow — no early withdrawal once bond is active",
                "Cannot cancel after counterparty accepts",
                "Settlement fails if oracle data is > 150 slots stale",
                "Expiry slot is a Solana slot number, not a timestamp (~0.4 s/slot on mainnet)",
              ],

              slot_to_time_estimate:
                "1 slot ≈ 0.4 s on mainnet, 0.4 s on local validator. " +
                `Current slot: ${currentSlot}`,
            },

            open_opportunities: open,
            current_slot: currentSlot,
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // bond_check_pending
    // -----------------------------------------------------------------------
    bond_check_pending: {
      description:
        "Check all watched bonds and settle any that have passed their expiry_slot. " +
        "When requireApproval is enabled (the default), returns a preview of what would settle " +
        "without submitting — pass confirmed: true to actually settle. " +
        "Use dry_run: true to always preview without settling regardless of requireApproval. " +
        "Use bond_list_pending to inspect the watch list without triggering any settlement logic.",
      parameters: Type.Object({
        confirmed: Type.Optional(Type.Boolean({ description: "Set to true to execute settlement (required when requireApproval is enabled)" })),
        dry_run: Type.Optional(Type.Boolean({ description: "Always preview what would settle without submitting any transactions" })),
      }),

      handler: async (args: { confirmed?: boolean; dry_run?: boolean }) => {
        try {
          const isDryRun = args.dry_run === true || (cfg.requireApproval && !args.confirmed);

          const wallet = loadWallet(cfg.walletPath);
          const connection = new Connection(cfg.rpcUrl, "confirmed");
          const program = getProgram(cfg, wallet);
          const currentSlot = await connection.getSlot();
          const pending = loadPendingBonds(cfg.storePath);

          if (pending.length === 0) {
            return { success: true, message: "No pending bonds.", results: [], dry_run: isDryRun };
          }

          if (isDryRun) {
            // Startup summary: show state without settling anything.
            const preview = pending.map((bond) => {
              const expired = currentSlot >= bond.expiry_slot;
              return {
                bond_pda: bond.bond_pda,
                status: expired ? "ready_to_settle" : "pending",
                slots_remaining: Math.max(0, bond.expiry_slot - currentSlot),
                estimated_seconds: Math.max(0, Math.ceil((bond.expiry_slot - currentSlot) * 0.45)),
                proposer: bond.proposer,
                counterparty: bond.counterparty,
                expiry_slot: bond.expiry_slot,
              };
            });

            const readyCount = preview.filter((r) => r.status === "ready_to_settle").length;
            return {
              success: true,
              dry_run: true,
              current_slot: currentSlot,
              checked: pending.length,
              ready_to_settle: readyCount,
              still_pending: preview.filter((r) => r.status === "pending").length,
              results: preview,
              next_step: readyCount > 0
                ? `${readyCount} bond(s) ready to settle. Call bond_check_pending with confirmed: true to submit settlement.`
                : "No bonds are ready to settle yet.",
            };
          }

          const results = [];

          for (const bond of pending) {
            if (currentSlot < bond.expiry_slot) {
              const slotsLeft = bond.expiry_slot - currentSlot;
              results.push({
                bond_pda: bond.bond_pda,
                status: "pending",
                slots_remaining: slotsLeft,
                estimated_seconds: Math.ceil(slotsLeft * 0.45),
              });
              continue;
            }

            const pdaInfo = await connection.getAccountInfo(new PublicKey(bond.bond_pda));
            if (!pdaInfo || pdaInfo.lamports === 0) {
              removePendingBond(cfg.storePath, bond.bond_pda);
              results.push({
                bond_pda: bond.bond_pda,
                status: "dropped",
                reason: "PDA not found — bond was never accepted or already settled",
              });
              continue;
            }

            try {
              const winner = await resolveWinner(program, bond, CHAINLINK_PROGRAM_ID);

              const signature = await (program.methods as any)
                .settleBond()
                .accounts({
                  bond: new PublicKey(bond.bond_pda),
                  proposer: new PublicKey(bond.proposer),
                  counterparty: new PublicKey(bond.counterparty),
                  winner: new PublicKey(winner),
                  chainlinkFeed: new PublicKey(bond.oracle_feed),
                  chainlinkProgram: CHAINLINK_PROGRAM_ID,
                  systemProgram: SystemProgram.programId,
                })
                .rpc();

              removePendingBond(cfg.storePath, bond.bond_pda);
              results.push({
                bond_pda: bond.bond_pda,
                status: "settled",
                winner,
                signature,
                explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
              });
            } catch (e: unknown) {
              results.push({
                bond_pda: bond.bond_pda,
                status: "error",
                error: String(e),
              });
            }
          }

          return {
            success: true,
            dry_run: false,
            current_slot: currentSlot,
            checked: pending.length,
            settled: results.filter((r) => r.status === "settled").length,
            still_pending: results.filter((r) => r.status === "pending").length,
            results,
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -------------------------------------------------------------------------
    // WorkBond tools
    // -------------------------------------------------------------------------

    work_bond_create: {
      name: "work_bond_create",
      description:
        "Create a work bond: escrow a payment for a specific worker, with a collateral " +
        "requirement and an adjudicator who decides the outcome. " +
        "The adjudicator is a fixed keypair chosen at creation — see SKILL.md for selection guidance. " +
        "Requires confirmation when requireApproval is enabled.",
      parameters: Type.Object({
        worker:       Type.String({ description: "Base58 pubkey of the agent who will do the work" }),
        adjudicator:  Type.String({ description: "Base58 pubkey of the agent (or human) who will adjudicate completion. Must be a trusted, pre-agreed party." }),
        payment:      Type.Number({ description: "Lamports to pay worker on success" }),
        worker_stake: Type.Number({ description: "Lamports worker must lock as collateral when joining" }),
        expiry_slot:  Type.Number({ description: "Slot deadline — after this, either party can call work_bond_expire" }),
        confirmed:    Type.Optional(Type.Boolean({ description: "Set to true to confirm after reviewing the approval summary" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const payment = params.payment as number;
          checkStakeCap(payment, cfg.maxStakeLamports, "payment");

          if (cfg.requireApproval && !params.confirmed) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify(pendingApproval("work_bond_create", {
                  payment_sol: `${(payment / 1e9).toFixed(4)} SOL`,
                  worker_stake_sol: `${((params.worker_stake as number) / 1e9).toFixed(4)} SOL`,
                  worker: params.worker,
                  adjudicator: params.adjudicator,
                  expiry_slot: params.expiry_slot,
                  warning: "Payment is escrowed immediately. Outcome decided by the adjudicator keypair — ensure you trust this party.",
                })),
              }],
            };
          }

          const pluginCfg = cfg;
          const wallet = loadWallet(pluginCfg.walletPath);
          const program = getProgram(pluginCfg, wallet);
          const connection = new Connection(pluginCfg.rpcUrl, "confirmed");

          const payer      = wallet.publicKey;
          const worker     = new PublicKey(params.worker as string);
          const adjudicator = new PublicKey(params.adjudicator as string);

          const [workBondPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("workbond"), payer.toBuffer(), worker.toBuffer()],
            program.programId
          );

          const sig = await (program.methods as any)
            .createWorkBond({
              payment:     new BN(payment),
              workerStake: new BN(params.worker_stake as number),
              expirySlot:  new BN(params.expiry_slot as number),
            })
            .accounts({
              payer,
              worker,
              adjudicator,
              workBond: workBondPda,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

          const slot = await connection.getSlot();
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                work_bond_pda: workBondPda.toBase58(),
                payer: payer.toBase58(),
                worker: params.worker,
                adjudicator: params.adjudicator,
                payment: payment,
                amount_lamports: payment,
                worker_stake: params.worker_stake,
                expiry_slot: params.expiry_slot,
                current_slot: slot,
                signature: sig,
                note: "Send work_bond_pda to the worker so they can call work_bond_join.",
              }),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }) }] };
        }
      },
    },

    work_bond_join: {
      name: "work_bond_join",
      description:
        "Join a work bond as the designated worker, escrowing your collateral stake. " +
        "Call this after receiving a work_bond_pda from the payer. " +
        "Requires confirmation when requireApproval is enabled.",
      parameters: Type.Object({
        work_bond_address: Type.String({ description: "Base58 address of the WorkBond PDA to join" }),
        confirmed:         Type.Optional(Type.Boolean({ description: "Set to true to confirm after reviewing the bond details" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const pluginCfg = cfg;
          const wallet = loadWallet(pluginCfg.walletPath);
          const program = getProgram(pluginCfg, wallet);

          const workBond = new PublicKey(params.work_bond_address as string);
          const acc = await (program.account as any).workBond.fetch(workBond);

          const workerStake = (acc.workerStake as { toNumber(): number }).toNumber();
          checkStakeCap(workerStake, pluginCfg.maxStakeLamports, "worker_stake");

          if (pluginCfg.requireApproval && !params.confirmed) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify(pendingApproval("work_bond_join", {
                  work_bond_pda: workBond.toBase58(),
                  payer: acc.payer.toBase58(),
                  payment_sol: `${(acc.payment.toNumber() / 1e9).toFixed(4)} SOL`,
                  your_stake_sol: `${(workerStake / 1e9).toFixed(4)} SOL`,
                  expiry_slot: acc.expirySlot.toNumber(),
                  adjudicator: acc.adjudicator.toBase58(),
                  warning: "Joining locks your collateral. The adjudicator decides if you receive payment or forfeit collateral.",
                })),
              }],
            };
          }

          const sig = await (program.methods as any)
            .joinWorkBond()
            .accounts({
              worker:        wallet.publicKey,
              workBond,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                work_bond_pda: workBond.toBase58(),
                payer: acc.payer.toBase58(),
                worker: wallet.publicKey.toBase58(),
                payment: acc.payment.toNumber(),
                worker_stake: workerStake,
                amount_lamports: workerStake,
                expiry_slot: acc.expirySlot.toNumber(),
                signature: sig,
                note: "Work bond is now Active. Complete the task, then notify the adjudicator.",
              }),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }) }] };
        }
      },
    },

    work_bond_complete: {
      name: "work_bond_complete",
      description:
        "Adjudicator confirms the worker completed the task. Worker receives the full payment plus their stake back. " +
        "Only callable by the adjudicator keypair set at bond creation. " +
        "Requires confirmation when requireApproval is enabled.",
      parameters: Type.Object({
        work_bond_address: Type.String({ description: "Base58 address of the WorkBond PDA" }),
        confirmed:         Type.Optional(Type.Boolean({ description: "Set to true to confirm the adjudication decision" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const pluginCfg = cfg;
          const wallet = loadWallet(pluginCfg.walletPath);
          const program = getProgram(pluginCfg, wallet);

          const workBond = new PublicKey(params.work_bond_address as string);
          const acc = await (program.account as any).workBond.fetch(workBond);
          const payout = acc.payment.toNumber() + acc.workerStake.toNumber();

          if (pluginCfg.requireApproval && !params.confirmed) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify(pendingApproval("work_bond_complete", {
                  work_bond_pda: workBond.toBase58(),
                  worker: acc.worker.toBase58(),
                  payout_sol: `${(payout / 1e9).toFixed(4)} SOL (payment + collateral)`,
                  warning: "This is an irreversible adjudicator decision. Worker will receive all funds.",
                })),
              }],
            };
          }

          const sig = await (program.methods as any)
            .completeWorkBond()
            .accounts({
              adjudicator: wallet.publicKey,
              worker:      acc.worker,
              workBond,
            })
            .rpc();

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                work_bond_pda: workBond.toBase58(),
                worker: acc.worker.toBase58(),
                payout,
                amount_lamports: payout,
                signature: sig,
                note: "Worker received payment + collateral. Bond closed.",
              }),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }) }] };
        }
      },
    },

    work_bond_fail: {
      name: "work_bond_fail",
      description:
        "Adjudicator rules the worker failed or abandoned the task. Payer receives the payment back plus the worker's collateral as a penalty. " +
        "Only callable by the adjudicator keypair set at bond creation. " +
        "Requires confirmation when requireApproval is enabled.",
      parameters: Type.Object({
        work_bond_address: Type.String({ description: "Base58 address of the WorkBond PDA" }),
        confirmed:         Type.Optional(Type.Boolean({ description: "Set to true to confirm the adjudication decision" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const pluginCfg = cfg;
          const wallet = loadWallet(pluginCfg.walletPath);
          const program = getProgram(pluginCfg, wallet);

          const workBond = new PublicKey(params.work_bond_address as string);
          const acc = await (program.account as any).workBond.fetch(workBond);
          const payout = acc.payment.toNumber() + acc.workerStake.toNumber();

          if (pluginCfg.requireApproval && !params.confirmed) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify(pendingApproval("work_bond_fail", {
                  work_bond_pda: workBond.toBase58(),
                  payer: acc.payer.toBase58(),
                  payout_sol: `${(payout / 1e9).toFixed(4)} SOL (payment returned + worker collateral penalty)`,
                  warning: "This is an irreversible adjudicator decision. Worker forfeits collateral.",
                })),
              }],
            };
          }

          const sig = await (program.methods as any)
            .failWorkBond()
            .accounts({
              adjudicator: wallet.publicKey,
              payer:       acc.payer,
              workBond,
            })
            .rpc();

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                work_bond_pda: workBond.toBase58(),
                payer: acc.payer.toBase58(),
                payout,
                amount_lamports: payout,
                signature: sig,
                note: "Payer received payment back + worker collateral. Bond closed.",
              }),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }) }] };
        }
      },
    },

    work_bond_expire: {
      name: "work_bond_expire",
      description:
        "Permissionless expiry handler — callable by anyone after expiry_slot. Payer gets payment back; if worker had joined (Active state), worker also gets their stake back. " +
        "Requires confirmation when requireApproval is enabled.",
      parameters: Type.Object({
        work_bond_address: Type.String({ description: "Base58 address of the WorkBond PDA" }),
        confirmed:         Type.Optional(Type.Boolean({ description: "Set to true to confirm expiry" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const pluginCfg = cfg;
          const wallet = loadWallet(pluginCfg.walletPath);
          const program = getProgram(pluginCfg, wallet);
          const connection = new Connection(pluginCfg.rpcUrl, "confirmed");

          const workBond = new PublicKey(params.work_bond_address as string);
          const acc = await (program.account as any).workBond.fetch(workBond);
          const currentSlot = await connection.getSlot();

          if (pluginCfg.requireApproval && !params.confirmed) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify(pendingApproval("work_bond_expire", {
                  work_bond_pda: workBond.toBase58(),
                  payer: acc.payer.toBase58(),
                  expiry_slot: acc.expirySlot.toNumber(),
                  current_slot: currentSlot,
                  worker_refunded: Object.keys(acc.state)[0] === "active",
                  warning: "Expiring releases escrowed funds. Ensure expiry_slot has passed.",
                })),
              }],
            };
          }

          const sig = await (program.methods as any)
            .expireWorkBond()
            .accounts({
              payer:    acc.payer,
              worker:   acc.worker,
              workBond,
            })
            .rpc();

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                work_bond_pda: workBond.toBase58(),
                expired_at_slot: currentSlot,
                expiry_slot: acc.expirySlot.toNumber(),
                worker_refunded: Object.keys(acc.state)[0] === "active",
                signature: sig,
              }),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }) }] };
        }
      },
    },

    // -------------------------------------------------------------------------
    // Oracle work bond tools — Switchboard TEE adjudication, no human in loop
    // -------------------------------------------------------------------------

    oracle_work_bond_create: {
      name: "oracle_work_bond_create",
      description:
        "Create an oracle-adjudicated work bond. The completion condition is evaluated " +
        "off-chain by a Switchboard TEE function — no trusted human adjudicator required. " +
        "The payer commits to a Switchboard function pubkey and a SHA-256 hash of the " +
        "evaluation params JSON. Both are immutable after creation. " +
        "Requires confirmation when requireApproval is enabled.",
      parameters: Type.Object({
        worker:           Type.String({ description: "Base58 pubkey of the agent who will do the work" }),
        sb_function:      Type.String({ description: "Base58 pubkey of the deployed Switchboard FunctionAccountData" }),
        payment:          Type.Number({ description: "Lamports to pay worker on success" }),
        worker_stake:     Type.Number({ description: "Lamports worker must lock as collateral" }),
        expiry_slot:      Type.Number({ description: "Slot deadline — oracle must respond before this" }),
        eval_template:    Type.String({ description: "Evaluation template: github_pr_merged | http_get | solana_tx_confirmed | ipfs_cid_exists" }),
        eval_params:      Type.Object({}, { additionalProperties: true, description: "Template-specific params (excluding oracle_work_bond/payer/worker — added automatically)" }),
        confirmed:        Type.Optional(Type.Boolean({ description: "Set to true to confirm after reviewing the approval summary" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const payment = params.payment as number;
          checkStakeCap(payment, cfg.maxStakeLamports, "payment");

          const wallet = loadWallet(cfg.walletPath);
          const programId = new PublicKey(cfg.programId);

          const [oracleWorkBondPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("oracle-workbond"), wallet.publicKey.toBuffer(), new PublicKey(params.worker as string).toBuffer()],
            programId
          );

          // Build the full params object — includes the bond address so the TEE knows where to callback.
          const fullParams = {
            template: params.eval_template,
            oracle_work_bond: oracleWorkBondPda.toBase58(),
            payer: wallet.publicKey.toBase58(),
            worker: params.worker,
            ...(params.eval_params as object),
          };
          const paramsJson = JSON.stringify(fullParams);
          const paramsBytes = Buffer.from(paramsJson);

          // SHA-256 of params JSON — committed on-chain at creation.
          const { createHash } = await import("crypto");
          const paramsHash = Array.from(createHash("sha256").update(paramsBytes).digest());

          if (cfg.requireApproval && !params.confirmed) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify(pendingApproval("oracle_work_bond_create", {
                  payment_sol: `${(payment / 1e9).toFixed(4)} SOL`,
                  worker_stake_sol: `${((params.worker_stake as number) / 1e9).toFixed(4)} SOL`,
                  worker: params.worker,
                  sb_function: params.sb_function,
                  eval_template: params.eval_template,
                  eval_params: params.eval_params,
                  params_hash: Buffer.from(paramsHash).toString("hex"),
                  oracle_work_bond_pda: oracleWorkBondPda.toBase58(),
                  warning: "Payment is escrowed immediately. Outcome decided by the Switchboard TEE oracle — fully trustless, no human arbitration.",
                })),
              }],
            };
          }

          const program = getProgram(cfg, wallet);
          const connection = new Connection(cfg.rpcUrl, "confirmed");

          const sig = await (program.methods as any)
            .createOracleWorkBond({
              payment:      new BN(payment),
              workerStake:  new BN(params.worker_stake as number),
              expirySlot:   new BN(params.expiry_slot as number),
              paramsHash,
            })
            .accounts({
              payer:           wallet.publicKey,
              worker:          new PublicKey(params.worker as string),
              sbFunction:      new PublicKey(params.sb_function as string),
              oracleWorkBond:  oracleWorkBondPda,
              systemProgram:   SystemProgram.programId,
            })
            .rpc();

          const slot = await connection.getSlot();
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                oracle_work_bond_pda: oracleWorkBondPda.toBase58(),
                bond_pda: oracleWorkBondPda.toBase58(),
                amount_lamports: payment,
                params_hash: Buffer.from(paramsHash).toString("hex"),
                params_json: paramsJson,
                signature: sig,
                current_slot: slot,
                note: "Send oracle_work_bond_pda and params_json to the worker so they can join. Keep params_json — it is required to trigger evaluation.",
              }),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }) }] };
        }
      },
    },

    oracle_work_bond_join: {
      name: "oracle_work_bond_join",
      description:
        "Join an oracle work bond as the designated worker, escrowing your collateral stake. " +
        "Requires confirmation when requireApproval is enabled.",
      parameters: Type.Object({
        oracle_work_bond_address: Type.String({ description: "Base58 address of the OracleWorkBond PDA" }),
        confirmed:                Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const wallet = loadWallet(cfg.walletPath);
          const program = getProgram(cfg, wallet);

          const bondPk = new PublicKey(params.oracle_work_bond_address as string);
          const acc = await (program.account as any).oracleWorkBond.fetch(bondPk);
          const workerStake = (acc.workerStake as { toNumber(): number }).toNumber();
          checkStakeCap(workerStake, cfg.maxStakeLamports, "worker_stake");

          if (cfg.requireApproval && !params.confirmed) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify(pendingApproval("oracle_work_bond_join", {
                  oracle_work_bond_pda: bondPk.toBase58(),
                  payer: acc.payer.toBase58(),
                  payment_sol: `${(acc.payment.toNumber() / 1e9).toFixed(4)} SOL`,
                  your_stake_sol: `${(workerStake / 1e9).toFixed(4)} SOL`,
                  expiry_slot: acc.expirySlot.toNumber(),
                  sb_function: acc.sbFunction.toBase58(),
                  warning: "Joining locks your collateral. A Switchboard TEE oracle — not a human — will determine if you receive payment.",
                })),
              }],
            };
          }

          const sig = await (program.methods as any)
            .joinOracleWorkBond()
            .accounts({
              worker:          wallet.publicKey,
              oracleWorkBond:  bondPk,
              systemProgram:   SystemProgram.programId,
            })
            .rpc();

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                oracle_work_bond_pda: bondPk.toBase58(),
                bond_pda: bondPk.toBase58(),
                amount_lamports: workerStake,
                worker: wallet.publicKey.toBase58(),
                payer: acc.payer.toBase58(),
                payment_on_success: acc.payment.toNumber(),
                expiry_slot: acc.expirySlot.toNumber(),
                signature: sig,
                note: "Work bond is now Active. Complete the task, then call oracle_work_bond_request_eval with the original params_json.",
              }),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }) }] };
        }
      },
    },

    oracle_work_bond_request_eval: {
      name: "oracle_work_bond_request_eval",
      description:
        "Trigger oracle evaluation of a completed oracle work bond. " +
        "Registers the evaluation request on-chain (verifying params hash), then creates " +
        "and triggers a Switchboard FunctionRequest off-chain. The Switchboard TEE fetches " +
        "real-world data, evaluates the condition, and calls oracle_callback automatically. " +
        "Permissionless — anyone can call once the work is claimed complete.",
      parameters: Type.Object({
        oracle_work_bond_address: Type.String({ description: "Base58 address of the OracleWorkBond PDA" }),
        params_json:              Type.String({ description: "The params_json returned from oracle_work_bond_create — must match the committed hash exactly" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const wallet = loadWallet(cfg.walletPath);
          const program = getProgram(cfg, wallet);
          const connection = new Connection(cfg.rpcUrl, "confirmed");

          const bondPk = new PublicKey(params.oracle_work_bond_address as string);
          const acc = await (program.account as any).oracleWorkBond.fetch(bondPk);
          const paramsBytes = Buffer.from(params.params_json as string);

          // 1. Register evaluation request on-chain (program verifies params hash).
          const sig = await (program.methods as any)
            .requestOracleEvaluation(Array.from(paramsBytes))
            .accounts({ oracleWorkBond: bondPk })
            .rpc();

          // 2. Create and trigger a Switchboard FunctionRequest off-chain.
          // The Switchboard SDK is called here so the oracle network picks up the job.
          // switchboard_request_signature is null in environments without the SB SDK.
          let switchboard_request_signature: string | null = null;
          try {
            // Optional dependency — bypass TS module resolution with indirect import
            const sbPkg = "@switchboard-xyz/solana.js";
            // eslint-disable-next-line @typescript-eslint/no-implied-eval
            const { SwitchboardProgram, FunctionAccount, FunctionRequestAccount } =
              await (new Function("m", "return import(m)"))(sbPkg) as any;
            const sbProgram = await SwitchboardProgram.load("devnet", connection);
            const [fnAccount] = FunctionAccount.fromSeed(sbProgram, acc.sbFunction);
            const [requestAccount, requestSig] = await FunctionRequestAccount.create(
              sbProgram,
              {
                function: fnAccount,
                params: paramsBytes,
                authority: wallet,
              }
            );
            await requestAccount.trigger(wallet);
            switchboard_request_signature = requestSig;
          } catch (sbErr) {
            // Switchboard SDK may not be installed in all environments.
            // The on-chain request is registered; the oracle can still be triggered
            // manually using the Switchboard CLI: `sb request trigger <request_key>`
          }

          const currentSlot = await connection.getSlot();
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                oracle_work_bond_pda: bondPk.toBase58(),
                bond_pda: bondPk.toBase58(),
                on_chain_signature: sig,
                switchboard_request_signature,
                current_slot: currentSlot,
                sb_function: acc.sbFunction.toBase58(),
                note: switchboard_request_signature
                  ? "Switchboard request triggered. The TEE oracle will evaluate the condition and call oracle_callback automatically."
                  : "On-chain request registered. Trigger the Switchboard request manually: `sb request trigger --function <sb_function>` with the params_json.",
              }),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }) }] };
        }
      },
    },

    oracle_work_bond_status: {
      name: "oracle_work_bond_status",
      description:
        "Check the current state of an oracle work bond. Returns the state, amounts, " +
        "and how to proceed. Read-only.",
      parameters: Type.Object({
        oracle_work_bond_address: Type.String({ description: "Base58 address of the OracleWorkBond PDA" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const wallet = loadWallet(cfg.walletPath);
          const program = getProgram(cfg, wallet);
          const connection = new Connection(cfg.rpcUrl, "confirmed");

          const bondPk = new PublicKey(params.oracle_work_bond_address as string);
          const acc = await (program.account as any).oracleWorkBond.fetch(bondPk);
          const currentSlot = await connection.getSlot();
          const state = Object.keys(acc.state)[0] as string;
          const expired = currentSlot >= acc.expirySlot.toNumber();

          const next_step: Record<string, string> = {
            pendingWorker:       "Send this address to the worker. They call oracle_work_bond_join.",
            active:              "Worker should complete the task, then call oracle_work_bond_request_eval with the original params_json.",
            evaluationRequested: "Switchboard oracle is evaluating. oracle_callback will settle automatically.",
            settled:             "Bond is settled. Funds have been disbursed.",
          };

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                oracle_work_bond_pda: bondPk.toBase58(),
                payer: acc.payer.toBase58(),
                worker: acc.worker.toBase58(),
                sb_function: acc.sbFunction.toBase58(),
                payment_sol: (acc.payment.toNumber() / 1e9).toFixed(4),
                worker_stake_sol: (acc.workerStake.toNumber() / 1e9).toFixed(4),
                expiry_slot: acc.expirySlot.toNumber(),
                current_slot: currentSlot,
                slots_remaining: Math.max(0, acc.expirySlot.toNumber() - currentSlot),
                state,
                expired,
                next_step: expired && state !== "settled"
                  ? "Bond has expired without oracle resolution. Call oracle_work_bond_expire to return funds."
                  : (next_step[state] ?? "Unknown state."),
              }),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }) }] };
        }
      },
    },

    oracle_work_bond_expire: {
      name: "oracle_work_bond_expire",
      description:
        "Permissionless expiry for an oracle work bond that was never resolved by the oracle. " +
        "After expiry_slot, payer gets their payment back and the worker gets their stake back " +
        "(no penalty — the oracle is the missing party, not either agent). " +
        "Requires confirmation when requireApproval is enabled.",
      parameters: Type.Object({
        oracle_work_bond_address: Type.String({ description: "Base58 address of the OracleWorkBond PDA" }),
        confirmed:                Type.Optional(Type.Boolean()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const wallet = loadWallet(cfg.walletPath);
          const program = getProgram(cfg, wallet);
          const connection = new Connection(cfg.rpcUrl, "confirmed");

          const bondPk = new PublicKey(params.oracle_work_bond_address as string);
          const acc = await (program.account as any).oracleWorkBond.fetch(bondPk);
          const currentSlot = await connection.getSlot();

          if (cfg.requireApproval && !params.confirmed) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify(pendingApproval("oracle_work_bond_expire", {
                  oracle_work_bond_pda: bondPk.toBase58(),
                  expiry_slot: acc.expirySlot.toNumber(),
                  current_slot: currentSlot,
                  state: Object.keys(acc.state)[0],
                  warning: "Expiring releases escrowed funds back to payer and worker. Cannot be undone.",
                })),
              }],
            };
          }

          const sig = await (program.methods as any)
            .expireOracleWorkBond()
            .accounts({
              payer:          acc.payer,
              worker:         acc.worker,
              oracleWorkBond: bondPk,
            })
            .rpc();

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                oracle_work_bond_pda: bondPk.toBase58(),
                signature: sig,
                expired_at_slot: currentSlot,
              }),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }) }] };
        }
      },
    },

    work_bond_list: {
      name: "work_bond_list",
      description:
        "List all on-chain work bonds. Returns PendingWorker bonds (available to join) and Active bonds (in progress).",
      parameters: Type.Object({
        filter: Type.Optional(Type.Union([
          Type.Literal("pending"),
          Type.Literal("active"),
          Type.Literal("all"),
        ], { description: "Filter by state. Defaults to 'all'." })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const pluginCfg = cfg;
          const wallet = loadWallet(pluginCfg.walletPath);
          const program = getProgram(pluginCfg, wallet);
          const connection = new Connection(pluginCfg.rpcUrl, "confirmed");

          const WORK_BOND_DISCRIMINATOR = Buffer.from([210, 210, 222, 171, 179, 60, 73, 78]);
          const accounts = await connection.getProgramAccounts(program.programId, {
            filters: [{ memcmp: { offset: 0, bytes: WORK_BOND_DISCRIMINATOR.toString("base64"), encoding: "base64" } }],
          });

          const currentSlot = await connection.getSlot();
          const filter = (params.filter as string) || "all";

          const results = [];
          for (const { pubkey, account } of accounts) {
            try {
              const wb = await (program.account as any).workBond.fetch(pubkey);
              const state = Object.keys(wb.state)[0];
              if (filter === "pending" && state !== "pendingWorker") continue;
              if (filter === "active"  && state !== "active")        continue;

              results.push({
                address:      pubkey.toBase58(),
                payer:        wb.payer.toBase58(),
                worker:       wb.worker.toBase58(),
                adjudicator:  wb.adjudicator.toBase58(),
                payment:      wb.payment.toNumber(),
                worker_stake: wb.workerStake.toNumber(),
                expiry_slot:  wb.expirySlot.toNumber(),
                state,
                expired:      currentSlot >= wb.expirySlot.toNumber(),
              });
            } catch (_) {
              // skip malformed accounts
            }
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                current_slot: currentSlot,
                count: results.length,
                work_bonds: results,
              }),
            }],
          };
        } catch (e: unknown) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }) }] };
        }
      },
    },
  };
}
