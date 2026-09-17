//! shieldpool — a shielded pool for ANY Solana token.
//!
//! Fork of Privacy Cash `shieldpool` (Tornado Nova design). Changes vs upstream:
//!   * pools are permissionless: anyone can open the tree + vault for any mint (`create_pool`)
//!   * Token-2022 supported through the token interface (`transfer_checked`, transfer-fee aware,
//!     transfer-hook accounts passed as remaining accounts)
//!   * protocol fee always goes to `global_config.fee_recipient` (not bypassable)
//!   * in-pool payments (`ext_amount == 0`) may carry a relayer fee (`public_amount = -fee`)
//!   * root history widened to 250 so busy pools don't invalidate proofs after 50 txs
//! Circuits, verifying key and proof format are unchanged from upstream.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::rent::Rent;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use ark_bn254::Fr;
use ark_ff::PrimeField;
use light_hasher::Poseidon;
use spl_token_2022::extension::transfer_fee::TransferFeeConfig;
use spl_token_2022::extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions};

declare_id!("7Bts9gjMRYG577hbipnAZMuEiBWnGy4SwkqN8TjRpuVF");

pub mod errors;
pub mod groth16;
pub mod merkle_tree;
pub mod utils;

use merkle_tree::MerkleTree;

const MERKLE_TREE_HEIGHT: u8 = 26;
pub const ROOT_HISTORY_SIZE: usize = 250;

#[program]
pub mod shieldpool {
    use crate::utils::{verify_proof, VERIFYING_KEY};

    use super::*;

    /// One-time protocol setup: SOL tree + SOL vault + global config. Whoever calls it is the authority.
    pub fn initialize(ctx: Context<Initialize>, withdrawal_fee_rate: u16) -> Result<()> {
        require!(withdrawal_fee_rate <= 10000, ErrorCode::InvalidFeeRate);
        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.authority.key();
        tree_account.next_index = 0;
        tree_account.root_index = 0;
        tree_account.bump = ctx.bumps.tree_account;
        tree_account.max_deposit_amount = u64::MAX;
        tree_account.height = MERKLE_TREE_HEIGHT;
        tree_account.root_history_size = ROOT_HISTORY_SIZE as u8;
        MerkleTree::initialize::<Poseidon>(tree_account)?;

        let token_account = &mut ctx.accounts.tree_token_account;
        token_account.authority = ctx.accounts.authority.key();
        token_account.bump = ctx.bumps.tree_token_account;

        let global_config = &mut ctx.accounts.global_config;
        global_config.authority = ctx.accounts.authority.key();
        global_config.fee_recipient = ctx.accounts.authority.key();
        global_config.deposit_fee_rate = 0;
        global_config.withdrawal_fee_rate = withdrawal_fee_rate;
        global_config.fee_error_margin = 500;
        global_config.bump = ctx.bumps.global_config;
        Ok(())
    }

    /// Authority only: change fee rates and/or the protocol fee recipient.
    pub fn update_global_config(
        ctx: Context<UpdateGlobalConfig>,
        deposit_fee_rate: Option<u16>,
        withdrawal_fee_rate: Option<u16>,
        fee_error_margin: Option<u16>,
        fee_recipient: Option<Pubkey>,
    ) -> Result<()> {
        let global_config = &mut ctx.accounts.global_config;
        if let Some(v) = deposit_fee_rate {
            require!(v <= 10000, ErrorCode::InvalidFeeRate);
            global_config.deposit_fee_rate = v;
        }
        if let Some(v) = withdrawal_fee_rate {
            require!(v <= 10000, ErrorCode::InvalidFeeRate);
            global_config.withdrawal_fee_rate = v;
        }
        if let Some(v) = fee_error_margin {
            require!(v <= 10000, ErrorCode::InvalidFeeRate);
            global_config.fee_error_margin = v;
        }
        if let Some(v) = fee_recipient {
            global_config.fee_recipient = v;
        }
        Ok(())
    }

    /// Authority only: cap deposits for one pool (u64::MAX = no cap).
    pub fn update_deposit_limit(ctx: Context<UpdateDepositLimit>, new_limit: u64) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        tree_account.max_deposit_amount = new_limit;
        Ok(())
    }

    /// Permissionless: open the shielded pool (Merkle tree + vault) for any mint. Payer covers rent.
    pub fn create_pool(ctx: Context<CreatePool>) -> Result<()> {
        // Refuse mints that can never be moved out again.
        let mint_info = ctx.accounts.mint.to_account_info();
        if *mint_info.owner == spl_token_2022::ID {
            let data = mint_info.try_borrow_data()?;
            let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)
                .map_err(|_| ErrorCode::InvalidMintAddress)?;
            let exts = state.get_extension_types().map_err(|_| ErrorCode::InvalidMintAddress)?;
            require!(!exts.contains(&ExtensionType::NonTransferable), ErrorCode::UnsupportedMintExtension);
        }

        let tree_account = &mut ctx.accounts.tree_account.load_init()?;
        tree_account.authority = ctx.accounts.global_config.authority;
        tree_account.next_index = 0;
        tree_account.root_index = 0;
        tree_account.bump = ctx.bumps.tree_account;
        tree_account.max_deposit_amount = u64::MAX;
        tree_account.height = MERKLE_TREE_HEIGHT;
        tree_account.root_history_size = ROOT_HISTORY_SIZE as u8;
        MerkleTree::initialize::<Poseidon>(tree_account)?;

        emit!(PoolCreated {
            mint: ctx.accounts.mint.key(),
            token_program: ctx.accounts.token_program.key(),
            tree: ctx.accounts.tree_account.key(),
            vault: ctx.accounts.vault.key(),
            decimals: ctx.accounts.mint.decimals,
        });
        Ok(())
    }

    /// Deposit / withdraw / in-pool payment for native SOL.
    /// Reentrancy is impossible: nullifier accounts are created by Anchor before the body runs.
    pub fn transact(
        ctx: Context<Transact>,
        proof: Proof,
        ext_data_minified: ExtDataMinified,
        encrypted_output1: Vec<u8>,
        encrypted_output2: Vec<u8>,
    ) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        let global_config = &ctx.accounts.global_config;
        let ext_data = ExtData::from_minified(&ctx, ext_data_minified);

        require!(MerkleTree::is_known_root(&tree_account, proof.root), ErrorCode::UnknownRoot);

        let calculated_ext_data_hash = utils::calculate_complete_ext_data_hash(
            ext_data.recipient,
            ext_data.ext_amount,
            &encrypted_output1,
            &encrypted_output2,
            ext_data.fee,
            ext_data.fee_recipient,
            ext_data.mint_address,
        )?;
        require!(
            Fr::from_le_bytes_mod_order(&calculated_ext_data_hash) == Fr::from_be_bytes_mod_order(&proof.ext_data_hash),
            ErrorCode::ExtDataHashMismatch
        );
        require!(
            utils::check_public_amount(ext_data.ext_amount, ext_data.fee, proof.public_amount),
            ErrorCode::InvalidPublicAmountData
        );

        let ext_amount = ext_data.ext_amount;
        let fee = ext_data.fee;
        utils::validate_fee(
            ext_amount,
            fee,
            global_config.deposit_fee_rate,
            global_config.withdrawal_fee_rate,
            global_config.fee_error_margin,
        )?;
        if fee > 0 {
            require!(
                ctx.accounts.fee_recipient_account.key() == global_config.fee_recipient,
                ErrorCode::InvalidFeeRecipient
            );
        }

        require!(verify_proof(proof.clone(), VERIFYING_KEY), ErrorCode::InvalidProof);

        let tree_token_account_info = ctx.accounts.tree_token_account.to_account_info();
        let rent = Rent::get()?;
        let rent_exempt_minimum = rent.minimum_balance(tree_token_account_info.data_len());

        if ext_amount > 0 {
            let deposit_amount = ext_amount as u64;
            require!(deposit_amount <= tree_account.max_deposit_amount, ErrorCode::DepositLimitExceeded);
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.signer.to_account_info(),
                        to: ctx.accounts.tree_token_account.to_account_info(),
                    },
                ),
                deposit_amount,
            )?;
        } else if ext_amount < 0 {
            let recipient_account_info = ctx.accounts.recipient.to_account_info();
            let ext_amount_abs: u64 = ext_amount
                .checked_neg()
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .try_into()
                .map_err(|_| ErrorCode::InvalidExtAmount)?;
            let total_required = ext_amount_abs
                .checked_add(fee)
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .checked_add(rent_exempt_minimum)
                .ok_or(ErrorCode::ArithmeticOverflow)?;
            require!(tree_token_account_info.lamports() >= total_required, ErrorCode::InsufficientFundsForWithdrawal);
            let new_tree = tree_token_account_info.lamports().checked_sub(ext_amount_abs).ok_or(ErrorCode::ArithmeticOverflow)?;
            let new_recipient = recipient_account_info.lamports().checked_add(ext_amount_abs).ok_or(ErrorCode::ArithmeticOverflow)?;
            **tree_token_account_info.try_borrow_mut_lamports()? = new_tree;
            **recipient_account_info.try_borrow_mut_lamports()? = new_recipient;
        }

        if fee > 0 {
            let fee_recipient_account_info = ctx.accounts.fee_recipient_account.to_account_info();
            if ext_amount >= 0 {
                let total_required = fee.checked_add(rent_exempt_minimum).ok_or(ErrorCode::ArithmeticOverflow)?;
                require!(tree_token_account_info.lamports() >= total_required, ErrorCode::InsufficientFundsForFee);
            }
            let new_tree = tree_token_account_info.lamports().checked_sub(fee).ok_or(ErrorCode::ArithmeticOverflow)?;
            let new_fee = fee_recipient_account_info.lamports().checked_add(fee).ok_or(ErrorCode::ArithmeticOverflow)?;
            **tree_token_account_info.try_borrow_mut_lamports()? = new_tree;
            **fee_recipient_account_info.try_borrow_mut_lamports()? = new_fee;
        }

        let next_index_to_insert = tree_account.next_index;
        MerkleTree::append::<Poseidon>(proof.output_commitments[0], tree_account)?;
        MerkleTree::append::<Poseidon>(proof.output_commitments[1], tree_account)?;
        let second_index = next_index_to_insert.checked_add(1).ok_or(ErrorCode::ArithmeticOverflow)?;

        emit!(CommitmentData { index: next_index_to_insert, commitment: proof.output_commitments[0], encrypted_output: encrypted_output1 });
        emit!(CommitmentData { index: second_index, commitment: proof.output_commitments[1], encrypted_output: encrypted_output2 });
        Ok(())
    }

    /// Deposit / withdraw / in-pool payment for any SPL or Token-2022 mint.
    /// Transfer-hook mints: pass the hook program, its validation account and extra metas as remaining accounts.
    pub fn transact_spl<'info>(
        ctx: Context<'_, '_, 'info, 'info, TransactSpl<'info>>,
        proof: Proof,
        ext_data_minified: ExtDataMinified,
        encrypted_output1: Vec<u8>,
        encrypted_output2: Vec<u8>,
    ) -> Result<()> {
        let tree_account = &mut ctx.accounts.tree_account.load_mut()?;
        let global_config = &ctx.accounts.global_config;

        require!(ctx.accounts.signer_token_account.owner == ctx.accounts.signer.key(), ErrorCode::InvalidTokenAccount);
        require!(ctx.accounts.signer_token_account.mint == ctx.accounts.mint.key(), ErrorCode::InvalidTokenAccountMintAddress);

        let ext_data = ExtData::from_minified_spl(&ctx, ext_data_minified);

        require!(MerkleTree::is_known_root(&tree_account, proof.root), ErrorCode::UnknownRoot);

        let calculated_ext_data_hash = utils::calculate_complete_ext_data_hash(
            ext_data.recipient,
            ext_data.ext_amount,
            &encrypted_output1,
            &encrypted_output2,
            ext_data.fee,
            ext_data.fee_recipient,
            ext_data.mint_address,
        )?;
        require!(
            Fr::from_le_bytes_mod_order(&calculated_ext_data_hash) == Fr::from_be_bytes_mod_order(&proof.ext_data_hash),
            ErrorCode::ExtDataHashMismatch
        );
        require!(
            utils::check_public_amount(ext_data.ext_amount, ext_data.fee, proof.public_amount),
            ErrorCode::InvalidPublicAmountData
        );

        let ext_amount = ext_data.ext_amount;
        let fee = ext_data.fee;
        utils::validate_fee(
            ext_amount,
            fee,
            global_config.deposit_fee_rate,
            global_config.withdrawal_fee_rate,
            global_config.fee_error_margin,
        )?;
        if fee > 0 {
            require!(ctx.accounts.fee_recipient_ata.owner == global_config.fee_recipient, ErrorCode::InvalidFeeRecipient);
        }

        require!(verify_proof(proof.clone(), VERIFYING_KEY), ErrorCode::InvalidProof);

        let decimals = ctx.accounts.mint.decimals;
        let token_program_key = ctx.accounts.token_program.key();
        let bump = &[ctx.accounts.global_config.bump];
        let seeds: &[&[u8]] = &[b"global_config", bump];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        if ext_amount > 0 {
            let deposit_amount = ext_amount as u64;
            require!(deposit_amount <= tree_account.max_deposit_amount, ErrorCode::DepositLimitExceeded);

            // For transfer-fee mints send enough that the vault nets exactly `deposit_amount`.
            let gross = gross_for_net(&ctx.accounts.mint.to_account_info(), deposit_amount)?;
            let before = ctx.accounts.tree_ata.amount;
            move_tokens(
                &token_program_key,
                ctx.accounts.signer_token_account.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.tree_ata.to_account_info(),
                ctx.accounts.signer.to_account_info(),
                ctx.remaining_accounts,
                gross,
                decimals,
                &[],
                ctx.accounts.token_program.to_account_info(),
            )?;
            ctx.accounts.tree_ata.reload()?;
            let received = ctx.accounts.tree_ata.amount.checked_sub(before).ok_or(ErrorCode::ArithmeticOverflow)?;
            require!(received == deposit_amount, ErrorCode::DepositAmountMismatch);
        } else if ext_amount < 0 {
            let ext_amount_abs: u64 = ext_amount
                .checked_neg()
                .ok_or(ErrorCode::ArithmeticOverflow)?
                .try_into()
                .map_err(|_| ErrorCode::InvalidExtAmount)?;
            move_tokens(
                &token_program_key,
                ctx.accounts.tree_ata.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.recipient_token_account.to_account_info(),
                ctx.accounts.global_config.to_account_info(),
                ctx.remaining_accounts,
                ext_amount_abs,
                decimals,
                signer_seeds,
                ctx.accounts.token_program.to_account_info(),
            )?;
        }

        if fee > 0 {
            move_tokens(
                &token_program_key,
                ctx.accounts.tree_ata.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.fee_recipient_ata.to_account_info(),
                ctx.accounts.global_config.to_account_info(),
                ctx.remaining_accounts,
                fee,
                decimals,
                signer_seeds,
                ctx.accounts.token_program.to_account_info(),
            )?;
        }

        let next_index_to_insert = tree_account.next_index;
        MerkleTree::append::<Poseidon>(proof.output_commitments[0], tree_account)?;
        MerkleTree::append::<Poseidon>(proof.output_commitments[1], tree_account)?;
        let second_index = next_index_to_insert.checked_add(1).ok_or(ErrorCode::ArithmeticOverflow)?;

        emit!(SplCommitmentData { index: next_index_to_insert, mint_address: ext_data.mint_address, commitment: proof.output_commitments[0], encrypted_output: encrypted_output1 });
        emit!(SplCommitmentData { index: second_index, mint_address: ext_data.mint_address, commitment: proof.output_commitments[1], encrypted_output: encrypted_output2 });
        Ok(())
    }
}

/// Transfer through the token interface. Token-2022 goes through the on-chain helper so transfer hooks
/// get their extra accounts; legacy SPL uses a plain transfer_checked.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn move_tokens<'info>(
    token_program_key: &Pubkey,
    source: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    remaining_accounts: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
    token_program: AccountInfo<'info>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    if *token_program_key == spl_token_2022::ID {
        spl_token_2022::onchain::invoke_transfer_checked(
            token_program_key,
            source,
            mint,
            destination,
            authority,
            remaining_accounts,
            amount,
            decimals,
            signer_seeds,
        )
        .map_err(Into::into)
    } else {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                token_program,
                TransferChecked { from: source, mint, to: destination, authority },
                signer_seeds,
            ),
            amount,
            decimals,
        )
    }
}

/// For a Token-2022 mint with a transfer fee, the amount to send so that `net` arrives. Otherwise `net`.
#[inline(never)]
fn gross_for_net(mint_info: &AccountInfo, net: u64) -> Result<u64> {
    if *mint_info.owner != spl_token_2022::ID {
        return Ok(net);
    }
    let data = mint_info.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data).map_err(|_| ErrorCode::InvalidMintAddress)?;
    if let Ok(cfg) = state.get_extension::<TransferFeeConfig>() {
        let epoch = Clock::get()?.epoch;
        let fee = cfg.get_epoch_fee(epoch);
        return fee.calculate_pre_fee_amount(net).ok_or_else(|| ErrorCode::ArithmeticOverflow.into());
    }
    Ok(net)
}

#[event]
pub struct CommitmentData {
    pub index: u64,
    pub commitment: [u8; 32],
    pub encrypted_output: Vec<u8>,
}

#[event]
pub struct SplCommitmentData {
    pub index: u64,
    pub mint_address: Pubkey,
    pub commitment: [u8; 32],
    pub encrypted_output: Vec<u8>,
}

#[event]
pub struct PoolCreated {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub tree: Pubkey,
    pub vault: Pubkey,
    pub decimals: u8,
}

// all public inputs needs to be in big endian format
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Proof {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExtData {
    pub recipient: Pubkey,
    pub ext_amount: i64,
    pub fee: u64,
    pub fee_recipient: Pubkey,
    pub mint_address: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ExtDataMinified {
    pub ext_amount: i64,
    pub fee: u64,
}

impl ExtData {
    fn from_minified(ctx: &Context<Transact>, minified: ExtDataMinified) -> Self {
        Self {
            recipient: ctx.accounts.recipient.key(),
            ext_amount: minified.ext_amount,
            fee: minified.fee,
            fee_recipient: ctx.accounts.fee_recipient_account.key(),
            mint_address: utils::SOL_ADDRESS,
        }
    }

    fn from_minified_spl<'info>(ctx: &Context<'_, '_, 'info, 'info, TransactSpl<'info>>, minified: ExtDataMinified) -> Self {
        Self {
            recipient: ctx.accounts.recipient_token_account.key(),
            ext_amount: minified.ext_amount,
            fee: minified.fee,
            fee_recipient: ctx.accounts.fee_recipient_ata.key(),
            mint_address: ctx.accounts.mint.key(),
        }
    }
}

#[derive(Accounts)]
#[instruction(proof: Proof, ext_data_minified: ExtDataMinified, encrypted_output1: Vec<u8>, encrypted_output2: Vec<u8>)]
pub struct Transact<'info> {
    #[account(mut, seeds = [b"merkle_tree"], bump = tree_account.load()?.bump)]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    /// `init` (not `init_if_needed`): a spent nullifier fails at account creation.
    #[account(init, payer = signer, space = 8 + std::mem::size_of::<NullifierAccount>(), seeds = [b"nullifier0", proof.input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Account<'info, NullifierAccount>,
    #[account(init, payer = signer, space = 8 + std::mem::size_of::<NullifierAccount>(), seeds = [b"nullifier1", proof.input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Account<'info, NullifierAccount>,
    /// Cross-check PDAs (HashCloak ZKC-7): the same nullifier under the other prefix must not exist either.
    #[account(seeds = [b"nullifier0", proof.input_nullifiers[1].as_ref()], bump)]
    pub nullifier2: SystemAccount<'info>,
    #[account(seeds = [b"nullifier1", proof.input_nullifiers[0].as_ref()], bump)]
    pub nullifier3: SystemAccount<'info>,

    #[account(mut, seeds = [b"tree_token"], bump = tree_token_account.bump)]
    pub tree_token_account: Account<'info, TreeTokenAccount>,
    #[account(seeds = [b"global_config"], bump = global_config.bump)]
    pub global_config: Account<'info, GlobalConfig>,

    /// CHECK: withdrawals may go to any account
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: must equal global_config.fee_recipient whenever fee > 0 (checked in the handler)
    #[account(mut)]
    pub fee_recipient_account: UncheckedAccount<'info>,

    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proof: Proof, ext_data_minified: ExtDataMinified, encrypted_output1: Vec<u8>, encrypted_output2: Vec<u8>)]
pub struct TransactSpl<'info> {
    #[account(mut, seeds = [b"merkle_tree", mint.key().as_ref()], bump = tree_account.load()?.bump)]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,

    #[account(init, payer = signer, space = 8 + std::mem::size_of::<NullifierAccount>(), seeds = [b"nullifier0", proof.input_nullifiers[0].as_ref()], bump)]
    pub nullifier0: Box<Account<'info, NullifierAccount>>,
    #[account(init, payer = signer, space = 8 + std::mem::size_of::<NullifierAccount>(), seeds = [b"nullifier1", proof.input_nullifiers[1].as_ref()], bump)]
    pub nullifier1: Box<Account<'info, NullifierAccount>>,
    #[account(seeds = [b"nullifier0", proof.input_nullifiers[1].as_ref()], bump)]
    pub nullifier2: SystemAccount<'info>,
    #[account(seeds = [b"nullifier1", proof.input_nullifiers[0].as_ref()], bump)]
    pub nullifier3: SystemAccount<'info>,

    #[account(seeds = [b"global_config"], bump = global_config.bump)]
    pub global_config: Box<Account<'info, GlobalConfig>>,

    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Source for deposits (must be owned by `signer`, checked in the handler).
    #[account(mut, token::token_program = token_program)]
    pub signer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: owner of `recipient_token_account`; withdrawals may go to any wallet
    pub recipient: UncheckedAccount<'info>,

    /// Destination for withdrawals. The relayer pre-creates it so rent griefing is impossible.
    #[account(mut, token::mint = mint, token::authority = recipient, token::token_program = token_program)]
    pub recipient_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The pool vault: ATA of `global_config` for this mint.
    #[account(init_if_needed, payer = signer, associated_token::mint = mint, associated_token::authority = global_config, associated_token::token_program = token_program)]
    pub tree_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Must be owned by `global_config.fee_recipient` whenever fee > 0 (checked in the handler).
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub fee_recipient_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + std::mem::size_of::<MerkleTreeAccount>(), seeds = [b"merkle_tree"], bump)]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    #[account(init, payer = authority, space = 8 + std::mem::size_of::<TreeTokenAccount>(), seeds = [b"tree_token"], bump)]
    pub tree_token_account: Account<'info, TreeTokenAccount>,
    #[account(init, payer = authority, space = 8 + std::mem::size_of::<GlobalConfig>(), seeds = [b"global_config"], bump)]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateDepositLimit<'info> {
    #[account(mut, has_one = authority @ ErrorCode::Unauthorized)]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateGlobalConfig<'info> {
    #[account(mut, seeds = [b"global_config"], bump = global_config.bump, has_one = authority @ ErrorCode::Unauthorized)]
    pub global_config: Account<'info, GlobalConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(init, payer = payer, space = 8 + std::mem::size_of::<MerkleTreeAccount>(), seeds = [b"merkle_tree", mint.key().as_ref()], bump)]
    pub tree_account: AccountLoader<'info, MerkleTreeAccount>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(seeds = [b"global_config"], bump = global_config.bump)]
    pub global_config: Box<Account<'info, GlobalConfig>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = mint, associated_token::authority = global_config, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct TreeTokenAccount {
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
pub struct GlobalConfig {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub deposit_fee_rate: u16,    // basis points
    pub withdrawal_fee_rate: u16, // basis points
    pub fee_error_margin: u16,    // basis points
    pub bump: u8,
}

#[account]
pub struct NullifierAccount {
    pub bump: u8,
}

#[account(zero_copy)]
pub struct MerkleTreeAccount {
    pub authority: Pubkey,
    pub next_index: u64,
    pub subtrees: [[u8; 32]; MERKLE_TREE_HEIGHT as usize],
    pub root: [u8; 32],
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    pub root_index: u64,
    pub max_deposit_amount: u64,
    pub height: u8,
    pub root_history_size: u8,
    pub bump: u8,
    pub _padding: [u8; 5],
}

#[error_code]
pub enum ErrorCode {
    #[msg("Not authorized to perform this action")]
    Unauthorized,
    #[msg("External data hash does not match the one in the proof")]
    ExtDataHashMismatch,
    #[msg("Root is not known in the tree")]
    UnknownRoot,
    #[msg("Public amount is invalid")]
    InvalidPublicAmountData,
    #[msg("Insufficient funds for withdrawal")]
    InsufficientFundsForWithdrawal,
    #[msg("Insufficient funds for fee")]
    InsufficientFundsForFee,
    #[msg("Proof is invalid")]
    InvalidProof,
    #[msg("Invalid fee: fee must be less than MAX_ALLOWED_VAL (2^248).")]
    InvalidFee,
    #[msg("Invalid ext amount: absolute ext_amount must be less than MAX_ALLOWED_VAL (2^248).")]
    InvalidExtAmount,
    #[msg("Public amount calculation resulted in an overflow/underflow.")]
    PublicAmountCalculationError,
    #[msg("Arithmetic overflow/underflow occurred")]
    ArithmeticOverflow,
    #[msg("Deposit limit exceeded")]
    DepositLimitExceeded,
    #[msg("Invalid fee rate: must be between 0 and 10000 basis points")]
    InvalidFeeRate,
    #[msg("Fee recipient does not match global configuration")]
    InvalidFeeRecipient,
    #[msg("Fee amount is below minimum required")]
    InvalidFeeAmount,
    #[msg("Recipient account does not match the ExtData recipient")]
    RecipientMismatch,
    #[msg("Merkle tree is full: cannot add more leaves")]
    MerkleTreeFull,
    #[msg("Invalid token account: account is not owned by the token program")]
    InvalidTokenAccount,
    #[msg("Invalid mint address")]
    InvalidMintAddress,
    #[msg("Invalid token account mint address")]
    InvalidTokenAccountMintAddress,
    #[msg("Mint has an extension the pool cannot support (non-transferable)")]
    UnsupportedMintExtension,
    #[msg("Vault did not receive exactly the deposited amount")]
    DepositAmountMismatch,
}
