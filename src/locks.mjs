// src/locks.mjs
// The part of Souvenir's src/stake.mjs that the snapshot needs: how an account of the lock program (programs/souvenir-lock, the coin staking
// program) reads, and the getProgramAccounts filters that find one coin's locks. A wallet's snapshot amount counts the coins in its locks, and
// a lock's vault (a token account owned by the lock's address) is no wallet. Plain @solana/web3.js, no Anchor client: an account starts with
// sha256("account:Lock")[0..8].
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

const LOCK_ACCOUNT = createHash('sha256').update('account:Lock').digest().subarray(0, 8);
/** A Lock account's size: discriminator, owner, mint, amount, start, end, days, nonce, bump. */
export const LOCK_SIZE = 8 + 32 + 32 + 8 + 8 + 8 + 2 + 8 + 1;
/** Where the mint and the owner sit in a Lock account (for getProgramAccounts' memcmp). */
export const MINT_OFFSET = 8 + 32, OWNER_OFFSET = 8;
const key = k => (k instanceof PublicKey ? k : new PublicKey(k));

/** A Lock account's data, or null when it is not one: `{ owner, mint, amount: BigInt, start: ms, end: ms, days, nonce: BigInt }`. */
export function decodeLock(data) {
  const b = Buffer.from(data);
  if (b.length !== LOCK_SIZE || !b.subarray(0, 8).equals(LOCK_ACCOUNT)) return null;
  return {
    owner: new PublicKey(b.subarray(8, 40)).toBase58(), mint: new PublicKey(b.subarray(40, 72)).toBase58(), amount: b.readBigUInt64LE(72),
    start: Number(b.readBigInt64LE(80)) * 1000, end: Number(b.readBigInt64LE(88)) * 1000, days: b.readUInt16LE(96), nonce: b.readBigUInt64LE(98),
  };
}

/** The getProgramAccounts filters for one mint's locks, and with `owner` only that wallet's. */
export const lockFilters = (mint, owner = null) => [{ dataSize: LOCK_SIZE }, { memcmp: { offset: MINT_OFFSET, bytes: key(mint).toBase58() } },
  ...(owner ? [{ memcmp: { offset: OWNER_OFFSET, bytes: key(owner).toBase58() } }] : [])];
