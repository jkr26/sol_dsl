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
