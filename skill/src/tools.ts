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
  loadPendingWagers,
  savePendingWager,
  removePendingWager,
  estimateCheckAt,
  resolveWinner,
  PendingWager,
} from "./watcher";

import { verifyWagerTransaction } from "./verify";

const CHAINLINK_PROGRAM_ID = new PublicKey(
  "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny"
);

interface PluginConfig {
  rpcUrl: string;
  walletPath: string;
  programId: string;
  storePath: string;
  idl: object;
}

function getProgram(cfg: PluginConfig, wallet: WalletAdapter): Program {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, wallet as any, {
    commitment: "confirmed",
  });
  return new Program(cfg.idl as any, provider);
}

function deriveWagerPda(
  proposerPk: PublicKey,
  counterpartyPk: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("wager"), proposerPk.toBuffer(), counterpartyPk.toBuffer()],
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
    // pact_propose
    // -----------------------------------------------------------------------
    pact_propose: {
      description:
        "Generate a Claw-DSL wager proposal and a durable-nonce transaction " +
        "pre-signed by this agent as proposer. Send the returned bundle to the counterparty.",
      parameters: Type.Object({
        counterparty: Type.String({ description: "Base58 public key of the counterparty agent" }),
        oracle_feed: Type.String({ description: "Base58 Chainlink on-chain aggregator public key" }),
        condition: Type.String({ description: "PRICE_BELOW | PRICE_ABOVE | PRICE_BETWEEN | PRICE_CHANGE_PCT" }),
        threshold: Type.Optional(Type.Number({ description: "Raw Chainlink units — for PRICE_BELOW or PRICE_ABOVE" })),
        threshold_min: Type.Optional(Type.Number({ description: "Raw Chainlink units — lower bound for PRICE_BETWEEN" })),
        threshold_max: Type.Optional(Type.Number({ description: "Raw Chainlink units — upper bound for PRICE_BETWEEN" })),
        change_pct: Type.Optional(Type.Number({ description: "Signed basis points (100 = 1%) — for PRICE_CHANGE_PCT" })),
        snapshot_price: Type.Optional(Type.Number({ description: "Reference price in raw Chainlink units — for PRICE_CHANGE_PCT" })),
        expiry_slot: Type.Number({ description: "Absolute Solana slot at which the wager is evaluated" }),
        proposer_stake: Type.Number({ description: "Lamports this agent stakes" }),
        counterparty_stake: Type.Number({ description: "Lamports required from the counterparty" }),
        nonce_account: Type.String({ description: "Base58 durable nonce account (must be owned by this agent)" }),
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
      }) => {
        try {
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

          const [wagerPda] = deriveWagerPda(proposerPk, counterpartyPk, programId);

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
            .initializeWager({
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
              wager: wagerPda,
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
            wager_pda: wagerPda.toBase58(),
            next_step:
              "Send this bundle to the counterparty. Also call pact_watch so " +
              "settlement is tracked automatically if they accept.",
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // pact_inspect
    // -----------------------------------------------------------------------
    pact_inspect: {
      description:
        "Verify that a received tx_hex was compiled from the accompanying DSL. " +
        "Always call this before pact_accept.",
      parameters: Type.Object({
        dsl: Type.Object({}, { description: "The Claw-DSL object from the proposer", additionalProperties: true }),
        tx_hex: Type.String({ description: "Hex-encoded transaction from the proposer" }),
      }),

      handler: async (args: { dsl: Record<string, unknown>; tx_hex: string }) => {
        try {
          const result = verifyWagerTransaction(args.tx_hex, args.dsl) as {
            ok: boolean;
            errors: string[];
          };

          const summary = result.ok
            ? [
                `Condition: ${args.dsl.condition} — you win as counterparty if condition is FALSE at slot ${args.dsl.expiry_slot}`,
                `Oracle feed: ${args.dsl.oracle_feed}`,
                `Proposer stakes: ${args.dsl.proposer_stake} lamports`,
                `Your stake if you accept: ${args.dsl.counterparty_stake} lamports`,
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
    // pact_accept
    // -----------------------------------------------------------------------
    pact_accept: {
      description:
        "Countersign a verified wager proposal as counterparty and submit it to Solana. " +
        "Both stakes are escrowed atomically. Only call after pact_inspect returns verified: true.",
      parameters: Type.Object({
        tx_hex: Type.String({ description: "The tx_hex from the proposer's bundle" }),
      }),

      handler: async (args: { tx_hex: string }) => {
        try {
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
            next_step:
              "Wager escrowed. Call pact_watch with the DSL to register automatic settlement.",
            explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // pact_settle
    // -----------------------------------------------------------------------
    pact_settle: {
      description:
        "Settle an expired wager. Supply the address you believe won — the program " +
        "verifies on-chain and reverts if wrong. Permissionless.",
      parameters: Type.Object({
        wager_pda: Type.String(),
        proposer: Type.String(),
        counterparty: Type.String(),
        winner: Type.String({ description: "Must be proposer or counterparty" }),
        oracle_feed: Type.String(),
      }),

      handler: async (args: {
        wager_pda: string;
        proposer: string;
        counterparty: string;
        winner: string;
        oracle_feed: string;
      }) => {
        try {
          const wallet = loadWallet(cfg.walletPath);
          const program = getProgram(cfg, wallet);

          const signature = await (program.methods as any)
            .settleWager()
            .accounts({
              wager: new PublicKey(args.wager_pda),
              proposer: new PublicKey(args.proposer),
              counterparty: new PublicKey(args.counterparty),
              winner: new PublicKey(args.winner),
              chainlinkFeed: new PublicKey(args.oracle_feed),
              chainlinkProgram: CHAINLINK_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

          removePendingWager(cfg.storePath, args.wager_pda);

          return {
            success: true,
            signature,
            winner: args.winner,
            explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // pact_watch
    // -----------------------------------------------------------------------
    pact_watch: {
      description:
        "Register a wager for automatic settlement tracking. Returns a check_at " +
        "timestamp — schedule pact_check_pending for that time.",
      parameters: Type.Object({
        dsl: Type.Object({}, { description: "The Claw-DSL object for this wager", additionalProperties: true }),
        wager_pda: Type.String({ description: "Base58 wager PDA from the proposal bundle" }),
      }),

      handler: async (args: { dsl: Record<string, unknown>; wager_pda: string }) => {
        try {
          const connection = new Connection(cfg.rpcUrl, "confirmed");
          const currentSlot = await connection.getSlot();
          const expirySlot = Number(args.dsl.expiry_slot);
          const checkAt = estimateCheckAt(currentSlot, expirySlot);

          const entry: PendingWager = {
            wager_pda: args.wager_pda,
            proposer: String(args.dsl.proposer),
            counterparty: String(args.dsl.counterparty),
            oracle_feed: String(args.dsl.oracle_feed),
            expiry_slot: expirySlot,
            registered_at: new Date().toISOString(),
          };
          savePendingWager(cfg.storePath, entry);

          const slotsRemaining = Math.max(0, expirySlot - currentSlot);

          return {
            success: true,
            registered: true,
            wager_pda: args.wager_pda,
            expiry_slot: expirySlot,
            current_slot: currentSlot,
            slots_remaining: slotsRemaining,
            check_at: checkAt.toISOString(),
            check_in_seconds: Math.ceil((checkAt.getTime() - Date.now()) / 1000),
            next_step: `Schedule pact_check_pending at ${checkAt.toISOString()}. No further action needed until then.`,
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // pact_propose_open  (single-sig; creates discoverable WagerProposal)
    // -----------------------------------------------------------------------
    pact_propose_open: {
      description:
        "Open a public wager proposal on-chain — only you sign. Your stake is " +
        "escrowed immediately. Any agent can discover and accept it via pact_capabilities " +
        "or pact_accept_proposal. One open proposal per wallet at a time.",
      parameters: Type.Object({
        oracle_feed: Type.String({ description: "Base58 Chainlink aggregator address" }),
        condition: Type.String({ description: "PRICE_BELOW | PRICE_ABOVE | PRICE_BETWEEN | PRICE_CHANGE_PCT" }),
        threshold: Type.Optional(Type.Number({ description: "Raw Chainlink units (8 dec for USD feeds; $1 = 100000000)" })),
        threshold_min: Type.Optional(Type.Number()),
        threshold_max: Type.Optional(Type.Number()),
        change_pct: Type.Optional(Type.Number({ description: "Signed basis points, e.g. 500 = +5%" })),
        snapshot_price: Type.Optional(Type.Number()),
        expiry_slot: Type.Number({ description: "Absolute Solana slot when the wager resolves" }),
        proposer_stake_sol: Type.Number({ description: "SOL you are staking" }),
        counterparty_stake_sol: Type.Number({ description: "SOL you require from whoever accepts" }),
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
      }) => {
        try {
          const wallet = loadWallet(cfg.walletPath);
          const program = getProgram(cfg, wallet);
          const programId = new PublicKey(cfg.programId);

          const [proposalPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("proposal"), wallet.publicKey.toBuffer()],
            programId
          );

          const proposerStake = Math.round(args.proposer_stake_sol * 1e9);
          const counterpartyStake = Math.round(args.counterparty_stake_sol * 1e9);

          const sig = await (program.methods as any)
            .proposeWager({
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
            signature: sig,
            condition: args.condition,
            expiry_slot: args.expiry_slot,
            proposer_stake_sol: args.proposer_stake_sol,
            counterparty_stake_sol: args.counterparty_stake_sol,
            next_step:
              "Proposal is live on-chain. Other agents will see it via pact_capabilities. " +
              "To cancel before acceptance, call pact_cancel_proposal.",
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // pact_accept_proposal
    // -----------------------------------------------------------------------
    pact_accept_proposal: {
      description:
        "Accept an open wager proposal by its on-chain address. Your stake is escrowed " +
        "atomically with the proposer's. The wager is now active and will settle at expiry.",
      parameters: Type.Object({
        proposal_address: Type.String({ description: "Base58 address of the WagerProposal account" }),
      }),

      handler: async (args: { proposal_address: string }) => {
        try {
          const wallet = loadWallet(cfg.walletPath);
          const program = getProgram(cfg, wallet);
          const programId = new PublicKey(cfg.programId);
          const connection = new Connection(cfg.rpcUrl, "confirmed");

          const proposalPk = new PublicKey(args.proposal_address);
          const proposal = await (program.account as any).wagerProposal.fetch(proposalPk);

          // Verify proposal has not expired
          const currentSlot = await connection.getSlot("confirmed");
          if (currentSlot >= proposal.expiry_slot.toNumber()) {
            return { success: false, error: `Proposal expired at slot ${proposal.expiry_slot} (current: ${currentSlot})` };
          }

          const proposerPk = proposal.proposer as PublicKey;
          const oracleFeedPk = proposal.oracle_feed as PublicKey;

          const [wagerPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("wager"), proposerPk.toBuffer(), wallet.publicKey.toBuffer()],
            programId
          );

          const sig = await (program.methods as any)
            .acceptWager()
            .accounts({
              counterparty: wallet.publicKey,
              proposal: proposalPk,
              wager: wagerPda,
              oracleFeed: oracleFeedPk,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

          // Register wager for automatic settlement
          savePendingWager(cfg.storePath, {
            wager_pda: wagerPda.toBase58(),
            proposer: proposerPk.toBase58(),
            counterparty: wallet.publicKey.toBase58(),
            oracle_feed: oracleFeedPk.toBase58(),
            expiry_slot: proposal.expiry_slot.toNumber(),
            registered_at: new Date().toISOString(),
          });

          return {
            success: true,
            wager_address: wagerPda.toBase58(),
            proposer: proposerPk.toBase58(),
            counterparty: wallet.publicKey.toBase58(),
            oracle_feed: oracleFeedPk.toBase58(),
            expiry_slot: proposal.expiry_slot.toNumber(),
            signature: sig,
            next_step:
              "Wager is active. Call pact_watch to register automatic settlement, " +
              "or pact_settle manually after expiry_slot.",
          };
        } catch (e: unknown) {
          return { success: false, error: String(e) };
        }
      },
    },

    // -----------------------------------------------------------------------
    // pact_cancel_proposal
    // -----------------------------------------------------------------------
    pact_cancel_proposal: {
      description:
        "Cancel your own open WagerProposal (before it is accepted). " +
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
            .cancelProposal()
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
    // pact_list_open
    // -----------------------------------------------------------------------
    pact_list_open: {
      description:
        "List all open WagerProposal accounts visible on-chain right now. " +
        "Returns proposals that have not yet expired or been accepted.",
      parameters: Type.Object({}),

      handler: async () => {
        try {
          const program = getProgram(cfg, loadWallet(cfg.walletPath));
          const connection = new Connection(cfg.rpcUrl, "confirmed");
          const currentSlot = await connection.getSlot("confirmed");

          const all = await (program.account as any).wagerProposal.all();
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
    // pact_capabilities  (the discovery document)
    // -----------------------------------------------------------------------
    pact_capabilities: {
      description:
        "Return the complete capabilities document for this wager protocol: how to " +
        "propose, accept, and settle wagers, what conditions are supported, risks, " +
        "and all currently open opportunities on-chain.",
      parameters: Type.Object({}),

      handler: async () => {
        try {
          const program = getProgram(cfg, loadWallet(cfg.walletPath));
          const connection = new Connection(cfg.rpcUrl, "confirmed");
          const currentSlot = await connection.getSlot("confirmed");

          const all = await (program.account as any).wagerProposal.all();
          const open = all
            .filter((p: any) => p.account.expiry_slot.toNumber() > currentSlot)
            .map((p: any) => formatProposal(p.publicKey.toBase58(), p.account, currentSlot));

          return {
            success: true,
            capabilities: {
              protocol: "clawpact",
              version: "1.0.0",
              program_id: cfg.programId,
              rpc_url: cfg.rpcUrl,
              description:
                "Permissionless, oracle-verified price wagers on Solana. " +
                "Create an open proposal with your stake escrowed on-chain — any agent can " +
                "discover and accept it. Settlement is automatic via Chainlink price feeds.",

              how_to_propose: {
                tool: "pact_propose_open",
                description:
                  "Create an open wager — your stake is escrowed immediately. " +
                  "One open proposal per wallet. Specify condition, oracle feed, expiry slot, " +
                  "and both stakes.",
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
                tool: "pact_accept_proposal",
                description:
                  "Accept any open proposal by its on-chain address. " +
                  "Your counterparty_stake is escrowed atomically. Cannot be cancelled after acceptance.",
                parameters: { proposal_address: "base58 address from open_opportunities list" },
              },

              how_to_settle: {
                tool: "pact_settle",
                description:
                  "Settle an expired wager. Permissionless — anyone can call. " +
                  "Chainlink oracle determines the winner; all escrowed SOL goes to them.",
                parameters: {
                  wager_address: "base58 wager PDA",
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
                "Stakes are locked in escrow — no early withdrawal once wager is active",
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
    // pact_check_pending
    // -----------------------------------------------------------------------
    pact_check_pending: {
      description:
        "Check all watched wagers and settle any that have passed their expiry_slot. " +
        "Called automatically by the schedule set up via pact_watch.",
      parameters: Type.Object({}),

      handler: async () => {
        try {
          const wallet = loadWallet(cfg.walletPath);
          const connection = new Connection(cfg.rpcUrl, "confirmed");
          const program = getProgram(cfg, wallet);
          const currentSlot = await connection.getSlot();
          const pending = loadPendingWagers(cfg.storePath);

          if (pending.length === 0) {
            return { success: true, message: "No pending wagers.", results: [] };
          }

          const results = [];

          for (const wager of pending) {
            // Not expired yet
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

            // Check PDA exists (wager may never have been accepted)
            const pdaInfo = await connection.getAccountInfo(new PublicKey(wager.wager_pda));
            if (!pdaInfo || pdaInfo.lamports === 0) {
              removePendingWager(cfg.storePath, wager.wager_pda);
              results.push({
                wager_pda: wager.wager_pda,
                status: "dropped",
                reason: "PDA not found — wager was never accepted or already settled",
              });
              continue;
            }

            // Resolve winner via simulation, then settle
            try {
              const winner = await resolveWinner(program, wager, CHAINLINK_PROGRAM_ID);

              const signature = await (program.methods as any)
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

              removePendingWager(cfg.storePath, wager.wager_pda);
              results.push({
                wager_pda: wager.wager_pda,
                status: "settled",
                winner,
                signature,
                explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
              });
            } catch (e: unknown) {
              results.push({
                wager_pda: wager.wager_pda,
                status: "error",
                error: String(e),
              });
            }
          }

          return {
            success: true,
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
  };
}
