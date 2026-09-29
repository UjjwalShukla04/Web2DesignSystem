// AI usage: estimated cost per generation, and daily limits for the server's keys.
//
// Only requests that use the SERVER's key count towards the limits (users who bring
// their own key pay for it themselves). Counters live in memory: they reset at
// midnight UTC and when the server restarts.

export type UsageProvider = "gemini" | "openai";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Estimated from the price table below; providers' real prices can differ. */
  costUsd: number;
}

export const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** USD per 1 million tokens. Override with env vars when prices or models change. */
export function prices(env: Record<string, string | undefined> = process.env) {
  return {
    gemini: { input: num(env.GEMINI_PRICE_INPUT, 0.3), output: num(env.GEMINI_PRICE_OUTPUT, 2.5) },
    openai: { input: num(env.OPENAI_PRICE_INPUT, 2.5), output: num(env.OPENAI_PRICE_OUTPUT, 10) },
  };
}

export function costOf(provider: UsageProvider, inputTokens: number, outputTokens: number): Usage {
  const p = prices()[provider];
  const costUsd = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  return { inputTokens, outputTokens, costUsd: Math.round(costUsd * 1e6) / 1e6 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
  };
}

// --- Daily limits (server key only) ---

export interface Limits {
  /** Generations per user (client IP) per day with the server's key. 0 = unlimited. */
  perUserPerDay: number;
  /** Estimated USD the server's keys may spend per day, all users together. 0 = unlimited. */
  dailyBudgetUsd: number;
}

export function loadLimits(env: Record<string, string | undefined> = process.env): Limits {
  return {
    perUserPerDay: Math.floor(num(env.DAILY_GENERATIONS_PER_USER, 50)),
    dailyBudgetUsd: num(env.DAILY_BUDGET_USD, 0),
  };
}

export class QuotaError extends Error {}

export function createUsageTracker(limits: Limits, now: () => Date = () => new Date()) {
  let day = "";
  let users = new Map<string, { requests: number; costUsd: number }>();
  let totalCostUsd = 0;

  const today = () => {
    const d = now().toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      users = new Map();
      totalCostUsd = 0;
    }
    return users;
  };
  const user = (id: string) => {
    const map = today();
    let u = map.get(id);
    if (!u) map.set(id, (u = { requests: 0, costUsd: 0 }));
    return u;
  };

  return {
    /**
     * Call before a generation with the server's key: throws QuotaError if a limit is
     * reached, otherwise counts the request (so parallel requests can't overshoot).
     */
    reserve(userId: string) {
      const u = user(userId);
      if (limits.dailyBudgetUsd > 0 && totalCostUsd >= limits.dailyBudgetUsd) {
        throw new QuotaError(
          "The server's daily AI budget is used up. Add your own API key in ⚙ Settings to continue, or try again tomorrow.",
        );
      }
      if (limits.perUserPerDay > 0 && u.requests >= limits.perUserPerDay) {
        throw new QuotaError(
          `Daily limit reached: ${limits.perUserPerDay} generations per day with the server's key. Add your own API key in ⚙ Settings to continue, or try again tomorrow.`,
        );
      }
      u.requests++;
    },
    /** Gives back a reserved request that failed (e.g. the provider rejected it). */
    release(userId: string) {
      const u = user(userId);
      u.requests = Math.max(0, u.requests - 1);
    },
    /** Adds a finished generation's estimated cost. */
    record(userId: string, usage: Usage) {
      user(userId).costUsd += usage.costUsd;
      totalCostUsd += usage.costUsd;
    },
    /** The caller's usage today and the limits (never other users' numbers). */
    summary(userId: string) {
      const u = user(userId);
      return {
        day,
        requests: u.requests,
        costUsd: Math.round(u.costUsd * 1e6) / 1e6,
        limits,
        remaining: limits.perUserPerDay > 0 ? Math.max(0, limits.perUserPerDay - u.requests) : null,
        budgetExhausted: limits.dailyBudgetUsd > 0 && totalCostUsd >= limits.dailyBudgetUsd,
      };
    },
  };
}

export type UsageTracker = ReturnType<typeof createUsageTracker>;
