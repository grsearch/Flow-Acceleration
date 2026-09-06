'use strict';

const VERSION = 'ACCOUNT_RECOVERY_DIAGNOSTICS_V1';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
const raw = value => typeof value === 'string' && /^\d{1,24}$/.test(value) ? value : null;

// Only operational evidence belongs in the Dashboard/export. Never persist an
// arbitrary RPC error, endpoint credentials or signed bytes as diagnostics.
function recoveryDiagnostics(value) {
  if (!value || value.version !== VERSION) return null;
  const result = { version: VERSION, quoteAttempts: [] };
  if (value.account && typeof value.account === 'object') {
    const a = value.account;
    result.account = { status: code(a.status), tokenAmountRaw: raw(a.tokenAmountRaw),
      contextSlot: count(a.contextSlot), reason: code(a.reason) };
  }
  if (Array.isArray(value.quoteAttempts)) {
    result.quoteAttempts = value.quoteAttempts.slice(0, 3).map(a => ({
      rpc: ['PRIMARY', 'FALLBACK'].includes(a?.rpc) ? a.rpc : null,
      blockhashSlot: count(a?.blockhashSlot), feeSlot: count(a?.feeSlot),
      feeLamports: count(a?.feeLamports), result: code(a?.result),
    }));
  }
  return result;
}

module.exports = { recoveryDiagnostics };
