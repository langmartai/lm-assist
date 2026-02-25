/**
 * Cost Calculator
 * Calculate token costs based on model pricing.
 *
 * Pricing is loaded from core/data/model-pricing.json with a hardcoded
 * fallback. Supports tiered pricing (above-200k token threshold) per
 * the LiteLLM/ccusage convention. An optional lazy LiteLLM fetch provides
 * pricing for unknown models.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TokenUsage, ModelPricing, CostEstimate, UsageSummary } from './types';

// ── Load pricing from external JSON with hardcoded fallback ─────────────

function loadPricingFromFile(): ModelPricing[] | null {
  // Works from both dist/ and src/ — JSON sits at core/data/
  const candidates = [
    path.join(__dirname, '..', 'data', 'model-pricing.json'),
    path.join(__dirname, '..', '..', 'data', 'model-pricing.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as ModelPricing[];
    } catch {
      // try next candidate
    }
  }
  return null;
}

const HARDCODED_PRICING: ModelPricing[] = [
  {
    modelPattern: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    inputPricePerMillion: 5.0,
    outputPricePerMillion: 25.0,
    cache5mWritePricePerMillion: 6.25,
    cache1hWritePricePerMillion: 10.0,
    cacheReadPricePerMillion: 0.5,
    inputPricePerMillionAbove200k: 10.0,
    outputPricePerMillionAbove200k: 37.5,
    cache5mWritePricePerMillionAbove200k: 12.5,
    cache1hWritePricePerMillionAbove200k: 20.0,
    cacheReadPricePerMillionAbove200k: 1.0,
    tieredThreshold: 200_000,
  },
  {
    modelPattern: 'claude-opus-4-5',
    displayName: 'Claude Opus 4.5',
    inputPricePerMillion: 5.0,
    outputPricePerMillion: 25.0,
    cache5mWritePricePerMillion: 6.25,
    cache1hWritePricePerMillion: 10.0,
    cacheReadPricePerMillion: 0.5,
  },
  {
    modelPattern: 'claude-sonnet-4',
    displayName: 'Claude Sonnet 4',
    inputPricePerMillion: 3.0,
    outputPricePerMillion: 15.0,
    cache5mWritePricePerMillion: 3.75,
    cache1hWritePricePerMillion: 6.0,
    cacheReadPricePerMillion: 0.3,
    inputPricePerMillionAbove200k: 6.0,
    outputPricePerMillionAbove200k: 22.5,
    cache5mWritePricePerMillionAbove200k: 7.5,
    cache1hWritePricePerMillionAbove200k: 12.0,
    cacheReadPricePerMillionAbove200k: 0.6,
    tieredThreshold: 200_000,
  },
  {
    modelPattern: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    inputPricePerMillion: 1.0,
    outputPricePerMillion: 5.0,
    cache5mWritePricePerMillion: 1.25,
    cache1hWritePricePerMillion: 2.0,
    cacheReadPricePerMillion: 0.1,
  },
  {
    modelPattern: 'claude-3-5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    inputPricePerMillion: 3.0,
    outputPricePerMillion: 15.0,
    cache5mWritePricePerMillion: 3.75,
    cache1hWritePricePerMillion: 6.0,
    cacheReadPricePerMillion: 0.3,
    inputPricePerMillionAbove200k: 6.0,
    outputPricePerMillionAbove200k: 30.0,
    cache5mWritePricePerMillionAbove200k: 7.5,
    cache1hWritePricePerMillionAbove200k: 12.0,
    cacheReadPricePerMillionAbove200k: 0.6,
    tieredThreshold: 200_000,
  },
  {
    modelPattern: 'claude-3-5-haiku',
    displayName: 'Claude 3.5 Haiku',
    inputPricePerMillion: 0.8,
    outputPricePerMillion: 4.0,
    cache5mWritePricePerMillion: 1.0,
    cache1hWritePricePerMillion: 1.6,
    cacheReadPricePerMillion: 0.08,
  },
  {
    modelPattern: 'claude-3-opus',
    displayName: 'Claude 3 Opus',
    inputPricePerMillion: 15.0,
    outputPricePerMillion: 75.0,
    cache5mWritePricePerMillion: 18.75,
    cache1hWritePricePerMillion: 30.0,
    cacheReadPricePerMillion: 1.5,
  },
];

/**
 * Default model pricing — loaded from core/data/model-pricing.json,
 * falling back to hardcoded values if the file is missing.
 */
export const DEFAULT_MODEL_PRICING: ModelPricing[] =
  loadPricingFromFile() || HARDCODED_PRICING;

// ── LiteLLM lazy fallback ───────────────────────────────────────────────

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** Shared across all CostCalculator instances */
let litellmCache: Map<string, ModelPricing> | null = null;
let litellmFetchInProgress = false;
let litellmFetchFailed = false;

function convertLiteLLMEntry(key: string, entry: any): ModelPricing | null {
  if (
    typeof entry.input_cost_per_token !== 'number' ||
    typeof entry.output_cost_per_token !== 'number'
  )
    return null;

  const inputPerM = entry.input_cost_per_token * 1_000_000;
  const outputPerM = entry.output_cost_per_token * 1_000_000;

  // Use LiteLLM cache fields if present, otherwise approximate with Anthropic ratios
  const cacheCreatePerM = typeof entry.cache_creation_input_token_cost === 'number'
    ? entry.cache_creation_input_token_cost * 1_000_000
    : inputPerM * 1.25;
  const cacheReadPerM = typeof entry.cache_read_input_token_cost === 'number'
    ? entry.cache_read_input_token_cost * 1_000_000
    : inputPerM * 0.1;

  const pricing: ModelPricing = {
    modelPattern: key,
    displayName: key,
    inputPricePerMillion: inputPerM,
    outputPricePerMillion: outputPerM,
    cache5mWritePricePerMillion: cacheCreatePerM,
    cache1hWritePricePerMillion: cacheCreatePerM * 1.6, // Approximate: 1h is ~1.6x of 5m
    cacheReadPricePerMillion: cacheReadPerM,
  };

  // Tiered pricing — LiteLLM uses `above_200k_tokens` fields for Claude/Anthropic models
  if (typeof entry.input_cost_per_token_above_200k_tokens === 'number') {
    pricing.inputPricePerMillionAbove200k = entry.input_cost_per_token_above_200k_tokens * 1_000_000;
    pricing.tieredThreshold = 200_000;
  }
  if (typeof entry.output_cost_per_token_above_200k_tokens === 'number') {
    pricing.outputPricePerMillionAbove200k = entry.output_cost_per_token_above_200k_tokens * 1_000_000;
  }
  if (typeof entry.cache_creation_input_token_cost_above_200k_tokens === 'number') {
    pricing.cache5mWritePricePerMillionAbove200k = entry.cache_creation_input_token_cost_above_200k_tokens * 1_000_000;
    pricing.cache1hWritePricePerMillionAbove200k = entry.cache_creation_input_token_cost_above_200k_tokens * 1_000_000 * 1.6;
  }
  if (typeof entry.cache_read_input_token_cost_above_200k_tokens === 'number') {
    pricing.cacheReadPricePerMillionAbove200k = entry.cache_read_input_token_cost_above_200k_tokens * 1_000_000;
  }

  return pricing;
}

/**
 * Fire-and-forget LiteLLM pricing fetch. Populates litellmCache on success.
 */
function fetchLiteLLMPricing(): void {
  if (litellmFetchInProgress || litellmFetchFailed || litellmCache) return;
  litellmFetchInProgress = true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  fetch(LITELLM_URL, { signal: controller.signal })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const cache = new Map<string, ModelPricing>();
      const entries = data as Record<string, any>;
      for (const [key, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== 'object') continue;
        const pricing = convertLiteLLMEntry(key, entry);
        if (pricing) cache.set(key, pricing);
      }
      litellmCache = cache;
    })
    .catch(() => {
      litellmFetchFailed = true;
    })
    .finally(() => {
      clearTimeout(timeout);
      litellmFetchInProgress = false;
    });
}

/**
 * Cost Calculator class
 */
export class CostCalculator {
  private pricing: ModelPricing[];
  private defaultModel: string;

  constructor(options?: { customPricing?: ModelPricing[]; defaultModel?: string }) {
    this.pricing = options?.customPricing || DEFAULT_MODEL_PRICING;
    this.defaultModel = options?.defaultModel || 'claude-opus-4-6';
  }

  /**
   * Get pricing for a specific model
   */
  getPricing(model: string): ModelPricing {
    // Normalize model name for matching
    const normalizedModel = model.toLowerCase().replace(/[^a-z0-9]/g, '-');

    // 1. Try local pricing array
    for (const price of this.pricing) {
      const normalizedPattern = price.modelPattern.toLowerCase().replace(/[^a-z0-9]/g, '-');
      if (normalizedModel.includes(normalizedPattern)) {
        return price;
      }
    }

    // 2. Try LiteLLM cache (populated asynchronously)
    if (litellmCache) {
      // Try exact key first, then substring match
      const exact = litellmCache.get(model);
      if (exact) return exact;
      for (const [key, pricing] of litellmCache) {
        const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '-');
        if (normalizedModel.includes(normalizedKey) || normalizedKey.includes(normalizedModel)) {
          return pricing;
        }
      }
    } else {
      // Trigger background fetch for next time
      fetchLiteLLMPricing();
    }

    // 3. Default to first pricing entry
    return this.pricing[0];
  }

  /**
   * Calculate cost for a token amount with tiered pricing.
   * If abovePricePerMillion is set and tokens exceed threshold,
   * the cost is split at the threshold boundary.
   */
  private calculateTieredTokenCost(
    tokens: number,
    basePricePerMillion: number,
    abovePricePerMillion: number | undefined,
    threshold: number
  ): number {
    if (!abovePricePerMillion || tokens <= threshold) {
      return (tokens / 1_000_000) * basePricePerMillion;
    }
    const baseCost = (threshold / 1_000_000) * basePricePerMillion;
    const aboveCost = ((tokens - threshold) / 1_000_000) * abovePricePerMillion;
    return baseCost + aboveCost;
  }

  /**
   * Calculate cost from token usage.
   *
   * When `cumulative` is true (default), token counts are session-level sums
   * across many API calls. Tiered pricing (above-200k) is a per-call concept
   * and cannot be correctly applied to cumulative totals, so base rates are
   * used. Set `cumulative: false` only when passing per-call token counts.
   */
  calculateCost(usage: TokenUsage, model?: string, options?: { cumulative?: boolean }): CostEstimate {
    const pricing = this.getPricing(model || this.defaultModel);
    const threshold = pricing.tieredThreshold || 200_000;
    // Default to cumulative (no tiering) — callers must opt in to per-call tiering
    const isCumulative = options?.cumulative !== false;

    const inputCost = this.calculateTieredTokenCost(
      usage.inputTokens,
      pricing.inputPricePerMillion,
      isCumulative ? undefined : pricing.inputPricePerMillionAbove200k,
      threshold
    );

    const outputCost = this.calculateTieredTokenCost(
      usage.outputTokens,
      pricing.outputPricePerMillion,
      isCumulative ? undefined : pricing.outputPricePerMillionAbove200k,
      threshold
    );

    // Calculate cache write cost (5m + 1h)
    let cacheWriteCost = 0;
    if (usage.cacheCreation) {
      cacheWriteCost += this.calculateTieredTokenCost(
        usage.cacheCreation.ephemeral5mInputTokens,
        pricing.cache5mWritePricePerMillion,
        isCumulative ? undefined : pricing.cache5mWritePricePerMillionAbove200k,
        threshold
      );
      cacheWriteCost += this.calculateTieredTokenCost(
        usage.cacheCreation.ephemeral1hInputTokens,
        pricing.cache1hWritePricePerMillion,
        isCumulative ? undefined : pricing.cache1hWritePricePerMillionAbove200k,
        threshold
      );
    } else {
      // Assume all cache creation is 5m if not specified
      cacheWriteCost = this.calculateTieredTokenCost(
        usage.cacheCreationInputTokens,
        pricing.cache5mWritePricePerMillion,
        isCumulative ? undefined : pricing.cache5mWritePricePerMillionAbove200k,
        threshold
      );
    }

    const cacheReadCost = this.calculateTieredTokenCost(
      usage.cacheReadInputTokens,
      pricing.cacheReadPricePerMillion,
      isCumulative ? undefined : pricing.cacheReadPricePerMillionAbove200k,
      threshold
    );

    return {
      inputCost,
      outputCost,
      cacheWriteCost,
      cacheReadCost,
      totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
      tokens: usage,
      model: model || this.defaultModel,
    };
  }

  /**
   * Estimate cost for a prompt before execution
   * Based on character count (rough estimate: ~4 chars per token)
   */
  estimatePromptCost(
    promptChars: number,
    expectedOutputChars: number,
    contextChars: number,
    model?: string
  ): CostEstimate {
    const CHARS_PER_TOKEN = 4;

    const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
    const outputTokens = Math.ceil(expectedOutputChars / CHARS_PER_TOKEN);
    const contextTokens = Math.ceil(contextChars / CHARS_PER_TOKEN);

    // Assume context goes into cache creation on first call, cache read on subsequent
    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: contextTokens,
      cacheReadInputTokens: 0,
    };

    return this.calculateCost(usage, model);
  }

  /**
   * Estimate CLAUDE.md impact on cost
   */
  estimateClaudeMdCost(
    claudeMdChars: number,
    requestsPerDay: number,
    model?: string
  ): {
    perRequest: number;
    daily: number;
    weekly: number;
    monthly: number;
  } {
    const CHARS_PER_TOKEN = 4;
    const tokens = Math.ceil(claudeMdChars / CHARS_PER_TOKEN);
    const pricing = this.getPricing(model || this.defaultModel);

    // First request pays cache write, subsequent pay cache read
    const firstRequestCost = (tokens / 1_000_000) * pricing.cache5mWritePricePerMillion;
    const subsequentCost = (tokens / 1_000_000) * pricing.cacheReadPricePerMillion;

    // Assume cache expires every 5 minutes, so ~12 cache writes per hour
    const cacheWritesPerDay = Math.min(requestsPerDay, 24 * 12);
    const cacheReadsPerDay = Math.max(0, requestsPerDay - cacheWritesPerDay);

    const dailyCost =
      cacheWritesPerDay * firstRequestCost + cacheReadsPerDay * subsequentCost;

    return {
      perRequest: firstRequestCost, // Worst case (cache miss)
      daily: dailyCost,
      weekly: dailyCost * 7,
      monthly: dailyCost * 30,
    };
  }

  /**
   * Aggregate usage across multiple cost estimates
   */
  aggregateCosts(estimates: CostEstimate[]): CostEstimate {
    const totals: CostEstimate = {
      inputCost: 0,
      outputCost: 0,
      cacheWriteCost: 0,
      cacheReadCost: 0,
      totalCost: 0,
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreation: {
          ephemeral5mInputTokens: 0,
          ephemeral1hInputTokens: 0,
        },
      },
      model: 'mixed',
    };

    for (const est of estimates) {
      totals.inputCost += est.inputCost;
      totals.outputCost += est.outputCost;
      totals.cacheWriteCost += est.cacheWriteCost;
      totals.cacheReadCost += est.cacheReadCost;
      totals.totalCost += est.totalCost;

      totals.tokens.inputTokens += est.tokens.inputTokens;
      totals.tokens.outputTokens += est.tokens.outputTokens;
      totals.tokens.cacheCreationInputTokens += est.tokens.cacheCreationInputTokens;
      totals.tokens.cacheReadInputTokens += est.tokens.cacheReadInputTokens;

      if (est.tokens.cacheCreation && totals.tokens.cacheCreation) {
        totals.tokens.cacheCreation.ephemeral5mInputTokens +=
          est.tokens.cacheCreation.ephemeral5mInputTokens;
        totals.tokens.cacheCreation.ephemeral1hInputTokens +=
          est.tokens.cacheCreation.ephemeral1hInputTokens;
      }
    }

    return totals;
  }

  /**
   * Format cost as string
   */
  formatCost(cost: number): string {
    if (cost < 0.01) {
      return `$${cost.toFixed(6)}`;
    } else if (cost < 1) {
      return `$${cost.toFixed(4)}`;
    } else {
      return `$${cost.toFixed(2)}`;
    }
  }

  /**
   * Format token count
   */
  formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
      return `${(tokens / 1_000_000).toFixed(2)}M`;
    } else if (tokens >= 1_000) {
      return `${(tokens / 1_000).toFixed(1)}K`;
    }
    return tokens.toString();
  }

  /**
   * Get all available pricing
   */
  getAllPricing(): ModelPricing[] {
    return [...this.pricing];
  }

  /**
   * Add custom pricing
   */
  addPricing(pricing: ModelPricing): void {
    this.pricing.push(pricing);
  }

  /**
   * Set default model
   */
  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }

  /**
   * Create usage summary for a time period
   */
  createUsageSummary(
    data: Array<{
      sessionId: string;
      date: Date;
      model: string;
      tokens: TokenUsage;
    }>
  ): UsageSummary {
    const costByModel: Record<string, number> = {};
    const costByDay: Record<string, number> = {};
    const sessionCosts: Array<{ sessionId: string; cost: number }> = [];

    let totalMessages = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let periodStart = new Date();
    let periodEnd = new Date(0);

    for (const item of data) {
      const cost = this.calculateCost(item.tokens, item.model);

      // Track totals
      totalMessages++;
      totalTokens +=
        item.tokens.inputTokens +
        item.tokens.outputTokens +
        item.tokens.cacheCreationInputTokens +
        item.tokens.cacheReadInputTokens;
      totalCost += cost.totalCost;

      // Track by model
      costByModel[item.model] = (costByModel[item.model] || 0) + cost.totalCost;

      // Track by day
      const dayKey = item.date.toISOString().split('T')[0];
      costByDay[dayKey] = (costByDay[dayKey] || 0) + cost.totalCost;

      // Track session costs
      const existingSession = sessionCosts.find((s) => s.sessionId === item.sessionId);
      if (existingSession) {
        existingSession.cost += cost.totalCost;
      } else {
        sessionCosts.push({ sessionId: item.sessionId, cost: cost.totalCost });
      }

      // Track date range
      if (item.date < periodStart) periodStart = item.date;
      if (item.date > periodEnd) periodEnd = item.date;
    }

    // Sort sessions by cost
    sessionCosts.sort((a, b) => b.cost - a.cost);

    return {
      periodStart,
      periodEnd,
      totalMessages,
      totalTokens,
      totalCost,
      costByModel,
      costByDay,
      topSessions: sessionCosts.slice(0, 10),
    };
  }
}

/**
 * Create a new cost calculator instance
 */
export function createCostCalculator(options?: {
  customPricing?: ModelPricing[];
  defaultModel?: string;
}): CostCalculator {
  return new CostCalculator(options);
}
