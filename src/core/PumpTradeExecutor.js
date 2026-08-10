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
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
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

function classifyBuyReconciliation(status, tokenBalanceRaw) {
  const tokenBalance = BigInt(tokenBalanceRaw || 0);
  if (tokenBalance > 0n) {
    return {
      state: 'CONFIRMED',
      tokenAmountRaw: tokenBalance.toString(),
      confirmationStatus: status?.confirmationStatus || null,
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
      state: 'EMPTY',
      tokenAmountRaw: '0',
      confirmationStatus: status.confirmationStatus,
      error: 'Buy transaction confirmed but the trading wallet has no token balance',
    };
  }
  return {
    state: 'UNKNOWN',
    tokenAmountRaw: '0',
    confirmationStatus: status?.confirmationStatus || null,
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
    const ata = getAssociatedTokenAddressSync(
      mint,
      this.signer.publicKey,
      true,
      tokenProgram,
    );
    try {
      const balance = await this.connection.getTokenAccountBalance(ata, commitment);
      return BigInt(balance.value.amount);
    } catch (error) {
      const message = String(error?.message || error);
      if (/could not find account|Invalid param|not found/i.test(message)) return 0n;
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
      associatedUserAccountInfo = token2022AtaInfo;
    } else if (mintAccountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      tokenProgram = TOKEN_PROGRAM_ID;
      associatedUserAccountInfo = legacyAtaInfo;
    } else {
      throw errorWithCode(
        `Unsupported token program: ${mintAccountInfo.owner.toBase58()}`,
        'TOKEN_PROGRAM',
      );
    }
    if (!bondingCurveAccountInfo) {
      throw errorWithCode(
        `Bonding curve account not found for mint: ${mint.toBase58()}`,
        'CURVE_NOT_FOUND',
      );
    }
    this.tokenPrograms.set(mint.toBase58(), tokenProgram);
    return {
      tokenProgram,
      balanceBefore: associatedUserAccountInfo
        ? AccountLayout.decode(associatedUserAccountInfo.data).amount
        : 0n,
      bondingCurveAccountInfo,
      bondingCurve: this.pump.decodeBondingCurve(bondingCurveAccountInfo),
      associatedUserAccountInfo,
      contextSlot: response.context.slot,
      contextRetries,
    };
  }

  _budgetInstructions() {
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({
      units: this.config.computeUnitLimit,
    })];
    if (this.config.priorityFeeMicroLamports > 0) {
      instructions.push(ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: this.config.priorityFeeMicroLamports,
      }));
    }
    return instructions;
  }

  async _send(instructions, { latestBlockhash = null, onStage = null } = {}) {
    const stage = (name) => {
      if (typeof onStage === 'function') onStage(name);
    };
    const latest = latestBlockhash
      || await this.connection.getLatestBlockhash(this.readCommitment);
    stage('blockhash_ready_ms');
    const transaction = new Transaction({
      feePayer: this.signer.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
    transaction.add(...this._budgetInstructions(), ...instructions);
    transaction.sign(this.signer);
    stage('signed_ms');
    let signature;
    try {
      signature = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 2,
        preflightCommitment: this.readCommitment,
      });
      stage('submitted_ms');
      const confirmation = await this.connection.confirmTransaction({
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }, this.confirmationCommitment);
      if (confirmation.value.err) {
        throw confirmedTransactionFailure(signature, confirmation.value.err);
      }
      stage('confirmed_ms');
      return signature;
    } catch (error) {
      if (signature) error.signature = signature;
      throw error;
    }
  }

  async reconcileBuy({ mint: mintValue, signature = null }) {
    const mint = new PublicKey(mintValue);
    const tokenProgram = await this._tokenProgram(mint);
    const [statusResponse, tokenBalance] = await Promise.all([
      signature
        ? this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
        : Promise.resolve({ value: [null] }),
      this._tokenBalanceRaw(mint, tokenProgram, this.confirmationCommitment),
    ]);
    const status = statusResponse?.value?.[0] || null;
    return classifyBuyReconciliation(status, tokenBalance);
  }

  async buy({
    mint: mintValue,
    solAmount,
    referencePrice,
    maxPriceJumpPct,
    signalSlot = null,
  }) {
    const startedAt = Date.now();
    const minimumContextSlot = normalizedSlot(signalSlot);
    const execution = {
      version: 2,
      buyMode: 'EXACT_QUOTE_IN_V2_FIXED_SOL',
      hardSpendCap: true,
      positionSol: solAmount,
      slippagePct: this.config.buySlippagePct ?? this.config.slippagePct,
      signalSlot: minimumContextSlot,
      readCommitment: this.readCommitment,
      preflightCommitment: this.readCommitment,
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
      const readConfig = commitmentConfig(this.readCommitment);
      const buyStatePromise = this._buyStateAtSignalSlot(mint, minimumContextSlot);
      const protocolPromise = this._protocolState();
      const latestBlockhashPromise = this.connection.getLatestBlockhashAndContext(readConfig);
      const balanceLamportsPromise = this.connection.getBalanceAndContext(
        this.signer.publicKey,
        readConfig,
      );

      const spendLamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
      execution.spendableQuoteRaw = spendLamports.toString();
      const [
        state,
        balanceResponse,
        protocol,
        blockhashResponse,
      ] = await Promise.all([
        buyStatePromise,
        balanceLamportsPromise,
        protocolPromise,
        latestBlockhashPromise,
      ]);
      const { tokenProgram, balanceBefore } = state;
      const balanceLamports = balanceResponse.value;
      const latestBlockhash = blockhashResponse.value;
      execution.rpcContextSlot = state.contextSlot;
      execution.slotLag = minimumContextSlot === null
        ? null
        : state.contextSlot - minimumContextSlot;
      execution.contextRetries = state.contextRetries;
      execution.rpcSlots = {
        minimumContextSlot,
        quoteContextSlot: state.contextSlot,
        walletContextSlot: balanceResponse.context.slot,
        blockhashContextSlot: blockhashResponse.context.slot,
      };
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

  async _confirmedSellResult({ mint, tokenProgram, signature, venue, soldRaw }) {
    try {
      const remaining = await this._tokenBalanceRaw(
        mint,
        tokenProgram,
        this.confirmationCommitment,
      );
      return {
        signature,
        venue,
        tokenAmountRaw: soldRaw.toString(),
        remainingTokenAmountRaw: remaining.toString(),
        balanceVerified: true,
      };
    } catch (error) {
      return {
        signature,
        venue,
        tokenAmountRaw: soldRaw.toString(),
        remainingTokenAmountRaw: null,
        balanceVerified: false,
        balanceCheckError: String(error?.message || error).slice(0, 1_000),
      };
    }
  }

  async sell({ mint: mintValue }) {
    const mint = new PublicKey(mintValue);
    const tokenProgram = await this._tokenProgram(mint);
    const walletBalance = await this._tokenBalanceRaw(mint, tokenProgram);
    // Entry rejects pre-existing holdings for the mint, so the live wallet balance belongs
    // to this position. Always sell that complete balance instead of the possibly stale
    // amount cached immediately after the buy confirmation.
    const sellRaw = walletBalance;
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
  classifyBuyReconciliation,
  confirmedTransactionFailure,
  exactQuoteInInstructionData,
  minimumTokensOut,
  replaceBuyV2WithExactQuoteIn,
  secretBytes,
};
