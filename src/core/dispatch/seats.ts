import { z } from "zod";

const SeatList = z.array(
  z.looseObject({
    id: z.string().min(1),
    roles: z.array(z.string().min(1)).min(1),
    runtime: z.string().min(1),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
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
