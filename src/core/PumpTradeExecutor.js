'use strict';

const {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} = require('@solana/web3.js');
const {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require('@solana/spl-token');
const {
  OnlinePumpSdk,
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} = require('@pump-fun/pump-sdk');
const {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  canonicalPumpPoolPda,
} = require('@pump-fun/pump-swap-sdk');
const BN = require('bn.js');
const bs58Module = require('bs58');

const bs58 = bs58Module.default || bs58Module;

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

class PumpTradeExecutor {
  constructor(config) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, {
      commitment: config.commitment,
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
  }

  publicKey() {
    return this.signer.publicKey.toBase58();
  }

  async walletBalanceSol() {
    return (await this.connection.getBalance(this.signer.publicKey, this.config.commitment))
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

  async _tokenProgram(mint) {
    const info = await this.connection.getAccountInfo(mint, this.config.commitment);
    if (!info) throw errorWithCode(`Mint account not found: ${mint.toBase58()}`, 'MINT_NOT_FOUND');
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
    if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
    throw errorWithCode(`Unsupported token program: ${info.owner.toBase58()}`, 'TOKEN_PROGRAM');
  }

  async _tokenBalanceRaw(mint, tokenProgram) {
    const ata = getAssociatedTokenAddressSync(
      mint,
      this.signer.publicKey,
      true,
      tokenProgram,
    );
    try {
      const balance = await this.connection.getTokenAccountBalance(ata, this.config.commitment);
      return BigInt(balance.value.amount);
    } catch (error) {
      const message = String(error?.message || error);
      if (/could not find account|Invalid param|not found/i.test(message)) return 0n;
      throw error;
    }
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

  async _send(instructions) {
    const latest = await this.connection.getLatestBlockhash(this.config.commitment);
    const transaction = new Transaction({
      feePayer: this.signer.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
    transaction.add(...this._budgetInstructions(), ...instructions);
    transaction.sign(this.signer);
    let signature;
    try {
      signature = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 2,
        preflightCommitment: this.config.commitment,
      });
      const confirmation = await this.connection.confirmTransaction({
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }, this.config.commitment);
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      return signature;
    } catch (error) {
      if (signature) error.signature = signature;
      throw error;
    }
  }

  async buy({ mint: mintValue, solAmount, referencePrice, maxPriceJumpPct }) {
    const mint = new PublicKey(mintValue);
    const tokenProgram = await this._tokenProgram(mint);
    const balanceBefore = await this._tokenBalanceRaw(mint, tokenProgram);
    if (balanceBefore > 0n) {
      throw errorWithCode('Trading wallet already holds this mint', 'WALLET_ALREADY_HOLDS_MINT');
    }

    const spendLamports = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
    const balanceLamports = await this.connection.getBalance(
      this.signer.publicKey,
      this.config.commitment,
    );
    const reserveLamports = Math.round(this.config.minWalletReserveSol * LAMPORTS_PER_SOL);
    if (balanceLamports - Number(spendLamports) < reserveLamports) {
      throw errorWithCode('Wallet reserve guard rejected entry', 'WALLET_RESERVE');
    }

    const [{ global, feeConfig }, state] = await Promise.all([
      this._protocolState(),
      this.onlinePump.fetchBuyState(mint, this.signer.publicKey, tokenProgram),
    ]);
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

    const expectedPrice = solAmount / (Number(amount.toString()) / 1e6);
    if (Number.isFinite(referencePrice) && referencePrice > 0 && maxPriceJumpPct >= 0) {
      const jumpPct = ((expectedPrice / referencePrice) - 1) * 100;
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
      slippage: this.config.slippagePct,
      tokenProgram,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });
    const signature = await this._send(instructions);
    const balanceAfter = await this._tokenBalanceRaw(mint, tokenProgram);
    const acquired = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : BigInt(amount.toString());
    return {
      signature,
      venue: 'PUMP_BONDING_CURVE',
      tokenAmountRaw: acquired.toString(),
      expectedPrice,
    };
  }

  async sell({ mint: mintValue, tokenAmountRaw }) {
    const mint = new PublicKey(mintValue);
    const tokenProgram = await this._tokenProgram(mint);
    const walletBalance = await this._tokenBalanceRaw(mint, tokenProgram);
    const requested = BigInt(tokenAmountRaw || '0');
    const sellRaw = requested > 0n && requested < walletBalance ? requested : walletBalance;
    if (sellRaw <= 0n) {
      return { signature: null, venue: 'NONE', tokenAmountRaw: '0', alreadyEmpty: true };
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
        slippage: this.config.slippagePct,
        tokenProgram,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      });
      const signature = await this._send(instructions);
      return { signature, venue: 'PUMP_BONDING_CURVE', tokenAmountRaw: sellRaw.toString() };
    } catch (error) {
      if (error.signature || !['CURVE_COMPLETE', 'MINT_NOT_FOUND'].includes(error.code)
        && !/complete|not found|Bonding curve/i.test(String(error.message))) throw error;
    }

    const pool = canonicalPumpPoolPda(mint, NATIVE_MINT);
    const state = await this.onlineAmm.swapSolanaState(pool, this.signer.publicKey);
    const instructions = await PUMP_AMM_SDK.sellBaseInput(
      state,
      amount,
      this.config.slippagePct,
    );
    const signature = await this._send(instructions);
    return { signature, venue: 'PUMP_AMM', tokenAmountRaw: sellRaw.toString() };
  }
}

module.exports = {
  PumpTradeExecutor,
  secretBytes,
};
