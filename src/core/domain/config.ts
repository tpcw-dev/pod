import { z } from "zod";
import { Json } from "./json.ts";

export const kinds = ["crew", "process", "policy", "task", "decision"] as const;
export const scopes = ["global", "project", "host", "run"] as const;

export const Kind = z.enum(kinds);
export type Kind = z.infer<typeof Kind>;

export const Scope = z.enum(scopes);
export type Scope = z.infer<typeof Scope>;

export const RevisionEnvelope = z
  .strictObject({
    kind: Kind,
    name: z.string().min(1),
    schema_version: z.int().positive(),
    scope: Scope.default("global"),
    scope_ref: z.string().default(""),
    parent: z.string().min(1).nullable().default(null),
    value: Json,
  })
  .refine((e) => (e.scope === "global") === (e.scope_ref === ""), {
    message: "scope_ref is empty exactly when scope is global",
    path: ["scope_ref"],
  });
export type RevisionEnvelope = z.infer<typeof RevisionEnvelope>;

export interface NewRevision extends RevisionEnvelope {
  id: string;
  actor: string;
  reason: string;
}

export interface Revision extends NewRevision {
  rev: number;
  created_at: Date;
}

export interface ActivationKey {
  scope: Scope;
  scope_ref: string;
  kind: Kind;
  name: string;
}

export interface Activation extends ActivationKey {
  revision_id: string;
  bundle_id: string | null;
  activated_by: string;
  activated_at: Date;
  previous_revision_id: string | null;
}

export interface ActivateInput extends ActivationKey {
  expected: string | null;
  revision_id: string;
  bundle_id: string | null;
  activated_by: string;
  activated_at: Date;
}

export type ActivateResult =
  { ok: true; previous: string | null } | { ok: false; active: string | null };

export interface Snapshot {
  run_id: string;
  crew_revision_id: string;
  process_revision_id: string;
  policy_revision_id: string;
  effective_gate_map: Json;
  hash: string;
  pinned_at: Date;
}
