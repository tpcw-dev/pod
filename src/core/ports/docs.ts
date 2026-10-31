export interface DocsPort {
  readSection(ref: SectionRef): Promise<DocsReceipt<Section>>;
}

export const docsMethods = ["readSection"] as const;
export type DocsMethod = (typeof docsMethods)[number];

export const docsSectionNotFound = "docs_section_not_found";

export interface SectionRef {
  page: string;
  heading: string;
}

export interface Section {
  heading: string;
  paragraphs: string[];
  tables: { header: string[]; rows: string[][] }[];
}

export interface DocsReceipt<T> {
  verb: DocsMethod;
  ok: boolean;
  result: T | null;
  raw: unknown;
  error: string | null;
  requestId: string | null;
}

export interface DocsRequest {
  method: "GET";
  path: string;
  query: Record<string, string>;
}

export interface DocsReceiptRecord {
  verb: DocsMethod;
  port: "docs";
  page: string;
  heading: string;
  request: DocsRequest;
  status: number | null;
  body: string | null;
  error: string | null;
  requestId: string | null;
  startedAt: string;
  endedAt: string;
}

export type DocsReceiptSink = (record: DocsReceiptRecord) => Promise<void>;
