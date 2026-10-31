import { z } from "zod";
import { connect } from "../adapters/postgres/connection.ts";
import { receiptLog, type ReceiptLog } from "../core/ledger/receipts.ts";
import { docsSectionNotFound, type Section } from "../core/ports/docs.ts";
import { docsFor } from "./docs.ts";
import { PodError, throwRecordRefusal } from "./errors.ts";
import { databaseUrl, readHostProfile } from "./host-profile.ts";

export const DocsReadInput = z.strictObject({
  args: z.tuple([]),
  page: z.string().min(1),
  heading: z.string().min(1),
  json: z.boolean().optional(),
});
type DocsReadInput = z.infer<typeof DocsReadInput>;

export const DocsReadOutput = z.object({
  heading: z.string(),
  paragraphs: z.array(z.string()),
  tables: z.array(
    z.object({
      header: z.array(z.string()),
      rows: z.array(z.array(z.string())),
    }),
  ),
});

function cells(row: readonly string[]): string {
  return `| ${row.join(" | ")} |`;
}

export function renderSection(section: Section): string {
  const tables = section.tables.map((table) =>
    [
      ...(table.header.length === 0
        ? []
        : [cells(table.header), cells(table.header.map(() => "---"))]),
      ...table.rows.map(cells),
    ].join("\n"),
  );
  return [`## ${section.heading}`, ...section.paragraphs, ...tables].join(
    "\n\n",
  );
}

export async function docsRead(input: DocsReadInput): Promise<Section> {
  const host = readHostProfile();
  let log: ReceiptLog | null = null;
  const wiring = await docsFor((record) => {
    if (log === null) throw new Error("docs receipt before the ledger opened");
    return log.docsSink(record);
  }, host);
  if (wiring === null)
    throw new PodError(
      "docs_port_missing",
      3,
      "this host has no docs token and no docs fixtures",
      [
        `set ${host.docsTokenEnv} to the docs token`,
        "or set POD_DOCS_FIXTURES to a fixture directory",
      ],
    );
  const connection = connect(databaseUrl(host));
  try {
    log = receiptLog(connection.db, host.hostId);
    const read = await wiring.port.readSection({
      page: input.page,
      heading: input.heading,
    });
    throwRecordRefusal(wiring.recordRefusals());
    if (read.ok && read.result !== null) return read.result;
    if (read.error === docsSectionNotFound)
      throw new PodError(
        "docs_section_not_found",
        3,
        `page ${input.page} has no heading_2 "${input.heading}"`,
        [`pod docs read --page ${input.page} --heading TEXT`],
      );
    throw new PodError(
      "failed",
      1,
      `docs read failed: ${read.error ?? "no result"}`,
      read.error === "object_not_found"
        ? ["connect the docs integration to the page under its Connections"]
        : [],
    );
  } finally {
    await connection.close();
  }
}
