'use strict';

const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js');
const {
  AccountLayout,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');
const {
  OnlinePumpSdk,
  PumpSdk,
  PUMP_PROGRAM_ID,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  pumpIdl,
} = require('@pump-fun/pump-sdk');
const {
  OFFLINE_PUMP_AMM_PROGRAM,
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  PUMP_AMM_PROGRAM_ID,
  buyQuoteInput: quoteAmmBuy,
  canonicalPumpPoolPda,
} = require('@pump-fun/pump-swap-sdk');
const BN = require('bn.js');
const bs58Module = require('bs58');

const bs58 = bs58Module.default || bs58Module;

const BUY_V2 = pumpIdl.instructions.find(
  (instruction) => instruction.name === 'buy_v2',
);
const EXACT_QUOTE_IN_V2 = pumpIdl.instructions.find(
  (instruction) => instruction.name === 'buy_exact_quote_in_v2',
);
if (!BUY_V2 || !EXACT_QUOTE_IN_V2) {
  throw new Error('Pump SDK is missing the required v2 buy instructions');
}
if (JSON.stringify(BUY_V2.accounts) !== JSON.stringify(EXACT_QUOTE_IN_V2.accounts)) {
  throw new Error('Pump SDK v2 buy account layouts no longer match');
}
const EXACT_QUOTE_IN_V2_DISCRIMINATOR = Buffer.from(EXACT_QUOTE_IN_V2.discriminator);
const U64_MAX = (1n << 64n) - 1n;

function normalizedSlot(value) {
  const slot = Number(value);
  return Number.isSafeInteger(slot) && slot >= 0 ? slot : null;
}

function commitmentConfig(commitment, minContextSlot = null) {
  const config = { commitment };
  const slot = normalizedSlot(minContextSlot);
  if (slot !== null) config.minContextSlot = slot;
  return config;
}

function isMinimumContextSlotError(error) {
  return Number(error?.code) === -32016
    || /minimum context slot|minimum ledger slot/i.test(String(error?.message || error));
}

function u64(value, name) {
  const raw = BigInt(value?.toString?.() ?? value);
  if (raw < 0n || raw > U64_MAX) throw new RangeError(`${name} must fit in u64`);
  return raw;
}

function minimumTokensOut(quotedAmount, slippagePct) {
  const amount = BN.isBN(quotedAmount) ? quotedAmount : new BN(String(quotedAmount));
  const bps = Math.max(0, Math.min(10_000, Math.round(Number(slippagePct) * 100)));
  return amount.muln(10_000 - bps).divn(10_000);
}

function rawNumber(value) {
  const number = Number(value?.toString?.() ?? value);
  return Number.isFinite(number) ? number : null;
}

function ammReservePrice({
  baseReserveRaw,
  quoteReserveRaw,
  virtualQuoteReservesRaw = 0,
  baseDecimals = 6,
}) {
  const baseReserve = rawNumber(baseReserveRaw);
  const quoteReserve = rawNumber(quoteReserveRaw);
  const virtualQuoteReserves = rawNumber(virtualQuoteReservesRaw);
  const decimals = Number(baseDecimals);
  if (!(baseReserve > 0) || !(quoteReserve >= 0) || !(virtualQuoteReserves >= 0)
    || !Number.isInteger(decimals) || decimals < 0) return null;
  const baseTokens = baseReserve / (10 ** decimals);
  const effectiveQuoteSol = (quoteReserve + virtualQuoteReserves) / LAMPORTS_PER_SOL;
  const price = effectiveQuoteSol / baseTokens;
  return Number.isFinite(price) && price > 0 ? price : null;
}

function ammQuotePriceDiagnostics({
  signalBaseReserveRaw,
  signalQuoteReserveRaw,
  freshBaseReserveRaw,
  freshQuoteReserveRaw,
  virtualQuoteReservesRaw,
  signalVirtualQuoteReservesRaw = null,
  freshVirtualQuoteReservesRaw = null,
  baseDecimals,
  positionSol,
  quotedBaseRaw,
  internalQuoteWithoutFeesRaw,
  legacyReferencePrice = null,
}) {
  const signalReservePrice = ammReservePrice({
    baseReserveRaw: signalBaseReserveRaw,
    quoteReserveRaw: signalQuoteReserveRaw,
    virtualQuoteReservesRaw: signalVirtualQuoteReservesRaw ?? virtualQuoteReservesRaw,
    baseDecimals,
  });
  const freshReservePrice = ammReservePrice({
    baseReserveRaw: freshBaseReserveRaw,
    quoteReserveRaw: freshQuoteReserveRaw,
    virtualQuoteReservesRaw: freshVirtualQuoteReservesRaw ?? virtualQuoteReservesRaw,
    baseDecimals,
  });
  const fallbackReference = Number(legacyReferencePrice);
  const marketReferencePrice = signalReservePrice
    || (Number.isFinite(fallbackReference) && fallbackReference > 0 ? fallbackReference : null);
  const quotedBase = rawNumber(quotedBaseRaw);
  const effectiveQuoteRaw = rawNumber(internalQuoteWithoutFeesRaw);
  const decimals = Number(baseDecimals);
  const quotedTokens = quotedBase > 0 && Number.isInteger(decimals)
    ? quotedBase / (10 ** decimals)
    : null;
  const quotedPrice = quotedTokens > 0 ? Number(positionSol) / quotedTokens : null;
  const curveAveragePrice = quotedTokens > 0 && effectiveQuoteRaw > 0
    ? (effectiveQuoteRaw / LAMPORTS_PER_SOL) / quotedTokens
    : null;
  const marketMovePct = marketReferencePrice > 0 && freshReservePrice > 0
    ? ((freshReservePrice / marketReferencePrice) - 1) * 100
    : null;
  const selfImpactPct = freshReservePrice > 0 && curveAveragePrice > 0
    ? ((curveAveragePrice / freshReservePrice) - 1) * 100
    : null;
  const feeImpactPct = curveAveragePrice > 0 && quotedPrice > 0
    ? ((quotedPrice / curveAveragePrice) - 1) * 100
    : null;
  const totalQuotePremiumPct = marketReferencePrice > 0 && quotedPrice > 0
    ? ((quotedPrice / marketReferencePrice) - 1) * 100
    : null;
  return {
    referencePriceMode: signalReservePrice ? 'EFFECTIVE_POOL_RESERVES' : 'LEGACY_REFERENCE',
    marketReferencePrice,
    signalReservePrice,
    freshReservePrice,
    quotedPrice,
    curveAveragePrice,
    marketMovePct,
    selfImpactPct,
    feeImpactPct,
    totalQuotePremiumPct,
  };
}

function exactQuoteInInstructionData(spendableQuoteIn, minTokensOut) {
  const data = Buffer.alloc(24);
  EXACT_QUOTE_IN_V2_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(u64(spendableQuoteIn, 'spendableQuoteIn'), 8);
  data.writeBigUInt64LE(u64(minTokensOut, 'minTokensOut'), 16);
  return data;
}

function replaceBuyV2WithExactQuoteIn(instructions, spendableQuoteIn, minTokensOut) {
  let replaced = false;
  const output = instructions.map((instruction) => {
    if (replaced || !instruction.programId.equals(PUMP_PROGRAM_ID)) return instruction;
    replaced = true;
    return new TransactionInstruction({
      programId: instruction.programId,
      keys: instruction.keys,
      data: exactQuoteInInstructionData(spendableQuoteIn, minTokensOut),
    });
  });
  if (!replaced) throw new Error('Pump buy instruction was not generated');
  return output;
}

function replaceAmmBuyWithExactQuoteIn(instructions, spendableQuoteIn, minBaseAmountOut) {
  const index = instructions.findIndex((instruction) => (
    instruction.programId.equals(PUMP_AMM_PROGRAM_ID) && instruction.data.length > 8
  ));
  if (index < 0) throw new Error('PumpSwap buy instruction was not generated');
  const output = [...instructions];
  output[index] = new TransactionInstruction({
    programId: output[index].programId,
    keys: output[index].keys,
    data: OFFLINE_PUMP_AMM_PROGRAM.coder.instruction.encode('buyExactQuoteIn', {
      spendableQuoteIn: new BN(u64(spendableQuoteIn, 'spendableQuoteIn').toString()),
      minBaseAmountOut: new BN(u64(minBaseAmountOut, 'minBaseAmountOut').toString()),
      trackVolume: { 0: true },
    }),
  });
  return output;
}

function secretBytes(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('FLOW_LIVE_PRIVATE_KEY is empty');
  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Private key JSON must be a byte array');
    return Uint8Array.from(parsed);
  }
  return Uint8Array.from(bs58.decode(raw));
}

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function confirmedTransactionFailure(signature, transactionError) {
  const error = errorWithCode(
    `Transaction failed on chain: ${JSON.stringify(transactionError)}`,
    'TRANSACTION_FAILED',
  );
  error.signature = signature;
  error.transactionFailed = true;
  error.transactionError = transactionError;
  return error;
}

function tokenDeltaFromTransaction(transactionResponse, mintValue, ownerValue) {
  const meta = transactionResponse?.meta;
  if (!meta || meta.err) return null;
  const mint = String(mintValue || '');
  const owner = String(ownerValue || '');
  const balances = new Map();
  const collect = (rows, field) => {
    for (const row of rows || []) {
      if (String(row?.mint || '') !== mint) continue;
      const accountIndex = Number(row.accountIndex);
      if (!Number.isInteger(accountIndex)) continue;
      const current = balances.get(accountIndex) || {
        pre: 0n, post: 0n, owner: null, matched: false,
      };
      const raw = row?.uiTokenAmount?.amount;
      try {
        current[field] = BigInt(raw || 0);
      } catch (_) {
        continue;
      }
      current.owner = row.owner || current.owner;
      current.matched = true;
      balances.set(accountIndex, current);
    }
  };
  collect(meta.preTokenBalances, 'pre');
  collect(meta.postTokenBalances, 'post');
  let delta = 0n;
  let matchedOwner = false;
  for (const row of balances.values()) {
    if (!row.matched || !row.owner || String(row.owner) !== owner) continue;
    matchedOwner = true;
    if (row.post > row.pre) delta += row.post - row.pre;
  }
  return matchedOwner ? delta : 0n;
}

function walletSolSettlementFromTransaction(transactionResponse, ownerValue) {
  const meta = transactionResponse?.meta;
  const message = transactionResponse?.transaction?.message;
  const keys = message?.accountKeys || message?.staticAccountKeys || [];
  // A failed on-chain transaction still consumes its network/priority fee. Keep
  // that wallet delta so realized PnL reconciles to the wallet, not just swaps.
  if (!meta || keys.length === 0) return null;
  const owner = String(ownerValue || '');
  const index = keys.findIndex((key) => {
    const value = key?.pubkey ?? key;
    return String(value?.toBase58?.() ?? value ?? '') === owner;
  });
  if (index < 0) return null;
  const pre = Number(meta.preBalances?.[index]);
  const post = Number(meta.postBalances?.[index]);
  if (!Number.isSafeInteger(pre) || !Number.isSafeInteger(post)) return null;
  const fee = Number(meta.fee || 0);
  return {
    walletSolDelta: (post - pre) / LAMPORTS_PER_SOL,
    networkFeeSol: Number.isFinite(fee) ? fee / LAMPORTS_PER_SOL : null,
    walletIndex: index,
  };
}

function classifyBuyReconciliation(status, tokenBalanceRaw, {
  transactionTokenDeltaRaw = null,
  transactionObserved = false,
  balanceObserved = true,
} = {}) {
  const tokenBalance = BigInt(tokenBalanceRaw || 0);
  const transactionDelta = transactionTokenDeltaRaw == null
    ? 0n
    : BigInt(transactionTokenDeltaRaw || 0);
  const recoveredAmount = tokenBalance > 0n ? tokenBalance : transactionDelta;
  if (recoveredAmount > 0n) {
    return {
      state: 'CONFIRMED',
      tokenAmountRaw: recoveredAmount.toString(),
      confirmationStatus: status?.confirmationStatus || null,
      recoveredFrom: tokenBalance > 0n ? 'WALLET_BALANCE' : 'TRANSACTION_META',
    };
  }
  if (status?.err) {
    return {
      state: 'FAILED',
      tokenAmountRaw: '0',
      confirmationStatus: status.confirmationStatus || null,
      error: `Transaction failed on chain: ${JSON.stringify(status.err)}`,
    };
  }
  if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) {
    return {
      // A confirmed signature can become visible before the Token/Token-2022
      // account index. Zero is therefore not proof that the buy was empty.
      state: 'UNKNOWN',
      tokenAmountRaw: '0',
      confirmationStatus: status.confirmationStatus,
      transactionObserved,
      balanceObserved,
      error: 'Buy transaction confirmed; token receipt is still awaiting RPC reconciliation',
    };
  }
  return {
    state: 'UNKNOWN',
    tokenAmountRaw: '0',
    confirmationStatus: status?.confirmationStatus || null,
    transactionObserved,
    balanceObserved,
  };
}

class PumpTradeExecutor {
  constructor(config) {
    this.config = config;
    this.readCommitment = config.readCommitment || 'processed';
    this.confirmationCommitment = config.confirmationCommitment
      || config.commitment
      || 'confirmed';
    this.connection = new Connection(config.rpcUrl, {
      commitment: this.readCommitment,
      confirmTransactionInitialTimeout: 20_000,
    });
    const secret = secretBytes(config.privateKey);
    if (secret.length === 32) this.signer = Keypair.fromSeed(secret);
    else if (secret.length === 64) this.signer = Keypair.fromSecretKey(secret);
    else throw new Error('FLOW_LIVE_PRIVATE_KEY must decode to 32 or 64 bytes');
    this.pump = new PumpSdk();
    this.onlinePump = new OnlinePumpSdk(this.connection);
    this.onlineAmm = new OnlinePumpAmmSdk(this.connection);
    this.cachedProtocol = null;
    this.tokenPrograms = new Map();
  }

  publicKey() {
    return this.signer.publicKey.toBase58();
  }

  async walletBalanceSol() {
    return (await this.connection.getBalance(this.signer.publicKey, this.readCommitment))
      / LAMPORTS_PER_SOL;
  }

  async _protocolState() {
    const now = Date.now();
    if (this.cachedProtocol && now - this.cachedProtocol.at < 30_000) return this.cachedProtocol;
    const [global, feeConfig] = await Promise.all([
      this.onlinePump.fetchGlobal(),
      this.onlinePump.fetchFeeConfig(),
    ]);
    this.cachedProtocol = { global, feeConfig, at: now };
    return this.cachedProtocol;
  }

  async _tokenProgram(mint, minContextSlot = null) {
    const key = mint.toBase58();
    const cached = this.tokenPrograms.get(key);
    if (cached) return cached;
    const info = await this.connection.getAccountInfo(
      mint,
      commitmentConfig(this.readCommitment, minContextSlot),
    );
    if (!info) throw errorWithCode(`Mint account not found: ${mint.toBase58()}`, 'MINT_NOT_FOUND');
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      this.tokenPrograms.set(key, TOKEN_2022_PROGRAM_ID);
      return TOKEN_2022_PROGRAM_ID;
    }
    if (info.owner.equals(TOKEN_PROGRAM_ID)) {
      this.tokenPrograms.set(key, TOKEN_PROGRAM_ID);
      return TOKEN_PROGRAM_ID;
    }
    throw errorWithCode(`Unsupported token program: ${info.owner.toBase58()}`, 'TOKEN_PROGRAM');
  }

  async _tokenBalanceRaw(mint, tokenProgram, commitment = this.readCommitment) {
    return (await this._tokenBalanceSnapshot(mint, tokenProgram, commitment)).amount;
  }

  async transactionSettlement(signature) {
    if (!signature || typeof this.connection.getTransaction !== 'function') return null;
    const response = await this.connection.getTransaction(signature, {
      commitment: this.confirmationCommitment,
      maxSupportedTransactionVersion: 0,
    });
    return walletSolSettlementFromTransaction(
      response,
      this.signer.publicKey.toBase58(),
    );
  }

  async _tokenBalanceSnapshot(mint, tokenProgram, commitment = this.readCommitment) {
    const ata = getAssociatedTokenAddressSync(
      mint,
      this.signer.publicKey,
      true,
      tokenProgram,
    );
    try {
      const balance = await this.connection.getTokenAccountBalance(ata, commitment);
      return { amount: BigInt(balance.value.amount), observed: true, ata: ata.toBase58() };
    } catch (error) {
      const message = String(error?.message || error);
      if (/could not find account|Invalid param|not found/i.test(message)) {
        return {
          amount: 0n,
          observed: false,
          ata: ata.toBase58(),
          error: message.slice(0, 1_000),
        };
      }
      throw error;
    }
  }

  async _buyStateAtSignalSlot(mint, signalSlot = null) {
    const legacyAta = getAssociatedTokenAddressSync(
      mint,
      this.signer.publicKey,
      true,
      TOKEN_PROGRAM_ID,
    );
    const token2022Ata = getAssociatedTokenAddressSync(
      mint,
      this.signer.publicKey,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const accountKeys = [mint, bondingCurvePda(mint), legacyAta, token2022Ata];
    const retryLimit = Math.max(0, Number(this.config?.contextSlotRetryCount ?? 2));
    const retryDelayMs = Math.max(0, Number(this.config?.contextSlotRetryDelayMs ?? 25));
    let response;
    let contextRetries = 0;
    while (true) {
      try {
        response = await this.connection.getMultipleAccountsInfoAndContext(
          accountKeys,
          commitmentConfig(this.readCommitment, signalSlot),
        );
        break;
      } catch (error) {
        if (!isMinimumContextSlotError(error)) throw error;
        if (contextRetries >= retryLimit) {
          const contextError = errorWithCode(
            `RPC did not reach signal slot ${normalizedSlot(signalSlot)} after ${contextRetries + 1} reads`,
            'RPC_CONTEXT_BEHIND',
          );
          contextError.contextRetries = contextRetries;
          contextError.cause = error;
          throw contextError;
        }
        contextRetries += 1;
        if (retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }
    const [mintAccountInfo, bondingCurveAccountInfo, legacyAtaInfo, token2022AtaInfo]
      = response.value;
    if (!mintAccountInfo) {
      throw errorWithCode(`Mint account not found: ${mint.toBase58()}`, 'MINT_NOT_FOUND');
    }
    let tokenProgram;
    let associatedUserAccountInfo;
    if (mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      tokenProgram = TOKEN_2022_PROGRAM_ID;
      associatedUserAccountInfo = token20…1706 tokens truncated…      };
      mark('state_and_blockhash_ready_ms');
      if (balanceBefore > 0n) {
        throw errorWithCode(
          'Trading wallet already holds this mint',
          'WALLET_ALREADY_HOLDS_MINT',
        );
      }

      const reserveLamports = Math.round(this.config.minWalletReserveSol * LAMPORTS_PER_SOL);
      if (balanceLamports - Number(spendLamports) < reserveLamports) {
        throw errorWithCode('Wallet reserve guard rejected entry', 'WALLET_RESERVE');
      }

      const { global, feeConfig } = protocol;
      if (state.bondingCurve.complete) {
        throw errorWithCode('Bonding curve already complete', 'CURVE_COMPLETE');
      }
      const quoteAmount = new BN(spendLamports.toString());
      const amount = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: state.bondingCurve.tokenTotalSupply,
        bondingCurve: state.bondingCurve,
        amount: quoteAmount,
        quoteMint: NATIVE_MINT,
      });
      if (amount.lten(0)) throw errorWithCode('Buy quote returned zero tokens', 'ZERO_QUOTE');
      const buySlippagePct = this.config.buySlippagePct ?? this.config.slippagePct;
      const minTokensOut = minimumTokensOut(amount, buySlippagePct);
      if (minTokensOut.lten(0)) {
        throw errorWithCode('Minimum token output is zero', 'ZERO_MIN_OUTPUT');
      }
      execution.quotedTokenRaw = amount.toString();
      execution.minimumTokenRaw = minTokensOut.toString();

      const expectedPrice = solAmount / (Number(amount.toString()) / 1e6);
      execution.quotedPrice = expectedPrice;
      mark('quote_ready_ms');
      if (Number.isFinite(referencePrice) && referencePrice > 0 && maxPriceJumpPct >= 0) {
        const jumpPct = ((expectedPrice / referencePrice) - 1) * 100;
        execution.referencePrice = referencePrice;
        execution.priceJumpPct = jumpPct;
        if (jumpPct > maxPriceJumpPct) {
          throw errorWithCode(
            `Entry price moved ${jumpPct.toFixed(2)}%, above ${maxPriceJumpPct}%`,
            'PRICE_JUMP',
          );
        }
      }

      const instructions = await this.pump.buyV2Instructions({
        global,
        bondingCurveAccountInfo: state.bondingCurveAccountInfo,
        bondingCurve: state.bondingCurve,
        associatedUserAccountInfo: state.associatedUserAccountInfo,
        mint,
        user: this.signer.publicKey,
        amount,
        quoteAmount,
        // Only use the SDK to produce the complete, current account list. Its high-level
        // wrapper exposes exact-token-out semantics, so the instruction data is replaced
        // below with buy_exact_quote_in_v2 to keep spendableQuoteIn as a hard SOL cap.
        slippage: 0,
        tokenProgram,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      });
      const exactInputInstructions = replaceBuyV2WithExactQuoteIn(
        instructions,
        spendLamports,
        minTokensOut,
      );
      mark('instructions_ready_ms');
      const signature = await this._send(exactInputInstructions, {
        latestBlockhash,
        onStage: mark,
      });
      const balanceAfter = await this._tokenBalanceRaw(
        mint,
        tokenProgram,
        this.confirmationCommitment,
      );
      const acquired = balanceAfter > balanceBefore
        ? balanceAfter - balanceBefore
        : BigInt(amount.toString());
      const acquiredTokens = Number(acquired) / 1e6;
      const filledPrice = acquiredTokens > 0 ? solAmount / acquiredTokens : expectedPrice;
      mark('balance_reconciled_ms');
      mark('total_ms');
      execution.settlement = await this.transactionSettlement(signature).catch(() => null);
      return {
        signature,
        venue: 'PUMP_BONDING_CURVE',
        tokenAmountRaw: acquired.toString(),
        quotedTokenAmountRaw: amount.toString(),
        minimumTokenAmountRaw: minTokensOut.toString(),
        expectedPrice: filledPrice,
        quotedPrice: expectedPrice,
        execution,
      };
    } catch (error) {
      mark('total_ms');
      if (Number.isFinite(error.contextRetries)) {
        execution.contextRetries = error.contextRetries;
      }
      error.execution = execution;
      throw error;
    }
  }

  async buyAmm({
    mint: mintValue,
    solAmount,
    referencePrice,
    maxPriceJumpPct,
    maxSelfImpactPct = Number.POSITIVE_INFINITY,
    signalPoolBaseReservesRaw = null,
    signalPoolQuoteReservesRaw = null,
    signalVirtualQuoteReservesRaw = null,
  }) {
    const startedAt = Date.now();
    const execution = {
      version: 2,
      buyMode: 'PUMP_AMM_FIXED_SOL_HARD_CAP',
      hardSpendCap: true,
      positionSol: solAmount,
      slippagePct: this.config.buySlippagePct ?? this.config.slippagePct,
      readCommitment: this.readCommitment,
      confirmationCommitment: this.confirmationCommitment,
      skipPreflight: false,
      startedAt,
      timelineMs: {},
    };
    const mark = (name) => {
      execution.timelineMs[name] = Date.now() - startedAt;
    };

    try {
      const mint = new PublicKey(mintValue);
      const tokenProgram = await this._tokenProgram(mint);
      const balanceBefore = await this._tokenBalanceRaw(mint, tokenProgram);
      if (balanceBefore > 0n) {
        throw errorWithCode(
          'Trading wallet already holds this mint',
          'WALLET_ALREADY_HOLDS_MINT',
        );
      }

      const spendLamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
      const reserveLamports = Math.round(this.config.minWalletReserveSol * LAMPORTS_PER_SOL);
      const [walletLamports, state, latestBlockhash] = await Promise.all([
        this.connection.getBalance(this.signer.publicKey, this.readCommitment),
        this.onlineAmm.swapSolanaState(
          canonicalPumpPoolPda(mint, NATIVE_MINT),
          this.signer.publicKey,
        ),
        this.connection.getLatestBlockhash(this.readCommitment),
      ]);
      mark('state_and_blockhash_ready_ms');
      if (!state.baseMint.equals(mint) || !state.pool.quoteMint.equals(NATIVE_MINT)) {
        throw errorWithCode('PumpSwap pool mint direction is invalid', 'INVALID_AMM_POOL');
      }
      if (walletLamports - Number(spendLamports) < reserveLamports) {
        throw errorWithCode('Wallet reserve guard rejected entry', 'WALLET_RESERVE');
      }

      const spend = new BN(spendLamports.toString());
      const quoted = quoteAmmBuy({
        quote: spend,
        slippage: 0,
        baseReserve: state.poolBaseAmount,
        quoteReserve: state.poolQuoteAmount,
        virtualQuoteReserves: state.pool.virtualQuoteReserves,
        globalConfig: state.globalConfig,
        baseMintAccount: state.baseMintAccount,
        baseMint: state.baseMint,
        coinCreator: state.pool.coinCreator,
        creator: state.pool.creator,
        feeConfig: state.feeConfig,
      });
      const minBaseOut = minimumTokensOut(
        quoted.base,
        this.config.buySlippagePct ?? this.config.slippagePct,
      );
      if (minBaseOut.lten(0)) throw errorWithCode('PumpSwap quote returned zero tokens', 'ZERO_QUOTE');
      const decimals = Number(state.baseMintAccount.decimals ?? 6);
      const quotedTokens = Number(quoted.base.toString()) / (10 ** decimals);
      const expectedPrice = quotedTokens > 0 ? solAmount / quotedTokens : null;
      const priceDiagnostics = ammQuotePriceDiagnostics({
        signalBaseReserveRaw: signalPoolBaseReservesRaw,
        signalQuoteReserveRaw: signalPoolQuoteReservesRaw,
        freshBaseReserveRaw: state.poolBaseAmount,
        freshQuoteReserveRaw: state.poolQuoteAmount,
        virtualQuoteReservesRaw: state.pool.virtualQuoteReserves,
        signalVirtualQuoteReservesRaw,
        freshVirtualQuoteReservesRaw: state.pool.virtualQuoteReserves,
        baseDecimals: decimals,
        positionSol: solAmount,
        quotedBaseRaw: quoted.base,
        internalQuoteWithoutFeesRaw: quoted.internalQuoteWithoutFees,
        legacyReferencePrice: referencePrice,
      });
      execution.spendableQuoteRaw = spendLamports.toString();
      execution.quotedTokenRaw = quoted.base.toString();
      execution.minimumTokenRaw = minBaseOut.toString();
      execution.quotedPrice = expectedPrice;
      execution.signalPoolBaseReservesRaw = signalPoolBaseReservesRaw == null
        ? null
        : signalPoolBaseReservesRaw.toString();
      execution.signalPoolQuoteReservesRaw = signalPoolQuoteReservesRaw == null
        ? null
        : signalPoolQuoteReservesRaw.toString();
      execution.signalVirtualQuoteReservesRaw = signalVirtualQuoteReservesRaw == null
        ? null
        : signalVirtualQuoteReservesRaw.toString();
      execution.freshPoolBaseReservesRaw = state.poolBaseAmount.toString();
      execution.freshPoolQuoteReservesRaw = state.poolQuoteAmount.toString();
      execution.virtualQuoteReservesRaw = state.pool.virtualQuoteReserves.toString();
      execution.referencePriceMode = priceDiagnostics.referencePriceMode;
      execution.legacyReferencePrice = Number.isFinite(Number(referencePrice))
        ? Number(referencePrice)
        : null;
      execution.referencePrice = priceDiagnostics.marketReferencePrice;
      execution.signalReservePrice = priceDiagnostics.signalReservePrice;
      execution.freshReservePrice = priceDiagnostics.freshReservePrice;
      execution.curveAveragePrice = priceDiagnostics.curveAveragePrice;
      execution.marketMovePct = priceDiagnostics.marketMovePct;
      execution.priceJumpPct = priceDiagnostics.marketMovePct;
      execution.selfImpactPct = priceDiagnostics.selfImpactPct;
      execution.feeImpactPct = priceDiagnostics.feeImpactPct;
      execution.totalQuotePremiumPct = priceDiagnostics.totalQuotePremiumPct;
      execution.maxMarketMovePct = maxPriceJumpPct;
      execution.maxSelfImpactPct = Number.isFinite(Number(maxSelfImpactPct))
        ? Number(maxSelfImpactPct)
        : null;
      mark('quote_ready_ms');
      if (Number.isFinite(priceDiagnostics.marketMovePct) && maxPriceJumpPct >= 0) {
        if (priceDiagnostics.marketMovePct > maxPriceJumpPct) {
          throw errorWithCode(
            `Market price moved ${priceDiagnostics.marketMovePct.toFixed(2)}%, `
              + `above ${maxPriceJumpPct}%`,
            'MARKET_PRICE_MOVED',
          );
        }
      }
      if (Number.isFinite(priceDiagnostics.selfImpactPct)
        && Number.isFinite(Number(maxSelfImpactPct))
        && Number(maxSelfImpactPct) >= 0
        && priceDiagnostics.selfImpactPct > Number(maxSelfImpactPct)) {
        throw errorWithCode(
          `Order self-impact ${priceDiagnostics.selfImpactPct.toFixed(2)}%, `
            + `above ${Number(maxSelfImpactPct)}%`,
          'SELF_IMPACT_REJECTED',
        );
      }

      // Build the canonical account list, then switch only the instruction payload
      // to buy_exact_quote_in. This spends the requested SOL budget exactly while
      // the configured tolerance controls only the minimum token amount received.
      const baseInstructions = await PUMP_AMM_SDK.buyInstructions(state, minBaseOut, spend);
      const instructions = replaceAmmBuyWithExactQuoteIn(
        baseInstructions,
        spendLamports,
        minBaseOut,
      );
      mark('instructions_ready_ms');
      const signature = await this._send(instructions, { latestBlockhash, onStage: mark });
      const balanceAfter = await this._tokenBalanceRaw(
        mint,
        tokenProgram,
        this.confirmationCommitment,
      );
      const acquired = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0n;
      if (acquired <= 0n) {
        const reconciled = await this.reconcileBuy({
          mint: mint.toBase58(),
          signature,
        });
        if (reconciled.state === 'CONFIRMED' && BigInt(reconciled.tokenAmountRaw) > 0n) {
          const recovered = BigInt(reconciled.tokenAmountRaw);
          const acquiredTokens = Number(recovered) / (10 ** decimals);
          const filledPrice = acquiredTokens > 0 ? solAmount / acquiredTokens : expectedPrice;
          mark('balance_reconciled_ms');
          mark('total_ms');
          execution.settlement = await this.transactionSettlement(signature).catch(() => null);
          return {
            signature,
            venue: 'PUMP_AMM',
            tokenAmountRaw: recovered.toString(),
            quotedTokenAmountRaw: quoted.base.toString(),
            minimumTokenAmountRaw: minBaseOut.toString(),
            expectedPrice: filledPrice,
            quotedPrice: expectedPrice,
            execution: { ...execution, receiptRecoveredFrom: reconciled.recoveredFrom },
          };
        }
        const error = errorWithCode(
          'PumpSwap buy confirmed; token receipt is awaiting RPC reconciliation',
          'CONFIRMATION_PENDING',
        );
        error.signature = signature;
        throw error;
      }
      const acquiredTokens = Number(acquired) / (10 ** decimals);
      const filledPrice = acquiredTokens > 0 ? solAmount / acquiredTokens : expectedPrice;
      mark('balance_reconciled_ms');
      mark('total_ms');
      execution.settlement = await this.transactionSettlement(signature).catch(() => null);
      return {
        signature,
        venue: 'PUMP_AMM',
        tokenAmountRaw: acquired.toString(),
        quotedTokenAmountRaw: quoted.base.toString(),
        minimumTokenAmountRaw: minBaseOut.toString(),
        expectedPrice: filledPrice,
        quotedPrice: expectedPrice,
        execution,
      };
    } catch (error) {
      mark('total_ms');
      error.execution = execution;
      throw error;
    }
  }

  async _confirmedSellResult({ mint, tokenProgram, signature, venue, soldRaw }) {
    const settlement = await this.transactionSettlement(signature).catch(() => null);
    try {
      const remaining = await this._tokenBalanceSnapshot(
        mint,
        tokenProgram,
        this.confirmationCommitment,
      );
      return {
        signature,
        venue,
        tokenAmountRaw: soldRaw.toString(),
        remainingTokenAmountRaw: remaining.observed ? remaining.amount.toString() : null,
        balanceVerified: remaining.observed,
        balanceCheckError: remaining.observed ? null : remaining.error,
        settlement,
      };
    } catch (error) {
      return {
        signature,
        venue,
        tokenAmountRaw: soldRaw.toString(),
        remainingTokenAmountRaw: null,
        balanceVerified: false,
        balanceCheckError: String(error?.message || error).slice(0, 1_000),
        settlement,
      };
    }
  }

  async sell({ mint: mintValue, tokenAmountRaw = null }) {
    const mint = new PublicKey(mintValue);
    const tokenProgram = await this._tokenProgram(mint);
    const balanceSnapshot = await this._tokenBalanceSnapshot(mint, tokenProgram);
    if (!balanceSnapshot.observed) {
      throw errorWithCode(
        `Token balance is not indexed yet for ${mint.toBase58()}`,
        'TOKEN_BALANCE_UNAVAILABLE',
      );
    }
    const walletBalance = balanceSnapshot.amount;
    // Entry rejects pre-existing holdings for the mint, so the live wallet balance belongs
    // to this position. Full exits keep selling the complete current balance; explicitly
    // sized exits are reserved for durable partial-exit strategies.
    const requestedRaw = tokenAmountRaw == null ? walletBalance : BigInt(tokenAmountRaw);
    const sellRaw = requestedRaw < walletBalance ? requestedRaw : walletBalance;
    if (sellRaw <= 0n) {
      return {
        signature: null,
        venue: 'NONE',
        tokenAmountRaw: '0',
        remainingTokenAmountRaw: '0',
        balanceVerified: true,
        alreadyEmpty: true,
      };
    }
    const amount = new BN(sellRaw.toString());

    try {
      const [{ global, feeConfig }, state] = await Promise.all([
        this._protocolState(),
        this.onlinePump.fetchSellState(mint, this.signer.publicKey, tokenProgram),
      ]);
      if (state.bondingCurve.complete) throw errorWithCode('Curve complete', 'CURVE_COMPLETE');
      const quoteAmount = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: state.bondingCurve.tokenTotalSupply,
        bondingCurve: state.bondingCurve,
        amount,
      });
      const instructions = await this.pump.sellV2Instructions({
        global,
        bondingCurveAccountInfo: state.bondingCurveAccountInfo,
        bondingCurve: state.bondingCurve,
        mint,
        user: this.signer.publicKey,
        amount,
        quoteAmount,
        slippage: this.config.sellSlippagePct ?? this.config.slippagePct,
        tokenProgram,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      });
      const signature = await this._send(instructions);
      return this._confirmedSellResult({
        mint,
        tokenProgram,
        signature,
        venue: 'PUMP_BONDING_CURVE',
        soldRaw: sellRaw,
      });
    } catch (error) {
      if (error.signature || !['CURVE_COMPLETE', 'MINT_NOT_FOUND'].includes(error.code)
        && !/complete|not found|Bonding curve/i.test(String(error.message))) throw error;
    }

    const pool = canonicalPumpPoolPda(mint, NATIVE_MINT);
    const state = await this.onlineAmm.swapSolanaState(pool, this.signer.publicKey);
    const instructions = await PUMP_AMM_SDK.sellBaseInput(
      state,
      amount,
      this.config.sellSlippagePct ?? this.config.slippagePct,
    );
    const signature = await this._send(instructions);
    return this._confirmedSellResult({
      mint,
      tokenProgram,
      signature,
      venue: 'PUMP_AMM',
      soldRaw: sellRaw,
    });
  }
}

module.exports = {
  PumpTradeExecutor,
  ammQuotePriceDiagnostics,
  ammReservePrice,
  classifyBuyReconciliation,
  confirmedTransactionFailure,
  exactQuoteInInstructionData,
  minimumTokensOut,
  replaceAmmBuyWithExactQuoteIn,
  replaceBuyV2WithExactQuoteIn,
  secretBytes,
  tokenDeltaFromTransaction,
  walletSolSettlementFromTransaction,
};
