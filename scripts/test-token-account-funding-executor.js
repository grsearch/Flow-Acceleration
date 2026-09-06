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
    async getLatestBlockhashAndContext(config) {
      latestCalls += 1;
      assert.strictEqual(config.commitment, 'finalized');
      assert.strictEqual(config.minContextSlot, 101);
      return { context: { slot: 102 }, value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 200 } };
    },
    async getFeeForMessage(message, commitment) { assert.strictEqual(commitment, 'finalized'); return { context: { slot: 102 }, value: fee }; },
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
      assert.strictEqual(options.minContextSlot, 102);
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
  assert.throws(() => validateEmptyTokenAccount(candidate, accountInfo(1n), owner), /TOKEN_ACCOUNT_BALANCE_NONZERO/);
  assert.throws(() => validateEmptyTokenAccount(candidate, accountInfo(0n, { delegateOption: 1, delegate: signer.publicKey }), owner), /TOKEN_ACCOUNT_DELEGATED/);
  assert.throws(() => validateEmptyTokenAccount(candidate, accountInfo(0n, { delegatedAmount: 1n }), owner), /TOKEN_ACCOUNT_DELEGATED/);
  assert.throws(() => validateEmptyTokenAccount(candidate, accountInfo(0n, { closeAuthorityOption: 1, closeAuthority: PublicKey.unique() }), owner), /TOKEN_ACCOUNT_AUTHORITY_MISMATCH/);
  assert.throws(() => validateEmptyTokenAccount(candidate, accountInfo(0n, { owner: PublicKey.unique() }), owner), /TOKEN_ACCOUNT_AUTHORITY_MISMATCH/);
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
  await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), error => {
    assert.strictEqual(error.code, 'TOKEN_ACCOUNT_BALANCE_NONZERO');
    assert.strictEqual(error.recoveryStage, 'ACCOUNT_SNAPSHOT');
    assert.deepStrictEqual(error.recoveryDiagnostics.account, { status: 'REJECTED', tokenAmountRaw: '2',
      contextSlot: 101, reason: 'TOKEN_ACCOUNT_BALANCE_NONZERO' });
    assert.deepStrictEqual(error.recoveryDiagnostics.quoteAttempts, []);
    return true;
  });
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
  // A null fee is a documented RPC result, not malformed account funding.
  // All retry/error fixtures are offline and must remain unsigned until a
  // fresh, valid bounded fee is obtained. No test broadcasts to a real RPC.
  const feeReader = executor.connection.getFeeForMessage;
  const hashReader = executor.connection.getLatestBlockhashAndContext;
  const originalSign = Transaction.prototype.sign;
  let signatures = 0;
  Transaction.prototype.sign = function (...args) { signatures++; return originalSign.apply(this, args); };
  try {
    for (const first of [{ value: null }, { context: { slot: 101 }, value: 105000 }]) {
      let calls = 0;
      executor.connection.getFeeForMessage = async (...args) => ++calls === 1 ? first : feeReader(...args);
      const before = signatures, hashes = latestCalls;
      assert.strictEqual((await executor.prepareEmptyTokenAccountClose(candidate)).status, 'READY');
      assert.strictEqual(calls, 2); assert.strictEqual(latestCalls - hashes, 2);
      assert.strictEqual(signatures - before, 1, 'sign only after valid retry');
    }
    for (const [response, code, expectedCalls] of [
      [{ value: null }, 'CLEANUP_FEE_UNAVAILABLE', 2],
      [null, 'CLEANUP_FEE_UNAVAILABLE', 2],
      [{ value: 105000 }, 'CLEANUP_FEE_CONTEXT_STALE', 2],
      [{ context: { slot: 101 }, value: 105000 }, 'CLEANUP_FEE_CONTEXT_STALE', 2],
      ...[0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '105000'].map(value => [
        { context: { slot: 102 }, value }, 'CLEANUP_FEE_INVALID', 1]),
      [{ context: { slot: 102 }, value: 200000 }, 'CLEANUP_FEE_TOO_HIGH', 1],
    ]) {
      let calls = 0;
      executor.connection.getFeeForMessage = async () => { calls++; return response; };
      const before = signatures;
      await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code, recoveryStage: 'FEE_QUOTE' });
      assert.strictEqual(calls, expectedCalls); assert.strictEqual(signatures, before);
    }
    executor.connection.getFeeForMessage = feeReader;
    for (const [response, code, expectedCalls] of [
      [{ value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 200 } }, 'CLEANUP_BLOCKHASH_CONTEXT_STALE', 2],
      [{ context: { slot: 100 } }, 'CLEANUP_BLOCKHASH_CONTEXT_STALE', 2],
      [{ context: { slot: 102 }, value: { blockhash: 'invalid0', lastValidBlockHeight: 200 } }, 'CLEANUP_BLOCKHASH_INVALID', 1],
      [{ context: { slot: 102 }, value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: null } }, 'CLEANUP_BLOCKHASH_INVALID', 1],
    ]) {
      let calls = 0;
      executor.connection.getLatestBlockhashAndContext = async () => { calls++; return response; };
      const before = signatures;
      await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code, recoveryStage: 'BLOCKHASH' });
      assert.strictEqual(calls, expectedCalls); assert.strictEqual(signatures, before);
    }
    executor.connection.getLatestBlockhashAndContext = hashReader;
    for (const nullFirst of [false, true]) {
      const abort = new AbortController(); let calls = 0;
      executor.connection.getFeeForMessage = async (...args) => {
        calls++;
        if (nullFirst && calls === 1) return { context: { slot: 102 }, value: null };
        abort.abort(); return feeReader(...args);
      };
      const before = signatures;
      await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate, { signal: abort.signal }),
        { code: 'ACCOUNT_RECOVERY_ABORTED', recoveryStage: 'FEE_QUOTE' });
      assert.strictEqual(signatures, before);
      assert.strictEqual(calls, nullFirst ? 2 : 1);
    }
    executor.connection.getFeeForMessage = feeReader;
    // Real web3 Connections expose the raw transport; the request must carry
    // minContextSlot, not silently route through the commitment-only helper.
    let rawCalls = 0;
    executor.connection.getFeeForMessage = async () => { throw new Error('Public fee helper must not be used'); };
    executor.connection._rpcRequest = async (method, args) => {
      rawCalls++;
      assert.strictEqual(method, 'getFeeForMessage');
      assert.strictEqual(typeof args[0], 'string');
      assert(Buffer.from(args[0], 'base64').length > 0);
      assert.deepStrictEqual(args[1], { commitment: 'finalized', minContextSlot: 102 });
      return { jsonrpc: '2.0', id: 1, result: { context: { slot: 103 }, value: 105000 } };
    };
    const rawPrepared = await executor.prepareEmptyTokenAccountClose(candidate);
    assert.strictEqual(rawCalls, 1);
    assert.deepStrictEqual(rawPrepared.recoveryDiagnostics, {
      version: 'ACCOUNT_RECOVERY_DIAGNOSTICS_V1',
      account: { status: 'EMPTY', tokenAmountRaw: '0', contextSlot: 101, reason: null },
      quoteAttempts: [{ rpc: 'PRIMARY', blockhashSlot: 102, feeSlot: 103, feeLamports: 105000, result: 'READY' }],
    });
    assert.strictEqual(rawPrepared.contextSlot, 103);
    const unsafeBodies = [null, { jsonrpc: '2.0', result: null },
      { jsonrpc: '2.0', result: { value: 105000 } },
      { jsonrpc: '2.0', result: { context: { slot: '102' }, value: 105000 } }];
    for (const response of unsafeBodies) {
      executor.connection._rpcRequest = async () => response;
      const before = signatures;
      await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), { code: 'CLEANUP_FEE_RESPONSE_INVALID' });
      assert.strictEqual(signatures, before);
    }
    // Two primary null quotes can use one preconfigured read-only fallback.
    // Its fee must use its own blockhash's minimum slot; only the eventual
    // validated transaction is signed, never a failed primary candidate.
    const rpcMarker = 'https://never-expose.invalid/private-provider-body';
    for (const primaryFailure of ['NULL', 'RPC_ERROR', 'STALE']) {
      const calls = [];
      executor.connection._rpcRequest = async () => {
        calls.push('PRIMARY');
        if (primaryFailure === 'RPC_ERROR') return { jsonrpc: '2.0', id: 1, error: { code: -32016, message: rpcMarker } };
        return { jsonrpc: '2.0', id: 1, result: { context: { slot: primaryFailure === 'STALE' ? 101 : 102 },
          value: primaryFailure === 'NULL' ? null : 105000 } };
      };
      const fallbackHash = Keypair.fromSeed(Buffer.alloc(32, 99)).publicKey.toBase58();
      executor.contextFallbackConnection = {
        async getLatestBlockhashAndContext(config) {
          assert.deepStrictEqual(config, { commitment: 'finalized', minContextSlot: 101 });
          return { context: { slot: 104 }, value: { blockhash: fallbackHash, lastValidBlockHeight: 210 } };
        },
        async _rpcRequest(method, args) {
          calls.push('FALLBACK');
          assert.strictEqual(method, 'getFeeForMessage');
          assert.deepStrictEqual(args[1], { commitment: 'finalized', minContextSlot: 104 });
          return { jsonrpc: '2.0', id: 1, result: { context: { slot: 105 }, value: 105000 } };
        },
      };
      const before = signatures;
      const fallbackPrepared = await executor.prepareEmptyTokenAccountClose(candidate);
      assert.deepStrictEqual(calls, ['PRIMARY', 'PRIMARY', 'FALLBACK']);
      assert.strictEqual(fallbackPrepared.blockhash, fallbackHash);
      assert.strictEqual(fallbackPrepared.contextSlot, 105);
      assert.strictEqual(signatures - before, 1);
      assert.strictEqual(fallbackPrepared.recoveryDiagnostics.quoteAttempts.length, 3);
      assert.strictEqual(fallbackPrepared.recoveryDiagnostics.quoteAttempts[2].rpc, 'FALLBACK');
      assert(!JSON.stringify(fallbackPrepared.recoveryDiagnostics).includes(rpcMarker));
      assert(!JSON.stringify(fallbackPrepared.recoveryDiagnostics).includes(fallbackPrepared.rawTransactionBase64));
    }
    executor.connection._rpcRequest = async () => ({ jsonrpc: '2.0', id: 1,
      result: { context: { slot: 102 }, value: null } });
    executor.contextFallbackConnection._rpcRequest = async () => ({ jsonrpc: '2.0', id: 1,
      result: { context: { slot: 104 }, value: null } });
    const beforeFallbackFailure = signatures;
    await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), error => {
      assert.strictEqual(error.code, 'CLEANUP_FEE_UNAVAILABLE');
      assert.deepStrictEqual(error.recoveryDiagnostics.quoteAttempts.map(row => row.rpc), ['PRIMARY', 'PRIMARY', 'FALLBACK']);
      assert(error.recoveryDiagnostics.quoteAttempts.every(row => row.result === 'FEE_UNAVAILABLE'));
      return true;
    });
    assert.strictEqual(signatures, beforeFallbackFailure);
    const fallbackAbort = new AbortController();
    executor.contextFallbackConnection._rpcRequest = async () => {
      fallbackAbort.abort();
      return { jsonrpc: '2.0', id: 1, result: { context: { slot: 104 }, value: 105000 } };
    };
    await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate, { signal: fallbackAbort.signal }), error => {
      assert.strictEqual(error.code, 'ACCOUNT_RECOVERY_ABORTED');
      assert.strictEqual(error.recoveryDiagnostics.quoteAttempts.at(-1).result, 'ABORTED');
      return true;
    });
    assert.strictEqual(signatures, beforeFallbackFailure, 'fallback cannot sign after deadline');
    let unsafeFallbackCalls = 0;
    executor.connection._rpcRequest = async () => ({ jsonrpc: '2.0', id: 1,
      result: { context: { slot: 102 }, value: 200000 } });
    executor.contextFallbackConnection._rpcRequest = async () => { unsafeFallbackCalls++; throw new Error('Not allowed'); };
    await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate), error => {
      assert.strictEqual(error.code, 'CLEANUP_FEE_TOO_HIGH');
      assert.strictEqual(error.recoveryDiagnostics.quoteAttempts.length, 1);
      assert.strictEqual(error.recoveryDiagnostics.quoteAttempts[0].result, 'FEE_TOO_HIGH');
      return true;
    });
    assert.strictEqual(unsafeFallbackCalls, 0, 'fallback must not override a valid fee cap rejection');
    assert.strictEqual(signatures, beforeFallbackFailure);
    delete executor.connection._rpcRequest;
    delete executor.contextFallbackConnection;
    executor.connection.getFeeForMessage = feeReader;
    for (const fundedLamports of [null, 1.5]) {
      const before = signatures;
      await assert.rejects(executor.prepareEmptyTokenAccountClose({ ...candidate, fundedLamports }),
        { code: 'ACCOUNT_CANDIDATE_FUNDING_INVALID', recoveryStage: 'CANDIDATE' });
      assert.strictEqual(signatures, before);
    }
    currentInfo = { ...accountInfo(), lamports: null };
    const before = signatures;
    await assert.rejects(executor.prepareEmptyTokenAccountClose(candidate),
      { code: 'ACCOUNT_BALANCE_INVALID', recoveryStage: 'ACCOUNT_SNAPSHOT' });
    assert.strictEqual(signatures, before); assert.strictEqual(sendCalls, 0);
  } finally {
    Transaction.prototype.sign = originalSign;
    executor.connection.getFeeForMessage = feeReader;
    executor.connection.getLatestBlockhashAndContext = hashReader;
    delete executor.connection._rpcRequest;
    delete executor.contextFallbackConnection;
    currentInfo = accountInfo();
  }
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
