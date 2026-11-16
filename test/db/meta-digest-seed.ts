import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { dispatch } from "../../src/core/dispatch/dispatch.ts";
import type { Json } from "../../src/core/domain/json.ts";
import { addLearning } from "../../src/core/learning/add.ts";
import type {
  MetaSeat,
  MetaSeatRequest,
} from "../../src/core/operate/meta-digest.ts";
import { closeStepKey } from "../../src/core/run/close-record.ts";
import { ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { seedMeta } from "./meta-seed.ts";
import { createRun, dispatchInput, replay, started } from "./run-fixture.ts";
import { activeRevision, crewValue, processValue } from "./seed.ts";

const hold = ["timeout", "cancel", "unknown"];

export const morningPolicy = {
  gates: ["pr"],
  learning: { kinds: ["lead"] },
  limits: {
    digest_per_day: 2,
    packet_items: 20,
    packet_words: 2000,
    packet_minutes: 30,
  },
};

export const retroProcess = {
  ...processValue,
  roles: [...processValue.roles, "retro"],
  steps: [
    ...processValue.steps,
    { id: "retro", type: "worker", role: "retro", after: "close" },
  ],
  edges: [
    ...processValue.edges,
    { from: "retro", on: "done", to: "done" },
    { from: "retro", on: hold, to: "hold" },
  ],
};

export const metaProcess = {
  summary: "meta work with no Run",
  selector: { stage: "meta" },
  roles: ["digest"],
  steps: [
    {
      id: "digest",
      type: "worker",
      role: "digest",
      method: "Theme the packet's learnings into proposals.",
    },
  ],
  edges: [
    { from: "digest", on: "done", to: "done" },
    { from: "digest", on: hold, to: "hold" },
  ],
  limits: { attempts_per_task: 1, rework_per_lineage: 1 },
  escalation: { to: "operator" },
};

export const retroCrew = {
  seats: [
    ...crewValue.seats,
    { id: "dev-retro", roles: ["developer", "retro"], runtime: "claude" },
    { id: "retro-1", roles: ["retro"], runtime: "claude" },
  ],
};

export async function seedMorning(
  conn: Connection,
  slots?: Json[],
): Promise<void> {
  await seedMeta(conn, slots, morningPolicy);
  await activeRevision(conn.db, "crew", "default", retroCrew);
  await activeRevision(conn.db, "process", "impl", retroProcess);
  await activeRevision(conn.db, "process", "meta", metaProcess);
}

async function launch(
  conn: Connection,
  task: string,
  seat: string,
  id: string,
) {
  const { orca, log } = replay(conn, [ok("worker-start", started(id, task))]);
  const outcome = await dispatch(
    conn.db,
    orca,
    log,
    dispatchInput({ task, seat, capacity: 10 }),
  );
  if (!outcome.ok) throw new Error(outcome.refusal.message);
}

export async function retroDueRun(
  conn: Connection,
  at: Date,
  builder = "dev-1",
): Promise<void> {
  await createRun(conn);
  await launch(conn, "task_b", builder, "ctx_dev");
  await conn.db.setTaskState("task_b", "done");
  await conn.db.setTaskState("task_r", "ready");
  await launch(conn, "task_r", "rev-1", "ctx_rev");
  await conn.db.setTaskState("task_r", "done");
  for (const id of ["ctx_dev", "ctx_rev"])
    await conn.db.setDispatchActivity(id, "settled", at);
  await conn.db.setRunState("run_1", "done");
  await conn.db.appendEvent({
    type: "close",
    ts: at,
    host: "local",
    run_id: "run_1",
    task_id: null,
    dispatch_id: null,
    op_key: closeStepKey("run_1", "archive"),
    payload: {
      op_key: closeStepKey("run_1", "archive"),
      retro_due: true,
      worktrees: [],
    },
    source: { kind: "command", verb: "run close" },
  });
}

export const retroLaunch: readonly TempEntry[] = [
  ok("task-create", { task: { id: "task_retro", status: "ready" } }),
  ok("worker-start", started("ctx_retro", "task_retro")),
];

export async function retroRecorded(conn: Connection, at: Date) {
  await conn.db.appendEvent({
    type: "retro",
    ts: at,
    host: "local",
    run_id: "run_1",
    task_id: null,
    dispatch_id: null,
    op_key: null,
    payload: { learning_ids: [], occurrence_ids: [] },
    source: { kind: "command", verb: "retro record" },
  });
}

export async function learn(
  conn: Connection,
  text: string,
  at: Date,
): Promise<number> {
  const added = await addLearning(conn.db, {
    row: {
      source_story: "S-1",
      evidence_refs: [`pr:${text}`],
      text,
      adoption: "new",
      area: "process",
      project_id: null,
      kind: "lead",
      reporter: "lead",
    },
    host: "local",
    now: () => at,
  });
  if (!added.ok) throw new Error(added.refusal.message);
  return added.id;
}

export async function needsHuman(
  conn: Connection,
  id: string,
  at: Date,
  verb: "agreed" | "resume" | null,
): Promise<void> {
  await conn.db.insertManifest({
    id: `man_${id}`,
    run_id: "run_1",
    task_id: null,
    decision_id: null,
    parent_id: null,
    references: [],
    tests: null,
    created_at: at,
  });
  await conn.db.insertDecision({
    id,
    run_id: "run_1",
    task_id: null,
    category: "plan",
    effect: "accept_plan",
    question: "q",
    options: [],
    manifest_id: `man_${id}`,
    state: verb === "agreed" ? "agreed" : "needs_human",
    outcome: verb === "agreed" ? { result: "agreed", text: "ship it" } : null,
    reason: "disagreement",
    binding: "run",
    budget: {},
    spent: {},
    supersedes_decision_id: null,
    adoption: "pending",
    adoption_evidence: [],
    created_at: at,
    closed_at: null,
  });
  if (verb === null) return;
  await conn.db.appendEvent({
    type: "decision",
    ts: at,
    host: "local",
    run_id: "run_1",
    task_id: null,
    dispatch_id: null,
    op_key: null,
    payload: {
      decision_id: id,
      outcome: verb === "agreed" ? "agreed" : "round",
      ruling: {
        comment_id: `c-${id}`,
        author: "person-a",
        readback_at: at.toISOString(),
        verb,
      },
    },
    source: { kind: "command", verb: "check" },
  });
}

export function fileSeat(requests: MetaSeatRequest[]): MetaSeat {
  const dir = mkdtempSync(join(tmpdir(), "pod-meta-seat-"));
  return {
    built: true,
    run: (request) => {
      requests.push(request);
      const ids = [...request.packet.matchAll(/learning (\d+) \[/gu)].map(
        (match) => Number(match[1]),
      );
      const body = ids
        .map(
          (id) =>
            `- theme: t${id}\n  text: proposal ${id}\n  learning_ids: [${id}]\n  evidence_refs: [learning:${id}]\n`,
        )
        .join("");
      const path = join(dir, `proposals-${requests.length}.yaml`);
      writeFileSync(path, ids.length === 0 ? "[]\n" : body);
      return Promise.resolve({ ok: true, file: path });
    },
  };
}

export function packetEvents(request: MetaSeatRequest | undefined): number[] {
  return [...(request?.packet ?? "").matchAll(/event (\d+):/gu)].map((match) =>
    Number(match[1]),
  );
}
