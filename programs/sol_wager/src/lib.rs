use anchor_lang::prelude::*;
use chainlink_solana as chainlink;

declare_id!("GJYEW4jBbBZTVNTdG2AB3EHjC39hFuWWZjaxvDUpmZ3i");

// Maximum age of a Chainlink round before it's considered stale (~1 min at 400ms/slot)
const MAX_STALENESS_SLOTS: u64 = 150;

#[program]
pub mod sol_wager {
    use super::*;

    /// Atomically initialises the wager and escrows funds from both parties.
    /// Both `proposer` and `counterparty` must be signers — use a durable-nonce
    /// transaction so the counterparty can inspect and sign asynchronously.
    pub fn initialize_wager(ctx: Context<InitializeWager>, params: WagerParams) -> Result<()> {
        params.validate()?;

        // Scope the mutable borrow so it ends before the CPI transfers below
        let (proposer_key, counterparty_key, expiry_slot) = {
            let wager = &mut ctx.accounts.wager;
            wager.proposer = ctx.accounts.proposer.key();
            wager.counterparty = ctx.accounts.counterparty.key();
            wager.oracle_feed = ctx.accounts.chainlink_feed.key();
            wager.condition = params.condition;
            wager.threshold = params.threshold;
            wager.threshold_min = params.threshold_min;
            wager.threshold_max = params.threshold_max;
            wager.change_pct = params.change_pct;
            wager.snapshot_price = params.snapshot_price;
            wager.expiry_slot = params.expiry_slot;
            wager.proposer_stake = params.proposer_stake;
            wager.counterparty_stake = params.counterparty_stake;
            wager.state = WagerState::Active;
            wager.bump = ctx.bumps.wager;
            (wager.proposer, wager.counterparty, wager.expiry_slot)
        };

        // Escrow proposer's stake into the wager PDA
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.proposer.to_account_info(),
                    to: ctx.accounts.wager.to_account_info(),
                },
            ),
            params.proposer_stake,
        )?;

        // Escrow counterparty's stake into the wager PDA
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.counterparty.to_account_info(),
                    to: ctx.accounts.wager.to_account_info(),
                },
            ),
            params.counterparty_stake,
        )?;

        emit!(WagerInitialised {
            wager: ctx.accounts.wager.key(),
            proposer: proposer_key,
            counterparty: counterparty_key,
            expiry_slot,
        });

        Ok(())
    }

    /// Creates an open wager proposal visible to all agents.
    /// Only the proposer signs; their stake is escrowed into the proposal PDA.
    /// Any counterparty can accept via accept_wager.
    pub fn propose_wager(ctx: Context<ProposeWager>, params: WagerParams) -> Result<()> {
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

        emit!(ProposalCreated {
            proposal: ctx.accounts.proposal.key(),
            proposer: proposer_key,
            expiry_slot,
        });

        Ok(())
    }

    /// Accepts an open WagerProposal as counterparty.
    /// Proposer's escrowed stake moves proposal→wager; counterparty deposits theirs.
    /// Proposal account is closed and its rent returned to the proposer.
    pub fn accept_wager(ctx: Context<AcceptWager>) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            clock.slot < ctx.accounts.proposal.expiry_slot,
            WagerError::ProposalExpired
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

        // Escrow counterparty's stake into the wager PDA.
        // The proposal's lamports (stake + rent) are moved to wager by `close = wager` below.
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.counterparty.to_account_info(),
                    to: ctx.accounts.wager.to_account_info(),
                },
            ),
            counterparty_stake,
        )?;

        {
            let wager = &mut ctx.accounts.wager;
            wager.proposer = proposer_key;
            wager.counterparty = ctx.accounts.counterparty.key();
            wager.oracle_feed = oracle_feed;
            wager.condition = condition;
            wager.threshold = threshold;
            wager.threshold_min = threshold_min;
            wager.threshold_max = threshold_max;
            wager.change_pct = change_pct;
            wager.snapshot_price = snapshot_price;
            wager.expiry_slot = expiry_slot;
            wager.proposer_stake = proposer_stake;
            wager.counterparty_stake = counterparty_stake;
            wager.state = WagerState::Active;
            wager.bump = ctx.bumps.wager;
        }

        emit!(WagerInitialised {
            wager: ctx.accounts.wager.key(),
            proposer: proposer_key,
            counterparty: ctx.accounts.counterparty.key(),
            expiry_slot,
        });

        Ok(())
        // `close = wager` moves proposal lamports (proposer_stake + rent) into the wager pot.
        // Winner takes everything including both rent deposits on settlement.
    }

    /// Cancels an open proposal and returns the escrowed stake + rent to the proposer.
    pub fn cancel_proposal(ctx: Context<CancelProposal>) -> Result<()> {
        emit!(ProposalCancelled {
            proposal: ctx.accounts.proposal.key(),
            proposer: ctx.accounts.proposer.key(),
        });
        Ok(())
        // Anchor's `close = proposer` returns all lamports (stake + rent)
    }

    /// Stores the canonical capabilities URI for this protocol in a well-known PDA.
    /// Call once after deployment so agents can discover the .well-known manifest
    /// by deriving seeds = ["meta"] from the program ID.
    pub fn register_protocol(ctx: Context<RegisterProtocol>, uri: String) -> Result<()> {
        require!(uri.len() <= ProtocolMeta::MAX_URI_LEN, WagerError::UriTooLong);
        ctx.accounts.meta.uri = uri;
        ctx.accounts.meta.bump = ctx.bumps.meta;
        Ok(())
    }

    /// Settles an expired wager by reading the Chainlink feed and sending all
    /// escrowed lamports (including rent) to the winner.
    /// Permissionless — either party may call once `expiry_slot` has passed.
    /// The caller must supply the correct `winner` account; the program verifies
    /// it matches the oracle outcome and reverts otherwise.
    pub fn settle_wager(ctx: Context<SettleWager>) -> Result<()> {
        require!(
            ctx.accounts.wager.state == WagerState::Active,
            WagerError::AlreadySettled
        );

        let clock = Clock::get()?;
        require!(
            clock.slot >= ctx.accounts.wager.expiry_slot,
            WagerError::NotExpiredYet
        );

        let round = chainlink::latest_round_data(
            ctx.accounts.chainlink_program.to_account_info(),
            ctx.accounts.chainlink_feed.to_account_info(),
        )?;

        require!(
            clock.slot <= round.slot + MAX_STALENESS_SLOTS,
            WagerError::StaleOracle
        );

        let proposer_wins = evaluate_condition(&ctx.accounts.wager, round.answer)?;

        let expected_winner = if proposer_wins {
            ctx.accounts.wager.proposer
        } else {
            ctx.accounts.wager.counterparty
        };

        require!(
            ctx.accounts.winner.key() == expected_winner,
            WagerError::WrongWinner
        );

        // Capture event data before account is closed
        let wager_key = ctx.accounts.wager.key();
        let proposer_key = ctx.accounts.wager.proposer;
        let counterparty_key = ctx.accounts.wager.counterparty;

        ctx.accounts.wager.state = WagerState::Settled;

        emit!(WagerSettled {
            wager: wager_key,
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
pub struct InitializeWager<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,

    #[account(mut)]
    pub counterparty: Signer<'info>,

    #[account(
        init,
        payer = proposer,
        space = Wager::SPACE,
        seeds = [b"wager", proposer.key().as_ref(), counterparty.key().as_ref()],
        bump
    )]
    pub wager: Account<'info, Wager>,

    /// CHECK: Chainlink aggregator feed — stored in wager.oracle_feed for later verification
    pub chainlink_feed: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleWager<'info> {
    #[account(
        mut,
        seeds = [b"wager", wager.proposer.as_ref(), wager.counterparty.as_ref()],
        bump = wager.bump,
        has_one = proposer @ WagerError::InvalidProposer,
        has_one = counterparty @ WagerError::InvalidCounterparty,
        constraint = chainlink_feed.key() == wager.oracle_feed @ WagerError::InvalidFeed,
        close = winner
    )]
    pub wager: Account<'info, Wager>,

    /// CHECK: Verified via has_one constraint against wager.proposer
    #[account(mut)]
    pub proposer: AccountInfo<'info>,

    /// CHECK: Verified via has_one constraint against wager.counterparty
    #[account(mut)]
    pub counterparty: AccountInfo<'info>,

    /// Winner receives all escrowed lamports; must match oracle outcome
    #[account(mut)]
    pub winner: SystemAccount<'info>,

    /// CHECK: Chainlink price feed — verified against wager.oracle_feed above
    pub chainlink_feed: AccountInfo<'info>,

    /// CHECK: Chainlink program
    pub chainlink_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeWager<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,

    #[account(
        init,
        payer = proposer,
        space = WagerProposal::SPACE,
        seeds = [b"proposal", proposer.key().as_ref()],
        bump
    )]
    pub proposal: Account<'info, WagerProposal>,

    /// CHECK: Chainlink aggregator feed — stored in proposal.oracle_feed
    pub oracle_feed: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptWager<'info> {
    #[account(mut)]
    pub counterparty: Signer<'info>,

    #[account(
        mut,
        seeds = [b"proposal", proposal.proposer.as_ref()],
        bump = proposal.bump,
        has_one = oracle_feed @ WagerError::InvalidFeed,
        close = wager
    )]
    pub proposal: Account<'info, WagerProposal>,

    #[account(
        init,
        payer = counterparty,
        space = Wager::SPACE,
        seeds = [b"wager", proposal.proposer.as_ref(), counterparty.key().as_ref()],
        bump
    )]
    pub wager: Account<'info, Wager>,

    /// CHECK: Chainlink feed — verified against proposal.oracle_feed via has_one
    pub oracle_feed: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelProposal<'info> {
    #[account(mut)]
    pub proposer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"proposal", proposer.key().as_ref()],
        bump = proposal.bump,
        has_one = proposer @ WagerError::InvalidProposer,
        close = proposer
    )]
    pub proposal: Account<'info, WagerProposal>,

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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct Wager {
    pub proposer: Pubkey,         // 32
    pub counterparty: Pubkey,     // 32
    pub oracle_feed: Pubkey,      // 32
    pub condition: WagerCondition, // 1
    pub threshold: i128,          // 16  (raw Chainlink answer units)
    pub threshold_min: i128,      // 16
    pub threshold_max: i128,      // 16
    pub change_pct: i32,          // 4   (basis points; signed — positive=up, negative=down)
    pub snapshot_price: i128,     // 16  (reference price for PRICE_CHANGE_PCT)
    pub expiry_slot: u64,         // 8
    pub proposer_stake: u64,      // 8   (lamports)
    pub counterparty_stake: u64,  // 8
    pub state: WagerState,        // 1
    pub bump: u8,                 // 1
}

impl Wager {
    // 8 discriminator + field sizes above
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

/// An open, single-signature wager proposal.  Any agent can accept it.
#[account]
pub struct WagerProposal {
    pub proposer: Pubkey,          // 32
    pub oracle_feed: Pubkey,       // 32
    pub condition: WagerCondition, // 1
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

impl WagerProposal {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 16 + 16 + 16 + 4 + 16 + 8 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum WagerCondition {
    PriceBelow,      // proposer wins if price < threshold at expiry
    PriceAbove,      // proposer wins if price > threshold at expiry
    PriceBetween,    // proposer wins if threshold_min <= price <= threshold_max
    PriceChangePct,  // proposer wins if pct change from snapshot >= change_pct (bps)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum WagerState {
    Active,
    Settled,
}

// ---------------------------------------------------------------------------
// Instruction params (Borsh-encoded; forms the basis of the verification hash)
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct WagerParams {
    pub condition: WagerCondition,
    pub threshold: i128,
    pub threshold_min: i128,
    pub threshold_max: i128,
    pub change_pct: i32,
    pub snapshot_price: i128,
    pub expiry_slot: u64,
    pub proposer_stake: u64,
    pub counterparty_stake: u64,
}

impl WagerParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.proposer_stake > 0, WagerError::ZeroStake);
        require!(self.counterparty_stake > 0, WagerError::ZeroStake);
        require!(self.expiry_slot > 0, WagerError::InvalidExpiry);

        if matches!(self.condition, WagerCondition::PriceBetween) {
            require!(
                self.threshold_min < self.threshold_max,
                WagerError::InvalidBand
            );
        }

        if matches!(self.condition, WagerCondition::PriceChangePct) {
            require!(self.snapshot_price != 0, WagerError::InvalidSnapshot);
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct WagerInitialised {
    pub wager: Pubkey,
    pub proposer: Pubkey,
    pub counterparty: Pubkey,
    pub expiry_slot: u64,
}

#[event]
pub struct ProposalCreated {
    pub proposal: Pubkey,
    pub proposer: Pubkey,
    pub expiry_slot: u64,
}

#[event]
pub struct ProposalCancelled {
    pub proposal: Pubkey,
    pub proposer: Pubkey,
}

#[event]
pub struct WagerSettled {
    pub wager: Pubkey,
    pub proposer: Pubkey,
    pub counterparty: Pubkey,
    pub proposer_wins: bool,
    pub final_price: i128,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum WagerError {
    #[msg("Wager has already been settled")]
    AlreadySettled,
    #[msg("Expiry slot has not been reached yet")]
    NotExpiredYet,
    #[msg("Oracle round data is stale")]
    StaleOracle,
    #[msg("Winner account does not match oracle outcome")]
    WrongWinner,
    #[msg("Proposer account does not match wager")]
    InvalidProposer,
    #[msg("Counterparty account does not match wager")]
    InvalidCounterparty,
    #[msg("Oracle feed account does not match wager")]
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn evaluate_condition(wager: &Wager, current_price: i128) -> Result<bool> {
    match wager.condition {
        WagerCondition::PriceBelow => Ok(current_price < wager.threshold),
        WagerCondition::PriceAbove => Ok(current_price > wager.threshold),
        WagerCondition::PriceBetween => Ok(
            current_price >= wager.threshold_min && current_price <= wager.threshold_max,
        ),
        WagerCondition::PriceChangePct => {
            let diff = current_price
                .checked_sub(wager.snapshot_price)
                .ok_or(WagerError::MathOverflow)?;
            let bps = diff
                .checked_mul(10_000)
                .ok_or(WagerError::MathOverflow)?
                .checked_div(wager.snapshot_price)
                .ok_or(WagerError::MathOverflow)?;
            Ok(bps >= wager.change_pct as i128)
        }
    }
}
