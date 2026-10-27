import { z } from "zod";

export const DrainPayload = z.looseObject({
  ended: z.boolean(),
  op_key: z.string(),
});
export type DrainPayload = z.infer<typeof DrainPayload>;
