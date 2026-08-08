'use strict';

const DEFAULT_COST_MODEL = Object.freeze({
  platformFeePct: 1.4,
  buySlippagePct: 0.3,
  sellSlippagePct: 0.3,
  priceImpactPct: 0.2,
  baseTxFeeSol: 0.00001,
  priorityFeeSol: 0.0005,
  jitoTipSol: 0,
  fixedCostSol: 0,
  positionSizeSol: 0.2,
  entryFailureRatePct: 0,
  entryFailureCostPct: 1,
});

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegative(value, fallback) {
  return Math.max(0, finite(value, fallback));
}

function normalizeCostModel(options = {}) {
  const entryFailureRatePct = Math.min(100, nonNegative(
    options.entryFailureRatePct,
    finite(options.failureRatePct, DEFAULT_COST_MODEL.entryFailureRatePct),
  ));
  const entryFailureCostPct = nonNegative(
    options.entryFailureCostPct,
    finite(options.failureLossPct, DEFAULT_COST_MODEL.entryFailureCostPct),
  );
  return {
    platformFeePct: nonNegative(
      options.platformFeePct,
      finite(options.tradingCostPct, DEFAULT_COST_MODEL.platformFeePct),
    ),
    buySlippagePct: nonNegative(options.buySlippagePct, DEFAULT_COST_MODEL.buySlippagePct),
    sellSlippagePct: nonNegative(options.sellSlippagePct, DEFAULT_COST_MODEL.sellSlippagePct),
    priceImpactPct: nonNegative(options.priceImpactPct, DEFAULT_COST_MODEL.priceImpactPct),
    baseTxFeeSol: nonNegative(options.baseTxFeeSol, DEFAULT_COST_MODEL.baseTxFeeSol),
    priorityFeeSol: nonNegative(options.priorityFeeSol, DEFAULT_COST_MODEL.priorityFeeSol),
    jitoTipSol: nonNegative(options.jitoTipSol, DEFAULT_COST_MODEL.jitoTipSol),
    fixedCostSol: nonNegative(options.fixedCostSol, DEFAULT_COST_MODEL.fixedCostSol),
    positionSizeSol: Math.max(
      0.000001,
      finite(options.positionSizeSol, DEFAULT_COST_MODEL.positionSizeSol),
    ),
    entryFailureRatePct,
    entryFailureCostPct,
    // Backward-compatible aliases. A failed entry means no position was opened.
    failureRatePct: entryFailureRatePct,
    failureLossPct: entryFailureCostPct,
  };
}

function costBreakdown(options = {}) {
  const model = normalizeCostModel(options);
  const totalFixedCostSol = model.baseTxFeeSol + model.priorityFeeSol
    + model.jitoTipSol + model.fixedCostSol;
  const fixedCostPct = (totalFixedCostSol / model.positionSizeSol) * 100;
  const deterministicCostPct = model.platformFeePct + model.buySlippagePct
    + model.sellSlippagePct + model.priceImpactPct + fixedCostPct;
  return { ...model, totalFixedCostSol, fixedCostPct, deterministicCostPct };
}

function expectedNetReturnPct(rawReturnPct, options = {}) {
  if (!Number.isFinite(rawReturnPct)) return null;
  const costs = costBreakdown(options);
  const successProbability = 1 - costs.entryFailureRatePct / 100;
  const failureProbability = costs.entryFailureRatePct / 100;
  const successfulReturn = rawReturnPct - costs.deterministicCostPct;
  const failedReturn = -costs.entryFailureCostPct;
  return successProbability * successfulReturn + failureProbability * failedReturn;
}

module.exports = {
  DEFAULT_COST_MODEL,
  normalizeCostModel,
  costBreakdown,
  expectedNetReturnPct,
};
