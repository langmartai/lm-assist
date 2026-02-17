/**
 * Cost Calculator
 * Calculate token costs based on model pricing
 */

import type { TokenUsage, ModelPricing, CostEstimate, UsageSummary } from './types';

/**
 * Default model pricing (as of January 2025)
 */
export const DEFAULT_MODEL_PRICING: ModelPricing[] = [
  {
    modelPattern: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    inputPricePerMillion: 5.0,
    outputPricePerMillion: 25.0,
    cache5mWritePricePerMillion: 6.25,
    cache1hWritePricePerMillion: 10.0,
    cacheReadPricePerMillion: 0.5,
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

    // Find matching pricing
    for (const price of this.pricing) {
      const normalizedPattern = price.modelPattern.toLowerCase().replace(/[^a-z0-9]/g, '-');
      if (normalizedModel.includes(normalizedPattern)) {
        return price;
      }
    }

    // Default to first pricing (usually Opus 4.5)
    return this.pricing[0];
  }

  /**
   * Calculate cost from token usage
   */
  calculateCost(usage: TokenUsage, model?: string): CostEstimate {
    const pricing = this.getPricing(model || this.defaultModel);

    const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPricePerMillion;
    const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPricePerMillion;

    // Calculate cache write cost (5m + 1h)
    let cacheWriteCost = 0;
    if (usage.cacheCreation) {
      cacheWriteCost +=
        (usage.cacheCreation.ephemeral5mInputTokens / 1_000_000) *
        pricing.cache5mWritePricePerMillion;
      cacheWriteCost +=
        (usage.cacheCreation.ephemeral1hInputTokens / 1_000_000) *
        pricing.cache1hWritePricePerMillion;
    } else {
      // Assume all cache creation is 5m if not specified
      cacheWriteCost =
        (usage.cacheCreationInputTokens / 1_000_000) * pricing.cache5mWritePricePerMillion;
    }

    const cacheReadCost =
      (usage.cacheReadInputTokens / 1_000_000) * pricing.cacheReadPricePerMillion;

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
