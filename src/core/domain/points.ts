import type { Size } from "./ledger.ts";

export const sizes: readonly Size[] = ["xs", "s", "m", "l", "xl"];

export const estimateScales: Readonly<Record<string, readonly number[]>> = {
  fibonacci: [1, 2, 3, 5, 8],
  tshirt: [1, 2, 3, 4, 5],
};

export function pointsOf(size: Size, scale: string): number | null {
  if (!Object.hasOwn(estimateScales, scale)) return null;
  return estimateScales[scale]?.[sizes.indexOf(size)] ?? null;
}
