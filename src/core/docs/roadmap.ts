import { z } from "zod";
import type { Refusal } from "../domain/outcome.ts";

const Fields = z.record(z.string(), z.unknown());

function invalid(field: string, message: string): Refusal {
  return {
    code: "config_invalid",
    message: `${field} ${message}`,
    nextSteps: [`fix ${field} in the policy value and apply again`],
  };
}

export function roadmapRefusal(
  policy: unknown,
  docsKind: string,
): Refusal | null {
  const value = Fields.safeParse(policy).data ?? {};
  if (!("roadmap" in value)) return null;
  const roadmap = Fields.safeParse(value["roadmap"]).data;
  if (roadmap === undefined)
    return invalid("roadmap", "must be an object with provider and page");
  const { provider, page } = roadmap;
  if (provider !== docsKind)
    return invalid(
      "roadmap.provider",
      `${String(provider)} is not the host docs kind ${docsKind}`,
    );
  if (typeof page !== "string" || page.trim() === "")
    return invalid("roadmap.page", "must name a page");
  return null;
}
