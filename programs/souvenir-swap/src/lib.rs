// Souvenir's holder swap (docs/specs/2026-10-28-token-migration.md §2). Holders of the old $SOUVENIR send old tokens and get new ones at
// exactly 1:1, each wallet up to what it held at the snapshot (a Merkle root of wallet and amount). The old tokens go straight from the
// holder to the seller's account; the program never holds them. New tokens leave the vault only to swappers, or after the deadline, through
// `settle` (anyone may call it), to the dev wallet's account named at `initialize`. The root, the deadline and both destinations are set
// at `initialize`, and `open` fixes the rate at 1 whatever the vault holds; no instruction changes any of them. No admin path moves tokens.
// The vault may hold less than the snapshot (the dev buy alone, the owner, 2026-10-29): a swap it cannot pay fails whole (`VaultShort`)
// and waits until new tokens are added, which anyone can do with a plain token transfer to the vault. The program stays upgradeable
// (the owner, 2026-10-28). The old mint is classic SPL Token and the new one Token-2022 (pump.fun's create_v2); both go through the token
// interface.
// A holder may also send old tokens to the swap's deposit address (the owner, 2026-10-31: "if people send the coins to the contract, we
// send them back the token"): the old-mint account of the PDA ["deposit", config], which no key holds. The seller (the owner of the old
// destination fixed at `initialize`) then swaps them for that holder with `swap_deposited`, under the same proof, cap, deadline and vault
// checks as `swap`, or sends them back with `refund_deposit`. Both draw only from the deposit account, so nothing moves that was not sent to it.
//   leaf = sha256(0x00 || wallet(32) || amount(u64 LE))
//   node = sha256(0x01 || min(a,b) || max(a,b))      (sorted pairs; a node without a sibling moves up as it is)
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use solana_sha256_hasher::hashv;

declare_id!("42Ft9ioktrSK4zLpnqDFgNDdFoYZHQmUhgYothhNCN6J");

/// The config is ["swap", admin, old_mint, new_mint]: the admin is in the seeds, so nobody else can take a mint pair's config first.
pub const SWAP_SEED: &[u8] = b"swap";
pub const RECEIPT_SEED: &[u8] = b"receipt";
/// The deposit address is ["deposit", config]: a PDA with no data that only signs for its old-mint account.
pub const DEPOSIT_SEED: &[u8] = b"deposit";

#[program]
pub mod souvenir_swap {
    use super::*;

    /// The admin makes the config and the new vault. `old_destination` (an old-mint token account, the seller's) and
    /// `unclaimed_destination` (a new-mint token account, the dev wallet's) are the accounts passed. Nothing swaps until `open`.
    pub fn initialize(ctx: Context<Initialize>, root: [u8; 32], old_total: u64, deadline: i64) -> Result<()> {
        require!(old_total > 0, SwapError::NothingOut);
        require!(deadline > Clock::get()?.unix_timestamp, SwapError::PastDeadline);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.old_mint = ctx.accounts.old_mint.key();
        config.new_mint = ctx.accounts.new_mint.key();
        config.root = root;
        config.old_total = old_total;
        config.new_total = 0;
        config.deadline = deadline;
        config.swapped_old = 0;
        config.old_destination = ctx.accounts.old_destination.key();
        config.unclaimed_destination = ctx.accounts.unclaimed_destination.key();
        config.opened = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// The admin, once, before the deadline: the new total becomes the old total, which fixes the rate at exactly 1. The vault is not
    /// read: what it holds only decides which swaps it can pay now.
    pub fn open(ctx: Context<Open>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(!config.opened, SwapError::AlreadyOpen);
        require!(Clock::get()?.unix_timestamp < config.deadline, SwapError::PastDeadline);
        config.new_total = config.old_total;
        config.opened = true;
        emit!(Opened { new_total: config.new_total });
        Ok(())
    }

    /// Before the deadline: `amount` old tokens from the holder to the old destination, and floor(amount × new_total / old_total) new
    /// tokens (`amount` itself, at 1:1) from the vault to the holder, as long as what the holder has swapped stays within `entitled`, their
    /// snapshot line, and the vault holds them: otherwise nothing moves (`VaultShort`).
    pub fn swap(ctx: Context<Swap>, amount: u64, entitled: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        let config = &ctx.accounts.config;
        let holder = ctx.accounts.holder.key();
        let (swapped, out) = checked_swap(config, ctx.accounts.receipt.swapped, &holder, amount, entitled, &proof, ctx.accounts.new_vault.amount)?;

        token_interface::transfer_checked(
            CpiContext::new(ctx.accounts.old_token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.holder_old.to_account_info(),
                mint: ctx.accounts.old_mint.to_account_info(),
                to: ctx.accounts.old_destination.to_account_info(),
                authority: ctx.accounts.holder.to_account_info(),
            }),
            amount,
            ctx.accounts.old_mint.decimals,
        )?;
        let seeds: &[&[u8]] = &[SWAP_SEED, config.admin.as_ref(), config.old_mint.as_ref(), config.new_mint.as_ref(), &[config.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.new_token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.new_vault.to_account_info(),
                mint: ctx.accounts.new_mint.to_account_info(),
                to: ctx.accounts.holder_new.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            }, &[seeds]),
            out,
            ctx.accounts.new_mint.decimals,
        )?;

        ctx.accounts.receipt.swapped = swapped;
        let config = &mut ctx.accounts.config;
        config.swapped_old = config.swapped_old.checked_add(amount).ok_or(SwapError::Overflow)?;
        emit!(Swapped { holder, amount, out });
        Ok(())
    }

    /// Anyone, from the deadline on: every new token left in the vault to the unclaimed destination fixed at `initialize`.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(Clock::get()?.unix_timestamp >= config.deadline, SwapError::BeforeDeadline);
        let held = ctx.accounts.new_vault.amount;
        require!(held > 0, SwapError::NothingOut);
        let seeds: &[&[u8]] = &[SWAP_SEED, config.admin.as_ref(), config.old_mint.as_ref(), config.new_mint.as_ref(), &[config.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.new_token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.new_vault.to_account_info(),
                mint: ctx.accounts.new_mint.to_account_info(),
                to: ctx.accounts.unclaimed_destination.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            }, &[seeds]),
            held,
            ctx.accounts.new_mint.decimals,
        )?;
        emit!(Settled { amount: held });
        Ok(())
    }

    /// The seller, for `holder`, who sent old tokens to the deposit address instead of signing a swap: `amount` of them from the deposit
    /// account to the old destination, and their new tokens from the vault to the holder's account, under every check of `swap` (`holder`'s
    /// snapshot line and proof, the receipt's cap, the deadline, the vault). The seller pays for the holder's new-token account and receipt.
    pub fn swap_deposited(ctx: Context<SwapDeposited>, amount: u64, entitled: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        let config = &ctx.accounts.config;
        let holder = ctx.accounts.holder.key();
        let (swapped, out) = checked_swap(config, ctx.accounts.receipt.swapped, &holder, amount, entitled, &proof, ctx.accounts.new_vault.amount)?;

        let config_key = config.key();
        let deposit_seeds: &[&[u8]] = &[DEPOSIT_SEED, config_key.as_ref(), &[ctx.bumps.deposit_authority]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.old_token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.deposit.to_account_info(),
                mint: ctx.accounts.old_mint.to_account_info(),
                to: ctx.accounts.old_destination.to_account_info(),
                authority: ctx.accounts.deposit_authority.to_account_info(),
            }, &[deposit_seeds]),
            amount,
            ctx.accounts.old_mint.decimals,
        )?;
        let seeds: &[&[u8]] = &[SWAP_SEED, config.admin.as_ref(), config.old_mint.as_ref(), config.new_mint.as_ref(), &[config.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.new_token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.new_vault.to_account_info(),
                mint: ctx.accounts.new_mint.to_account_info(),
                to: ctx.accounts.holder_new.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            }, &[seeds]),
            out,
            ctx.accounts.new_mint.decimals,
        )?;

        ctx.accounts.receipt.swapped = swapped;
        let config = &mut ctx.accounts.config;
        config.swapped_old = config.swapped_old.checked_add(amount).ok_or(SwapError::Overflow)?;
        emit!(DepositSwapped { holder, amount, out });
        Ok(())
    }

    /// The seller, at any time: `amount` old tokens from the deposit account back to `to` (the sender's: one not in the snapshot, past
    /// its cap, after the deadline, or while the vault cannot pay).
    pub fn refund_deposit(ctx: Context<RefundDeposit>, amount: u64) -> Result<()> {
        require!(amount > 0, SwapError::NothingOut);
        let config_key = ctx.accounts.config.key();
        let deposit_seeds: &[&[u8]] = &[DEPOSIT_SEED, config_key.as_ref(), &[ctx.bumps.deposit_authority]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.old_token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.deposit.to_account_info(),
                mint: ctx.accounts.old_mint.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.deposit_authority.to_account_info(),
            }, &[deposit_seeds]),
            amount,
            ctx.accounts.old_mint.decimals,
        )?;
        emit!(DepositRefunded { to: ctx.accounts.to.key(), amount });
        Ok(())
    }
}

/// Every check of a swap, signed or deposited: open, before the deadline, `holder`'s snapshot line under the root, what it has swapped
/// (`already`) plus `amount` within that line, something to pay, and a vault (`vault`) that holds it. Returns the receipt's new total and
/// the new tokens paid.
fn checked_swap(config: &Config, already: u64, holder: &Pubkey, amount: u64, entitled: u64, proof: &[[u8; 32]], vault: u64) -> Result<(u64, u64)> {
    require!(config.opened, SwapError::NotOpen);
    require!(Clock::get()?.unix_timestamp < config.deadline, SwapError::PastDeadline);
    require!(root_of(leaf(holder, entitled), proof) == config.root, SwapError::BadProof);
    let swapped = already.checked_add(amount).ok_or(SwapError::OverEntitled)?;
    require!(swapped <= entitled, SwapError::OverEntitled);
    let out = u64::try_from(u128::from(amount) * u128::from(config.new_total) / u128::from(config.old_total))
        .map_err(|_| SwapError::Overflow)?;
    require!(out > 0, SwapError::NothingOut);
    require!(vault >= out, SwapError::VaultShort);
    Ok((swapped, out))
}

fn leaf(wallet: &Pubkey, amount: u64) -> [u8; 32] {
    hashv(&[&[0u8], wallet.as_ref(), &amount.to_le_bytes()]).to_bytes()
}
fn root_of(leaf: [u8; 32], proof: &[[u8; 32]]) -> [u8; 32] {
    proof.iter().fold(leaf, |node, sibling| {
        let (a, b) = if node <= *sibling { (node, *sibling) } else { (*sibling, node) };
        hashv(&[&[1u8], a.as_ref(), b.as_ref()]).to_bytes()
    })
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub old_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = new_token_program)]
    pub new_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = admin, space = 8 + Config::SPACE, seeds = [SWAP_SEED, admin.key().as_ref(), old_mint.key().as_ref(), new_mint.key().as_ref()], bump)]
    pub config: Box<Account<'info, Config>>,
    /// Anyone can create the config's associated account beforehand; that does not block `initialize`.
    #[account(init_if_needed, payer = admin, associated_token::mint = new_mint, associated_token::authority = config,
        associated_token::token_program = new_token_program)]
    pub new_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(token::mint = old_mint)]
    pub old_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(token::mint = new_mint, token::token_program = new_token_program)]
    pub unclaimed_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub new_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Open<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin, seeds = [SWAP_SEED, config.admin.as_ref(), config.old_mint.as_ref(), config.new_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(mut, has_one = old_mint, has_one = new_mint, seeds = [SWAP_SEED, config.admin.as_ref(), config.old_mint.as_ref(), config.new_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mint::token_program = old_token_program)]
    pub old_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = new_token_program)]
    pub new_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Any old-token account of the holder's (Souvenir's site sends their associated one).
    #[account(mut, token::mint = old_mint, token::authority = holder, token::token_program = old_token_program)]
    pub holder_old: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = holder, associated_token::mint = new_mint, associated_token::authority = holder,
        associated_token::token_program = new_token_program)]
    pub holder_new: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.old_destination @ SwapError::WrongDestination)]
    pub old_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = new_mint, associated_token::authority = config, associated_token::token_program = new_token_program)]
    pub new_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = holder, space = 8 + Receipt::SPACE, seeds = [RECEIPT_SEED, config.key().as_ref(), holder.key().as_ref()], bump)]
    pub receipt: Box<Account<'info, Receipt>>,
    pub old_token_program: Interface<'info, TokenInterface>,
    pub new_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(has_one = new_mint, seeds = [SWAP_SEED, config.admin.as_ref(), config.old_mint.as_ref(), config.new_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mint::token_program = new_token_program)]
    pub new_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = new_mint, associated_token::authority = config, associated_token::token_program = new_token_program)]
    pub new_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.unclaimed_destination @ SwapError::WrongDestination)]
    pub unclaimed_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub new_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SwapDeposited<'info> {
    /// The seller: the owner of the old destination fixed at `initialize`. It pays for the holder's accounts.
    #[account(mut)]
    pub operator: Signer<'info>,
    /// CHECK: the wallet the deposit is credited to: only its snapshot line (proof) is accepted, and only its own accounts are paid.
    pub holder: UncheckedAccount<'info>,
    #[account(mut, has_one = old_mint, has_one = new_mint, seeds = [SWAP_SEED, config.admin.as_ref(), config.old_mint.as_ref(), config.new_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mint::token_program = old_token_program)]
    pub old_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = new_token_program)]
    pub new_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the deposit address, a PDA with no data: it only signs for the deposit account.
    #[account(seeds = [DEPOSIT_SEED, config.key().as_ref()], bump)]
    pub deposit_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = old_mint, associated_token::authority = deposit_authority, associated_token::token_program = old_token_program)]
    pub deposit: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = operator, associated_token::mint = new_mint, associated_token::authority = holder,
        associated_token::token_program = new_token_program)]
    pub holder_new: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.old_destination @ SwapError::WrongDestination, constraint = old_destination.owner == operator.key() @ SwapError::NotOperator)]
    pub old_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = new_mint, associated_token::authority = config, associated_token::token_program = new_token_program)]
    pub new_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = operator, space = 8 + Receipt::SPACE, seeds = [RECEIPT_SEED, config.key().as_ref(), holder.key().as_ref()], bump)]
    pub receipt: Box<Account<'info, Receipt>>,
    pub old_token_program: Interface<'info, TokenInterface>,
    pub new_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundDeposit<'info> {
    /// The seller: the owner of the old destination fixed at `initialize`.
    pub operator: Signer<'info>,
    #[account(has_one = old_mint, seeds = [SWAP_SEED, config.admin.as_ref(), config.old_mint.as_ref(), config.new_mint.as_ref()], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mint::token_program = old_token_program)]
    pub old_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the deposit address, a PDA with no data: it only signs for the deposit account.
    #[account(seeds = [DEPOSIT_SEED, config.key().as_ref()], bump)]
    pub deposit_authority: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = old_mint, associated_token::authority = deposit_authority, associated_token::token_program = old_token_program)]
    pub deposit: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The sender's old-token account.
    #[account(mut, token::mint = old_mint, token::token_program = old_token_program)]
    pub to: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.old_destination @ SwapError::WrongDestination, constraint = old_destination.owner == operator.key() @ SwapError::NotOperator)]
    pub old_destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub old_token_program: Interface<'info, TokenInterface>,
}

/// One swap. Read by Souvenir's server (src/holderswap.mjs decodeConfig) and by anyone checking the swap.
#[account]
pub struct Config {
    pub admin: Pubkey,
    pub old_mint: Pubkey,
    pub new_mint: Pubkey,
    pub root: [u8; 32],
    pub old_total: u64,
    pub new_total: u64,
    pub deadline: i64,
    pub swapped_old: u64,
    pub old_destination: Pubkey,
    pub unclaimed_destination: Pubkey,
    pub opened: bool,
    pub bump: u8,
}
impl Config {
    pub const SPACE: usize = 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 32 + 32 + 1 + 1;
}

/// What one wallet has swapped so far, in old tokens.
#[account]
pub struct Receipt {
    pub swapped: u64,
}
impl Receipt {
    pub const SPACE: usize = 8;
}

#[event]
pub struct Opened { pub new_total: u64 }
#[event]
pub struct Swapped { pub holder: Pubkey, pub amount: u64, pub out: u64 }
#[event]
pub struct Settled { pub amount: u64 }
#[event]
pub struct DepositSwapped { pub holder: Pubkey, pub amount: u64, pub out: u64 }
#[event]
pub struct DepositRefunded { pub to: Pubkey, pub amount: u64 }

#[error_code]
pub enum SwapError {
    #[msg("This wallet and amount are not in the snapshot")]
    BadProof,
    #[msg("More than this wallet held at the snapshot")]
    OverEntitled,
    #[msg("The swap has ended")]
    PastDeadline,
    #[msg("The swap has not ended yet")]
    BeforeDeadline,
    #[msg("The swap is already open")]
    AlreadyOpen,
    #[msg("The swap is not open yet")]
    NotOpen,
    #[msg("Nothing would move")]
    NothingOut,
    #[msg("Not the destination fixed at initialize")]
    WrongDestination,
    #[msg("Overflow")]
    Overflow,
    #[msg("The vault holds fewer new tokens than this swap pays; it waits until the vault is topped up")]
    VaultShort,
    #[msg("Only the seller, the owner of the old destination, swaps or refunds deposits")]
    NotOperator,
}
