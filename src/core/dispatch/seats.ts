import { z } from "zod";

const SeatList = z.array(
  z.looseObject({
    id: z.string().min(1),
    roles: z.array(z.string().min(1)).min(1),
    runtime: z.string().min(1),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    fallback: z.string().min(1).optional(),
  }),
);

export type Seat = z.infer<typeof SeatList>[number];

export class SeatsInvalid extends Error {
  constructor(readonly path: string) {
    super(`the crew value fails the Seat schema at ${path}`);
  }
}

export function readSeats(value: unknown): Seat[] {
  const raw =
    value !== null && typeof value === "object" && "seats" in value
      ? value.seats
      : undefined;
  const parsed = SeatList.safeParse(raw);
  if (parsed.success) return parsed.data;
  const [first] = parsed.error.issues;
  throw new SeatsInvalid(
    `${["seats", ...(first?.path ?? []).map(String)].join(".")}: ${first?.message ?? "invalid"}`,
  );
}

export function seatProviders(crew: unknown): string[] {
  return [...new Set(readSeats(crew).map((seat) => seat.runtime))].sort();
}

export function fallbackProblem(
  value: unknown,
): { path: string; message: string } | null {
  const raw =
    value !== null && typeof value === "object" && "seats" in value
      ? value.seats
      : undefined;
  if (!Array.isArray(raw)) return null;
  const ids = raw.map((seat: unknown) =>
    seat !== null && typeof seat === "object" && "id" in seat
      ? String(seat.id)
      : "",
  );
  const next = new Map<string, string>();
  for (const [i, seat] of raw.entries()) {
    if (seat === null || typeof seat !== "object" || !("fallback" in seat))
      continue;
    const path = `seats.${i}.fallback`;
    const target = String(seat.fallback);
    if (target === ids[i])
      return { path, message: `${path}: names the seat itself` };
    if (!ids.includes(target))
      return { path, message: `${path}: names undefined seat ${target}` };
    next.set(ids[i] ?? "", target);
  }
  for (const [i, start] of ids.entries()) {
    const seen = [start];
    let at = next.get(start);
    while (at !== undefined) {
      if (seen.includes(at)) {
        const path = `seats.${i}.fallback`;
        return {
          path,
          message: `${path}: forms a cycle ${[...seen, at].join(" -> ")}`,
        };
      }
      seen.push(at);
      at = next.get(at);
    }
  }
  return null;
}
