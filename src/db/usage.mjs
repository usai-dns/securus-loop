// Claude API usage + cost tracing. Every AI call records its token usage here so
// we can monitor per-request and cumulative pricing.

import { getState, setState } from './state.mjs';

// USD per 1M tokens. Cache reads bill at ~0.1x the input rate.
export const PRICING = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-opus-4-8':   { input: 5.0, output: 25.0 },
  'claude-haiku-4-5':  { input: 1.0, output: 5.0 },
};

export function estimateCost(model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0) {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  const inCost = (inputTokens / 1e6) * p.input;
  const cacheCost = (cacheReadTokens / 1e6) * p.input * 0.1;
  const outCost = (outputTokens / 1e6) * p.output;
  return inCost + cacheCost + outCost;
}

// Record one AI call: logs a per-request line and increments cumulative counters
// (requests, input/output tokens, cost). Returns { total, cost }.
export async function recordUsage(db, { kind, model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0 }) {
  const total = inputTokens + outputTokens;
  const cost = estimateCost(model, inputTokens, outputTokens, cacheReadTokens);

  const num = async (key) => parseFloat(await getState(db, key)) || 0;
  const reqs = (await num('ai_total_requests')) + 1;
  const totIn = (await num('ai_total_input_tokens')) + inputTokens;
  const totOut = (await num('ai_total_output_tokens')) + outputTokens;
  const totCost = (await num('ai_total_cost_usd')) + cost;

  await setState(db, 'ai_total_requests', String(reqs));
  await setState(db, 'ai_total_input_tokens', String(totIn));
  await setState(db, 'ai_total_output_tokens', String(totOut));
  await setState(db, 'ai_total_cost_usd', String(totCost));

  const avgTotal = Math.round((totIn + totOut) / reqs);
  console.log(
    `[USAGE] ${kind} model=${model} in=${inputTokens} out=${outputTokens} total=${total} ` +
    `cost=$${cost.toFixed(4)} | cumulative: reqs=${reqs} avg=${avgTotal} tok/req ` +
    `in=${totIn} out=${totOut} cost=$${totCost.toFixed(2)}`
  );
  return { total, cost };
}

// Read the cumulative usage snapshot for the dashboard / status.
export async function getUsageSnapshot(db) {
  const num = async (key) => parseFloat(await getState(db, key)) || 0;
  const reqs = await num('ai_total_requests');
  const totIn = await num('ai_total_input_tokens');
  const totOut = await num('ai_total_output_tokens');
  const totCost = await num('ai_total_cost_usd');
  const totalTokens = totIn + totOut;
  return {
    requests: reqs,
    inputTokens: totIn,
    outputTokens: totOut,
    totalTokens,
    avgTokensPerRequest: reqs ? Math.round(totalTokens / reqs) : 0,
    avgCostPerRequest: reqs ? totCost / reqs : 0,
    totalCostUsd: totCost,
  };
}
