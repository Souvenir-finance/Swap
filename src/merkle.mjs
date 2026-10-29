// src/merkle.mjs
// The Merkle tree the snapshot's root is over, copied unchanged from Souvenir's src/tickets.mjs (`tree` and `verify`; the same tree commits
// the draws' ticket lists). Leaves are src/holderswap.mjs `leafOf`; a node is
//   node = sha256(0x01 || min(a,b) || max(a,b))      (sorted pairs; a node without a sibling moves up as it is)
import { createHash } from 'node:crypto';

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const pair = (a, b) => (Buffer.compare(a, b) <= 0 ? sha256(Buffer.from([1]), a, b) : sha256(Buffer.from([1]), b, a));

/** A Merkle tree over the leaves (Buffers). `root` is a Buffer; `proof(i)` the sibling path of leaf i. */
export function tree(leaves) {
  if (!leaves.length) throw new Error('no leaves');
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const below = levels.at(-1), above = [];
    for (let i = 0; i < below.length; i += 2) above.push(i + 1 < below.length ? pair(below[i], below[i + 1]) : below[i]);
    levels.push(above);
  }
  const proof = index => {
    const path = [];
    for (let level = 0, i = index; level < levels.length - 1; level++, i = Math.floor(i / 2)) { const sibling = levels[level][i ^ 1]; if (sibling !== undefined) path.push(sibling); }
    return path;
  };
  return { root: levels.at(-1)[0], proof };
}
export const verify = (leaf, proof, root) => proof.reduce(pair, leaf).equals(root);
