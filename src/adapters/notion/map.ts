import { z } from "zod";

export const Block = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
});
export type Block = z.infer<typeof Block>;

export const Listing = z.looseObject({
  results: z.array(Block),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const RichText = z.array(z.looseObject({ plain_text: z.string() }));
const Cells = z.array(RichText);

export const textTypes: ReadonlySet<string> = new Set([
  "paragraph",
  "bulleted_list_item",
  "numbered_list_item",
]);
export const headingTypes: ReadonlySet<string> = new Set([
  "heading_1",
  "heading_2",
  "heading_3",
]);

function payloadOf(block: Block): Record<string, unknown> {
  const payload: unknown = block[block.type];
  return payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function plainText(items: z.infer<typeof RichText>): string {
  return items.map((item) => item.plain_text).join("");
}

export function textOf(block: Block): string | null {
  const parsed = RichText.safeParse(payloadOf(block)["rich_text"]);
  return parsed.success ? plainText(parsed.data) : null;
}

export function hasColumnHeader(block: Block): boolean {
  return payloadOf(block)["has_column_header"] === true;
}

export function cellsOf(block: Block): string[] | null {
  const parsed = Cells.safeParse(payloadOf(block)["cells"]);
  return parsed.success ? parsed.data.map(plainText) : null;
}
