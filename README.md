# Souvenir holder swap

The program that swaps the old $SOUVENIR for the new $SOUVENIR (the pump.fun coin), the scripts that build the snapshot it is based on, and
what you need to check all of it yourself. Program id: `42Ft9ioktrSK4zLpnqDFgNDdFoYZHQmUhgYothhNCN6J` (Solana mainnet).

The code here is copied from Souvenir's own source; only two import lines changed, so that the tree stands on its own. The site (souvenir.finance/migrate) and
the seller (the keeper step that sells the swapped old tokens) are not in this repo. They cannot change what the program does: they build transactions
for it, and the program checks every one.

## What the program does

- `initialize(root, old_total, deadline)`: the admin (the dev wallet) makes the swap's config and the vault, and names two token accounts for good:
  `old_destination` (where swapped old tokens go) and `unclaimed_destination` (where unclaimed new tokens go after the deadline).
- `open()`: the admin, once. It sets `new_total` to `old_total`, which fixes the rate at exactly 1 new token for each old one, whatever the vault holds.
- `swap(amount, entitled, proof)`: before the deadline, a holder sends `amount` old tokens and gets `amount * new_total / old_total` new tokens, that is
  `amount` itself, from the vault. `entitled` is the holder's line in the snapshot and `proof` its Merkle path to the root fixed at `initialize`; the program
  checks both, and that everything the wallet has swapped (its receipt) stays within `entitled`. The old tokens go from the holder straight to
  `old_destination`. If the vault holds fewer new tokens than the swap pays, it fails whole (`VaultShort`): nothing moves, and the same swap goes through
  once the vault holds enough.
- Adding to the vault takes no instruction: anyone can send new tokens to it with a plain token transfer. The vault opens with the team's dev buy, which
  covers most of the snapshot, and the team tops it up if it runs low; its balance is public (the vault is the config's associated account of the new mint).
- `settle()`: anyone, from the deadline on (2027-02-15 00:00 UTC, unix 1802649600). Every new token left in the vault goes to `unclaimed_destination`.

The root, the rate, the deadline and both destinations are fixed by `initialize` and `open`; no instruction changes them.

## What it does not do

- No instruction moves new tokens except `swap` (to the swapper) and `settle` (to `unclaimed_destination`). The admin has no withdraw, no pause and no way to
  change anything after `open`.
- The program never holds old tokens and has no say in what happens to them afterwards. The seller sells them into the old pool and the team's costs
  are repaid from the proceeds (announced separately, with a public ledger on /migrate).
- It does not check that the snapshot is honest. The root is the admin's input; the snapshot is checkable against the chain (below).
- It does not make anyone fill the vault. A swap it cannot pay waits for a top-up; the rate never changes.
- It does not decide what happens to the unclaimed tokens after `settle`. The team announces that separately.

## The program is upgradeable

The program stays upgradeable, so a bug can be fixed. An upgrade is the one way the rules fixed at `open` could change, so check the authority first:
`solana program show 42Ft9ioktrSK4zLpnqDFgNDdFoYZHQmUhgYothhNCN6J --url https://api.mainnet-beta.solana.com` prints `Authority`.

At deploy time it is the deploy key `21mi3qHN82ii4QauHLH823ZQp2Db5VZ4EkUR1TDbcLfZ`, a key made on the team's own machine for this program alone and never put on a server. It is not the dev wallet (the swap's admin, which signs the launch).

Every upgrade is rebuilt from this repo, verified with `solana-verify` (below), and announced with what changed and why, before or with the upgrade.

## Rebuild the program and compare it with the one on chain

You need Docker and [`solana-verify`](https://github.com/Ellipsis-Labs/solana-verifiable-build) (`cargo install solana-verify`). The program on chain is the container's
build: `solana-verify build` builds inside a pinned container, so everyone gets the same file whatever their machine, while a plain `cargo build-sbf` gives a
file that differs with the machine and toolchain (fine for the tests, not for this comparison).

The program is built with Solana 3.1.11, so name that container: `solana-verify`'s default pick for this code is an older one whose Cargo cannot build
it (it stops on `edition2024`).

```
cd programs/souvenir-swap
solana-verify build --library-name souvenir_swap --base-image solanafoundation/solana-verifiable-build:3.1.11
solana-verify get-executable-hash target/deploy/souvenir_swap.so
solana-verify get-program-hash --url https://api.mainnet-beta.solana.com 42Ft9ioktrSK4zLpnqDFgNDdFoYZHQmUhgYothhNCN6J
```

The last two lines must print the same hash. To have `solana-verify` do the whole check from the repo on GitHub, run it from anywhere:

```
solana-verify verify-from-repo --url https://api.mainnet-beta.solana.com --program-id 42Ft9ioktrSK4zLpnqDFgNDdFoYZHQmUhgYothhNCN6J \
  --mount-path programs/souvenir-swap --library-name souvenir_swap \
  --base-image solanafoundation/solana-verifiable-build:3.1.11 https://github.com/Souvenir-finance/Swap
```

On a Mac with Apple silicon Docker runs this x86 container under emulation; it works, only slower.

(`solana-verify <command> --help` is the reference if a flag has moved.)

## Check the snapshot

`snapshot/snapshot.csv` has one line per wallet: the wallet and what it held of the old coin at the snapshot (token accounts plus staking locks, in raw units: 6
decimals, so 1,000,000 is one token), and a label for the team's wallets. `snapshot/snapshot.json` has the same rows with the root, the total and the slots they were read
at. The root is stored in the program's config when the swap is initialized.

- **Row order is part of the root.** The Merkle tree is built over the rows in the order of the file (sorted by wallet address). Do not sort or reorder the CSV.
- A row's leaf is `sha256(0x00 || wallet(32 bytes) || amount(u64 little-endian))`, a node `sha256(0x01 || min(a,b) || max(a,b))` (`src/holderswap.mjs`, `src/merkle.mjs`).
- Left out of the snapshot, by design: the two old pools' accounts (`HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC`, `EiCR1fuipdPcTzfakdxXZXNXKQ4jLW7WTSe3wNmvmbKR`) and Souvenir's own wallets (`6pdsnYdpLyrWGSSucaZBui9izxQ7Ubg7bYesa8RQbZ7X`, `5QvWRsrghBRDSJyEpqipoewtjedkLuxBvGSYxg6bTbyF`, `ME3pEst3tfpeLPk2DK6r6DB1pK8cw7dVX5D81xijQWW`). They are listed in `scripts/migration.mjs`.
  A staking lock's coins count for the lock's owner, not for the lock's vault. The team's wallets swap like anyone's and are named in the announcement.

**Check your own line.** `npm install` once in the repo root, then, with your wallet in `WALLET`:

```
WALLET=<your wallet address> node --input-type=module - <<'EOF'
import { readFileSync } from 'node:fs';
import { leafOf, snapshotTree } from './src/holderswap.mjs';
import { verify } from './src/merkle.mjs';

const published = JSON.parse(readFileSync('snapshot/snapshot.json', 'utf8')).root;
const rows = readFileSync('snapshot/snapshot.csv', 'utf8').split('\n')
  .filter(line => line && !line.startsWith('#') && !line.startsWith('wallet,'))
  .map(line => { const [wallet, amount] = line.split(','); return { wallet, amount: BigInt(amount) }; });
const { root, proofOf } = snapshotTree(rows);              // rows in file order
console.log('root of snapshot.csv ', root.toString('hex'));
console.log('root in snapshot.json', published);
const row = rows.find(r => r.wallet === process.env.WALLET);
if (!row) throw new Error('that wallet is not in the snapshot');
const proof = proofOf(row.wallet);
const ok = verify(leafOf(row), proof, Buffer.from(published, 'hex'));
console.log(row.wallet, row.amount.toString(), 'raw units;', proof.length, 'proof nodes;', ok ? 'its line is under the root' : 'NOT UNDER THE ROOT');
EOF
```

The two roots must be equal and the last line must end with "its line is under the root". Then check that the root is the one the program holds: the swap's config
address is in the announcement (`open` prints it), and its root is what `decodeConfig` reads out of the account:

```
RPC=https://api.mainnet-beta.solana.com CONFIG=<config address> node --input-type=module - <<'EOF'
import { Connection, PublicKey } from '@solana/web3.js';
import { SWAP_PROGRAM_ID, decodeConfig } from './src/holderswap.mjs';

const info = await new Connection(process.env.RPC).getAccountInfo(new PublicKey(process.env.CONFIG));
if (!info || info.owner.toBase58() !== SWAP_PROGRAM_ID) throw new Error('that account is not owned by the swap program');
const { root, ...rest } = decodeConfig(info.data);
console.log('root in the program', root.toString('hex'));
console.log(rest);
EOF
```

It must print the same root, `opened: true`, and `newTotal` equal to `oldTotal` (1 new token for each old one).
To read the snapshot yourself, `node scripts/migration.mjs snapshot --rpc <url> --out <new directory>` runs the same code against the chain as it is now (the
numbers move as people trade); the slots in `snapshot.json` say when the published one was read.

## After the deadline: settle (anyone)

From 2027-02-15 00:00 UTC any wallet can call `settle`, which moves every new token left in the vault to `unclaimed_destination`; the program checks nothing about the
caller but the time. With the swap's config address (in the announcement) and the path of any funded keypair file (`PAYER`, which only pays the fee):

```
RPC=https://api.mainnet-beta.solana.com CONFIG=<config address> PAYER=<keypair file> node --input-type=module - <<'EOF'
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { SWAP_PROGRAM_ID, decodeConfig, settleInstruction } from './src/holderswap.mjs';

const connection = new Connection(process.env.RPC, 'confirmed');
const info = await connection.getAccountInfo(new PublicKey(process.env.CONFIG));
if (!info || info.owner.toBase58() !== SWAP_PROGRAM_ID) throw new Error('that account is not owned by the swap program');
const config = decodeConfig(info.data);
const newTokenProgram = (await connection.getAccountInfo(new PublicKey(config.newMint))).owner;
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.PAYER, 'utf8'))));
const { admin, oldMint, newMint, unclaimedDestination } = config;
const settle = settleInstruction({ programId: SWAP_PROGRAM_ID, admin, oldMint, newMint, newTokenProgram, unclaimedDestination });
console.log('settled:', await connection.sendTransaction(new Transaction().add(settle), [payer]));
EOF
```

Before the deadline the network refuses the transaction (the program's error is `BeforeDeadline`, "The swap has not ended yet") and nothing moves.

## Run the tests

You need Node 24 or newer, Rust with the Solana toolchain (`cargo build-sbf`).

```
npm install
(cd programs/souvenir-swap && cargo build-sbf)
npm test
```

The tests run the program on [LiteSVM](https://github.com/LiteSVM/litesvm), an in-memory Solana runtime whose clock can be moved. They build every
instruction with `src/holderswap.mjs`, the same builders the site and the owner's script use, and cover proofs, the per-wallet cap across partial
swaps, rounding, the deadline, old tokens landing in `old_destination`, `settle` called by a stranger, the admin being unable to touch new tokens, and a
Token-2022 new mint (pump.fun's).

## Layout

- `programs/souvenir-swap`: the program (`src/lib.rs`) and its tests.
- `src/holderswap.mjs`: the instructions, the accounts' layout and the snapshot's tree. `src/merkle.mjs`: the tree itself (`tree` and `verify`, unchanged from
  Souvenir's source). `src/snapshot.mjs` and `src/locks.mjs`: how the snapshot is read from the chain (`locks.mjs` is the part of Souvenir's staking code that reads a lock).
- `scripts/migration.mjs`: the owner's commands, `snapshot`, `open` and `topup` (which adds new tokens to the vault).

Some comments in these files mention Souvenir's app files (`src/tickets.mjs`, `src/stake.mjs`) and its design notes (`docs/specs/…`), which are not in this repo. The parts of the app files that the snapshot needs are `src/merkle.mjs` and `src/locks.mjs` here.
