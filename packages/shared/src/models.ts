import { z } from "zod";

export const ModelRole = z.enum([
  "chat", "reasoning", "coding", "fast", "research",
  "creative", "vision", "backup", "embedding",
]);
export type ModelRole = z.infer<typeof ModelRole>;

/** User-editable at runtime (stored in settings, not compiled in). */
export const ModelRoute = z.object({
  role: ModelRole,
  primary: z.string(), // OpenRouter model id, e.g. "provider/model:free"
  fallbacks: z.array(z.string()).default([]),
  maxTokens: z.number().int().positive().optional(),
});
export type ModelRoute = z.infer<typeof ModelRoute>;

export const Budget = z.object({
  monthlyLimitUsd: z.number().nonnegative(),
  warnAtFraction: z.number().min(0).max(1).default(0.8),
  hardStop: z.boolean().default(true),
});
export type Budget = z.infer<typeof Budget>;

export type BudgetDecision = "ok" | "warn" | "blocked";

/** Paid calls only; free models (cost 0) always pass. */
export function checkBudget(spentUsd: number, estimatedCallUsd: number, b: Budget): BudgetDecision {
  if (estimatedCallUsd <= 0) return "ok";
  const after = spentUsd + estimatedCallUsd;
  if (after > b.monthlyLimitUsd) return b.hardStop ? "blocked" : "warn";
  if (after >= b.monthlyLimitUsd * b.warnAtFraction) return "warn";
  return "ok";
}

/** Free OpenRouter models carry the ":free" suffix. */
export const isFreeModel = (id: string) => id.endsWith(":free");
