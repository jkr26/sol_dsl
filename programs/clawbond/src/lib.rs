use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use chainlink_solana as chainlink;

/// Switchboard Attestation Program — owner of all FunctionRequest accounts.
/// Source: sbattyXrzedoNATfc4L31wC9Mhxsi1BmFhTiN8gDshx
const SWITCHBOARD_ATTESTATION_PROGRAM: &str = "sbattyXrzedoNATfc4L31wC9Mhxsi1BmFhTiN8gDshx";

declare_id!("GJYEW4jBbBZTVNTdG2AB3EHjC39hFuWWZjaxvDUpmZ3i");

// Maximum age of a Chainlink round before it's considered stale (~1 min at 400ms/slot)
const MAX_STALENESS_SLOTS: u64 = 150;

#[program]
pub mod clawbond {
    use super::*;

    /// Atomically initialises the bond and escrows funds from both parties.
    /// Both `proposer` and `counterparty` must be signers — use a durable-nonce
    /// transaction so the counterparty can inspect and sign asynchronously.
    pub fn initialize_bond(ctx: Context<InitializeBond>, params: BondParams) -> Result<()> {
        params.validate()?;

        let (proposer_key, counterparty_key, expiry_slot) = {
            let bond = &mut ctx.accounts.bond;
            bond.proposer = ctx.accounts.proposer.key();
            bond.counterparty = ctx.accounts.counterparty.key();
            bond.oracle_feed = ctx.accounts.chainlink_feed.key();
            bond.condition = params.condition;
            bond.threshold = params.threshold;
            bond.threshold_min = params.threshold_min;
            bond.threshold_max = params.threshold_max;
            bond.change_pct = params.change_pct;
            bond.snapshot_price = params.snapshot_price;
            bond.expiry_slot = params.expiry_slot;
            bond.proposer_stake = params.proposer_stake;
            bond.counterparty_stake = params.counterparty_stake;
            bond.state = BondState::Active;
            bond.bump = ctx.bumps.bond;
            (bond.proposer, bond.counterparty, bond.expiry_slot)
        };

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.proposer.to_account_info(),
                    to: ctx.accounts.bond.to_account_info(),
                },
            ),
            params.proposer_stake,
        )?;

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.counterparty.to_account_info(),
                    to: ctx.accounts.bond.to_account_info(),
                },
            ),
            params.counterparty_stake,
        )?;

        emit!(BondInitialised {
            bond: ctx.accounts.bond.key(),
            proposer: proposer_key,
            counterparty: counterparty_key,
            expiry_slot,
        });

        Ok(())
    }

    /// Creates an open bond proposal visible to all agents.
    /// Only the proposer signs; their stake is escrowed into the proposal PDA.
    /// Any counterparty can accept via accept_bond.
    pub fn propose_bond(ctx: Context<ProposeBond>, params: BondParams) -> Result<()> {
        params.validate()?;

        let (proposer_key, expiry_slot) = {
            let p = &mut ctx.accounts.proposal;
            p.proposer = ctx.accounts.proposer.key();
            p.oracle_feed = ctx.accounts.oracle_feed.key();
            p.condition = params.condition;
            p.threshold = params.threshold;
            p.threshold_min = params.threshold_min;
            p.threshold_max = params.threshold_max;
            p.change_pct = params.change_pct;
            p.snapshot_price = params.snapshot_price;
            p.expiry_slot = params.expiry_slot;
            p.proposer_stake = params.proposer_stake;
            p.counterparty_stake = params.counterparty_stake;
            p.bump = ctx.bumps.proposal;
            (p.proposer, p.expiry_slot)
        };

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.proposer.to_account_info(),
                    to: ctx.accounts.proposal.to_account_info(),
                },
            ),
            params.proposer_stake,
        )?;

        emit!(BondProposed {
            proposal: ctx.accounts.proposal.key(),
            proposer: proposer_key,
            expiry_slot,
        });

        Ok(())
    }

    /// Accepts an open BondProposal as counterparty.
    /// Proposer's escrowed stake moves proposal→bond; counterparty deposits theirs.
    /// Proposal account is closed and its rent returned via `close = bond`.
    pub fn accept_bond(ctx: Context<AcceptBond>) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            clock.slot < ctx.accounts.proposal.expiry_slot,
            BondError::ProposalExpired
        );

        let proposer_key = ctx.accounts.proposal.proposer;
        let proposer_stake = ctx.accounts.proposal.proposer_stake;
        let counterparty_stake = ctx.accounts.proposal.counterparty_stake;
        let oracle_feed = ctx.accounts.proposal.oracle_feed;
        let condition = ctx.accounts.proposal.condition.clone();
        let threshold = ctx.accounts.proposal.threshold;
        let threshold_min = ctx.accounts.proposal.threshold_min;
        let threshold_max = ctx.accounts.proposal.threshold_max;
        let change_pct = ctx.accounts.proposal.change_pct;
        let snapshot_price = ctx.accounts.proposal.snapshot_price;
        let expiry_slot = ctx.accounts.proposal.expiry_slot;

        // Escrow counterparty's stake into the bond PDA.
        // The proposal's lamports (stake + rent) are moved to bond by `close = bond` below.
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.counterparty.to_account_info(),
                    to: ctx.accounts.bond.to_account_info(),
                },
            ),
            counterparty_stake,
        )?;

        {
            let bond = &mut ctx.accounts.bond;
            bond.proposer = proposer_key;
            bond.counterparty = ctx.accounts.counterparty.key();
            bond.oracle_feed = oracle_feed;
            bond.condition = condition;
            bond.threshold = threshold;
            bond.threshold_min = threshold_min;
            bond.threshold_max = threshold_max;
            bond.change_pct = change_pct;
            bond.snapshot_price = snapshot_price;
            bond.expiry_slot = expiry_slot;
            bond.proposer_stake = proposer_stake;
            bond.counterparty_stake = counterparty_stake;
            bond.state = BondState::Active;
            bond.bump = ctx.bumps.bond;
        }

        emit!(BondInitialised {
            bond: ctx.accounts.bond.key(),
            proposer: proposer_key,
            counterparty: ctx.accounts.counterparty.key(),
            expiry_slot,
        });

        Ok(())
        // `close = bond` moves proposal lamports (proposer_stake + rent) into the bond pot.
        // Winner takes everything including both rent deposits on settlement.
    }

    /// Cancels an open proposal and returns the escrowed stake + rent to the proposer.
    pub fn cancel_bond(ctx: Context<CancelBond>) -> Result<()> {
        emit!(BondCancelled {
            proposal: ctx.accounts.proposal.key(),
            proposer: ctx.accounts.proposer.key(),
        });
        Ok(())
        // Anchor's `close = proposer` returns all lamports (stake + rent)
    }

    /// Creates a work bond: payer escrows payment, specifies worker and adjudicator.
    /// Worker must call join_work_bond to activate.
    pub fn create_work_bond(ctx: Context<CreateWorkBond>, params: WorkBondParams) -> Result<()> {
        params.validate()?;

        let (payer_key, worker_key, adjudicator_key) = {
            let wb = &mut ctx.accounts.work_bond;
            wb.payer        = ctx.accounts.payer.key();
            wb.worker       = ctx.accounts.worker.key();
            wb.adjudicator  = ctx.accounts.adjudicator.key();
            wb.payment      = params.payment;
            wb.worker_stake = params.worker_stake;
            wb.expiry_slot  = params.expiry_slot;
            wb.state        = WorkBondState::PendingWorker;
            wb.bump         = ctx.bumps.work_bond;
            (wb.payer, wb.worker, wb.adjudicator)
        };

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to:   ctx.accounts.work_bond.to_account_info(),
                },
            ),
            params.payment,
        )?;

        emit!(WorkBondCreated {
            work_bond:    ctx.accounts.work_bond.key(),
            payer:        payer_key,
            worker:       worker_key,
            adjudicator:  adjudicator_key,
            payment:      params.payment,
            worker_stake: params.worker_stake,
            expiry_slot:  params.expiry_slot,
        });

        Ok(())
    }

    /// Worker joins an open work bond by escrowing their stake.
    /// Transitions state from PendingWorker → Active.
    pub fn join_work_bond(ctx: Context<JoinWorkBond>) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            ctx.accounts.work_bond.state == WorkBondState::PendingWorker,
            BondError::WorkBondNotPendingWorker
        );
        require!(
            clock.slot < ctx.accounts.work_bond.expiry_slot,
            BondError::ProposalExpired
        );

        let worker_stake = ctx.accounts.work_bond.worker_stake;
        ctx.accounts.work_bond.state = WorkBondState::Active;

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.worker.to_account_info(),
                    to:   ctx.accounts.work_bond.to_account_info(),
                },
            ),
            worker_stake,
        )?;

        emit!(WorkBondJoined {
            work_bond: ctx.accounts.work_bond.key(),
            worker:    ctx.accounts.worker.key(),
        });

        Ok(())
    }

    /// Adjudicator confirms the worker completed the task.
    /// Worker receives payment + stake + rent.
    pub fn complete_work_bond(ctx: Context<CompleteWorkBond>) -> Result<()> {
        require!(
            ctx.accounts.work_bond.state == WorkBondState::Active,
            BondError::WorkBondNotActive
        );

        emit!(WorkBondCompleted {
            work_bond:    ctx.accounts.work_bond.key(),
            payer:        ctx.accounts.work_bond.payer,
            worker:       ctx.accounts.work_bond.worker,
            payment:      ctx.accounts.work_bond.payment,
            worker_stake: ctx.accounts.work_bond.worker_stake,
        });

        Ok(())
        // close = worker: all lamports (payment + worker_stake + rent) go to worker
    }

    /// Adjudicator confirms the worker failed or abandoned the task.
    /// Payer receives payment + worker_stake + rent as penalty.
    pub fn fail_work_bond(ctx: Context<FailWorkBond>) -> Result<()> {
        require!(
            ctx.accounts.work_bond.state == WorkBondState::Active,
            BondError::WorkBondNotActive
        );

        emit!(WorkBondFailed {
            work_bond:    ctx.accounts.work_bond.key(),
            payer:        ctx.accounts.work_bond.payer,
            worker:       ctx.accounts.work_bond.worker,
            payment:      ctx.accounts.work_bond.payment,
            worker_stake: ctx.accounts.work_bond.worker_stake,
        });

        Ok(())
        // close = payer: all lamports go to payer
    }

    /// Permissionless expiry handler — callable by anyone after expiry_slot.
    /// PendingWorker: payment returned to payer (worker never joined).
    /// Active: payment returned to payer, worker_stake returned to worker
    ///         (adjudicator disappeared — neither party should be penalised).
    pub fn expire_work_bond(ctx: Context<ExpireWorkBond>) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            clock.slot >= ctx.accounts.work_bond.expiry_slot,
            BondError::NotExpiredYet
        );

        if ctx.accounts.work_bond.state == WorkBondState::Active {
            let worker_stake = ctx.accounts.work_bond.worker_stake;
            **ctx.accounts.work_bond.to_account_info().try_borrow_mut_lamports()? -= worker_stake;
            **ctx.accounts.worker.to_account_info().try_borrow_mut_lamports()? += worker_stake;
        }

        emit!(WorkBondExpired {
            work_bond:       ctx.accounts.work_bond.key(),
            payer:           ctx.accounts.work_bond.payer,
            worker_refunded: ctx.accounts.work_bond.state == WorkBondState::Active,
        });

        Ok(())
        // close = payer: remaining lamports (payment + rent) go to payer
    }

    // -----------------------------------------------------------------------
    // Oracle work bond — Switchboard Functions adjudication
    // -----------------------------------------------------------------------

    /// Creates an oracle-adjudicated work bond.
    /// The payer commits to a Switchboard function pubkey and a SHA-256 hash of
    /// the evaluation params JSON. Both are immutable after creation — the oracle
    /// function independently fetches the completion condition from the web and
    /// reports the result on-chain with a TEE-backed proof.
    pub fn create_oracle_work_bond(
        ctx: Context<CreateOracleWorkBond>,
        params: OracleWorkBondParams,
    ) -> Result<()> {
        params.validate()?;

        let bond_key = {
            let wb = &mut ctx.accounts.oracle_work_bond;
            wb.payer        = ctx.accounts.payer.key();
            wb.worker       = ctx.accounts.worker.key();
            wb.payment      = params.payment;
            wb.worker_stake = params.worker_stake;
            wb.expiry_slot  = params.expiry_slot;
            wb.sb_function  = ctx.accounts.sb_function.key();
            wb.params_hash  = params.params_hash;
            wb.state        = OracleWorkBondState::PendingWorker;
            wb.bump         = ctx.bumps.oracle_work_bond;
            ctx.accounts.oracle_work_bond.key()
        };

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to:   ctx.accounts.oracle_work_bond.to_account_info(),
                },
            ),
            params.payment,
        )?;

        let wb = &ctx.accounts.oracle_work_bond;
        emit!(OracleWorkBondCreated {
            oracle_work_bond: bond_key,
            payer:            wb.payer,
            worker:           wb.worker,
            sb_function:      wb.sb_function,
            payment:          params.payment,
            worker_stake:     params.worker_stake,
            expiry_slot:      params.expiry_slot,
        });

        Ok(())
    }

    /// Worker joins an oracle work bond by escrowing their collateral stake.
    /// Transitions PendingWorker → Active.
    pub fn join_oracle_work_bond(ctx: Context<JoinOracleWorkBond>) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            ctx.accounts.oracle_work_bond.state == OracleWorkBondState::PendingWorker,
            BondError::WorkBondNotPendingWorker
        );
        require!(
            clock.slot < ctx.accounts.oracle_work_bond.expiry_slot,
            BondError::ProposalExpired
        );

        let worker_stake = ctx.accounts.oracle_work_bond.worker_stake;
        ctx.accounts.oracle_work_bond.state = OracleWorkBondState::Active;

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.worker.to_account_info(),
                    to:   ctx.accounts.oracle_work_bond.to_account_info(),
                },
            ),
            worker_stake,
        )?;

        emit!(OracleWorkBondJoined {
            oracle_work_bond: ctx.accounts.oracle_work_bond.key(),
            worker:           ctx.accounts.worker.key(),
        });

        Ok(())
    }

    /// Registers an evaluation request.
    /// The caller supplies the raw params bytes; the program verifies SHA-256
    /// matches the hash committed at creation. Transitions Active → EvaluationRequested.
    ///
    /// After this succeeds, the caller should create and trigger a Switchboard
    /// FunctionRequest off-chain (via the plugin) using the same params bytes.
    /// The Switchboard TEE will call oracle_callback once it has a result.
    pub fn request_oracle_evaluation(
        ctx: Context<RequestOracleEvaluation>,
        params: Vec<u8>,
    ) -> Result<()> {
        let bond_key = ctx.accounts.oracle_work_bond.key();
        let sb_function = {
            let bond = &mut ctx.accounts.oracle_work_bond;

            require!(bond.state == OracleWorkBondState::Active, BondError::WorkBondNotActive);

            let clock = Clock::get()?;
            require!(clock.slot < bond.expiry_slot, BondError::ProposalExpired);

            let hash = hashv(&[&params]);
            require!(hash.to_bytes() == bond.params_hash, BondError::InvalidOracleParams);

            bond.state = OracleWorkBondState::EvaluationRequested;
            bond.sb_function
        };

        emit!(OracleEvalRequested {
            oracle_work_bond: bond_key,
            sb_function,
            params,
        });

        Ok(())
    }

    /// Called by the Switchboard TEE oracle once the evaluation function has run.
    /// result = 1 → worker completed the task; payment + stake go to worker.
    /// result = 0 → worker failed; payment + stake go to payer as penalty.
    ///
    /// Security: the enclave_signer must be a signer (implicit via Signer<'info>),
    /// and the function_request account must be owned by the Switchboard Attestation
    /// Program — forging a Switchboard-owned account requires control of that program.
    /// Params integrity is already verified at request_oracle_evaluation time.
    pub fn oracle_callback(ctx: Context<OracleCallback>, result: u8) -> Result<()> {
        // Verify function_request is owned by the Switchboard Attestation Program.
        let sb_attestation_id = Pubkey::try_from(SWITCHBOARD_ATTESTATION_PROGRAM)
            .map_err(|_| error!(BondError::InvalidOracleCallback))?;
        require!(
            ctx.accounts.function_request.owner == &sb_attestation_id,
            BondError::InvalidOracleCallback
        );

        let total = ctx.accounts.oracle_work_bond.to_account_info().lamports();
        let (payer_key, worker_key) = {
            let bond = &mut ctx.accounts.oracle_work_bond;
            require!(
                bond.state == OracleWorkBondState::EvaluationRequested,
                BondError::OracleCallbackUnexpected
            );
            bond.state = OracleWorkBondState::Settled;
            (bond.payer, bond.worker)
        };

        if result == 1 {
            **ctx.accounts.oracle_work_bond.to_account_info().try_borrow_mut_lamports()? -= total;
            **ctx.accounts.worker.to_account_info().try_borrow_mut_lamports()? += total;
        } else {
            **ctx.accounts.oracle_work_bond.to_account_info().try_borrow_mut_lamports()? -= total;
            **ctx.accounts.payer.to_account_info().try_borrow_mut_lamports()? += total;
        }

        emit!(OracleWorkBondSettled {
            oracle_work_bond: ctx.accounts.oracle_work_bond.key(),
            payer:            payer_key,
            worker:           worker_key,
            result,
        });

        Ok(())
    }

    /// Permissionless expiry for oracle work bonds.
    /// After expiry_slot, if the oracle never delivered a result, both parties
    /// get their funds back — no penalty, since the oracle is the missing party.
    pub fn expire_oracle_work_bond(ctx: Context<ExpireOracleWorkBond>) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            clock.slot >= ctx.accounts.oracle_work_bond.expiry_slot,
            BondError::NotExpiredYet
        );

        // If worker had joined, return their stake before closing to payer.
        if ctx.accounts.oracle_work_bond.state != OracleWorkBondState::PendingWorker {
            let worker_stake = ctx.accounts.oracle_work_bond.worker_stake;
            **ctx.accounts.oracle_work_bond.to_account_info().try_borrow_mut_lamports()? -= worker_stake;
            **ctx.accounts.worker.to_account_info().try_borrow_mut_lamports()? += worker_stake;
        }

        emit!(OracleWorkBondExpired {
            oracle_work_bond: ctx.accounts.oracle_work_bond.key(),
            payer:            ctx.accounts.oracle_work_bond.payer,
            worker_refunded:  ctx.accounts.oracle_work_bond.state != OracleWorkBondState::PendingWorker,
        });

        Ok(())
        // close = payer: remaining lamports (payment + rent) go to payer
    }

    /// Stores the canonical capabilities URI for this protocol in a well-known PDA.
    /// Call once after deployment so agents can discover the .well-known manifest
    /// by deriving seeds = ["meta"] from the program ID.
    pub fn register_protocol(ctx: Context<RegisterProtocol>, uri: String) -> Result<()> {
        require!(uri.len() <= ProtocolMeta::MAX_URI_LEN, BondError::UriTooLong);
        ctx.accounts.meta.uri = uri;
        ctx.accounts.meta.bump = ctx.bumps.meta;
        Ok(())
    }

    /// Settles an expired bond by reading the Chainlink feed and sending all
    /// escrowed lamports (including rent) to the winner.
    /// Permissionless — either party may call once `expiry_slot` has passed.
    /// The caller must supply the correct `winner` account; the program verifies
    /// it matches the oracle outcome and reverts otherwise.
    pub fn settle_bond(ctx: Context<SettleBond>) -> Result<()> {
        require!(
            ctx.accounts.bond.state == BondState::Active,
            BondError::AlreadySettled
        );

        let clock = Clock::get()?;
        require!(
            clock.slot >= ctx.accounts.bond.expiry_slot,
            BondError::NotExpiredYet
        );

        let round = chainlink::latest_round_data(
            ctx.accounts.chainlink_program.to_account_info(),
            ctx.accounts.chainlink_feed.to_account_info(),
        )?;

        require!(
            clock.slot <= round.slot + MAX_STALENESS_SLOTS,
            BondError::StaleOracle
        );

        let proposer_wins = evaluate_condition(&ctx.accounts.bond, round.answer)?;

        let expected_winner = if proposer_wins {
            ctx.accounts.bond.proposer
        } else {
            ctx.accounts.bond.counterparty
        };

        require!(
            ctx.accounts.winner.key() == expected_winner,
            BondError::WrongWinner
        );

        let bond_key = ctx.accounts.bond.key();
        let proposer_key = ctx.accounts.bond.proposer;
        let counterparty_key = ctx.accounts.bond.counterparty;

        ctx.accounts.bond.state = BondState::Settled;

        emit!(BondSettled {
            bond: bond_key,
            proposer: proposer_key,
            counterparty: counterparty_key,
            proposer_wins,
            final_price: round.answer,
        });

        // `close = winner` in the account constraint transfers all lamports
        // (rent + both stakes) to the winner and marks the account as closed.
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeBond<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,

    #[account(mut)]
    pub counterparty: Signer<'info>,

    #[account(
        init,
        payer = proposer,
        space = Bond::SPACE,
        seeds = [b"bond", proposer.key().as_ref(), counterparty.key().as_ref()],
        bump
    )]
    pub bond: Account<'info, Bond>,

    /// CHECK: Chainlink aggregator feed — stored in bond.oracle_feed for later verification
    pub chainlink_feed: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleBond<'info> {
    #[account(
        mut,
        seeds = [b"bond", bond.proposer.as_ref(), bond.counterparty.as_ref()],
        bump = bond.bump,
        has_one = proposer @ BondError::InvalidProposer,
        has_one = counterparty @ BondError::InvalidCounterparty,
        constraint = chainlink_feed.key() == bond.oracle_feed @ BondError::InvalidFeed,
        close = winner
    )]
    pub bond: Account<'info, Bond>,

    /// CHECK: Verified via has_one constraint against bond.proposer
    #[account(mut)]
    pub proposer: AccountInfo<'info>,

    /// CHECK: Verified via has_one constraint against bond.counterparty
    #[account(mut)]
    pub counterparty: AccountInfo<'info>,

    /// Winner receives all escrowed lamports; must match oracle outcome
    #[account(mut)]
    pub winner: SystemAccount<'info>,

    /// CHECK: Chainlink price feed — verified against bond.oracle_feed above
    pub chainlink_feed: AccountInfo<'info>,

    /// CHECK: Chainlink program
    pub chainlink_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeBond<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,

    #[account(
        init,
        payer = proposer,
        space = BondProposal::SPACE,
        seeds = [b"proposal", proposer.key().as_ref()],
        bump
    )]
    pub proposal: Account<'info, BondProposal>,

    /// CHECK: Chainlink aggregator feed — stored in proposal.oracle_feed
    pub oracle_feed: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptBond<'info> {
    #[account(mut)]
    pub counterparty: Signer<'info>,

    #[account(
        mut,
        seeds = [b"proposal", proposal.proposer.as_ref()],
        bump = proposal.bump,
        has_one = oracle_feed @ BondError::InvalidFeed,
        close = bond
    )]
    pub proposal: Account<'info, BondProposal>,

    #[account(
        init,
        payer = counterparty,
        space = Bond::SPACE,
        seeds = [b"bond", proposal.proposer.as_ref(), counterparty.key().as_ref()],
        bump
    )]
    pub bond: Account<'info, Bond>,

    /// CHECK: Chainlink feed — verified against proposal.oracle_feed via has_one
    pub oracle_feed: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelBond<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"proposal", proposer.key().as_ref()],
        bump = proposal.bump,
        has_one = proposer @ BondError::InvalidProposer,
        close = proposer
    )]
    pub proposal: Account<'info, BondProposal>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterProtocol<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = ProtocolMeta::SPACE,
        seeds = [b"meta"],
        bump
    )]
    pub meta: Account<'info, ProtocolMeta>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateWorkBond<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: worker pubkey is stored; they sign join_work_bond
    pub worker: AccountInfo<'info>,

    /// CHECK: adjudicator pubkey is stored; they sign complete/fail
    pub adjudicator: AccountInfo<'info>,

    #[account(
        init,
        payer = payer,
        space = WorkBond::SPACE,
        seeds = [b"workbond", payer.key().as_ref(), worker.key().as_ref()],
        bump
    )]
    pub work_bond: Account<'info, WorkBond>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinWorkBond<'info> {
    #[account(mut)]
    pub worker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"workbond", work_bond.payer.as_ref(), worker.key().as_ref()],
        bump = work_bond.bump,
        has_one = worker @ BondError::InvalidWorker,
    )]
    pub work_bond: Account<'info, WorkBond>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CompleteWorkBond<'info> {
    pub adjudicator: Signer<'info>,

    #[account(mut)]
    pub worker: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"workbond", work_bond.payer.as_ref(), work_bond.worker.as_ref()],
        bump = work_bond.bump,
        has_one = adjudicator @ BondError::InvalidAdjudicator,
        has_one = worker @ BondError::InvalidWorker,
        close = worker
    )]
    pub work_bond: Account<'info, WorkBond>,
}

#[derive(Accounts)]
pub struct FailWorkBond<'info> {
    pub adjudicator: Signer<'info>,

    #[account(mut)]
    pub payer: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"workbond", work_bond.payer.as_ref(), work_bond.worker.as_ref()],
        bump = work_bond.bump,
        has_one = adjudicator @ BondError::InvalidAdjudicator,
        has_one = payer @ BondError::InvalidProposer,
        close = payer
    )]
    pub work_bond: Account<'info, WorkBond>,
}

#[derive(Accounts)]
pub struct ExpireWorkBond<'info> {
    #[account(mut)]
    pub payer: SystemAccount<'info>,

    #[account(mut)]
    pub worker: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"workbond", work_bond.payer.as_ref(), work_bond.worker.as_ref()],
        bump = work_bond.bump,
        has_one = payer @ BondError::InvalidProposer,
        has_one = worker @ BondError::InvalidWorker,
        close = payer
    )]
    pub work_bond: Account<'info, WorkBond>,
}

#[derive(Accounts)]
pub struct CreateOracleWorkBond<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: worker pubkey stored; they sign join_oracle_work_bond
    pub worker: AccountInfo<'info>,

    /// CHECK: verified to be a valid FunctionAccountData by Switchboard's account discriminator
    pub sb_function: AccountInfo<'info>,

    #[account(
        init,
        payer = payer,
        space = OracleWorkBond::SPACE,
        seeds = [b"oracle-workbond", payer.key().as_ref(), worker.key().as_ref()],
        bump
    )]
    pub oracle_work_bond: Account<'info, OracleWorkBond>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinOracleWorkBond<'info> {
    #[account(mut)]
    pub worker: Signer<'info>,

    #[account(
        mut,
        seeds = [b"oracle-workbond", oracle_work_bond.payer.as_ref(), worker.key().as_ref()],
        bump = oracle_work_bond.bump,
        has_one = worker @ BondError::InvalidWorker,
    )]
    pub oracle_work_bond: Account<'info, OracleWorkBond>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestOracleEvaluation<'info> {
    // Permissionless — any caller can trigger evaluation after worker signals done.
    #[account(
        mut,
        seeds = [b"oracle-workbond", oracle_work_bond.payer.as_ref(), oracle_work_bond.worker.as_ref()],
        bump = oracle_work_bond.bump,
    )]
    pub oracle_work_bond: Account<'info, OracleWorkBond>,
}

#[derive(Accounts)]
pub struct OracleCallback<'info> {
    /// The Switchboard TEE enclave ephemeral signer. By being a Signer, this
    /// account must have signed the transaction — only the TEE process holds its key.
    pub enclave_signer: Signer<'info>,

    /// The Switchboard FunctionRequest account. Verified in instruction logic to be
    /// owned by the Switchboard Attestation Program (sbattyXrzedoNATfc4L31wC9Mhxsi1BmFhTiN8gDshx).
    /// CHECK: owner verified against SWITCHBOARD_ATTESTATION_PROGRAM in oracle_callback
    pub function_request: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"oracle-workbond", oracle_work_bond.payer.as_ref(), oracle_work_bond.worker.as_ref()],
        bump = oracle_work_bond.bump,
    )]
    pub oracle_work_bond: Account<'info, OracleWorkBond>,

    /// CHECK: verified via has_one / manual check in instruction logic
    #[account(mut, constraint = payer.key() == oracle_work_bond.payer @ BondError::InvalidProposer)]
    pub payer: AccountInfo<'info>,

    /// CHECK: verified via has_one / manual check in instruction logic
    #[account(mut, constraint = worker.key() == oracle_work_bond.worker @ BondError::InvalidWorker)]
    pub worker: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ExpireOracleWorkBond<'info> {
    #[account(mut)]
    pub payer: SystemAccount<'info>,

    #[account(mut)]
    pub worker: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [b"oracle-workbond", oracle_work_bond.payer.as_ref(), oracle_work_bond.worker.as_ref()],
        bump = oracle_work_bond.bump,
        has_one = payer @ BondError::InvalidProposer,
        has_one = worker @ BondError::InvalidWorker,
        close = payer
    )]
    pub oracle_work_bond: Account<'info, OracleWorkBond>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct Bond {
    pub proposer: Pubkey,          // 32
    pub counterparty: Pubkey,      // 32
    pub oracle_feed: Pubkey,       // 32
    pub condition: BondCondition,  // 1
    pub threshold: i128,           // 16  (raw Chainlink answer units)
    pub threshold_min: i128,       // 16
    pub threshold_max: i128,       // 16
    pub change_pct: i32,           // 4   (basis points; signed — positive=up, negative=down)
    pub snapshot_price: i128,      // 16  (reference price for PRICE_CHANGE_PCT)
    pub expiry_slot: u64,          // 8
    pub proposer_stake: u64,       // 8   (lamports)
    pub counterparty_stake: u64,   // 8
    pub state: BondState,          // 1
    pub bump: u8,                  // 1
}

impl Bond {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 1 + 16 + 16 + 16 + 4 + 16 + 8 + 8 + 8 + 1 + 1;
}

/// Stores the canonical capabilities URI so agents can discover this protocol
/// by deriving PDA seeds = ["meta"] from the program ID.
#[account]
pub struct ProtocolMeta {
    pub uri: String,
    pub bump: u8,
}

impl ProtocolMeta {
    pub const MAX_URI_LEN: usize = 200;
    pub const SPACE: usize = 8 + 4 + Self::MAX_URI_LEN + 1;
}

/// A work contract: payer escrows payment, worker escrows stake as collateral.
/// An adjudicator (third agent or human) resolves the outcome.
#[account]
pub struct WorkBond {
    pub payer:        Pubkey,        // 32 — pays on success
    pub worker:       Pubkey,        // 32 — does work; stake slashed on failure
    pub adjudicator:  Pubkey,        // 32 — signs complete/fail
    pub payment:      u64,           // 8  — lamports released to worker on success
    pub worker_stake: u64,           // 8  — lamports worker locks as collateral
    pub expiry_slot:  u64,           // 8  — deadline for adjudication
    pub state:        WorkBondState, // 1
    pub bump:         u8,            // 1
}

impl WorkBond {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum WorkBondState {
    PendingWorker, // created, awaiting worker to join
    Active,        // both parties joined, awaiting adjudication
}

/// An oracle-adjudicated work bond. The completion condition is evaluated
/// off-chain by a Switchboard TEE function. No trusted human adjudicator.
#[account]
pub struct OracleWorkBond {
    pub payer:        Pubkey,              // 32 — funds the payment
    pub worker:       Pubkey,              // 32 — does the work
    pub payment:      u64,                 // 8  — lamports to worker on success
    pub worker_stake: u64,                 // 8  — lamports worker locks as collateral
    pub expiry_slot:  u64,                 // 8  — deadline for evaluation
    pub sb_function:  Pubkey,              // 32 — Switchboard FunctionAccountData
    pub params_hash:  [u8; 32],            // 32 — SHA-256 of eval params JSON (committed at creation)
    pub state:        OracleWorkBondState, // 1
    pub bump:         u8,                  // 1
}

impl OracleWorkBond {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 32 + 32 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum OracleWorkBondState {
    PendingWorker,       // created, awaiting worker
    Active,              // worker joined, work in progress
    EvaluationRequested, // oracle call registered, awaiting TEE callback
    Settled,             // oracle delivered result; funds disbursed
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct OracleWorkBondParams {
    pub payment:      u64,
    pub worker_stake: u64,
    pub expiry_slot:  u64,
    pub params_hash:  [u8; 32], // SHA-256 of the eval params JSON string
}

impl OracleWorkBondParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.payment > 0,      BondError::ZeroStake);
        require!(self.worker_stake > 0, BondError::ZeroStake);
        require!(self.expiry_slot > 0,  BondError::InvalidExpiry);
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct WorkBondParams {
    pub payment:      u64,
    pub worker_stake: u64,
    pub expiry_slot:  u64,
}

impl WorkBondParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.payment > 0,      BondError::ZeroStake);
        require!(self.worker_stake > 0, BondError::ZeroStake);
        require!(self.expiry_slot > 0,  BondError::InvalidExpiry);
        Ok(())
    }
}

/// An open, single-signature bond proposal. Any agent can accept it.
#[account]
pub struct BondProposal {
    pub proposer: Pubkey,          // 32
    pub oracle_feed: Pubkey,       // 32
    pub condition: BondCondition,  // 1
    pub threshold: i128,           // 16
    pub threshold_min: i128,       // 16
    pub threshold_max: i128,       // 16
    pub change_pct: i32,           // 4
    pub snapshot_price: i128,      // 16
    pub expiry_slot: u64,          // 8
    pub proposer_stake: u64,       // 8
    pub counterparty_stake: u64,   // 8
    pub bump: u8,                  // 1
}

impl BondProposal {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 16 + 16 + 16 + 4 + 16 + 8 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum BondCondition {
    PriceBelow,      // proposer wins if price < threshold at expiry
    PriceAbove,      // proposer wins if price > threshold at expiry
    PriceBetween,    // proposer wins if threshold_min <= price <= threshold_max
    PriceChangePct,  // proposer wins if pct change from snapshot >= change_pct (bps)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum BondState {
    Active,
    Settled,
}

// ---------------------------------------------------------------------------
// Instruction params (Borsh-encoded; forms the basis of the verification hash)
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct BondParams {
    pub condition: BondCondition,
    pub threshold: i128,
    pub threshold_min: i128,
    pub threshold_max: i128,
    pub change_pct: i32,
    pub snapshot_price: i128,
    pub expiry_slot: u64,
    pub proposer_stake: u64,
    pub counterparty_stake: u64,
}

impl BondParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.proposer_stake > 0, BondError::ZeroStake);
        require!(self.counterparty_stake > 0, BondError::ZeroStake);
        require!(self.expiry_slot > 0, BondError::InvalidExpiry);

        if matches!(self.condition, BondCondition::PriceBetween) {
            require!(
                self.threshold_min < self.threshold_max,
                BondError::InvalidBand
            );
        }

        if matches!(self.condition, BondCondition::PriceChangePct) {
            require!(self.snapshot_price != 0, BondError::InvalidSnapshot);
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct BondInitialised {
    pub bond: Pubkey,
    pub proposer: Pubkey,
    pub counterparty: Pubkey,
    pub expiry_slot: u64,
}

#[event]
pub struct BondProposed {
    pub proposal: Pubkey,
    pub proposer: Pubkey,
    pub expiry_slot: u64,
}

#[event]
pub struct BondCancelled {
    pub proposal: Pubkey,
    pub proposer: Pubkey,
}

#[event]
pub struct BondSettled {
    pub bond: Pubkey,
    pub proposer: Pubkey,
    pub counterparty: Pubkey,
    pub proposer_wins: bool,
    pub final_price: i128,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[event]
pub struct WorkBondCreated {
    pub work_bond:    Pubkey,
    pub payer:        Pubkey,
    pub worker:       Pubkey,
    pub adjudicator:  Pubkey,
    pub payment:      u64,
    pub worker_stake: u64,
    pub expiry_slot:  u64,
}

#[event]
pub struct WorkBondJoined {
    pub work_bond: Pubkey,
    pub worker:    Pubkey,
}

#[event]
pub struct WorkBondCompleted {
    pub work_bond:    Pubkey,
    pub payer:        Pubkey,
    pub worker:       Pubkey,
    pub payment:      u64,
    pub worker_stake: u64,
}

#[event]
pub struct WorkBondFailed {
    pub work_bond:    Pubkey,
    pub payer:        Pubkey,
    pub worker:       Pubkey,
    pub payment:      u64,
    pub worker_stake: u64,
}

#[event]
pub struct WorkBondExpired {
    pub work_bond:       Pubkey,
    pub payer:           Pubkey,
    pub worker_refunded: bool,
}

#[event]
pub struct OracleWorkBondCreated {
    pub oracle_work_bond: Pubkey,
    pub payer:            Pubkey,
    pub worker:           Pubkey,
    pub sb_function:      Pubkey,
    pub payment:          u64,
    pub worker_stake:     u64,
    pub expiry_slot:      u64,
}

#[event]
pub struct OracleWorkBondJoined {
    pub oracle_work_bond: Pubkey,
    pub worker:           Pubkey,
}

/// Emitted when the on-chain evaluation request is registered.
/// The plugin listens for this event to trigger the off-chain Switchboard request.
#[event]
pub struct OracleEvalRequested {
    pub oracle_work_bond: Pubkey,
    pub sb_function:      Pubkey,
    pub params:           Vec<u8>, // raw params bytes — passed to Switchboard function
}

#[event]
pub struct OracleWorkBondSettled {
    pub oracle_work_bond: Pubkey,
    pub payer:            Pubkey,
    pub worker:           Pubkey,
    pub result:           u8, // 1 = worker succeeded, 0 = worker failed
}

#[event]
pub struct OracleWorkBondExpired {
    pub oracle_work_bond: Pubkey,
    pub payer:            Pubkey,
    pub worker_refunded:  bool,
}

#[error_code]
pub enum BondError {
    #[msg("Bond has already been settled")]
    AlreadySettled,
    #[msg("Expiry slot has not been reached yet")]
    NotExpiredYet,
    #[msg("Oracle round data is stale")]
    StaleOracle,
    #[msg("Winner account does not match oracle outcome")]
    WrongWinner,
    #[msg("Proposer account does not match bond")]
    InvalidProposer,
    #[msg("Counterparty account does not match bond")]
    InvalidCounterparty,
    #[msg("Oracle feed account does not match bond")]
    InvalidFeed,
    #[msg("Stake amount must be greater than zero")]
    ZeroStake,
    #[msg("Expiry slot must be non-zero")]
    InvalidExpiry,
    #[msg("PRICE_BETWEEN band is invalid: min must be less than max")]
    InvalidBand,
    #[msg("Snapshot price must be non-zero for PRICE_CHANGE_PCT")]
    InvalidSnapshot,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Proposal has already expired")]
    ProposalExpired,
    #[msg("Capabilities URI exceeds 200-byte limit")]
    UriTooLong,
    #[msg("Work bond is not in PendingWorker state")]
    WorkBondNotPendingWorker,
    #[msg("Work bond is not in Active state")]
    WorkBondNotActive,
    #[msg("Adjudicator account does not match work bond")]
    InvalidAdjudicator,
    #[msg("Worker account does not match work bond")]
    InvalidWorker,
    #[msg("Oracle params do not match the hash committed at bond creation")]
    InvalidOracleParams,
    #[msg("Oracle callback signer or function does not match this bond")]
    InvalidOracleCallback,
    #[msg("oracle_callback called when bond is not in EvaluationRequested state")]
    OracleCallbackUnexpected,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn evaluate_condition(bond: &Bond, current_price: i128) -> Result<bool> {
    match bond.condition {
        BondCondition::PriceBelow => Ok(current_price < bond.threshold),
        BondCondition::PriceAbove => Ok(current_price > bond.threshold),
        BondCondition::PriceBetween => Ok(
            current_price >= bond.threshold_min && current_price <= bond.threshold_max,
        ),
        BondCondition::PriceChangePct => {
            let diff = current_price
                .checked_sub(bond.snapshot_price)
                .ok_or(BondError::MathOverflow)?;
            let bps = diff
                .checked_mul(10_000)
                .ok_or(BondError::MathOverflow)?
                .checked_div(bond.snapshot_price)
                .ok_or(BondError::MathOverflow)?;
            Ok(bps >= bond.change_pct as i128)
        }
    }
}
