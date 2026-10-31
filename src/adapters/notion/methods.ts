import {
  docsSectionNotFound,
  type DocsMethod,
  type DocsPort,
  type DocsReceipt,
  type DocsRequest,
  type Section,
  type SectionRef,
} from "../../core/ports/docs.ts";
import { decode, type HttpReply } from "./client.ts";
import {
  Listing,
  cellsOf,
  hasColumnHeader,
  headingTypes,
  textOf,
  textTypes,
  type Block,
} from "./map.ts";

export type Send = (
  verb: DocsMethod,
  ref: SectionRef,
  request: DocsRequest,
) => Promise<HttpReply>;

export const maxPages = 40;
export const pageSize = "100";

type Step = "next" | "stop" | { error: string };

interface Reads {
  raws: unknown[];
  requestId: string | null;
}

type Table = Section["tables"][number];

export function docsMethods(send: Send): DocsPort {
  async function eachBlock(
    ref: SectionRef,
    id: string,
    reads: Reads,
    visit: (block: Block) => Step | Promise<Step>,
  ): Promise<string | null> {
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const reply = await send("readSection", ref, {
        method: "GET",
        path: `/v1/blocks/${id}/children`,
        query:
          cursor === null
            ? { page_size: pageSize }
            : { page_size: pageSize, start_cursor: cursor },
      });
      reads.requestId ??= reply.requestId;
      const decoded = decode(reply, Listing);
      reads.raws.push(decoded.raw);
      if (decoded.result === null) return decoded.error ?? "unparsed";
      for (const block of decoded.result.results) {
        const step = await visit(block);
        if (step === "stop") return null;
        if (step !== "next") return step.error;
      }
      if (!decoded.result.has_more) return null;
      if (decoded.result.next_cursor === null) return "pages_incomplete";
      cursor = decoded.result.next_cursor;
    }
    return "pages_incomplete";
  }

  async function readTable(
    ref: SectionRef,
    table: Block,
    reads: Reads,
  ): Promise<Table | { error: string }> {
    const rows: string[][] = [];
    const error = await eachBlock(ref, table.id, reads, (block) => {
      if (block.type !== "table_row") return "next";
      const cells = cellsOf(block);
      if (cells === null) return { error: "unparsed" };
      rows.push(cells);
      return "next";
    });
    if (error !== null) return { error };
    if (!hasColumnHeader(table)) return { header: [], rows };
    const [header = [], ...rest] = rows;
    return { header, rows: rest };
  }

  return {
    async readSection(ref) {
      const wanted = ref.heading.trim();
      const reads: Reads = { raws: [], requestId: null };
      let section: Section | null = null;
      const error = await eachBlock(ref, ref.page, reads, async (block) => {
        const text = textOf(block);
        if (section === null) {
          if (block.type === "heading_2" && text?.trim() === wanted)
            section = { heading: wanted, paragraphs: [], tables: [] };
          return "next";
        }
        if (headingTypes.has(block.type) && text !== null) return "stop";
        if (textTypes.has(block.type) && text !== null)
          section.paragraphs.push(text);
        if (block.type === "table") {
          const table = await readTable(ref, block, reads);
          if ("error" in table) return table;
          section.tables.push(table);
        }
        return "next";
      });
      const receipt = (
        result: Section | null,
        failure: string | null,
      ): DocsReceipt<Section> => ({
        verb: "readSection",
        ok: failure === null,
        result,
        raw: reads.raws,
        error: failure,
        requestId: reads.requestId,
      });
      if (error !== null) return receipt(null, error);
      if (section === null) return receipt(null, docsSectionNotFound);
      return receipt(section, null);
    },
  };
}
