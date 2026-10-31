import { readFileSync } from "node:fs";
import { z } from "zod";

export interface BypassResult {
  result: "pass" | "fail";
  at: string;
}

const Line = z.looseObject({
  host: z.string(),
  result: z.enum(["pass", "fail"]),
  at: z.string().min(1),
});

export function readBypass(path: string, host: string): BypassResult | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let newest: BypassResult | null = null;
  for (const line of text.split("\n")) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = Line.safeParse(value);
    if (parsed.success && parsed.data.host === host)
      newest = { result: parsed.data.result, at: parsed.data.at };
  }
  return newest;
}
