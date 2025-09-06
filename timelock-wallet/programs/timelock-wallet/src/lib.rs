use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

declare_id!("8LQG6U5AQKe9t97ogxMtggbr24QgUKNFz22qvVPzBYYe");

const TIME_LOCK_SEED: &[u8] = b"time-lock";
const TIME_LOCK_SOL_SEED: &[u8] = b"time-lock-sol";
const TIME_LOCK_SPL_SEED: &[u8] = b"time-lock-spl";

#[program]
pub mod timelock_wallet {
    use super::*;

    // Initialize a SOL timelock. Funds are transferred into the PDA account lamports.
    pub fn initialize_lock_sol(
        ctx: Context<InitializeLockSol>,
        amount_lamports: u64,
        unlock_timestamp: i64,
    ) -> Result<()> {
        msg!(
            "[initialize_lock_sol] amount_lamports={} unlock_timestamp={} now={}",
            amount_lamports,
            unlock_timestamp,
            Clock::get()?.unix_timestamp
        );
        msg!(
            "[initialize_lock_sol] initializer={} lock_account={} system_program={}",
            ctx.accounts.initializer.key(),
            ctx.accounts.lock_account.key(),
            ctx.accounts.system_program.key()
        );

        require!(amount_lamports > 0, TimeLockError::InvalidAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(unlock_timestamp > now, TimeLockError::UnlockInPast);

        let initializer = &ctx.accounts.initializer;
        let lock_account = &mut ctx.accounts.lock_account;

        // Persist state
        lock_account.initializer = initializer.key();
        lock_account.amount = amount_lamports;
        lock_account.unlock_timestamp = unlock_timestamp;
        lock_account.bump = ctx.bumps.lock_account;
        lock_account.kind = AssetKind::Sol;

        // SOL is transferred from the client as a separate instruction in the same transaction.
        // This avoids CPI writable privilege issues when creating and funding in one go.

        Ok(())
    }

    // Transfer SOL to lock account (separate instruction)
    pub fn fund_sol_lock(
        ctx: Context<FundSolLock>,
        amount_lamports: u64,
    ) -> Result<()> {
        // Use system program transfer với anchor's system_program interface
        let cpi_accounts = anchor_lang::system_program::Transfer {
            from: ctx.accounts.initializer.to_account_info(),
            to: ctx.accounts.lock_account.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
        anchor_lang::system_program::transfer(cpi_ctx, amount_lamports)?;
        
        Ok(())
    }

    // Withdraw SOL after unlock; closing the account returns remaining lamports to initializer
    pub fn withdraw_sol(ctx: Context<WithdrawSol>) -> Result<()> {
        let clock = Clock::get()?;
        let lock_account = &ctx.accounts.lock_account;
        require!(lock_account.kind == AssetKind::Sol, TimeLockError::WrongAssetKind);
        require!(clock.unix_timestamp >= lock_account.unlock_timestamp, TimeLockError::TimeLockNotExpired);
        // No explicit transfer needed; close = initializer will return lamports.
        Ok(())
    }

    // Initialize an SPL timelock for a given mint (e.g., USDC on devnet)
    pub fn initialize_lock_spl(
        ctx: Context<InitializeLockSpl>,
        amount: u64,
        unlock_timestamp: i64,
    ) -> Result<()> {
        require!(amount > 0, TimeLockError::InvalidAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(unlock_timestamp > now, TimeLockError::UnlockInPast);

        let initializer = &ctx.accounts.initializer;
        let lock_account = &mut ctx.accounts.lock_account;

        // Persist state
        lock_account.initializer = initializer.key();
        lock_account.amount = amount;
        lock_account.unlock_timestamp = unlock_timestamp;
        lock_account.bump = ctx.bumps.lock_account;
        lock_account.kind = AssetKind::Spl;
        lock_account.mint = Some(ctx.accounts.mint.key());

        // Transfer SPL tokens from user ATA to vault ATA with PDA signer as authority after init.
        let cpi_accounts = SplTransfer {
            from: ctx.accounts.user_ata.to_account_info(),
            to: ctx.accounts.vault_ata.to_account_info(),
            authority: initializer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    // Withdraw SPL tokens back to the user's ATA after unlock
    pub fn withdraw_spl(ctx: Context<WithdrawSpl>) -> Result<()> {
        let clock = Clock::get()?;
        let lock_account = &ctx.accounts.lock_account;
        require!(lock_account.kind == AssetKind::Spl, TimeLockError::WrongAssetKind);
        require!(clock.unix_timestamp >= lock_account.unlock_timestamp, TimeLockError::TimeLockNotExpired);

        let initializer_key = ctx.accounts.initializer.key();
        let seeds: &[&[u8]] = &[TIME_LOCK_SPL_SEED, initializer_key.as_ref(), &[lock_account.bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        // Transfer entire vault balance back to user
        let vault_balance = ctx.accounts.vault_ata.amount;
        require!(vault_balance > 0, TimeLockError::InsufficientVaultBalance);

        let cpi_accounts = SplTransfer {
            from: ctx.accounts.vault_ata.to_account_info(),
            to: ctx.accounts.user_ata.to_account_info(),
            authority: ctx.accounts.lock_account.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        // Transfer the entire vault balance, not just the stored amount
        token::transfer(cpi_ctx, vault_balance)?;

        Ok(())
    }
}

#[account]
pub struct TimeLockAccount {
    pub initializer: Pubkey,
    pub amount: u64,
    pub unlock_timestamp: i64,
    pub bump: u8,
    pub kind: AssetKind,
    pub mint: Option<Pubkey>,
}

impl TimeLockAccount {
    pub const LEN: usize = 8  // discriminator
        + 32 // initializer
        + 8  // amount
        + 8  // unlock_timestamp
        + 1  // bump
        + 1  // kind (u8)
        + 1 + 32; // Option<Pubkey>
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    Sol = 0,
    Spl = 1,
}

#[derive(Accounts)]
pub struct InitializeLockSol<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,

    #[account(
        init_if_needed,
        payer = initializer,
        space = 8 + TimeLockAccount::LEN,
        seeds = [TIME_LOCK_SOL_SEED, initializer.key().as_ref()],
        bump,
    )]
    pub lock_account: Account<'info, TimeLockAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundSolLock<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,
    #[account(
        mut,
        seeds = [TIME_LOCK_SOL_SEED, initializer.key().as_ref()],
        bump = lock_account.bump,
    )]
    pub lock_account: Account<'info, TimeLockAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,
    #[account(
        mut,
        seeds = [TIME_LOCK_SOL_SEED, initializer.key().as_ref()],
        bump = lock_account.bump,
        has_one = initializer,
        close = initializer,
    )]
    pub lock_account: Account<'info, TimeLockAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeLockSpl<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = initializer,
        space = 8 + TimeLockAccount::LEN,
        seeds = [TIME_LOCK_SPL_SEED, initializer.key().as_ref()],
        bump,
    )]
    pub lock_account: Account<'info, TimeLockAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_ata.owner == initializer.key(),
        constraint = user_ata.mint == mint.key(),
    )]
    pub user_ata: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = initializer,
        associated_token::mint = mint,
        associated_token::authority = lock_account,
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSpl<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,
    #[account(
        mut,
        seeds = [TIME_LOCK_SPL_SEED, initializer.key().as_ref()],
        bump = lock_account.bump,
        has_one = initializer,
    )]
    pub lock_account: Account<'info, TimeLockAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_ata.owner == initializer.key(),
        constraint = user_ata.mint == mint.key(),
    )]
    pub user_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_ata.owner == lock_account.key(),
        constraint = vault_ata.mint == mint.key(),
    )]
    pub vault_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum TimeLockError {
    #[msg("Time lock has not expired yet")] 
    TimeLockNotExpired,
    #[msg("Invalid amount")] 
    InvalidAmount,
    #[msg("Unlock timestamp must be in the future")] 
    UnlockInPast,
    #[msg("Missing bump")] 
    BumpMissing,
    #[msg("Incorrect asset kind for this operation")] 
    WrongAssetKind,
    #[msg("Vault balance lower than expected amount")] 
    InsufficientVaultBalance,
}