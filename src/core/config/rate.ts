import { z } from "zod";
import type { ActivationKey, RevisionEnvelope } from "../domain/config.ts";
import type { Refusal } from "../domain/outcome.ts";

const Name = z.string().min(1);
const Price = z.number().finite().min(0);

const PriceRow = z.strictObject({
  runtime: Name,
  model: Name,
  input: Price,
  cached_input: Price,
  cache_write: Price,
  output: Price,
  per: z.int().positive(),
});
export type PriceRow = z.infer<typeof PriceRow>;

const RateValue = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/, "needs a three-letter code"),
  prices: z.array(PriceRow),
});
export type RateValue = z.infer<typeof RateValue>;

export const activeRate: ActivationKey = {
  scope: "global",
  scope_ref: "",
  kind: "rate",
  name: "default",
};

function invalid(message: string, path: string): Refusal {
  return { code: "schema_invalid", message, nextSteps: [path] };
}

function checkRate(
  value: unknown,
): { rate: RateValue; refusal: null } | { rate: null; refusal: Refusal } {
  const parsed = RateValue.safeParse(value);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const path =
      issue?.code === "unrecognized_keys"
        ? [...issue.path, ...issue.keys]
        : (issue?.path ?? []);
    return {
      rate: null,
      refusal: invalid(
        `rate value fails its schema: ${issue?.message ?? "invalid"}`,
        path.join("."),
      ),
    };
  }
  const seen = new Set<string>();
  for (const [index, row] of parsed.data.prices.entries()) {
    const key = JSON.stringify([row.runtime, row.model]);
    if (seen.has(key))
      return {
        rate: null,
        refusal: invalid(
          `prices lists runtime ${row.runtime} and model ${row.model} twice`,
          `prices.${index}`,
        ),
      };
    seen.add(key);
  }
  return { rate: parsed.data, refusal: null };
}

export function validateRate(value: unknown): Refusal | null {
  return checkRate(value).refusal;
}

export function parseRate(value: unknown): RateValue {
  const { rate, refusal } = checkRate(value);
  if (rate === null) throw new Error(refusal.message);
  return rate;
}

export function rateRefusal(envelope: RevisionEnvelope): Refusal | null {
  if (envelope.scope !== "global")
    return invalid(
      `a rate Revision has scope global, not ${envelope.scope}`,
      "scope",
    );
  if (envelope.name !== activeRate.name)
    return invalid(
      `a rate Revision is named ${activeRate.name}, not ${envelope.name}`,
      "name",
    );
  return validateRate(envelope.value);
}
