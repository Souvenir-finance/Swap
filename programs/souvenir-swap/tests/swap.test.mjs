// The holder swap program on LiteSVM (an in-memory Solana runtime whose clock can be moved): `npm test` here, after `cargo build-sbf` in
// programs/souvenir-swap. The instructions come from the app's own builders (src/holderswap.mjs), so the server, the owner's script and
// the program are tested together. docs/specs/2026-10-28-token-migration.md §2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { LiteSVM, Clock } from 'litesvm';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, MINT_SIZE, getMintLen, AccountLayout,
  createInitializeMint2Instruction, createInitializeMetadataPointerInstruction, createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync, createMintToInstruction, createTransferCheckedInstruction,
} from '@solana/spl-token';
import {
  SWAP_PROGRAM_ID, configAddress, receiptAddress, newVaultAddress, snapshotTree, initializeInstruction, openInstruction, swapInstruction,
  settleInstruction, openInstructions, decodeConfig, decodeReceipt,
} from '../../../src/holderswap.mjs';

const PROGRAM = new PublicKey(SWAP_PROGRAM_ID);
const SO = fileURLToPath(new URL('../target/deploy/souvenir_swap.so', import.meta.url));
const T22 = TOKEN_2022_PROGRAM_ID;
const M = 1_000_000n; // one token (6 decimals, both coins)
/** The snapshot: what A, B and C held of the old coin. */
const ENTITLED = { A: 100n * M, B: 50n * M, C: 7n * M };
const OLD_TOTAL = 157n * M;
/** About what the dev buy gets: the new supply the dev wallet holds at launch, all of which `openInstructions` moves into the vault. */
const NEW = 793_100_000n * M;
const NOW = 1_793_232_000n; // 2026-10-29T00:00:00Z
const DEADLINE = 1_802_649_600n; // 2027-02-15T00:00:00Z, the real migration's
/** The new tokens a swap of `amount` old ones pays: the rate is fixed at exactly 1 at `open`, whatever the vault holds. */
const out = amount => amount;

const send = (svm, payer, ixs, signers = []) => {
  const tx = new Transaction();
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.add(...ixs);
  tx.sign(payer, ...signers);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  return res;
};
const ok = res => { assert.equal(typeof res.err, 'undefined', typeof res.err === 'function' ? `${res.toString()}\n${res.meta().prettyLogs()}` : ''); return res; };
const failed = (res, pattern) => {
  assert.equal(typeof res.err, 'function', 'expected the transaction to fail');
  if (pattern) assert.match(res.meta().logs().join('\n'), pattern);
};
const tokens = (svm, address) => { const a = svm.getAccount(address); return a ? AccountLayout.decode(Buffer.from(a.data)).amount : null; };
const at = (svm, unix) => { const c = svm.getClock(); svm.setClock(new Clock(c.slot + 1000n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unix)); };

/**
 * The world at launch: an old coin on classic SPL Token held by A, B and C (`held`, which may differ from the snapshot), a new coin on
 * Token-2022 with a metadata pointer (as pump.fun's create_v2 makes it) whose `newTotal` sits in the dev wallet (the swap's admin), and
 * the snapshot's tree.
 */
function world({ newTotal = NEW, held = { A: 150n * M, B: 50n * M, C: 7n * M } } = {}) {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM, SO);
  at(svm, NOW);
  const admin = Keypair.generate(), seller = Keypair.generate(), stranger = Keypair.generate();
  const holders = { A: Keypair.generate(), B: Keypair.generate(), C: Keypair.generate() };
  for (const kp of [admin, stranger, ...Object.values(holders)]) svm.airdrop(kp.publicKey, 10_000_000_000n);
  const rent = space => Number(svm.minimumBalanceForRentExemption(BigInt(space)));
  const oldMint = Keypair.generate(), newMint = Keypair.generate();
  const oldOf = owner => getAssociatedTokenAddressSync(oldMint.publicKey, owner.publicKey ?? owner);
  const newOf = owner => getAssociatedTokenAddressSync(newMint.publicKey, owner.publicKey ?? owner, false, T22);

  const oldIxs = [
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: oldMint.publicKey, space: MINT_SIZE, lamports: rent(MINT_SIZE), programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(oldMint.publicKey, 6, admin.publicKey, null),
  ];
  for (const [name, kp] of Object.entries(holders)) {
    oldIxs.push(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, oldOf(kp), kp.publicKey, oldMint.publicKey),
      createMintToInstruction(oldMint.publicKey, oldOf(kp), admin.publicKey, held[name]));
  }
  ok(send(svm, admin, oldIxs, [oldMint]));

  const space = getMintLen([ExtensionType.MetadataPointer]);
  ok(send(svm, admin, [
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: newMint.publicKey, space, lamports: rent(space), programId: T22 }),
    createInitializeMetadataPointerInstruction(newMint.publicKey, admin.publicKey, newMint.publicKey, T22),
    createInitializeMint2Instruction(newMint.publicKey, 6, admin.publicKey, null, T22),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, newOf(admin), admin.publicKey, newMint.publicKey, T22),
    createMintToInstruction(newMint.publicKey, newOf(admin), admin.publicKey, newTotal, [], T22),
  ], [newMint]));

  const snap = snapshotTree(Object.entries(ENTITLED).map(([name, amount]) => ({ wallet: holders[name].publicKey.toBase58(), amount })));
  const config = configAddress(PROGRAM, admin.publicKey, oldMint.publicKey, newMint.publicKey);
  return {
    svm, admin, seller, stranger, holders, snap, config, oldOf, newOf, oldMint: oldMint.publicKey, newMint: newMint.publicKey,
    vault: newVaultAddress(config, newMint.publicKey, T22), devNew: newOf(admin), sellerOld: oldOf(seller),
  };
}

/** What every builder takes to find the admin's config. */
const mints = w => ({ programId: PROGRAM, admin: w.admin.publicKey, oldMint: w.oldMint, newMint: w.newMint, newTokenProgram: T22 });
/** `initialize` alone, after the seller's old-token account is created (as openInstructions does). */
const initialize = (w, over = {}) => send(w.svm, w.admin, [
  createAssociatedTokenAccountIdempotentInstruction(w.admin.publicKey, w.sellerOld, w.seller.publicKey, w.oldMint),
  initializeInstruction({ ...mints(w), root: w.snap.root, oldTotal: OLD_TOTAL, deadline: DEADLINE,
    oldDestination: w.sellerOld, unclaimedDestination: w.devNew, ...over }),
]);
/** New tokens from the dev wallet into the vault. */
const fund = (w, amount) => send(w.svm, w.admin, [createTransferCheckedInstruction(w.devNew, w.newMint, w.vault, w.admin.publicKey, amount, 6, [], T22)]);
/** `open` on the admin's config, signed by `signer` (the admin by default). It reads no vault: only the admin and the config. */
const open = (w, signer = w.admin) => {
  const ix = openInstruction(mints(w));
  ix.keys[0] = { pubkey: signer.publicKey, isSigner: true, isWritable: false };
  return send(w.svm, signer, [ix]);
};
const opening = (w, devBalance = NEW) => openInstructions({
  ...mints(w), oldTokenProgram: TOKEN_PROGRAM_ID, root: w.snap.root, oldTotal: OLD_TOTAL, deadline: DEADLINE,
  seller: w.seller.publicKey, devBalance,
});
/** The whole opening in one transaction, as the owner's script sends it. */
const opened = (w, devBalance = NEW) => ok(send(w.svm, w.admin, opening(w, devBalance)));
/** `name`'s swap of `amount` with their own leaf and proof, signed by `signer` (`name` by default). */
const swap = (w, name, amount, { signer = w.holders[name], ...over } = {}) => send(w.svm, signer, [swapInstruction({
  ...mints(w), holder: signer.publicKey, oldTokenProgram: TOKEN_PROGRAM_ID, oldDestination: w.sellerOld, amount,
  entitled: ENTITLED[name], proof: w.snap.proofOf(w.holders[name].publicKey), ...over,
})]);
const settle = (w, payer, unclaimedDestination = w.devNew) => send(w.svm, payer, [settleInstruction({ ...mints(w), unclaimedDestination })]);
const configOf = w => decodeConfig(w.svm.getAccount(w.config).data);

test('a holder swaps part, then the rest, never past the snapshot', () => {
  // A holds more now than at the snapshot; B sold 20 of its 50 since.
  const w = world({ held: { A: 150n * M, B: 30n * M, C: 7n * M } });
  opened(w);
  ok(swap(w, 'A', 40n * M));
  assert.equal(tokens(w.svm, w.newOf(w.holders.A)), out(40n * M));
  ok(swap(w, 'A', 60n * M));
  assert.equal(tokens(w.svm, w.newOf(w.holders.A)), out(40n * M) + out(60n * M));
  assert.deepEqual(decodeReceipt(w.svm.getAccount(receiptAddress(PROGRAM, w.config, w.holders.A.publicKey)).data), { swapped: 100n * M });
  failed(swap(w, 'A', 1n), /OverEntitled/);
  assert.equal(tokens(w.svm, w.oldOf(w.holders.A)), 50n * M, 'A keeps what it held beyond the snapshot');
  assert.equal(tokens(w.svm, w.sellerOld), 100n * M, 'the old tokens went straight to the seller');

  // B swaps the 30 it still holds, buys 25 back, and can swap only the 20 left of its 50.
  ok(swap(w, 'B', 30n * M));
  ok(send(w.svm, w.holders.A, [createTransferCheckedInstruction(w.oldOf(w.holders.A), w.oldMint, w.oldOf(w.holders.B), w.holders.A.publicKey, 25n * M, 6)]));
  failed(swap(w, 'B', 25n * M), /OverEntitled/);
  ok(swap(w, 'B', 20n * M));
  assert.equal(decodeReceipt(w.svm.getAccount(receiptAddress(PROGRAM, w.config, w.holders.B.publicKey)).data).swapped, 50n * M);
  assert.equal(tokens(w.svm, w.newOf(w.holders.B)), out(30n * M) + out(20n * M));

  assert.equal(configOf(w).swappedOld, 150n * M);
  assert.equal(tokens(w.svm, w.sellerOld), 150n * M);
  assert.equal(tokens(w.svm, w.vault), NEW - out(40n * M) - out(60n * M) - out(30n * M) - out(20n * M));
  assert.equal(w.svm.getAccount(getAssociatedTokenAddressSync(w.oldMint, w.config, true)), null, 'the program never holds old tokens');
});

test('a wrong proof or another wallet\'s leaf fails', () => {
  const w = world();
  opened(w);
  ok(send(w.svm, w.holders.A, [ // the stranger holds old tokens too, but was not in the snapshot
    createAssociatedTokenAccountIdempotentInstruction(w.holders.A.publicKey, w.oldOf(w.stranger), w.stranger.publicKey, w.oldMint),
    createTransferCheckedInstruction(w.oldOf(w.holders.A), w.oldMint, w.oldOf(w.stranger), w.holders.A.publicKey, 10n * M, 6),
  ]));
  const bent = w.snap.proofOf(w.holders.A.publicKey).map(b => Buffer.from(b));
  bent[0][0] ^= 1;
  failed(swap(w, 'A', M, { proof: w.snap.proofOf(w.holders.B.publicKey) }), /BadProof/); // another wallet's path
  failed(swap(w, 'A', M, { entitled: 101n * M }), /BadProof/); // more than its leaf says
  failed(swap(w, 'A', M, { proof: bent }), /BadProof/);
  failed(swap(w, 'A', M, { signer: w.holders.B }), /BadProof/); // B signing with A's leaf and proof
  failed(swap(w, 'A', M, { signer: w.stranger }), /BadProof/); // a wallet not in the snapshot, with A's
  failed(swap(w, 'A', M, { signer: w.stranger, entitled: 10n * M, proof: [] }), /BadProof/);
  // A good proof, but the old tokens named to go anywhere but the seller's account: A's own, or the stranger's.
  failed(swap(w, 'A', M, { oldDestination: w.oldOf(w.holders.A) }), /WrongDestination/);
  failed(swap(w, 'A', M, { oldDestination: w.oldOf(w.stranger) }), /WrongDestination/);
  assert.equal(tokens(w.svm, w.vault), NEW);
  assert.equal(tokens(w.svm, w.sellerOld), 0n);
  assert.equal(tokens(w.svm, w.oldOf(w.stranger)), 10n * M);
  ok(swap(w, 'A', M));
});

test('a swap of nothing fails', () => {
  const w = world();
  opened(w);
  failed(swap(w, 'A', 0n), /NothingOut/);
  assert.equal(tokens(w.svm, w.oldOf(w.holders.A)), 150n * M, 'no old tokens taken for nothing');
  ok(swap(w, 'A', 1n));
  assert.equal(tokens(w.svm, w.newOf(w.holders.A)), 1n, 'one raw unit pays one raw unit');
});

test('nothing swaps before open, and open runs once', () => {
  const w = world();
  ok(initialize(w));
  ok(fund(w, NEW));
  failed(swap(w, 'A', M), /NotOpen/);
  failed(open(w, w.stranger), /ConstraintHasOne/); // only the admin opens
  ok(open(w));
  failed(open(w), /AlreadyOpen/);
  ok(swap(w, 'A', M));
  assert.equal(tokens(w.svm, w.newOf(w.holders.A)), out(M));
});

test('open fixes the rate at exactly 1 whatever the vault holds: below the total, or nothing', () => {
  const w = world();
  failed(initialize(w, { oldTotal: 0n }), /NothingOut/); // nor does an empty snapshot set one up
  ok(initialize(w));
  ok(fund(w, 120n * M)); // the dev buy got less than the snapshot's 157
  assert.deepEqual(openInstruction(mints(w)).keys.map(k => k.pubkey.toBase58()), [w.admin.publicKey.toBase58(), w.config.toBase58()],
    'open takes the admin and the config: no vault to read');
  ok(open(w));
  assert.equal(configOf(w).newTotal, OLD_TOTAL, 'new total = old total: 1 new token for each old one');
  assert.equal(tokens(w.svm, w.vault), 120n * M, 'the vault keeps what was put in');
  ok(swap(w, 'A', 40n * M));
  assert.equal(tokens(w.svm, w.newOf(w.holders.A)), 40n * M);
  ok(fund(w, 1_000n * M)); // more after open changes no rate: it pays swaps, and what is left leaves at settle
  assert.equal(configOf(w).newTotal, OLD_TOTAL);

  // Opened with nothing in the vault: still 1:1, and every swap waits for new tokens.
  const v = world();
  ok(initialize(v));
  ok(open(v));
  assert.equal(configOf(v).newTotal, OLD_TOTAL);
  failed(swap(v, 'A', M), /VaultShort/);
  ok(fund(v, M));
  ok(swap(v, 'A', M));
});

test('a swap the vault cannot cover fails with VaultShort and moves nothing; a plain transfer in, and the same swap goes through', () => {
  // The dev wallet holds the whole 157, but the opening puts only 120 in the vault (what the dev buy got); 37 stay for a top-up.
  const w = world({ newTotal: OLD_TOTAL });
  opened(w, 120n * M);
  assert.equal(configOf(w).newTotal, OLD_TOTAL);
  ok(swap(w, 'A', 100n * M)); // covered: 20 left in the vault
  assert.equal(tokens(w.svm, w.vault), 20n * M);
  const before = { config: configOf(w), old: tokens(w.svm, w.oldOf(w.holders.B)), seller: tokens(w.svm, w.sellerOld) };
  failed(swap(w, 'B', 30n * M), /VaultShort/);
  assert.equal(tokens(w.svm, w.oldOf(w.holders.B)), before.old, 'B keeps its old tokens');
  assert.equal(tokens(w.svm, w.sellerOld), before.seller, 'nothing reached the seller');
  assert.equal(tokens(w.svm, w.vault), 20n * M, 'the vault is untouched');
  assert.equal(tokens(w.svm, w.newOf(w.holders.B)), null, 'B got nothing, not even its new token account');
  assert.equal(w.svm.getAccount(receiptAddress(PROGRAM, w.config, w.holders.B.publicKey)), null, 'and no receipt');
  assert.deepEqual(configOf(w), before.config, 'nothing counted as swapped');

  // A plain token transfer into the vault, no instruction of the program's: the same swap now lands.
  ok(fund(w, 37n * M));
  ok(swap(w, 'B', 30n * M));
  assert.equal(tokens(w.svm, w.newOf(w.holders.B)), 30n * M);
  assert.equal(tokens(w.svm, w.vault), 27n * M);
  ok(swap(w, 'C', 7n * M));
  ok(swap(w, 'B', 20n * M)); // exactly what is left
  assert.equal(tokens(w.svm, w.vault), 0n);
  failed(swap(w, 'A', 1n), /OverEntitled/); // the cap still comes first
  assert.equal(configOf(w).swappedOld, OLD_TOTAL);
});

test('settle sweeps whatever is in the vault: the opening\'s rest and any top-up', () => {
  const w = world({ newTotal: OLD_TOTAL });
  opened(w, 100n * M);
  ok(swap(w, 'A', 90n * M));
  ok(fund(w, 50n * M)); // a top-up after the opening
  ok(swap(w, 'B', 50n * M));
  const left = tokens(w.svm, w.vault);
  assert.equal(left, 10n * M);
  at(w.svm, DEADLINE);
  ok(fund(w, 7n * M)); // a transfer in even after the deadline leaves with the rest
  ok(settle(w, w.stranger));
  assert.equal(tokens(w.svm, w.vault), 0n);
  assert.equal(tokens(w.svm, w.devNew), left + 7n * M);
});

test('swaps stop at the deadline; settle runs only after it', () => {
  const w = world();
  failed(initialize(w, { deadline: NOW }), /PastDeadline/); // a swap cannot be set up already over
  opened(w);
  at(w.svm, DEADLINE - 1n);
  failed(settle(w, w.stranger), /BeforeDeadline/);
  ok(swap(w, 'A', 10n * M));
  at(w.svm, DEADLINE);
  failed(swap(w, 'A', 10n * M), /PastDeadline/);
  ok(settle(w, w.stranger));
  assert.equal(tokens(w.svm, w.devNew), NEW - out(10n * M));

  // A swap set up but never opened: open is refused once the deadline passes, and settle hands the vault back.
  const v = world();
  ok(initialize(v));
  ok(fund(v, NEW));
  at(v.svm, DEADLINE);
  failed(open(v), /PastDeadline/);
  ok(settle(v, v.stranger));
  assert.equal(tokens(v.svm, v.devNew), NEW);
});

test('anyone can settle, and only to the unclaimed destination', () => {
  const w = world();
  opened(w);
  ok(swap(w, 'A', 100n * M));
  at(w.svm, DEADLINE);
  const strangerNew = w.newOf(w.stranger);
  ok(send(w.svm, w.stranger, [createAssociatedTokenAccountIdempotentInstruction(w.stranger.publicKey, strangerNew, w.stranger.publicKey, w.newMint, T22)]));
  failed(settle(w, w.stranger, strangerNew), /WrongDestination/);
  failed(settle(w, w.stranger, w.newOf(w.holders.A)), /WrongDestination/);
  const left = NEW - out(100n * M);
  assert.equal(tokens(w.svm, w.vault), left);
  const ix = settleInstruction({ ...mints(w), unclaimedDestination: w.devNew });
  assert.ok(ix.keys.every(k => !k.isSigner), 'settle needs no signature: the stranger only pays the fee');
  ok(settle(w, w.stranger));
  assert.equal(tokens(w.svm, w.vault), 0n);
  assert.equal(tokens(w.svm, w.devNew), left);
  assert.equal(tokens(w.svm, strangerNew), 0n);
  failed(settle(w, w.stranger), /NothingOut/);
});

test('the admin cannot take new tokens any other way', () => {
  const w = world();
  opened(w);
  const before = configOf(w);
  // The admin holds old tokens and its own one-leaf tree claiming all of them.
  const adminOld = w.oldOf(w.admin);
  ok(send(w.svm, w.admin, [createAssociatedTokenAccountIdempotentInstruction(w.admin.publicKey, adminOld, w.admin.publicKey, w.oldMint),
    createMintToInstruction(w.oldMint, adminOld, w.admin.publicKey, OLD_TOTAL)]));
  const own = snapshotTree([{ wallet: w.admin.publicKey.toBase58(), amount: OLD_TOTAL }]);

  failed(initialize(w, { root: own.root, oldDestination: adminOld }), /already in use/); // the config exists: it is never made again
  failed(open(w), /AlreadyOpen/);
  failed(swap(w, 'A', OLD_TOTAL, { signer: w.admin, entitled: OLD_TOTAL, proof: own.proofOf(w.admin.publicKey) }), /BadProof/);
  failed(settle(w, w.admin), /BeforeDeadline/);
  failed(send(w.svm, w.admin, [createTransferCheckedInstruction(w.vault, w.newMint, w.devNew, w.admin.publicKey, 1n, 6, [], T22)]), /owner does not match/i);

  assert.equal(tokens(w.svm, w.vault), NEW);
  assert.deepEqual(configOf(w), before, 'nothing about the swap changed');
});

test('openInstructions opens a working swap in one transaction', () => {
  const w = world();
  const ixs = opening(w);
  assert.deepEqual(ixs.map(ix => ix.programId.toBase58()),
    [ASSOCIATED_TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, PROGRAM, T22, PROGRAM].map(p => p.toBase58()));
  ok(send(w.svm, w.admin, ixs));
  assert.deepEqual(configOf(w), {
    admin: w.admin.publicKey.toBase58(), oldMint: w.oldMint.toBase58(), newMint: w.newMint.toBase58(), root: w.snap.root, oldTotal: OLD_TOTAL,
    newTotal: OLD_TOTAL, deadline: Number(DEADLINE), swappedOld: 0n, oldDestination: w.sellerOld.toBase58(), unclaimedDestination: w.devNew.toBase58(),
    opened: true,
  });
  assert.equal(tokens(w.svm, w.vault), NEW);
  assert.equal(tokens(w.svm, w.devNew), 0n, 'the dev wallet holds none after the transaction');
  assert.equal(tokens(w.svm, w.sellerOld), 0n, 'the seller\'s old-token account exists');
  ok(swap(w, 'A', 10n * M));
  assert.equal(tokens(w.svm, w.newOf(w.holders.A)), out(10n * M));
  assert.equal(tokens(w.svm, w.sellerOld), 10n * M);
  assert.equal(decodeConfig(Buffer.alloc(10)), null);
  assert.equal(decodeReceipt(w.svm.getAccount(w.config).data), null);
});

test('another wallet initializing the same pair gets its own config, and the admin still opens', () => {
  const w = world(), squatter = w.stranger;
  const theirs = configAddress(PROGRAM, squatter.publicKey, w.oldMint, w.newMint);
  assert.notEqual(theirs.toBase58(), w.config.toBase58());
  const own = snapshotTree([{ wallet: squatter.publicKey.toBase58(), amount: OLD_TOTAL }]);
  ok(send(w.svm, squatter, [
    createAssociatedTokenAccountIdempotentInstruction(squatter.publicKey, w.oldOf(squatter), squatter.publicKey, w.oldMint),
    createAssociatedTokenAccountIdempotentInstruction(squatter.publicKey, w.newOf(squatter), squatter.publicKey, w.newMint, T22),
    initializeInstruction({ ...mints(w), admin: squatter.publicKey, root: own.root, oldTotal: OLD_TOTAL, deadline: DEADLINE,
      oldDestination: w.oldOf(squatter), unclaimedDestination: w.newOf(squatter) }),
  ]));
  assert.equal(decodeConfig(w.svm.getAccount(theirs).data).admin, squatter.publicKey.toBase58());
  assert.equal(w.svm.getAccount(w.config), null, 'the admin\'s config is still free');
  opened(w);
  assert.equal(configOf(w).admin, w.admin.publicKey.toBase58());
  assert.equal(tokens(w.svm, w.vault), NEW);
  ok(swap(w, 'A', 10n * M));
  assert.equal(tokens(w.svm, w.newOf(w.holders.A)), out(10n * M));
});
