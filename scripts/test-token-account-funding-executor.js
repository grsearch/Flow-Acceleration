'use strict';

const assert = require('assert');
const { Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync } = require('@solana/spl-token');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;
const { PumpTradeExecutor, walletSolSettlementFromTransaction } = require('../src/core/PumpTradeExecutor');
const { tokenAccountFundingFromTransaction, transactionClosesTokenAccount,
  validateEmptyTokenAccount } = require('../src/core/TokenAccountFunding');

const signer = Keypair.fromSeed(Buffer.alloc(32, 41));
const owner = signer.publicKey.toBase58();
const mint = Keypair.fromSeed(Buffer.alloc(32, 42)).publicKey.toBase58();
const programId = TOKEN_2022_PROGRAM_ID.toBase58();
const address = getAssociatedTokenAddressSync(new PublicKey(mint), signer.publicKey, false, TOKEN_2022_PROGRAM_ID).toBase58();
const signature = bs58.encode(Buffer.alloc(64, 3));
const candidate = { address, mint, owner, programId, creationVerified: true,
  sourceSignature: signature, fundedLamports: '1887234' };
const clone = (value) => JSON.parse(JSON.stringify(value));

function receipt() {
  return { slot: 100, transaction: { signatures: [signature], message: {
    staticAccountKeys: [signer.publicKey, TOKEN_2022_PROGRAM_ID],
  } }, meta: { err: null, fee: 105000,
    loadedAddresses: { writable: [new PublicKey(address)], readonly: [] },
    preBalances: [100000000, 0, 0], postBalances: [78007766, 0, 1887234],
    preTokenBalances: [], postTokenBalances: [{ accountIndex: 2, mint, owner, programId,
      uiTokenAmount: { amount: '9000000', decimals: 6 } }] } };
}

function accountInfo(amount = 0n, overrides = {}) {
  const data = Buffer.alloc(170);
  AccountLayout.encode({ mint: new PublicKey(mint), owner: signer.publicKey, amount,
    delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    ...overrides }, data);
  data[165] = 2;
  data.writeUInt16LE(7, 166);
  return { owner: TOKEN_2022_PROGRAM_ID, data, lamports: 1887234, executable: false };
}

function assertFunding() {
  const data = receipt();
  let result = tokenAccountFundingFromTransaction(data, owner);
  assert.strictEqual(result.verified, true);
  assert.strictEqual(result.netFundingLamports, '1887234');
  assert.strictEqual(result.accounts[0].creationVerified, true);
  assert.strictEqual(result.accounts[0].preTokenRaw, null);
  assert.strictEqual(result.accounts[0].postTokenRaw, '9000000');
  assert.strictEqual(result.accounts[0].sourceSignature, signature);
  const settlement = walletSolSettlementFromTransaction(data, owner);
  assert.strictEqual(settlement.wallet, owner);
  assert.strictEqual(settlement.accountFunding.verified, true);
  assert.strictEqual(settlement.walletSolDelta, -0.021992234);
  assert.strictEqual(settlement.networkFeeSol, 0.000105);

  const parsed = clone(data);
  parsed.transaction.message = { accountKeys: [owner, programId, address] };
  result = tokenAccountFundingFromTransaction(parsed, owner);
  assert.strictEqual(result.netFundingLamports, '1887234', 'already resolved loaded keys cannot be appended twice');
  const duplicate = clone(parsed);
  duplicate.meta.postTokenBalances.push(duplicate.meta.postTokenBalances[0]);
  assert.strictEqual(tokenAccountFundingFromTransaction(duplicate, owner).verified, false);
  const missing = clone(parsed);
  delete missing.meta.postTokenBalances[0].programId;
  assert.strictEqual(tokenAccountFundingFromTransaction(missing, owner).verified, false);
  const malformed = clone(parsed);
  malformed.meta.postBalances.pop();
  assert.strictEqual(tokenAccountFundingFromTransaction(malformed, owner).verified, false);
  const changed = clone(parsed);
  changed.meta.preTokenBalances = [{ ...changed.meta.postTokenBalances[0], mint: PublicKey.unique().toBase58() }];
  assert.strictEqual(tokenAccountFundingFromTransaction(changed, owner).verified, false);

  const wsol = clone(parsed);
  wsol.transaction.message.accountKeys[2] = getAssociatedTokenAddressSync(NATIVE_MINT, signer.publicKey).toBase58();
  wsol.meta.postTokenBalances[0].mint = NATIVE_MINT.toBase58();
  wsol.meta.postTokenBalances[0].programId = TOKEN_PROGRAM_ID.toBase58();
  assert.strictEqual(tokenAccountFundingFromTransaction(wsol, owner).netFundingLamports, '0');
  const closed = clone(parsed);
  closed.meta.preBalances = [100000000, 0, 1887234];
  closed.meta.postBalances = [101782234, 0, 0];
  closed.meta.preTokenBalances = [{ ...closed.meta.postTokenBalances[0], uiTokenAmount: { amount: '0' } }];
  closed.meta.postTokenBalances = [];
  assert.strictEqual(tokenAccountFundingFromTransaction(closed, owner).netFundingLamports, '-1887234');
  assert.strictEqual(tokenAccountFundingFromTransaction(closed, owner).accounts[0].closed, true);
  const failed = clone(parsed);
  failed.meta.err = { InstructionError: [2, 'Custom'] };
  failed.meta.postBalances = [99895000, 0, 0];
  failed.meta.postTokenBalances = [];
  const failedSettlement = walletSolSettlementFromTransaction(failed, owner);
  assert.strictEqual(failedSettlement.walletSolDelta, -0.000105);
  assert.strictEqual(failedSettlement.accountFunding.netFundingLamports, '0');
  assert.strictEqual(failedSettlement.accountFunding.verified, true);
  assert.strictEqual(failedSettlement.accountFunding.sourceSignature, signature);
}

async function assertCleanup() {
  const executor = Object.create(PumpTradeExecutor.prototype);
  executor.signer = signer;
  let sendCalls = 0;
  let cleanupReceipt = null;
  let currentInfo = accountInfo();
  let currentSlot = 101;
  let height = 190;
  let status = null;
  let statusContext = 102;
  let source = receipt();
  let laterReceipt = null;
  let fee = 105000;
  let history = [{ signature }];
  let latestCalls = 0;
  const reads = [];
  executor.connection = {
    async getTransaction(sig, config) {
      reads.push(config);
      if (sig === signature) return source;
      if (sig === bs58.encode(Buffer.alloc(64, 4))) return laterReceipt;
      return cleanupReceipt;
    },
    async getAccountInfoAndContext(account, config) {
      assert.strictEqual(account.toBase58(), address);
      assert.strictEqual(config.commitment, 'finalized');
      assert.strictEqual(config.minContextSlot, 100);
      return { context: { slot: currentSlot }, value: currentInfo };
    },
    async getLatestBlockhash(config) {
      latestCalls += 1;
      assert.strictEqual(config.commitment, 'finalized');
      return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 200 };
    },
    async getFeeForMessage(message, commitment) { assert.strictEqual(commitment, 'finalized'); return { value: fee }; },
    async getSignaturesForAddress(account, config, commitment) {
      assert.strictEqual(account.toBase58(), address);
      assert.strictEqual(config.limit, 32);
      assert.strictEqual(commitment, 'finalized');
      return history;
    },
    async sendRawTransaction(raw, options) {
      sendCalls += 1;
      assert.strictEqual(options.skipPreflight, false);
      assert.strictEqual(options.maxRetries, 0);
      assert.strictEqual(options.preflightCommitment, 'finalized');
      return bs58.encode(Transaction.from(raw).signature);
    },
    async getBlockHeight(commitment) { assert.strictEqual(commitment, 'finalized'); return height; },
    async getSlot(commitment) { assert.strictEqual(commitment, 'finalized'); return 102; },
    async getSignatureStatuses(sigs, config) {
      assert.strictEqual(config.searchTransactionHistory, true);
      return { context: { slot: statusContext }, value: [status] };
    },
  };
  assert.strictEqual(validateEmptyTokenAccount(candidate, currentInfo, owner).refundLamports, '1887234');
  assert.throws(() => validateEmptyTokenAccount(candidate, accountInfo(1n), owner), /TOKEN_ACCOUNT_NOT_SAFELY_EMPTY/);
  assert.throws(() => validateEmptyTokenAccount(candidate, accountInfo(0n, { delegateOption: 1, delegate: signer.publicKey }), owner));
  assert.throws(() => validateEmptyTokenAccount(candidate, accountInfo(0n, { closeAuthorityOption: 1, closeAuthority: PublicKey.unique() }), owner));
  assert.throws(() => validateEmptyTokenAccount(candidate, accountInfo(0n, { state: 2 }), owner));
  const unsafe = accountInfo();
  unsafe.data.writeUInt16LE(2, 166);
  assert.throws(() => validateEmptyTokenAccount(candidate, unsafe, owner), /UNSAFE_TOKEN_ACCOUNT_EXTENSION/);
  const malformedTlv = accountInfo();
  malformedTlv.data = Buffer.concat([malformedTlv.data, Buffer.from([0])]);
  assert.throws(() => validateEmptyTokenAccount(candidate, malformedTlv, owner));
  await assert.rejects(executor.prepareEmptyTokenAccountClose({ ...candidate, owner: PublicKey.unique().toBase58() }));
  await assert.rejects(executor.prepareEmptyTokenAccountClose({ ...candidate, address: mint }));
  await assert.rejects(executor.prepareEmptyTokenAccountClose({ ...candidate, creationVerified: false }));
  source = null;
  await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code: 'ACCOUNT_CREATION_UNVERIFIED' });
  source = receipt();
  currentInfo = accountInfo(2n);
  await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code: 'TOKEN_ACCOUNT_NOT_SAFELY_EMPTY' });
  currentInfo = accountInfo(); currentInfo.lamports += 1;
  await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code: 'ACCOUNT_FUNDING_CHANGED' });
  currentInfo = accountInfo(); currentSlot = 99;
  await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code: 'ACCOUNT_CONTEXT_STALE' });
  currentSlot = 101; currentInfo = null;
  assert.strictEqual((await executor.prepareEmptyTokenAccountClose(candidate)).status, 'ABSENT');
  currentInfo = accountInfo(); fee = 200000;
  await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code: 'CLEANUP_FEE_TOO_HIGH' });
  fee = 105000;
  history = [];
  await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code: 'ACCOUNT_HISTORY_TRUNCATED' });
  history = [{ signature: bs58.encode(Buffer.alloc(64, 4)) }, { signature }];
  await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code: 'ACCOUNT_LIFECYCLE_UNVERIFIED' });
  laterReceipt = clone(receipt());
  laterReceipt.transaction.signatures = [history[0].signature];
  laterReceipt.transaction.message.instructions = [];
  laterReceipt.meta.innerInstructions = [];
  laterReceipt.meta.preBalances[2] = 1887234;
  assert.strictEqual((await executor.prepareEmptyTokenAccountClose(candidate)).status, 'READY');
  laterReceipt.meta.postBalances[2] = 0;
  await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code: 'ACCOUNT_LIFECYCLE_CHANGED' });
  // Same-transaction close/recreate can preserve all final balances. The inner
  // CloseAccount instruction must still invalidate the old account identity.
  laterReceipt.meta.postBalances[2] = 1887234;
  laterReceipt.meta.innerInstructions = [{ index: 0, instructions: [{ programIdIndex: 1,
    accounts: [2, 0, 0], data: bs58.encode(Buffer.from([9])) }] }];
  assert.strictEqual(transactionClosesTokenAccount(laterReceipt, address), true);
  await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code: 'ACCOUNT_LIFECYCLE_CHANGED' });
  laterReceipt.meta.innerInstructions = [{ index: 0, instructions: [{ programId,
    parsed: { type: 'closeAccount', info: { account: address } } }] }];
  assert.strictEqual(transactionClosesTokenAccount(laterReceipt, address), true);
  laterReceipt = null;
  history = [{ signature }];
  const historyReader = executor.connection.getSignaturesForAddress;
  let resolveHistory;
  let enteredHistory;
  const historyEntered = new Promise(resolve => { enteredHistory = resolve; });
  executor.connection.getSignaturesForAddress = async () => {
    enteredHistory();
    return new Promise(resolve => { resolveHistory = resolve; });
  };
  const controller = new AbortController();
  const callsBeforeAbort = latestCalls;
  const timedOutPrepare = executor.prepareEmptyTokenAccountClose(candidate, { signal: controller.signal });
  await historyEntered;
  controller.abort();
  resolveHistory(history);
  await assert.rejects(timedOutPrepare, { code: 'ACCOUNT_RECOVERY_ABORTED' });
  assert.strictEqual(latestCalls, callsBeforeAbort, 'a late RPC cannot continue to blockhash/fee/sign after timeout');
  assert.strictEqual(sendCalls, 0);
  executor.connection.getSignaturesForAddress = historyReader;
  const prepared = await executor.prepareEmptyTokenAccountClose(candidate);
  assert.strictEqual(sendCalls, 0, 'prepare must not send');
  assert.strictEqual(prepared.status, 'READY');
  assert.strictEqual(prepared.expectedRefundLamports, '1887234');
  await assert.rejects(executor.sendPreparedTokenAccountClose({ ...prepared, owner: mint }));
  await assert.rejects(executor.sendPreparedTokenAccountClose({ ...prepared, signature }));
  const malicious = Transaction.from(Buffer.from(prepared.rawTransactionBase64, 'base64'));
  malicious.instructions[2].data = Buffer.from([1]);
  malicious.sign(signer);
  await assert.rejects(executor.sendPreparedTokenAccountClose({ ...prepared,
    signature: bs58.encode(malicious.signature), rawTransactionBase64: malicious.serialize().toString('base64') }));
  assert.strictEqual(sendCalls, 0);
  const sent = await executor.sendPreparedTokenAccountClose(prepared);
  assert.strictEqual(sent.signature, prepared.signature);
  assert.strictEqual(sendCalls, 1);
  const abortedReconcile = new AbortController(); abortedReconcile.abort();
  const readCount = reads.length;
  await assert.rejects(executor.reconcileTokenAccountClose(prepared, { signal: abortedReconcile.signal }), { code: 'ACCOUNT_RECOVERY_ABORTED' });
  assert.strictEqual(reads.length, readCount);
  assert.strictEqual((await executor.reconcileTokenAccountClose(prepared)).status, 'PENDING');
  height = 201; statusContext = 101;
  assert.strictEqual((await executor.reconcileTokenAccountClose(prepared)).status, 'PENDING', 'stale null status is not expiry');
  statusContext = 102; status = { confirmationStatus: 'processed' };
  assert.strictEqual((await executor.reconcileTokenAccountClose(prepared)).status, 'PENDING');
  status = null;
  assert.strictEqual((await executor.reconcileTokenAccountClose(prepared)).status, 'EXPIRED');

  const transaction = Transaction.from(Buffer.from(prepared.rawTransactionBase64, 'base64'));
  const message = transaction.compileMessage();
  const accountIndex = message.accountKeys.findIndex((item) => item.toBase58() === address);
  const preBalances = message.accountKeys.map(() => 0);
  const postBalances = message.accountKeys.map(() => 0);
  preBalances[0] = 10000000; postBalances[0] = 11782234;
  preBalances[accountIndex] = 1887234;
  cleanupReceipt = { slot: 105, transaction: { signatures: [prepared.signature], message },
    meta: { err: null, fee: 105000, preBalances, postBalances, preTokenBalances: [], postTokenBalances: [] } };
  let reconciled = await executor.reconcileTokenAccountClose(prepared);
  assert.strictEqual(reconciled.status, 'CONFIRMED');
  assert.strictEqual(reconciled.refundLamports, '1887234');
  assert.strictEqual(reconciled.walletSolDelta, 0.001782234);
  assert.strictEqual(reconciled.networkFeeSol, 0.000105);
  cleanupReceipt.meta.postBalances[0] += 1;
  assert.strictEqual((await executor.reconcileTokenAccountClose(prepared)).status, 'UNVERIFIED');
  cleanupReceipt.meta.err = { InstructionError: [2, 'Custom'] };
  cleanupReceipt.meta.postBalances[0] = 9895000;
  cleanupReceipt.meta.postBalances[accountIndex] = 1887234;
  reconciled = await executor.reconcileTokenAccountClose(prepared);
  assert.strictEqual(reconciled.status, 'FAILED');
  assert.strictEqual(reconciled.refundLamports, '0');
  assert.strictEqual(reconciled.walletSolDelta, -0.000105);
  assert.ok(reads.every((config) => config.commitment === 'finalized'));
}

(async () => {
  assertFunding();
  await assertCleanup();
  console.log('Token account funding receipt and safe close executor tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
