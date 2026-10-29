// scripts/migration.mjs
// The owner's side of the token migration (docs/specs/2026-10-28-token-migration.md), run on the owner's own machine. Three commands:
//
//   node scripts/migration.mjs snapshot --rpc <url> --out <dir> [--team a,b,c] [--add wallet:amount,...] [--exclude a,b,c]
//     Right before the new coin launches: what every wallet holds of the old coin (token accounts plus staking locks) as snapshot.json (the
//     file the server loads) and snapshot.csv (the same rows to read), with the Merkle root, the total and the slots it was read at.
//   node scripts/migration.mjs open --rpc <url> --keypair <path> --snapshot <dir>/snapshot.json --new-mint <mint> --seller <address> [--yes]
//   node scripts/migration.mjs open --rpc <url> --admin <address> --phantom --snapshot <dir>/snapshot.json --new-mint <mint> --seller <address> [--yes]
//     Right after it: opens the swap from the dev wallet. Every new token the dev wallet holds (the dev buy's) goes into the vault, and the
//     program fixes the rate at exactly 1:1 whatever the vault holds; it prints how much of the snapshot the vault covers. A swap the vault
//     cannot pay waits until the vault is topped up (`topup`). Without --yes it only prints the opening and simulates it (--dry-run says the
//     same); with --yes it sends the transaction. A swap that already exists is reported, never opened twice.
//   node scripts/migration.mjs topup --rpc <url> --keypair <path> --new-mint <mint> --amount <whole tokens> [--yes]
//   node scripts/migration.mjs topup --rpc <url> --admin <address> --phantom --new-mint <mint> --amount <whole tokens> [--yes]
//     Later, if the vault runs low (the keeper's alarm migration_vault_low): moves --amount new tokens from the dev wallet into the vault, one
//     plain token transfer, and prints the vault's new balance and coverage. It refuses a swap that is not open or past its deadline.
//     The dev wallet signs from a keypair file (--keypair) or in Phantom (--phantom, the wallet's address as --admin; Souvenir's treasury, whose
//     key never leaves Phantom). With --phantom --yes the script serves a page on this machine (127.0.0.1, a random path) where Phantom signs and
//     sends the transaction; the page sends the signature back, and the script checks the result exactly as it does after sending it itself.
//
// Nothing here reads .env (it holds production secret keys): Souvenir's wallets and the incinerator are listed below, --exclude adds more.
// The dev wallet that signs `open` and `topup` is the swap's admin: the keypair file's own address, or with --phantom the --admin address, which
// only a signature by that wallet's key can open a swap for.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TokenAccountNotFoundError, createTransferCheckedInstruction, decodeTransferCheckedInstruction, getAccount,
  getAssociatedTokenAddressSync, getMint,
} from '@solana/spl-token';
import { readSnapshot, snapshotFile } from '../src/snapshot.mjs';
import { SWAP_PROGRAM_ID, configAddress, decodeConfig, newVaultAddress, openInstructions, snapshotTree } from '../src/holderswap.mjs';

/** $SOUVENIR, the old coin (SPL Token), and the lock program its staking locks live in. */
export const OLD_MINT = '6VsnbKz6erJRTPiiD34Msq7eWmmgZHDnh4Bxan4MpGjm';
export const LOCK_PROGRAM = 'B98ymkitewbYK4UxXH9cLscdUr59c7qyixEeZK1LacxP';
/** The swap closes at this unix time (2027-02-15 00:00 UTC). */
export const DEADLINE = 1802649600;
/** The old coin's two pools. Their balances are liquidity, no holders': a snapshot that counted them would give the pool's coins to nobody. */
export const POOLS = ['HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC', 'EiCR1fuipdPcTzfakdxXZXNXKQ4jLW7WTSe3wNmvmbKR'];
/** Souvenir's fee, payout and treasury wallets. */
export const SOUVENIR_WALLETS = [
  '6pdsnYdpLyrWGSSucaZBui9izxQ7Ubg7bYesa8RQbZ7X', '5QvWRsrghBRDSJyEpqipoewtjedkLuxBvGSYxg6bTbyF', 'ME3pEst3tfpeLPk2DK6r6DB1pK8cw7dVX5D81xijQWW',
];
/** The incinerator: tokens sent there are gone, and nobody can sign for it (the site's holder scans leave it out too). */
export const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
/** Both coins have 6 decimals (the swap program and `openInstructions` assume it); 1:1 in raw units is then 1:1 in tokens. */
const DECIMALS = 6, UNIT = 10n ** 6n;
/** How long `open --phantom --yes` (and `topup`'s) waits for the page to send back a signed transaction before it stops. */
export const SIGNING_TIMEOUT_MS = 10 * 60_000;

export class UsageError extends Error {}

const USAGE = `usage:
  node scripts/migration.mjs snapshot --rpc <url> --out <dir> [--team a,b,c] [--add wallet:amount,...] [--exclude a,b,c]
  node scripts/migration.mjs open --rpc <url> --keypair <path> --snapshot <dir>/snapshot.json --new-mint <mint> --seller <address> [--yes]
  node scripts/migration.mjs open --rpc <url> --admin <address> --phantom --snapshot <dir>/snapshot.json --new-mint <mint> --seller <address> [--yes]
  node scripts/migration.mjs topup --rpc <url> --keypair <path> --new-mint <mint> --amount <whole tokens> [--yes]
  node scripts/migration.mjs topup --rpc <url> --admin <address> --phantom --new-mint <mint> --amount <whole tokens> [--yes]
  --yes      open and topup send the transaction only with this; without it they print it, simulate it and send nothing (--dry-run says the same)
  --phantom  the dev wallet (--admin, its address) signs in Phantom: with --yes, the script serves a page on 127.0.0.1 to approve it in Phantom
  --amount   topup: the new tokens to move from the dev wallet into the vault, in whole tokens (not raw units)
  --exclude  more wallets to leave out of the snapshot (pass the seller); the pools, Souvenir's wallets and the incinerator are always left out
  --team     wallets to label "team" in snapshot.csv and the summary; they swap like anyone
  --add      credits by hand, wallet:amount, the amount in raw units (6 decimals: 1.5 tokens is 1500000), for liquidity providers
  --old-mint, --lock-program   for rehearsals on another cluster; default to the real ones`;

const OPTIONS = {
  rpc: { type: 'string' }, out: { type: 'string' }, team: { type: 'string' }, add: { type: 'string' }, exclude: { type: 'string' },
  'old-mint': { type: 'string' }, 'lock-program': { type: 'string' }, keypair: { type: 'string' }, snapshot: { type: 'string' },
  'new-mint': { type: 'string' }, seller: { type: 'string' }, 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, admin: { type: 'string' },
  phantom: { type: 'boolean' }, amount: { type: 'string' },
};
/** The options each command takes: the required ones, then the optional ones. */
const COMMANDS = {
  snapshot: { required: ['rpc', 'out'], optional: ['team', 'add', 'exclude', 'old-mint', 'lock-program'] },
  open: { required: ['rpc', 'snapshot', 'new-mint', 'seller'], optional: ['keypair', 'admin', 'phantom', 'old-mint', 'dry-run', 'yes'] },
  topup: { required: ['rpc', 'new-mint', 'amount'], optional: ['keypair', 'admin', 'phantom', 'old-mint', 'dry-run', 'yes'] },
};

/** The command and its options from the command line, or a UsageError naming what is wrong. */
export function parseCli(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); } catch (error) { throw new UsageError(error.message); }
  const [command, ...extra] = parsed.positionals;
  if (!Object.hasOwn(COMMANDS, command ?? '')) throw new UsageError(command ? `Unknown command ${command}.` : 'Say which command: snapshot, open or topup.');
  if (extra.length) throw new UsageError(`Unexpected ${extra.join(' ')}.`);
  const { required, optional } = COMMANDS[command], values = parsed.values;
  for (const name of Object.keys(values)) if (!required.includes(name) && !optional.includes(name)) throw new UsageError(`--${name} is not an option of ${command}.`);
  for (const name of required) if (!values[name]) throw new UsageError(`${command} needs --${name}.`);
  if (values.yes && values['dry-run']) throw new UsageError('--yes sends and --dry-run does not: pass one of them.');
  if (command !== 'snapshot') {
    // The dev wallet signs from a keypair file, whose own address is the admin, or in Phantom, as the address given.
    if (values.phantom && values.keypair) throw new UsageError('--phantom signs in Phantom and --keypair from a file: pass one of them.');
    if (values.phantom && !values.admin) throw new UsageError('--phantom needs --admin, the dev wallet\'s address.');
    if (!values.phantom && values.admin) throw new UsageError('--admin goes with --phantom; with --keypair the admin is the keypair file\'s own address.');
    if (!values.phantom && !values.keypair) throw new UsageError(`${command} needs --keypair, or --phantom with --admin.`);
  }
  return { command, options: values };
}

/** One address, as base58. */
export function parseWallet(text, what) {
  try { return new PublicKey(String(text).trim()).toBase58(); } catch { throw new UsageError(`${what} "${text}" is not an address.`); }
}
/** A comma-separated list of addresses, as base58. */
export const parseWallets = (text, flag) => String(text ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => parseWallet(s, flag));

/** `--add wallet:amount,...` as `[{ owner, amount: bigint }]`. The amount is raw units, whole and above zero: a decimal point is refused, so 1.5 tokens cannot pass as 1. */
export function parseAdd(text) {
  return String(text ?? '').split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const [wallet, amount, ...more] = entry.split(':');
    if (!wallet || !amount || more.length) throw new UsageError(`--add "${entry}" is not wallet:amount.`);
    if (!/^\d+$/.test(amount) || BigInt(amount) === 0n) throw new UsageError(`--add ${wallet}: the amount "${amount}" must be raw units, a whole number above zero (6 decimals: 1.5 tokens is 1500000).`);
    return { owner: parseWallet(wallet, '--add wallet'), amount: BigInt(amount) };
  });
}

/** `--amount`: whole new tokens above zero (`topup`), as raw units. A decimal point, a separator or raw units past a u64 are refused. */
export function parseAmount(text) {
  const value = String(text ?? '').trim();
  if (!/^\d+$/.test(value) || BigInt(value) === 0n || BigInt(value) * UNIT >= 2n ** 64n) {
    throw new UsageError(`--amount "${text}" must be whole new tokens, a whole number above zero with no separators (not raw units).`);
  }
  return BigInt(value) * UNIT;
}

/** The wallets left out of the snapshot: the pools, Souvenir's own wallets, the incinerator and whatever else is passed. */
export const exclusionSet = (extra = []) => new Set([...POOLS, ...SOUVENIR_WALLETS, INCINERATOR, ...extra.map(String)]);
/** A snapshot that counted a pool as a wallet would hand the pool's coins to nobody, so none runs without both pools excluded. */
export function assertPoolsExcluded(exclude) {
  const missing = POOLS.filter(pool => !exclude.has(pool));
  if (missing.length) throw new Error(`The snapshot must leave out both pools; not in the exclusion list: ${missing.join(', ')}.`);
}

/** Whole tokens with their decimals trimmed: 70,123,456.789 */
export function tokens(raw) {
  const n = BigInt(raw), frac = String(n % UNIT).padStart(DECIMALS, '0').replace(/0+$/, '');
  return (n / UNIT).toLocaleString('en-US') + (frac ? `.${frac}` : '');
}

/** What share of the snapshot's `total` a vault of `vault` new tokens covers at 1:1, rounded down: 91.86% */
export const coverage = (vault, total) => `${(Number(BigInt(vault) * 10_000n / BigInt(total)) / 100).toFixed(2)}%`;

/** The snapshot the way `snapshot.json` is written: the top-level fields, then one row to a line. */
export function snapshotJson(snapshot) {
  const { rows, ...head } = snapshotFile(snapshot);
  const fields = Object.entries(head).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
  return `{\n${fields.join(',\n')},\n  "rows": [\n${rows.map(row => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`;
}

/** `snapshot.csv`: the rows in the order of snapshot.json, which is the order the root is over. The first line says so. */
export function snapshotCsv(snapshot, labels = new Map()) {
  const lines = ['# Rows are in the order of the Merkle root, the same as snapshot.json: do not sort or reorder them. Amounts are raw units (6 decimals).', 'wallet,amount,label'];
  for (const { wallet, amount } of snapshot.rows) lines.push(`${wallet},${amount},${labels.get(wallet) ?? ''}`);
  return `${lines.join('\n')}\n`;
}

/** The snapshot read from the chain, after the exclusion guard. */
export async function takeSnapshot({ rpc, oldMint = OLD_MINT, lockProgram = LOCK_PROGRAM, exclude, add = [] }) {
  assertPoolsExcluded(exclude);
  return readSnapshot({ rpc, oldMint, lockProgram, exclude, add });
}

/** A snapshot file as the rows it commits to; refused when its total or its root is not what its rows add up to (a hand-edited file). */
export function loadSnapshot(path) {
  let file;
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new UsageError(`${path} is not a snapshot file (snapshot.json from the snapshot command).`); }
  if (!file || typeof file.oldMint !== 'string' || !Array.isArray(file.rows) || !file.rows.length || !/^[0-9a-f]{64}$/.test(file.root ?? '') || !/^\d+$/.test(file.total ?? '')) {
    throw new UsageError(`${path} is not a snapshot file (snapshot.json from the snapshot command).`);
  }
  const rows = file.rows.map(([wallet, amount]) => ({ wallet: parseWallet(wallet, 'A snapshot wallet'), amount: BigInt(amount) }));
  const total = rows.reduce((sum, row) => sum + row.amount, 0n);
  if (total !== BigInt(file.total)) throw new Error(`${path}: the rows add up to ${total}, not the ${file.total} it says.`);
  const root = snapshotTree(rows).root;
  if (root.toString('hex') !== file.root) throw new Error(`${path}: the rows' Merkle root is ${root.toString('hex')}, not the ${file.root} it says. The file was changed.`);
  return { oldMint: parseWallet(file.oldMint, 'The snapshot\'s old mint'), rows, total, root, slots: file.slots };
}

/** The keypair file (a JSON array of 64 bytes, as solana-keygen writes it). Its contents are never printed, not even in an error. */
export function readKeypair(path) {
  let bytes;
  try { bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))); } catch { throw new UsageError(`${path} is not a keypair file (a JSON array of 64 numbers).`); }
  try { return Keypair.fromSecretKey(bytes); } catch { throw new UsageError(`${path} is not a keypair file (a JSON array of 64 numbers).`); }
}

/**
 * The opening for the dev wallet `admin`: `openInstructions` with everything the dev wallet holds (`balance`, its new-token balance, bigint raw
 * units) as the vault's deposit (`vault`), short of the snapshot's total or beyond it: the program fixes the rate at 1:1 whatever the vault
 * holds, swaps it cannot pay wait for a top-up, and what is left at the deadline goes back to the dev wallet. Nothing is burned. Refuses before
 * building anything if the wallet holds none.
 */
export function buildOpen({ admin, snapshot, newMint, newTokenProgram, seller, balance, oldTokenProgram = TOKEN_PROGRAM_ID, programId = SWAP_PROGRAM_ID, deadline = DEADLINE }) {
  const total = snapshot.total;
  if (balance <= 0n) throw new Error('The dev wallet holds no new tokens: there is nothing to put in the vault. Is --new-mint the new coin, and the dev wallet its creator?');
  if (snapshot.rows.some(row => row.wallet === new PublicKey(seller).toBase58())) throw new Error('The seller is in the snapshot: leave it out (snapshot --exclude) and take the snapshot again.');
  const adminKey = new PublicKey(admin), mint = new PublicKey(newMint), program = new PublicKey(newTokenProgram);
  const instructions = openInstructions({
    programId, admin: adminKey, oldMint: snapshot.oldMint, newMint: mint, oldTokenProgram, newTokenProgram: program, root: snapshot.root,
    oldTotal: total, deadline, seller, devBalance: balance,
  });
  const labels = [
    'Create the seller\'s old-token account (if missing)', 'Create the dev wallet\'s new-token account (if missing)', 'Initialize the swap',
    `Move ${tokens(balance)} new tokens into the vault (${coverage(balance, total)} of the snapshot)`, 'Open the swap at 1:1',
  ];
  if (instructions.length !== labels.length) throw new Error('openInstructions changed: this script does not know its instructions any more.');
  return { instructions, labels, config: configAddress(programId, adminKey, snapshot.oldMint, mint), devAccount: getAssociatedTokenAddressSync(mint, adminKey, false, program), vault: balance };
}

/** The new mint's token program (pump.fun mints are Token-2022), both mints' decimals, and the dev wallet's new-token balance, from the chain. */
export async function readOpenState({ connection, admin, oldMint, newMint }) {
  const info = await connection.getAccountInfo(new PublicKey(newMint), 'confirmed');
  if (!info) throw new Error(`${newMint} does not exist on this cluster.`);
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error(`${newMint} is not a token mint (it belongs to ${info.owner.toBase58()}).`);
  const newTokenProgram = info.owner;
  const [oldInfo, newInfo] = await Promise.all([
    getMint(connection, new PublicKey(oldMint), 'confirmed', TOKEN_PROGRAM_ID), getMint(connection, new PublicKey(newMint), 'confirmed', newTokenProgram),
  ]);
  if (oldInfo.decimals !== DECIMALS || newInfo.decimals !== DECIMALS) {
    throw new Error(`Both coins must have ${DECIMALS} decimals for a 1:1 swap; the old one has ${oldInfo.decimals}, the new one ${newInfo.decimals}.`);
  }
  const devAccount = getAssociatedTokenAddressSync(new PublicKey(newMint), new PublicKey(admin), false, newTokenProgram);
  const balance = await getAccount(connection, devAccount, 'confirmed', newTokenProgram).then(account => account.amount, error => {
    if (error instanceof TokenAccountNotFoundError) return 0n;
    throw error;
  });
  return { newTokenProgram, balance };
}

/** What the swap's vault (the config's account of the new mint) holds: raw units, 0n while it does not exist. */
export async function readVault({ connection, config, newMint, newTokenProgram }) {
  return getAccount(connection, newVaultAddress(config, newMint, newTokenProgram), 'confirmed', newTokenProgram).then(account => account.amount, error => {
    if (error instanceof TokenAccountNotFoundError) return 0n;
    throw error;
  });
}

/** What is wrong with a swap's config next to the snapshot it should have been opened from: `[]` when nothing is. */
export function configProblems(config, snapshot) {
  const problems = [];
  if (!config.opened) problems.push('it is not open');
  if (config.newTotal !== config.oldTotal) problems.push(`its new total ${config.newTotal} is not its old total ${config.oldTotal}, so it is not 1:1`);
  if (config.oldTotal !== snapshot.total) problems.push(`its old total ${config.oldTotal} is not the snapshot's ${snapshot.total}`);
  if (!config.root.equals(snapshot.root)) problems.push(`its root ${config.root.toString('hex')} is not the snapshot's ${snapshot.root.toString('hex')}`);
  return problems;
}

/**
 * The swap at `config`, if it already exists (the address is the dev wallet's own, so nothing but a past `open` made it): `null` when there is
 * none, otherwise `{ config, line, problems }`, the swap's config, the line to print and what is wrong with it next to the snapshot. Opening a
 * second time would only fail (and the dev wallet, emptied by the first, would hold nothing to put in), so `open` asks first. Anyone can send
 * lamports to the address, which makes it an account of the system program with no data: that is no swap yet (`initialize` takes such an
 * account as it finds it).
 */
export async function existingSwap({ connection, config, snapshot, programId = SWAP_PROGRAM_ID }) {
  const info = await connection.getAccountInfo(config, 'confirmed');
  if (!info || (!new PublicKey(info.owner).equals(new PublicKey(programId)) && !info.data?.length)) return null;
  const found = decodeConfig(info.data);
  if (!found) throw new Error(`${config} exists but is not a swap config; check it before anything else.`);
  return {
    config: found, problems: configProblems(found, snapshot),
    line: `The swap is already ${found.opened ? 'open' : 'set up but not open'} at ${config} (opened=${found.opened}, old total ${found.oldTotal}, new total ${found.newTotal}, root ${found.root.equals(snapshot.root) ? 'matches' : 'doesn\'t match'} the snapshot); nothing sent`,
  };
}

/**
 * What to do with `balance` new tokens left in the dev wallet after an opening: move their whole tokens into the vault with `topup`, signed as
 * the opening was (`signer`: `--keypair <path>`, or `--admin <address> --phantom`). Under one token is too little for `topup`: it can stay.
 */
export const leftoverAdvice = ({ signer, newMint, oldMint, balance }) => (balance < UNIT
  ? 'That is under one token, too little for topup (whole tokens): it can stay in the dev wallet.'
  : `Move them into the vault with: node scripts/migration.mjs topup --rpc <the --rpc url> ${signer} --new-mint ${newMint}${oldMint === OLD_MINT ? '' : ` --old-mint ${oldMint}`} --amount ${balance / UNIT}`);

/**
 * What is wrong with a swap's config next to the opening this script builds (`expected`): the deadline, and the two destinations `open` fixes for
 * good, the seller's old-token account and the dev wallet's new-token account. `[]` when nothing is.
 */
export function openingProblems(config, { deadline, oldDestination, unclaimedDestination, seller }) {
  const problems = [];
  if (config.deadline !== deadline) problems.push(`its deadline ${config.deadline} is not ${deadline}`);
  if (config.oldDestination !== oldDestination) problems.push(`swapped old tokens go to ${config.oldDestination}, not to the seller ${seller}'s old-token account ${oldDestination}`);
  if (config.unclaimedDestination !== unclaimedDestination) {
    problems.push(`unclaimed new tokens go to ${config.unclaimedDestination}, not to the dev wallet's new-token account ${unclaimedDestination}`);
  }
  return problems;
}

/**
 * After the opening has been confirmed: the config read back (`null` if it is not there) must be open, 1:1 (its new total its old total) and
 * the snapshot's (root and total), it must be the opening this script built (`expected`: openingProblems), and the dev wallet must hold no new
 * tokens. A deposit that landed after the balance was read stays in the wallet, and then this throws, naming the remainder and `leftover`, the
 * sentence that says what to do with it (leftoverAdvice).
 */
export function verifyOpened({ config, snapshot, balance, leftover, expected }) {
  if (!config) throw new Error('The transaction landed but the config account is not there; check the signature before anything else.');
  const problems = configProblems(config, snapshot);
  if (problems.length) throw new Error(`The swap does not match the snapshot: ${problems.join('; ')}. Check the signature before anything else.`);
  const built = openingProblems(config, expected);
  if (built.length) throw new Error(`The swap is not the opening this script built from these arguments: ${built.join('; ')}. Check the signature before anything else.`);
  if (balance !== 0n) {
    throw new Error(`The swap is open, but the dev wallet still holds ${tokens(balance)} new tokens (${balance} raw units), which arrived after the balance was read. ${leftover}`);
  }
}

/** What `snapshot` does with its options: read, write the two files (never over an existing one), print the summary. */
async function runSnapshot(options, log) {
  const extra = parseWallets(options.exclude, '--exclude'), team = parseWallets(options.team, '--team'), add = parseAdd(options.add);
  const oldMint = options['old-mint'] ? parseWallet(options['old-mint'], '--old-mint') : OLD_MINT;
  const lockProgram = options['lock-program'] ? parseWallet(options['lock-program'], '--lock-program') : LOCK_PROGRAM;
  const jsonPath = join(options.out, 'snapshot.json'), csvPath = join(options.out, 'snapshot.csv');
  for (const path of [jsonPath, csvPath]) if (existsSync(path)) throw new UsageError(`${path} already exists: nothing is overwritten, choose another --out.`);
  const exclude = exclusionSet(extra), connection = new Connection(options.rpc);
  const snapshot = await takeSnapshot({ rpc: connection, oldMint, lockProgram, exclude, add });
  const labels = new Map(team.map(wallet => [wallet, 'team']));
  mkdirSync(options.out, { recursive: true });
  writeFileSync(jsonPath, snapshotJson(snapshot), { flag: 'wx' });
  writeFileSync(csvPath, snapshotCsv(snapshot, labels), { flag: 'wx' });
  const { slots } = snapshot;
  log(`Snapshot of ${oldMint} (locks of ${lockProgram}) read from ${new URL(options.rpc).host}`);
  log(`Root     ${snapshot.root.toString('hex')}`);
  log(`Total    ${tokens(snapshot.total)} tokens (${snapshot.total} raw units) over ${snapshot.rows.length} wallets`);
  log(`Slots    locks before ${slots.locksBefore}, token accounts ${slots.accounts}, locks after ${slots.locks}`);
  log(`Left out ${exclude.size} wallets: the 2 pools, Souvenir's ${SOUVENIR_WALLETS.length} wallets, the incinerator${extra.length ? `, ${extra.length} more by --exclude` : ''}`);
  for (const { owner, amount } of add) log(`Added    ${owner} ${tokens(amount)} tokens by hand`);
  const held = new Map(snapshot.rows.map(row => [row.wallet, row.amount]));
  for (const wallet of team) {
    const amount = held.get(wallet);
    log(`Team     ${wallet} ${amount === undefined ? 'not in the snapshot (no coins, or left out)' : `${tokens(amount)} tokens, ${(Number(amount * 10000n / snapshot.total) / 100).toFixed(2)}% of the total`}`);
  }
  log(`Wrote ${jsonPath} and ${csvPath}`);
}

const keyLine = (key, indent) => `${indent}${key.pubkey.toBase58()}${key.isSigner ? ' signer' : ''}${key.isWritable ? ' writable' : ''}`;

/** What the signing page, its terminal lines and its timeout call the transaction, for `open` and for `topup`. */
const OPENING = {
  noun: 'opening', title: 'Open the swap', heading: 'Open the holder swap', rerun: 'run the same command again: it finds the swap and checks it.',
  where: config => [`Config  ${config}`, 'If this errors, check the config address before re-running.'],
};
const TOPUP = {
  noun: 'top-up', title: 'Top up the vault', heading: 'Top up the swap\'s vault',
  rerun: 'check the vault\'s balance before running the command again: a second run moves the tokens again.',
  where: vault => [`Vault   ${vault}`, 'If this errors, check the vault\'s balance before re-running: a second run moves the tokens again.'],
};

/**
 * The part `open` and `topup` share once they have built `instructions` for the dev wallet `admin` to sign: the transaction (its size checked),
 * printed with each instruction under `labels`; without `options.yes`, simulated (with the keypair, or unsigned for Phantom) and nothing more;
 * with it, sent and confirmed. The dev wallet signs from `keypair`, or with `phantom` in Phantom on the page `serve` serves (`rows`: the page's
 * summary). `words` is OPENING or TOPUP, `at` the address its re-run line names. Resolves with the confirmation, or null when nothing was sent;
 * in Phantom mode the confirmation also carries the `signature` and `landed`, the transaction as the chain has it (Phantom sent it, so what it
 * does is read there).
 */
async function signAndSend({ options, log, connection, keypair, admin, instructions, labels, words, at, rows, serve, timeoutMs }) {
  const phantom = !keypair, send = Boolean(options.yes);
  const transaction = new Transaction().add(...instructions);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.feePayer = admin;
  transaction.recentBlockhash = blockhash;
  if (keypair) transaction.sign(keypair);
  // Throws when the transaction does not fit in a packet. Unsigned (Phantom signs it), its signature's place counts all the same.
  const size = transaction.serialize({ requireAllSignatures: !phantom, verifySignatures: !phantom }).length;
  log(`Transaction      ${instructions.length} instruction${instructions.length === 1 ? '' : 's'}, ${size} of 1232 bytes`);
  instructions.forEach((instruction, i) => {
    log(`\n${i + 1}. ${labels[i]}\n   program ${instruction.programId.toBase58()}\n   data    ${instruction.data.toString('hex')}\n   accounts`);
    for (const key of instruction.keys) log(keyLine(key, '     '));
  });

  if (!send) {
    // In Phantom mode no key is here: no signer is given, so the simulation runs with signature verification off.
    const { value } = await (keypair ? connection.simulateTransaction(transaction, [keypair]) : connection.simulateTransaction(transaction));
    log(`\nSimulation ${value.err ? `FAILED: ${JSON.stringify(value.err)}` : 'ok'}, ${value.unitsConsumed ?? '?'} compute units${phantom ? ' (signatures not checked: Phantom signs)' : ''}`);
    if (value.err) {
      for (const line of value.logs ?? []) log(`  ${line}`);
      throw new Error(`The simulated ${words.noun} failed.`);
    }
    log(phantom ? '\nNothing was sent. To sign it in Phantom, run the same command again with --yes: it serves a page on this machine to approve it on.'
      : '\nNothing was sent. To send it, run the same command again with --yes.');
    return null;
  }

  if (keypair) {
    // Sent and confirmed in two steps, so the signature is on screen as soon as the cluster has taken the transaction.
    const signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: 'confirmed' });
    log(`\nSent. Signature ${signature}`);
    for (const line of words.where(at)) log(line);
    return connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  }

  // Phantom. The page asks for the transaction when the owner approves (`transaction`: the same instructions, a fresh blockhash each time, so a
  // slow approval never signs an expired one), Phantom signs and sends it, and the page posts the signature back (`accept`). It is taken once
  // it is on chain and signed by the dev wallet; then the same checks as after a send from the keypair.
  const handedOut = [];
  return serve({
    timeoutMs, words,
    page: signingPage({ admin: admin.toBase58(), labels, rows, words }),
    onListen: url => {
      log(`\nOpen this page in the browser where Phantom is, with the dev wallet ${admin.toBase58()} as Phantom's account:\n\n  ${url}\n`);
      log(`It shows this ${words.noun}; "Approve in Phantom" asks this script for it with a fresh blockhash, and Phantom signs and sends it. Waiting up to ${duration(timeoutMs)}.`);
    },
    transaction: async () => {
      const latest = await connection.getLatestBlockhash('confirmed');
      handedOut.push(latest);
      return new Transaction({ feePayer: admin, ...latest }).add(...instructions).serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    },
    accept: async signature => {
      log(`\nThe page sent signature ${signature}`);
      for (const line of words.where(at)) log(line);
      try {
        // The last transaction handed out expires last: waiting until it has is long enough for any of them. The transaction itself is looked
        // up even when the wait runs out: Phantom may have given it a newer blockhash, and on chain is what counts.
        const latest = handedOut.at(-1);
        if (!latest) throw new Error(`No ${words.noun} was handed out yet: approve it on the page first.`);
        let confirmed = null, waited = null;
        try { confirmed = await connection.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed'); }
        catch (error) { waited = error; }
        const landed = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (!landed) throw new Error(`${signature} is not on chain${waited ? `: ${waited.message}` : '.'}`);
        const { message } = landed.transaction;
        if (!message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).some(signer => signer.equals(admin))) {
          throw new Error(`${signature} is not signed by the dev wallet ${admin.toBase58()}.`);
        }
        return { ...(confirmed ?? { value: { err: landed.meta?.err ?? null } }), signature, landed };
      } catch (error) {
        log(`Refused: ${error.message} Still waiting for the page.`);
        throw error;
      }
    },
  });
}

/** The dev wallet from the options: the keypair file's (`keypair`, its key) or, with `--phantom`, the `--admin` address (no key here). */
function devWallet(options) {
  const keypair = options.phantom ? null : readKeypair(options.keypair);
  const admin = keypair ? keypair.publicKey : new PublicKey(parseWallet(options.admin, '--admin'));
  // How `topup` is told to sign the same way, for the leftover advice.
  const signer = keypair ? `--keypair ${options.keypair}` : `--admin ${admin.toBase58()} --phantom`;
  return { keypair, admin, signer };
}

/**
 * What `open` does with its options: check, print the opening, simulate it, and send it only with `--yes`. A swap that already exists is
 * reported and nothing is sent. The dev wallet signs from `--keypair`, or with `--phantom` in Phantom, on the page `serve` serves (the
 * already-open check, the balance and the opening come first; nothing is served without `--yes`). `connection` and `serve`/`timeoutMs` are for tests.
 */
export async function runOpen(options, log, connection = new Connection(options.rpc, 'confirmed'), { serve = serveSigning, timeoutMs = SIGNING_TIMEOUT_MS } = {}) {
  const { keypair, admin, signer } = devWallet(options), phantom = !keypair;
  const oldMint = options['old-mint'] ? parseWallet(options['old-mint'], '--old-mint') : OLD_MINT;
  const newMint = parseWallet(options['new-mint'], '--new-mint'), seller = parseWallet(options.seller, '--seller');
  const snapshot = loadSnapshot(options.snapshot);
  if (snapshot.oldMint !== oldMint) throw new Error(`${options.snapshot} is a snapshot of ${snapshot.oldMint}, not of ${oldMint}.`);
  // What to do with new tokens left in the dev wallet after the opening: `topup`, signed the same way.
  const leftovers = balance => leftoverAdvice({ signer, newMint, oldMint, balance });
  // What the opening fixes besides the snapshot, as this script builds it (buildOpen, openInstructions): checked on the swap after it.
  const oldDestination = getAssociatedTokenAddressSync(new PublicKey(oldMint), new PublicKey(seller), false, TOKEN_PROGRAM_ID);
  const expectedFor = newTokenProgram => ({
    deadline: DEADLINE, oldDestination: oldDestination.toBase58(), seller,
    unclaimedDestination: getAssociatedTokenAddressSync(new PublicKey(newMint), admin, false, newTokenProgram).toBase58(),
  });

  const existing = await existingSwap({ connection, config: configAddress(SWAP_PROGRAM_ID, admin, snapshot.oldMint, newMint), snapshot });
  if (existing) {
    log(existing.line);
    if (existing.problems.length) throw new Error(`The swap that exists does not match this snapshot: ${existing.problems.join('; ')}.`);
    // A run again after one that crashed once the opening was sent: the dev wallet must hold none of the new coin, as the check after a send
    // says. Not from the deadline on, when `settle` sends the unclaimed tokens there.
    if (Date.now() / 1000 < existing.config.deadline) {
      const { newTokenProgram, balance } = await readOpenState({ connection, admin, oldMint, newMint });
      verifyOpened({ config: existing.config, snapshot, balance, leftover: leftovers(balance), expected: expectedFor(newTokenProgram) });
    }
    return;
  }

  const { newTokenProgram, balance } = await readOpenState({ connection, admin, oldMint, newMint });
  const { instructions, labels, config } = buildOpen({ admin, snapshot, newMint, newTokenProgram, seller, balance });
  const host = new URL(options.rpc).host, deadline = `${DEADLINE} (${new Date(DEADLINE * 1000).toISOString()})`, covers = coverage(balance, snapshot.total);

  log(`Opening the swap on ${host}${options.yes ? '' : ' (nothing is sent without --yes)'}`);
  log(`Config           ${config.toBase58()}`);
  log(`Dev wallet       ${admin.toBase58()} (the swap's admin${phantom ? ', signing in Phantom' : ''})`);
  log(`Old mint         ${oldMint}`);
  log(`New mint         ${newMint} (${newTokenProgram.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58() ? 'Token-2022' : 'SPL Token'})`);
  log(`Snapshot total   ${tokens(snapshot.total)} tokens (${snapshot.total} raw units), root ${snapshot.root.toString('hex')}`);
  log(`Dev wallet holds ${tokens(balance)} new tokens; all of them go into the vault`);
  log(`Vault covers     ${covers} of the snapshot (1:1 whatever the vault holds; a swap beyond it waits for a top-up)`);
  log(`Old tokens go to ${oldDestination.toBase58()} (the seller ${seller}'s account)`);
  log(`Deadline         ${deadline}`);

  const confirmation = await signAndSend({
    options, log, connection, keypair, admin, instructions, labels, words: OPENING, at: config.toBase58(), serve, timeoutMs,
    rows: [
      ['Config', config.toBase58()], ['Dev wallet', `${admin.toBase58()} (the swap's admin)`], ['New mint', newMint], ['Old mint', oldMint],
      ['Snapshot total', `${tokens(snapshot.total)} tokens`], ['Into the vault', `${tokens(balance)} new tokens, all the dev wallet holds`],
      ['Vault covers', `${covers} of the snapshot`], ['Rate', '1 new token for each old one, whatever the vault holds'],
      ['Deadline', deadline], ['Old tokens go to', `${oldDestination.toBase58()} (the seller ${seller}'s account)`], ['Root', snapshot.root.toString('hex')],
      ['Checked on', host],
    ],
  });
  if (!confirmation) return;

  // After the send, whoever signed it: the config read back, the vault and the dev wallet's balance, checked against the snapshot.
  if (confirmation.value.err) throw new Error(`The transaction failed: ${JSON.stringify(confirmation.value.err)}.`);
  log('Confirmed.');
  const opened = decodeConfig((await connection.getAccountInfo(config, 'confirmed'))?.data ?? Buffer.alloc(0));
  const left = (await readOpenState({ connection, admin, oldMint, newMint })).balance;
  if (opened) log(`opened: ${opened.opened}, old total ${opened.oldTotal}, new total ${opened.newTotal}, root ${opened.root.equals(snapshot.root) ? 'matches' : 'DOES NOT MATCH'} the snapshot`);
  const vault = await readVault({ connection, config, newMint, newTokenProgram });
  log(`Vault holds ${tokens(vault)} new tokens, ${coverage(vault, snapshot.total)} of the snapshot`);
  log(`Dev wallet's new-token balance now ${tokens(left)}`);
  verifyOpened({ config: opened, snapshot, balance: left, leftover: leftovers(left), expected: expectedFor(newTokenProgram) });
}

/**
 * Whether `landed` (getTransaction's answer) holds a transferChecked of `program` moving exactly `amount` from `source` into `vault`: what the
 * top-up must do. In Phantom mode the script did not send the transaction, and the signature the page sends back is accepted once it is on chain
 * and signed by the dev wallet, whatever it does; this reads what it did.
 */
export function movesTopup(landed, { source, vault, amount, program }) {
  const { message } = landed.transaction;
  const keys = message.getAccountKeys({ accountKeysFromLookups: landed.meta?.loadedAddresses });
  return message.compiledInstructions.some(ix => {
    const instruction = new TransactionInstruction({
      programId: keys.get(ix.programIdIndex), data: Buffer.from(ix.data),
      keys: ix.accountKeyIndexes.map(i => ({ pubkey: keys.get(i), isSigner: false, isWritable: false })),
    });
    let decoded;
    try { decoded = decodeTransferCheckedInstruction(instruction, program); } catch { return false; } // another program or instruction
    return decoded.keys.source.pubkey.equals(source) && decoded.keys.destination.pubkey.equals(vault) && decoded.data.amount === amount;
  });
}

/**
 * What `topup` does with its options: `--amount` whole new tokens from the dev wallet's new-token account into the swap's vault, one
 * transferChecked, signed as `open` is (signAndSend). It reads the swap first and refuses one that is not there, not open, or past its
 * deadline (settle sends the whole vault back to the dev wallet then), and a dev wallet holding less than the amount. It prints the vault before
 * and after, and once sent, its new balance and how much of the snapshot it covers. Signed in Phantom, it fails unless the transaction that landed
 * moves exactly the amount from the dev wallet's new-token account into the vault (movesTopup). `connection` and `serve`/`timeoutMs` are for tests.
 */
export async function runTopup(options, log, connection = new Connection(options.rpc, 'confirmed'), { serve = serveSigning, timeoutMs = SIGNING_TIMEOUT_MS } = {}) {
  const { keypair, admin } = devWallet(options), phantom = !keypair;
  const oldMint = options['old-mint'] ? parseWallet(options['old-mint'], '--old-mint') : OLD_MINT;
  const newMint = parseWallet(options['new-mint'], '--new-mint'), amount = parseAmount(options.amount);
  const config = configAddress(SWAP_PROGRAM_ID, admin, oldMint, newMint);
  const readSwap = async () => {
    const info = await connection.getAccountInfo(config, 'confirmed');
    if (!info) throw new Error(`There is no swap at ${config} (the dev wallet ${admin.toBase58()}'s for these mints): check --new-mint and the dev wallet.`);
    const swap = decodeConfig(info.data);
    if (!swap) throw new Error(`${config} exists but is not a swap config; check it before anything else.`);
    return swap;
  };
  const swap = await readSwap();
  if (!swap.opened) throw new Error('The swap is not open yet: open fills the vault. Run open first.');
  if (Date.now() / 1000 >= swap.deadline) throw new Error(`The swap's deadline has passed (${new Date(swap.deadline * 1000).toISOString()}): nobody can swap any more, and settle sends the vault back to the dev wallet. Nothing to top up.`);
  const { newTokenProgram, balance } = await readOpenState({ connection, admin, oldMint, newMint });
  if (balance < amount) throw new Error(`The dev wallet holds ${tokens(balance)} new tokens, less than the ${tokens(amount)} to move.`);
  const vaultAddress = newVaultAddress(config, newMint, newTokenProgram), vault = await readVault({ connection, config, newMint, newTokenProgram });
  const toSwap = swap.oldTotal > swap.swappedOld ? swap.oldTotal - swap.swappedOld : 0n;
  const source = getAssociatedTokenAddressSync(new PublicKey(newMint), admin, false, newTokenProgram);
  const instructions = [createTransferCheckedInstruction(source, new PublicKey(newMint), vaultAddress, admin, amount, DECIMALS, [], newTokenProgram)];
  const host = new URL(options.rpc).host;
  const now = `${tokens(vault)} new tokens, ${coverage(vault, swap.oldTotal)} of the snapshot; ${tokens(toSwap)} still to swap`;
  const after = `${tokens(vault + amount)} new tokens, ${coverage(vault + amount, swap.oldTotal)} of the snapshot`;

  log(`Topping up the swap's vault on ${host}${options.yes ? '' : ' (nothing is sent without --yes)'}`);
  log(`Config           ${config.toBase58()}`);
  log(`Vault            ${vaultAddress.toBase58()}`);
  log(`Dev wallet       ${admin.toBase58()} (the swap's admin${phantom ? ', signing in Phantom' : ''})`);
  log(`New mint         ${newMint} (${newTokenProgram.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58() ? 'Token-2022' : 'SPL Token'})`);
  log(`Dev wallet holds ${tokens(balance)} new tokens`);
  log(`Top-up           ${tokens(amount)} new tokens`);
  log(`Vault now        ${now}`);
  log(`Vault after      ${after}`);

  const confirmation = await signAndSend({
    options, log, connection, keypair, admin, instructions, labels: [`Move ${tokens(amount)} new tokens from the dev wallet into the vault`],
    words: TOPUP, at: vaultAddress.toBase58(), serve, timeoutMs,
    rows: [
      ['Config', config.toBase58()], ['Vault', vaultAddress.toBase58()], ['Dev wallet', `${admin.toBase58()} (the swap's admin)`], ['New mint', newMint],
      ['Top-up', `${tokens(amount)} new tokens`], ['Vault now', now], ['Vault after', after], ['Checked on', host],
    ],
  });
  if (!confirmation) return;
  if (confirmation.value.err) throw new Error(`The transaction failed: ${JSON.stringify(confirmation.value.err)}.`);
  if (confirmation.landed && !movesTopup(confirmation.landed, { source, vault: vaultAddress, amount, program: newTokenProgram })) {
    throw new Error(`${confirmation.signature} does not move ${tokens(amount)} new tokens from the dev wallet's new-token account ${source.toBase58()} into the vault ${vaultAddress.toBase58()}: Phantom signed and sent another transaction. Look at it on an explorer and check the vault's balance before running topup again.`);
  }
  log('Confirmed.');
  const [held, landed] = await Promise.all([readVault({ connection, config, newMint, newTokenProgram }), readSwap()]);
  const left = landed.oldTotal > landed.swappedOld ? landed.oldTotal - landed.swappedOld : 0n;
  log(`Vault now holds ${tokens(held)} new tokens, ${coverage(held, landed.oldTotal)} of the snapshot; ${tokens(left)} still to swap`);
}

/** A wait, as the timeout message says it: whole minutes, else seconds. */
const duration = ms => (ms % 60_000 ? `${ms / 1000} seconds` : `${ms / 60_000} minutes`);
/** A transaction signature: 64 bytes in base58. */
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** The browser build of @solana/web3.js from this checkout's packages: the page reads the transaction with it, so it needs no other site. */
function browserWeb3() {
  try { return readFileSync(createRequire(import.meta.url).resolve('@solana/web3.js/lib/index.iife.min.js')); } catch {
    throw new Error('The browser build of @solana/web3.js (lib/index.iife.min.js) is not installed here; run npm install first.');
  }
}

/**
 * Serves the page `open --phantom --yes` (and `topup`'s) signs on: on 127.0.0.1 only, on a free port, under a random path token, until a
 * signature is accepted or `timeoutMs` passes. Under /<token>/ only (anything else is a 404): the page (GET), the browser build of
 * @solana/web3.js it reads the transaction with (GET web3.js), the transaction (GET tx: `transaction()`, base64) and the signature Phantom
 * returned (POST sent, JSON `{ signature }`). `words` (OPENING or TOPUP) names the transaction in its errors. `accept(signature)` checks a signature: a throw refuses it (409 with its message; the page may send another), a return
 * accepts it: then this resolves at once with what `accept` returned, whether or not the page is still there to read the answer, and the server
 * takes no new connection and closes once that answer is written or dropped. One signature is checked at a time and one is accepted at most.
 * `onListen(url)` is called with the page's address. Rejects when the time runs out, whatever is happening then, the server closed.
 */
export function serveSigning({ page, transaction, accept, timeoutMs = SIGNING_TIMEOUT_MS, onListen = () => {}, words = OPENING }) {
  const web3 = browserWeb3(), token = randomBytes(16).toString('hex'), base = `/${token}/`;
  return new Promise((resolve, reject) => {
    let checking = false, done = false;
    const reply = (res, status, type, body, then) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
      res.end(body, then);
    };
    const json = (res, status, body, then) => reply(res, status, 'application/json; charset=utf-8', JSON.stringify(body), then);
    const stop = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      reject(error);
    };
    const timedOut = () => new Error(`No signed ${words.noun} came back from the page within ${duration(timeoutMs)}, so this run stops and the page with it. If you approved it in Phantom, ${words.rerun}`);
    // The time runs out whatever is happening, a signature being checked included (its RPC may never answer): the run stops, and a re-run checks
    // the swap on chain.
    const timer = setTimeout(() => stop(timedOut()), timeoutMs);

    async function sent(req, res) {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) return json(res, 413, { message: 'Too long.' });
      }
      let signature = null;
      try { signature = JSON.parse(body).signature; } catch { /* not JSON */ }
      if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return json(res, 400, { message: 'That is not a transaction signature.' });
      if (checking) return json(res, 409, { message: 'Another signature is already being checked; wait for its answer.' });
      checking = true;
      let value;
      try { value = await accept(signature); } catch (error) {
        checking = false;
        if (!done) json(res, 409, { message: error.message });
        return;
      }
      if (done) return; // the time ran out first: the run has stopped
      // Accepted. The run goes on to its checks at once, whatever becomes of this answer: the page may be gone. No new connection is taken,
      // and the last ones close once this answer is written or dropped.
      done = true;
      clearTimeout(timer);
      server.close();
      res.on('close', () => server.closeAllConnections());
      if (res.socket?.destroyed !== false) server.closeAllConnections();
      json(res, 200, { ok: true });
      resolve(value);
    }

    async function route(req, res) {
      const path = req.url.split('?')[0], name = path.startsWith(base) ? path.slice(base.length) : null;
      if (req.method === 'GET' && name === '') return reply(res, 200, 'text/html; charset=utf-8', page);
      if (req.method === 'GET' && name === 'web3.js') return reply(res, 200, 'text/javascript; charset=utf-8', web3);
      if (req.method === 'GET' && name === 'tx') {
        let body;
        try { body = await transaction(); } catch (error) { return json(res, 502, { message: `The script could not build the ${words.noun}: ${error.message}` }); }
        return reply(res, 200, 'text/plain; charset=utf-8', body);
      }
      if (req.method === 'POST' && name === 'sent') return sent(req, res);
      return reply(res, 404, 'text/plain; charset=utf-8', 'Not found');
    }

    const server = createServer((req, res) => {
      route(req, res).catch(error => { if (!res.headersSent) json(res, 500, { message: error.message }); });
    });
    server.on('error', error => stop(error));
    server.listen(0, '127.0.0.1', () => onListen(`http://127.0.0.1:${server.address().port}${base}`));
  });
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The signing page: the transaction's summary and its steps (`words`: OPENING or TOPUP names it), and a script that finds Phantom (its own
 * provider, else Phantom through the Wallet Standard), refuses any account but `admin`, fetches the transaction from the script (`tx`), has
 * Phantom sign and send it, and posts the signature back (`sent`). It never holds a key; it reads the transaction with the @solana/web3.js the
 * script serves beside it (`web3.js`).
 */
export function signingPage({ admin, rows, labels, words = OPENING }) {
  const dl = rows.map(([name, value]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`).join('\n');
  const steps = labels.map(label => `<li>${escapeHtml(label)}</li>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(words.title)}</title>
<style>
:root { color-scheme: light dark; --bg: #f6f4ef; --card: #fff; --ink: #1c1a15; --muted: #69645a; --line: #e0dbd0; --good: #1d7438; --bad: #b3261e; --accent: #4537d0; }
@media (prefers-color-scheme: dark) { :root { --bg: #14130f; --card: #1e1c17; --ink: #f0ece3; --muted: #a39d90; --line: #37342c; --good: #63cf8f; --bad: #ff8b82; --accent: #a49bff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 6px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 10px; }
p { margin: 0 0 20px; color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
ol { margin: 0; padding-left: 22px; }
#status { padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); margin: 0 0 16px; overflow-wrap: anywhere; }
#status.good { border-color: var(--good); color: var(--good); }
#status.bad { border-color: var(--bad); color: var(--bad); }
button { font: inherit; font-weight: 600; padding: 10px 20px; border-radius: 999px; border: 0; background: var(--accent); color: #fff; cursor: pointer; margin: 0 8px 8px 0; }
button:disabled { opacity: .5; cursor: default; }
@media (max-width: 560px) { dl { grid-template-columns: 1fr; gap: 0; } dd { margin-bottom: 8px; } }
</style>
</head>
<body data-admin="${escapeHtml(admin)}" data-noun="${escapeHtml(words.noun)}" data-rerun="${escapeHtml(words.rerun)}">
<main>
<h1>${escapeHtml(words.heading)}</h1>
<p>The script on this machine built this ${escapeHtml(words.noun)}. Sign it in Phantom with the dev wallet: this page hands it to Phantom and the signature back to the script, which checks the result on chain. No key ever comes here.</p>
<section class="card"><h2>The ${escapeHtml(words.noun)}</h2><dl>
${dl}
</dl></section>
<section class="card"><h2>What the transaction does</h2><ol>
${steps}
</ol></section>
<div id="status" role="status" aria-live="polite">Looking for Phantom&hellip;</div>
<div><button id="connect" hidden>Connect Phantom</button><button id="approve" hidden>Approve in Phantom</button><button id="again" hidden>Send the signature again</button></div>
</main>
<script src="web3.js"></script>
<script>
(function () {
  'use strict';
  var admin = document.body.getAttribute('data-admin'), noun = document.body.getAttribute('data-noun'), rerun = document.body.getAttribute('data-rerun');
  var statusBox = document.getElementById('status');
  var connectButton = document.getElementById('connect'), approveButton = document.getElementById('approve'), againButton = document.getElementById('again');
  var wallet = null, lastSignature = null;
  function say(text, kind) { statusBox.textContent = text; statusBox.className = kind || ''; }
  function show(button, on) { button.hidden = !on; button.disabled = false; }
  function reason(error) { return (error && (error.message || String(error))) || 'unknown error'; }

  // Phantom's own provider, else Phantom as a Wallet Standard wallet (the page asks wallets to register, and listens for late ones).
  var registered = [];
  function register() { for (var i = 0; i < arguments.length; i++) registered.push(arguments[i]); return function () {}; }
  window.addEventListener('wallet-standard:register-wallet', function (event) { try { event.detail({ register: register }); } catch (e) {} });
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: register } })); } catch (e) {}
  function injected() { var provider = window.phantom && window.phantom.solana; return provider && provider.isPhantom ? provider : null; }
  function standard() {
    for (var i = 0; i < registered.length; i++) {
      var features = registered[i].features || {};
      if (/phantom/i.test(registered[i].name) && features['standard:connect'] && features['solana:signAndSendTransaction']) return registered[i];
    }
    return null;
  }

  var ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58(bytes) {
    var n = BigInt(0), text = '';
    for (var i = 0; i < bytes.length; i++) n = n * BigInt(256) + BigInt(bytes[i]);
    while (n > BigInt(0)) { text = ALPHABET[Number(n % BigInt(58))] + text; n = n / BigInt(58); }
    for (var j = 0; j < bytes.length && bytes[j] === 0; j++) text = '1' + text;
    return text;
  }
  function fromBase64(text) {
    var raw = atob(text.trim()), bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  async function connect() {
    var provider = injected();
    if (provider) {
      await provider.connect();
      if (provider.on) provider.on('accountChanged', function () { check(); });
      return {
        address: function () { return provider.publicKey ? provider.publicKey.toString() : null; },
        sign: async function (bytes) { return (await provider.signAndSendTransaction(window.solanaWeb3.Transaction.from(bytes))).signature; },
      };
    }
    var phantom = standard();
    if (!phantom) return null;
    var accounts = (await phantom.features['standard:connect'].connect()).accounts || phantom.accounts || [];
    var account = accounts.filter(function (a) { return a.address === admin; })[0] || accounts[0] || null;
    return {
      address: function () { return account ? account.address : null; },
      sign: async function (bytes) {
        var results = await phantom.features['solana:signAndSendTransaction'].signAndSendTransaction({ account: account, chain: 'solana:mainnet', transaction: bytes });
        return base58(results[0].signature);
      },
    };
  }

  function notFound() {
    show(connectButton, false); show(approveButton, false);
    say('Phantom not found. Open this address in the browser where the Phantom extension is installed and unlocked; Phantom works on http://127.0.0.1 pages. Nothing has been signed or sent.', 'bad');
  }
  // Only the dev wallet signs: any other account is refused before anything is asked of Phantom.
  function check() {
    var address = wallet && wallet.address();
    if (address === admin) {
      show(connectButton, false); show(approveButton, true);
      say('Connected as the dev wallet ' + admin + '. Check the ' + noun + ' above, then approve it.');
      return true;
    }
    show(approveButton, false); show(connectButton, true);
    say('Phantom is on ' + (address || 'no account') + ', not the dev wallet ' + admin + '. Switch to that account in Phantom, then connect again. Nothing is signed from another account.', 'bad');
    return false;
  }

  async function report(signature) {
    show(approveButton, false); show(againButton, false);
    say('Phantom sent it: ' + signature + '. The script is looking for it on chain; this can take a minute.');
    var res, body;
    try {
      res = await fetch('sent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature: signature }) });
      body = await res.json();
    } catch (error) {
      say('The script did not answer (it stops after its time, or was stopped). The signature is ' + signature + '. In the terminal, ' + rerun, 'bad');
      return;
    }
    if (res.ok) {
      say('Done. The script found ' + signature + ' on chain, signed by the dev wallet, and is checking the result: it is in the terminal. This page can be closed.', 'good');
      return;
    }
    say(body.message + ' (signature ' + signature + ')', 'bad');
    show(againButton, true); show(approveButton, true);
  }

  connectButton.onclick = async function () {
    connectButton.disabled = true;
    say('Connecting to Phantom…');
    try {
      wallet = await connect();
      if (!wallet) return notFound();
      check();
    } catch (error) {
      say('Phantom did not connect: ' + reason(error), 'bad');
      show(connectButton, true);
    }
  };
  approveButton.onclick = async function () {
    if (!check()) return;
    approveButton.disabled = true; againButton.hidden = true;
    try {
      say('Getting the ' + noun + ' from the script…');
      var res = await fetch('tx', { cache: 'no-store' }), text = await res.text();
      if (!res.ok) { var problem = text; try { problem = JSON.parse(text).message; } catch (e) {} throw new Error(problem); }
      say('Approve it in Phantom. Phantom shows what it does before you sign.');
      lastSignature = await wallet.sign(fromBase64(text));
    } catch (error) {
      say(error && error.code === 4001 ? 'You rejected it in Phantom. Nothing was sent.' : 'It did not go through: ' + reason(error), 'bad');
      show(approveButton, true);
      return;
    }
    report(lastSignature);
  };
  againButton.onclick = function () { if (lastSignature) report(lastSignature); };

  var tries = 0;
  (function look() {
    if (injected() || standard()) {
      show(connectButton, true);
      say('Phantom found. Connect it, on the dev wallet ' + admin + '.');
      return;
    }
    if (++tries >= 15) return notFound();
    setTimeout(look, 200);
  })();
})();
</script>
</body>
</html>
`;
}

export async function main(argv, log = console.log) {
  const { command, options } = parseCli(argv);
  if (!/^https?:\/\//.test(options.rpc)) throw new UsageError(`--rpc "${options.rpc}" is not an http(s) URL.`);
  return { snapshot: runSnapshot, open: runOpen, topup: runTopup }[command](options, log);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`migration: ${error.message}`);
    if (error instanceof UsageError) console.error(`\n${USAGE}`);
    process.exit(1);
  });
}
