// src/holderswap.mjs
// Souvenir's holder swap program (programs/souvenir-swap, docs/specs/2026-10-28-token-migration.md §2): its instructions as the server and
// the owner's script build them, its accounts as they read them, and the snapshot's Merkle tree. Plain @solana/web3.js, no Anchor client,
// as src/stake.mjs: an instruction is its 8-byte discriminator (sha256("global:<name>")[0..8]) and its Borsh arguments; an account starts
// with sha256("account:<Name>")[0..8]. The snapshot hashes as src/tickets.mjs does, with an amount in place of a ticket range:
//   leaf = sha256(0x00 || wallet(32) || amount(u64 LE))
//   node = sha256(0x01 || min(a,b) || max(a,b))      (sorted pairs; a node without a sibling moves up as it is)
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
} from '@solana/spl-token';
import { tree } from './merkle.mjs';

/** The program's id (its keypair is ~/.config/solana/souvenir-swap-program.json on the owner's machine). */
export const SWAP_PROGRAM_ID = '42Ft9ioktrSK4zLpnqDFgNDdFoYZHQmUhgYothhNCN6J';
export const SWAP_SEED = 'swap', RECEIPT_SEED = 'receipt';
/** pump.fun coins have 6 decimals. */
const NEW_DECIMALS = 6;

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const disc = s => sha256(Buffer.from(s)).subarray(0, 8);
const IX = { initialize: disc('global:initialize'), open: disc('global:open'), swap: disc('global:swap'), settle: disc('global:settle') };
const CONFIG_ACCOUNT = disc('account:Config'), RECEIPT_ACCOUNT = disc('account:Receipt');
/** A Config account: discriminator, admin, old mint, new mint, root, old total, new total, deadline, swapped old, old destination,
 *  unclaimed destination, opened, bump. */
const CONFIG_SIZE = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 32 + 32 + 1 + 1;
/** A Receipt account: discriminator, swapped. */
const RECEIPT_SIZE = 8 + 8;

const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const key = k => (k instanceof PublicKey ? k : new PublicKey(k));
/** 32 bytes, from a Buffer (or Uint8Array) or 64 hex characters. */
function bytes32(v) {
  const b = typeof v === 'string' ? Buffer.from(/^[0-9a-f]{64}$/i.test(v) ? v : '', 'hex') : Buffer.from(v);
  if (b.length !== 32) throw new Error('A root or proof node is 32 bytes.');
  return b;
}

/** The swap's Config account for an admin's pair of mints: the admin is in the seeds, so no other wallet can take the address first. */
export const configAddress = (programId, admin, oldMint, newMint) =>
  PublicKey.findProgramAddressSync([Buffer.from(SWAP_SEED), key(admin).toBuffer(), key(oldMint).toBuffer(), key(newMint).toBuffer()], key(programId))[0];
/** A wallet's Receipt: what it has swapped so far. */
export const receiptAddress = (programId, config, wallet) =>
  PublicKey.findProgramAddressSync([Buffer.from(RECEIPT_SEED), key(config).toBuffer(), key(wallet).toBuffer()], key(programId))[0];
/** The new-token vault: the config's associated token account, under the new mint's token program. */
export const newVaultAddress = (config, newMint, newTokenProgram) => getAssociatedTokenAddressSync(key(newMint), key(config), true, key(newTokenProgram));

/** A snapshot row's leaf. */
export const leafOf = ({ wallet, amount }) => sha256(Buffer.from([0]), key(wallet).toBuffer(), u64(amount));

/** The snapshot's tree over `rows` in the order given: `root` (a Buffer) and `proofOf(wallet)`, the sibling path of its leaf. */
export function snapshotTree(rows) {
  const index = new Map();
  rows.forEach((row, i) => {
    const wallet = key(row.wallet).toBase58();
    if (index.has(wallet)) throw new Error(`${wallet} is in the snapshot twice.`);
    index.set(wallet, i);
  });
  const { root, proof } = tree(rows.map(leafOf));
  return {
    root,
    proofOf(wallet) {
      const i = index.get(key(wallet).toBase58());
      if (i === undefined) throw new Error(`${key(wallet).toBase58()} is not in the snapshot.`);
      return proof(i);
    },
  };
}

/** `initialize(root, old_total, deadline)`: the admin makes the config and the new vault, naming both destinations (token accounts of the
 *  old and the new mint). Nothing swaps until `open`. */
export function initializeInstruction({ programId, admin, oldMint, newMint, newTokenProgram, root, oldTotal, deadline, oldDestination, unclaimedDestination }) {
  const config = configAddress(programId, admin, oldMint, newMint);
  return new TransactionInstruction({
    programId: key(programId),
    keys: [
      { pubkey: key(admin), isSigner: true, isWritable: true },
      { pubkey: key(oldMint), isSigner: false, isWritable: false },
      { pubkey: key(newMint), isSigner: false, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: newVaultAddress(config, newMint, newTokenProgram), isSigner: false, isWritable: true },
      { pubkey: key(oldDestination), isSigner: false, isWritable: false },
      { pubkey: key(unclaimedDestination), isSigner: false, isWritable: false },
      { pubkey: key(newTokenProgram), isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.initialize, bytes32(root), u64(oldTotal), i64(deadline)]),
  });
}

/** `open()`: the admin, once. The new total becomes the old total: the rate is fixed at exactly 1, whatever the vault holds. */
export function openInstruction({ programId, admin, oldMint, newMint }) {
  return new TransactionInstruction({
    programId: key(programId),
    keys: [
      { pubkey: key(admin), isSigner: true, isWritable: false },
      { pubkey: configAddress(programId, admin, oldMint, newMint), isSigner: false, isWritable: true },
    ],
    data: IX.open,
  });
}

/** `swap(amount, entitled, proof)` on `admin`'s swap: `amount` old tokens from the holder's associated account to `oldDestination`, and
 *  their worth in new tokens (as many, at 1:1) from the vault to the holder's associated account (created if missing). `entitled` and
 *  `proof` are the holder's snapshot line. The program refuses it whole (VaultShort) while the vault holds less than it pays. */
export function swapInstruction({ programId, admin, holder, oldMint, newMint, oldTokenProgram, newTokenProgram, oldDestination, amount, entitled, proof }) {
  const config = configAddress(programId, admin, oldMint, newMint);
  return new TransactionInstruction({
    programId: key(programId),
    keys: [
      { pubkey: key(holder), isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: key(oldMint), isSigner: false, isWritable: false },
      { pubkey: key(newMint), isSigner: false, isWritable: false },
      { pubkey: getAssociatedTokenAddressSync(key(oldMint), key(holder), false, key(oldTokenProgram)), isSigner: false, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(key(newMint), key(holder), false, key(newTokenProgram)), isSigner: false, isWritable: true },
      { pubkey: key(oldDestination), isSigner: false, isWritable: true },
      { pubkey: newVaultAddress(config, newMint, newTokenProgram), isSigner: false, isWritable: true },
      { pubkey: receiptAddress(programId, config, holder), isSigner: false, isWritable: true },
      { pubkey: key(oldTokenProgram), isSigner: false, isWritable: false },
      { pubkey: key(newTokenProgram), isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([IX.swap, u64(amount), u64(entitled), u32(proof.length), ...proof.map(bytes32)]),
  });
}

/** `settle()` on `admin`'s swap: anyone, after the deadline. Every new token left in the vault to `unclaimedDestination`. No signature:
 *  the sender only pays the fee. */
export function settleInstruction({ programId, admin, oldMint, newMint, newTokenProgram, unclaimedDestination }) {
  const config = configAddress(programId, admin, oldMint, newMint);
  return new TransactionInstruction({
    programId: key(programId),
    keys: [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: key(newMint), isSigner: false, isWritable: false },
      { pubkey: newVaultAddress(config, newMint, newTokenProgram), isSigner: false, isWritable: true },
      { pubkey: key(unclaimedDestination), isSigner: false, isWritable: true },
      { pubkey: key(newTokenProgram), isSigner: false, isWritable: false },
    ],
    data: IX.settle,
  });
}

/**
 * The whole opening, for one transaction the admin (the dev wallet) signs: the seller's old-token account and the dev wallet's new-token
 * account (both created if missing; they are the two destinations), `initialize`, `devBalance` new tokens from the dev wallet into the
 * vault (what the dev buy got, which may be less than the snapshot's total), and `open`.
 */
export function openInstructions({ programId, admin, oldMint, newMint, oldTokenProgram, newTokenProgram, root, oldTotal, deadline, seller, devBalance }) {
  if (!(BigInt(devBalance) > 0n)) throw new Error('Nothing to put in the vault.');
  const config = configAddress(programId, admin, oldMint, newMint);
  const oldDestination = getAssociatedTokenAddressSync(key(oldMint), key(seller), false, key(oldTokenProgram));
  const unclaimedDestination = getAssociatedTokenAddressSync(key(newMint), key(admin), false, key(newTokenProgram));
  const mints = { programId, admin, oldMint, newMint, newTokenProgram };
  return [
    createAssociatedTokenAccountIdempotentInstruction(key(admin), oldDestination, key(seller), key(oldMint), key(oldTokenProgram)),
    createAssociatedTokenAccountIdempotentInstruction(key(admin), unclaimedDestination, key(admin), key(newMint), key(newTokenProgram)),
    initializeInstruction({ ...mints, root, oldTotal, deadline, oldDestination, unclaimedDestination }),
    createTransferCheckedInstruction(unclaimedDestination, key(newMint), newVaultAddress(config, newMint, newTokenProgram), key(admin),
      BigInt(devBalance), NEW_DECIMALS, [], key(newTokenProgram)),
    openInstruction(mints),
  ];
}

/** A Config account's data, or null when it is not one. Amounts are BigInt, the deadline unix seconds, addresses base58. */
export function decodeConfig(data) {
  const b = Buffer.from(data);
  if (b.length !== CONFIG_SIZE || !b.subarray(0, 8).equals(CONFIG_ACCOUNT)) return null;
  const pk = at => new PublicKey(b.subarray(at, at + 32)).toBase58();
  return {
    admin: pk(8), oldMint: pk(40), newMint: pk(72), root: Buffer.from(b.subarray(104, 136)), oldTotal: b.readBigUInt64LE(136),
    newTotal: b.readBigUInt64LE(144), deadline: Number(b.readBigInt64LE(152)), swappedOld: b.readBigUInt64LE(160), oldDestination: pk(168),
    unclaimedDestination: pk(200), opened: b[232] === 1,
  };
}

/** A Receipt account's data, or null when it is not one: `{ swapped: BigInt }`. */
export function decodeReceipt(data) {
  const b = Buffer.from(data);
  if (b.length !== RECEIPT_SIZE || !b.subarray(0, 8).equals(RECEIPT_ACCOUNT)) return null;
  return { swapped: b.readBigUInt64LE(8) };
}
