'use strict';

const { PublicKey } = require('@solana/web3.js');
const bs58Module = require('bs58');
const { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync, unpackAccount, AccountLayout } = require('@solana/spl-token');

const VERSION = 'TOKEN_ACCOUNT_FUNDING_V1';
const PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
const bs58 = bs58Module.default || bs58Module;

function reject(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function key(value) {
  return new PublicKey(value?.pubkey ?? value).toBase58();
}

function integer(value, label = 'amount') {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) reject('INVALID_ACCOUNT_FUNDING', label);
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) reject('INVALID_ACCOUNT_FUNDING', label);
  return BigInt(text);
}

// RPC v0 receipts expose static + loaded keys; parsed receipts already include
// loaded keys. Validate the balance-vector length instead of appending twice.
function fullAccountKeys(receipt) {
  const message = receipt?.transaction?.message;
  const meta = receipt?.meta;
  if (!message || !meta || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)
    || meta.preBalances.length !== meta.postBalances.length) reject('INCOMPLETE_ACCOUNT_META');
  const base = message.accountKeys || message.staticAccountKeys;
  if (!Array.isArray(base) || !base.length) reject('INCOMPLETE_ACCOUNT_KEYS');
  let result = base.map(key);
  const loaded = [...(meta.loadedAddresses?.writable || []), ...(meta.loadedAddresses?.readonly || [])].map(key);
  if (result.length !== meta.preBalances.length) result = [...result, ...loaded];
  if (result.length !== meta.preBalances.length || new Set(result).size !== result.length) reject('INCOMPLETE_ACCOUNT_KEYS');
  for (const amount of [...meta.preBalances, ...meta.postBalances]) integer(amount);
  return result;
}

function canonicalCandidate(candidate, expectedOwner) {
  const owner = key(candidate?.owner);
  const address = key(candidate?.address ?? candidate?.account);
  const mint = key(candidate?.mint);
  const programId = key(candidate?.programId);
  if (owner !== key(expectedOwner) || !PROGRAMS.has(programId) || mint === NATIVE_MINT.toBase58()) reject('UNSAFE_TOKEN_ACCOUNT');
  const canonical = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, new PublicKey(programId));
  if (canonical.toBase58() !== address) reject('NON_CANONICAL_TOKEN_ACCOUNT');
  return { address, mint, owner, programId };
}

function transactionClosesTokenAccount(receipt, accountAddress) {
  const keys = fullAccountKeys(receipt);
  const message = receipt.transaction.message;
  const top = message.instructions || message.compiledInstructions;
  if (!Array.isArray(top) || !Array.isArray(receipt.meta.innerInstructions)) reject('ACCOUNT_LIFECYCLE_UNVERIFIED');
  const instructions = [...top];
  for (const group of receipt.meta.innerInstructions) {
    if (!Array.isArray(group?.instructions)) reject('ACCOUNT_LIFECYCLE_UNVERIFIED');
    instructions.push(...group.instructions);
  }
  for (const instruction of instructions) {
    const programId = instruction.programId ? key(instruction.programId) : keys[instruction.programIdIndex];
    if (!programId) reject('ACCOUNT_LIFECYCLE_UNVERIFIED');
    if (!PROGRAMS.has(programId)) continue;
    if (instruction.parsed) {
      if (instruction.parsed.type === 'closeAccount'
        && key(instruction.parsed.info?.account) === accountAddress) return true;
      continue;
    }
    const data = typeof instruction.data === 'string' ? Buffer.from(bs58.decode(instruction.data)) : Buffer.from(instruction.data || []);
    const accountIndexes = instruction.accounts || instruction.accountKeyIndexes;
    if (!data.length || !accountIndexes || !Number.isSafeInteger(Number(accountIndexes[0]))) reject('ACCOUNT_LIFECYCLE_UNVERIFIED');
    if (data[0] === 9 && keys[Number(accountIndexes[0])] === accountAddress) return true;
  }
  return false;
}

function tokenAccountFundingFromTransaction(receipt, ownerValue) {
  let owner;
  try { owner = key(ownerValue); } catch (_) { return { version: VERSION, verified: false, reason: 'INVALID_OWNER', accounts: [], netFundingLamports: null }; }
  const failure = (reason) => ({ version: VERSION, owner, verified: false, reason, accounts: [], netFundingLamports: null });
  try {
    const keys = fullAccountKeys(receipt);
    const meta = receipt.meta;
    const ownerIndex = keys.indexOf(owner);
    if (ownerIndex !== 0) return failure('OWNER_NOT_FEE_PAYER');
    if (!Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) return failure('INCOMPLETE_TOKEN_META');
    const fee = integer(meta.fee, 'fee');
    if (meta.err) {
      if (BigInt(meta.postBalances[0]) !== BigInt(meta.preBalances[0]) - fee
        || meta.preBalances.some((value, index) => index > 0 && BigInt(value) !== BigInt(meta.postBalances[index]))) return failure('FAILED_TX_UNEXPECTED_BALANCES');
      return { version: VERSION, owner, sourceSignature: receipt.transaction.signatures?.[0] || null,
        verified: true, failedTransaction: true, netFundingLamports: '0', accounts: [] };
    }
    const rows = new Map();
    for (const [field, balances] of [['pre', meta.preTokenBalances], ['post', meta.postTokenBalances]]) {
      const seen = new Set();
      for (const item of balances) {
        const index = item?.accountIndex;
        if (!Number.isSafeInteger(index) || index < 0 || index >= keys.length || seen.has(index)) return failure('INVALID_OR_DUPLICATE_TOKEN_META');
        seen.add(index);
        // Missing owner/program cannot be assumed to be a foreign account.
        const normalized = { mint: key(item.mint), owner: key(item.owner), programId: key(item.programId), raw: integer(item.uiTokenAmount?.amount).toString() };
        const row = rows.get(index) || {};
        if (row.pre || row.post) {
          const prior = row.pre || row.post;
          if (prior.mint !== normalized.mint || prior.owner !== normalized.owner || prior.programId !== normalized.programId) return failure('TOKEN_META_IDENTITY_CHANGED');
        }
        row[field] = normalized;
        rows.set(index, row);
      }
    }
    let netFunding = 0n;
    const accounts = [];
    const sourceSignature = receipt.transaction.signatures?.[0] || null;
    for (const [index, row] of rows) {
      const identity = row.post || row.pre;
      if (identity.owner !== owner || identity.mint === NATIVE_MINT.toBase58()) continue;
      const canonical = canonicalCandidate({ address: keys[index], ...identity }, owner);
      const pre = integer(meta.preBalances[index]);
      const post = integer(meta.postBalances[index]);
      const created = pre === 0n && post > 0n;
      const closed = pre > 0n && post === 0n;
      if ((pre > 0n && !row.pre) || (post > 0n && !row.post)
        || (created && row.pre) || (closed && row.post)) return failure('INCOMPLETE_ACCOUNT_LIFECYCLE_META');
      const delta = post - pre;
      netFunding += delta;
      accounts.push({ ...canonical, preLamports: pre.toString(), postLamports: post.toString(),
        deltaLamports: delta.toString(), created, closed, creationVerified: created,
        sourceSignature, preTokenRaw: row.pre?.raw ?? null, postTokenRaw: row.post?.raw ?? null });
    }
    return { version: VERSION, owner, sourceSignature, verified: true, netFundingLamports: netFunding.toString(), accounts };
  } catch (error) { return failure(error.code || 'MALFORMED_ACCOUNT_FUNDING_META'); }
}

function validateEmptyTokenAccount(candidate, info, expectedOwner) {
  const identity = canonicalCandidate(candidate, expectedOwner);
  if (!info || info.executable || key(info.owner) !== identity.programId || !Buffer.isBuffer(info.data)) reject('UNSAFE_TOKEN_ACCOUNT');
  // Fail closed on all Token-2022 extensions except the immutable-owner marker.
  // Transfer-fee/confidential balances may survive an apparent zero token amount.
  if (identity.programId === TOKEN_PROGRAM_ID.toBase58() && info.data.length !== 165) reject('UNSAFE_TOKEN_ACCOUNT_EXTENSION');
  if (info.data.length !== 165) {
    if (info.data.length !== 170 || info.data[165] !== 2 || info.data.readUInt16LE(166) !== 7 || info.data.readUInt16LE(168) !== 0) reject('UNSAFE_TOKEN_ACCOUNT_EXTENSION');
  }
  const raw = AccountLayout.decode(info.data.subarray(0, 165));
  if (![0, 1].includes(raw.delegateOption) || ![0, 1].includes(raw.closeAuthorityOption)
    || raw.isNativeOption !== 0 || raw.state !== 1) reject('UNSAFE_TOKEN_ACCOUNT_STATE');
  const account = unpackAccount(new PublicKey(identity.address), info, new PublicKey(identity.programId));
  if (!account.owner.equals(new PublicKey(identity.owner)) || !account.mint.equals(new PublicKey(identity.mint))
    || account.amount !== 0n || account.delegate || account.delegatedAmount !== 0n || account.isNative
    || account.closeAuthority && !account.closeAuthority.equals(new PublicKey(identity.owner))) reject('TOKEN_ACCOUNT_NOT_SAFELY_EMPTY');
  const refund = integer(info.lamports);
  if (refund <= 0n) reject('TOKEN_ACCOUNT_HAS_NO_REFUND');
  return { ...identity, refundLamports: refund.toString() };
}

module.exports = { VERSION, canonicalCandidate, fullAccountKeys, integer,
  tokenAccountFundingFromTransaction, transactionClosesTokenAccount, validateEmptyTokenAccount };
