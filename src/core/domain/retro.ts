import { z } from "zod";
import { Area } from "./learning.ts";

const Text = z.string().min(1);

export const transcriptRef = /^transcript:([^:]+):([1-9][0-9]*)$/u;

export const Finding = z.strictObject({
  text: Text,
  expected: Text.optional(),
  area: Area,
  evidence_refs: z.array(Text).min(1),
  wording: Text,
  repeat_of: z.int().positive().optional(),
});
export type Finding = z.infer<typeof Finding>;

export const Findings = z.array(Finding);

const TranscriptStatus = z.enum(["resolved", "unresolved", "absent"]);

export const TranscriptLine = z.object({
  dispatch_id: z.string(),
  harness: z.string().nullable(),
  session_id: z.string().nullable(),
  path: z.string().nullable(),
  status: TranscriptStatus,
});
export type TranscriptLine = z.infer<typeof TranscriptLine>;

export const RetroRecorded = z.object({
  learning_ids: z.array(z.int()),
  occurrence_ids: z.array(z.int()),
  dispatch_id: z.string().nullable(),
});
export type RetroRecorded = z.infer<typeof RetroRecorded>;

export const RetroRunResult = z.object({
  run_id: z.string(),
  story: z.string(),
  state: z.enum(["dispatched", "recorded"]),
  task_id: z.string().nullable(),
  dispatch_id: z.string().nullable(),
  manifest_id: z.string().nullable(),
  op_key: z.string(),
  transcripts: z.array(TranscriptLine),
  recorded: RetroRecorded.nullable(),
  replayed: z.boolean(),
});
export type RetroRunResult = z.infer<typeof RetroRunResult>;

export const Ambiguous = z.object({
  index: z.int(),
  text: z.string(),
  candidates: z.array(z.int()),
  nextSteps: z.array(z.string()),
});
export type Ambiguous = z.infer<typeof Ambiguous>;

export const RetroRecordResult = z.object({
  run_id: z.string(),
  learning_ids: z.array(z.int()),
  occurrence_ids: z.array(z.int()),
  ambiguous: z.array(Ambiguous),
  complete: z.boolean(),
  replayed: z.boolean(),
});
export type RetroRecordResult = z.infer<typeof RetroRecordResult>;
