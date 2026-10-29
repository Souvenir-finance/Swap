// src/snapshot.mjs
// The migration snapshot (docs/specs/2026-10-28-token-migration.md section 1): what each wallet held of the old coin, read from the chain,
// as the rows the swap program's Merkle root commits to. A wallet's entitlement is its token accounts plus its staking locks; the pools,
// Souvenir's own wallets and the lock program's vaults are left out (a vault's coins are credited to the lock's owner). Amounts are raw
// units (bigint, 6 decimals). The tree is src/holderswap.mjs `snapshotTree`, hashed as src/tickets.mjs.
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { snapshotTree } from './holderswap.mjs';
import { decodeLock, lockFilters } from './locks.mjs';

/** The snapshot reads at the commitment nothing is rolled back from: its root is committed on chain. */
const COMMITMENT = 'finalized';
/** A classic SPL token account: 165 bytes, the mint at offset 0, the owner at 32, the amount (u64 LE) at 64. We read offset 32, 40 bytes: owner and amount. */
const TOKEN_ACCOUNT_SIZE = 165, SLICE = { offset: 32, length: 40 };

const key = k => (k instanceof PublicKey ? k : new PublicKey(k));
/** An account's data from web3.js (a Buffer) or from a raw JSON-RPC result (`[base64, 'base64']`). */
const bytes = data => Buffer.from(Array.isArray(data) ? data[0] : data, 'base64');

const NEEDS = {
  accounts: 'the old coin\'s token accounts',
  locks: 'the lock program\'s locks of the old coin (their vaults are no wallets)',
  exclude: 'the wallets to leave out (the pools, Souvenir\'s wallets)',
};
/** Refuses a missing input: a snapshot without its exclusion list would count the pool as a wallet, one without its locks the vaults. */
function need(inputs) {
  for (const [name, value] of Object.entries(inputs)) if (!value) throw new Error(`A snapshot needs \`${name}\`: ${NEEDS[name]}.`);
}

/**
 * The snapshot's rows from what was read: `accounts` is `[{ owner, amount }]` (several per wallet are added up), `locks`
 * `[{ address, owner, amount }]` (each lock's amount is credited to its owner). `exclude` is the wallets left out (a Set or a list); so
 * are the owners of the locks' vaults (each vault is owned by its lock's address), and an excluded wallet's own locks. Zero balances are
 * dropped. Rows are `[{ wallet, amount: bigint }]`, sorted by wallet (plain string order, so `LC_ALL=C sort` on the file's wallets
 * reproduces it).
 */
export function snapshotRows({ accounts, locks, exclude }) {
  need({ accounts, locks, exclude });
  const out = new Set([...exclude].map(String)), vaults = new Set(locks.map(l => String(l.address))), sums = new Map();
  const credit = (wallet, amount) => {
    const n = BigInt(amount);
    if (n < 0n) throw new Error('A balance cannot be negative.');
    if (n > 0n && !out.has(wallet)) sums.set(wallet, (sums.get(wallet) || 0n) + n);
  };
  for (const { owner, amount } of accounts) if (!vaults.has(String(owner))) credit(String(owner), amount);
  for (const { owner, amount } of locks) credit(String(owner), amount);
  return [...sums].map(([wallet, amount]) => ({ wallet, amount })).sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
}

/** One `getProgramAccounts` read with its context: `{ slot, value }`. A node that sends no slot (or the plain list) is refused. */
async function read(rpc, program, config, what) {
  const result = await rpc.getProgramAccounts(program, { commitment: COMMITMENT, encoding: 'base64', withContext: true, ...config });
  if (!Number.isSafeInteger(result?.context?.slot) || !Array.isArray(result.value)) throw new Error(`The read of ${what} came back without its slot.`);
  return { slot: result.context.slot, value: result.value };
}

/** An old-coin token account read through the 40-byte slice: `{ owner, amount }`. A node that ignored the slice is refused (it would hand back the mint as an owner). */
function tokenAccount(data) {
  const d = bytes(data);
  if (d.length !== SLICE.length) throw new Error(`The node ignored the data slice: a token account came back as ${d.length} bytes, not ${SLICE.length}.`);
  return { owner: new PublicKey(d.subarray(0, 32)).toBase58(), amount: d.readBigUInt64LE(32) };
}

/**
 * The snapshot: the lock program's locks of the old mint, then the old mint's token accounts, then the locks again, each read with the
 * slot it was read at (src/stake.mjs `scanWithLocks` does the same for a draw). A lock unlocked while the accounts were read would leave its
 * vault, still holding coins in that read, as a wallet; one made meanwhile would be missed. So the locks of both reads count, by address:
 * every one is a vault to leave out and its amount is credited to its owner (a lock in both counts once; one that closed during the read
 * can credit its owner twice, never miss them). Still, run it when nothing is moving, as the spec has it. `rpc` is anything with web3.js's
 * `getProgramAccounts` (a Connection). `add` is balances credited by hand, `[{ owner, amount }]`, under the same rules as the accounts
 * read (the owner's `--add` of the DLMM liquidity providers). `{ oldMint, rows, slots: { locksBefore, accounts, locks }, total: bigint,
 * root: Buffer }`, `locks` being the later locks read's slot.
 */
export async function readSnapshot({ rpc, oldMint, lockProgram, exclude, add = [] }) {
  need({ exclude });
  const mint = key(oldMint).toBase58(), program = key(lockProgram);
  const readLocks = async () => {
    const found = await read(rpc, program, { filters: lockFilters(mint) }, 'the old coin\'s locks');
    return {
      slot: found.slot,
      locks: found.value.map(({ pubkey, account }) => {
        const lock = decodeLock(bytes(account.data));
        if (!lock) throw new Error(`${pubkey} is not a lock.`);
        // A lock of another coin would credit its owner coins of that coin: the read asked for the old mint's locks only, so a node that
        // answers with another's ignored the filter, and the snapshot stops.
        if (lock.mint !== mint) throw new Error(`${pubkey} is a lock of ${lock.mint}, not of ${mint}: the node ignored the mint filter.`);
        return { address: String(pubkey), owner: lock.owner, amount: lock.amount };
      }),
    };
  };
  const before = await readLocks();
  const tokens = await read(rpc, TOKEN_PROGRAM_ID, { dataSlice: SLICE, filters: [{ dataSize: TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint } }] }, 'the old coin\'s token accounts');
  const after = await readLocks();
  const locks = [...new Map([...before.locks, ...after.locks].map(lock => [lock.address, lock])).values()];
  const accounts = [...tokens.value.map(({ account }) => tokenAccount(account.data)), ...add];
  const rows = snapshotRows({ accounts, locks, exclude });
  if (!rows.length) throw new Error('Nobody holds the old coin, so the snapshot is empty.');
  return {
    oldMint: mint, rows, slots: { locksBefore: before.slot, accounts: tokens.slot, locks: after.slot },
    total: rows.reduce((sum, row) => sum + row.amount, 0n), root: snapshotTree(rows).root,
  };
}

/** The snapshot as JSON-ready data (the file the owner publishes and the server loads): amounts as decimal strings, the root as hex. */
export const snapshotFile = ({ oldMint, slots, total, root, rows }) => ({
  oldMint, slots, total: String(total), root: root.toString('hex'), rows: rows.map(({ wallet, amount }) => [wallet, String(amount)]),
});
