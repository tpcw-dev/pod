import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Connection } from "../../src/adapters/postgres/connection.ts";
import { checkPass } from "../../src/core/check/check.ts";
import { launchLeaseSeconds } from "../../src/core/check/reconcile.ts";
import { ok } from "../orca/temp-fixtures.ts";
import {
  applyConfig,
  cliReplay,
  implementTask,
  planTask,
} from "../db/decision-fixture.ts";
import { fakeTracker, trackerStory } from "../db/fake-tracker.ts";
import {
  dbUrl,
  describeDb,
  openDb,
  podHome,
  resetDb,
  runCli,
} from "../db/helpers.ts";
import { empty, replay, workers } from "../db/run-fixture.ts";

const dir = "test/replay/profiles";
const bypassPath = join(
  mkdtempSync(join(tmpdir(), "pod-profiles-")),
  "bypass.jsonl",
);
writeFileSync(
  bypassPath,
  `${JSON.stringify({ host: "h1", result: "pass", at: "2026-10-31T00:00:00.000Z" })}\n`,
);

function stateText(): string {
  const result = spawnSync(
    "node_modules/.bin/tsx",
    ["src/cli/index.ts", "state", "--project", "dogfood"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        POD_DB_URL: dbUrl(),
        POD_HOME: podHome,
        POD_DOCS_TOKEN: "",
      },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

interface BriefJson {
  projects: { project: string; profile: string | null; line: string }[];
  stories: {
    runs: { run_id: string; profile: string | null; profile_stale: boolean }[];
  }[];
}

describeDb.each(["hands-on", "standard", "hands-off"])(
  "profiles replay: %s",
  (profile) => {
    let conn: Connection;

    beforeAll(async () => {
      await resetDb();
      conn = openDb();
      applyConfig([
        `${dir}/policy.yaml`,
        `${dir}/crew.yaml`,
        `${dir}/process.yaml`,
      ]);
    });
    afterAll(() => conn.close());

    test(`${profile} activates on the keeper's readback and shows in pod state and pod brief`, async () => {
      const created = await cliReplay(
        conn,
        [
          "run",
          "create",
          "story:TRK-1",
          "--project",
          "dogfood",
          "--process",
          "profiles@1",
          "--size",
          "l",
          "--stage",
          "impl",
        ],
        [
          ok("run-create", { run: { id: "run_1" } }),
          ok("task-create", { task: { id: planTask, status: "ready" } }),
          ok("task-create", { task: { id: implementTask, status: "pending" } }),
        ],
      );
      expect(created.status, created.json.error?.message).toBe(0);

      const applied = runCli([
        "config",
        "apply",
        `${dir}/project-${profile}.yaml`,
        "--activate",
        "--scope",
        "project:dogfood",
        "--expected-revision",
        "none",
      ]);
      expect(applied.status, applied.json.error?.message).toBe(0);
      const comment = `profile dogfood ${profile} policy.dogfood@1`;
      expect(applied.json.result).toMatchObject({
        activation: null,
        pending: { profile, comment, runs_on_old_profile: ["run_1"] },
      });
      const waiting = stateText();
      expect(waiting).toContain("Profile: none (policy default@1)");
      expect(waiting).toContain(
        `Profile pending: ${profile} (policy dogfood@1), post "${comment}"`,
      );

      const tracker = fakeTracker(
        trackerStory({ ref: { provider: "linear", external_id: "TRK-1" } }),
      );
      tracker.comments.push({
        ref: { provider: "linear", external_id: "TRK-1", comment_id: "c-1" },
        authorId: "keeper-1",
        body: comment,
        editedAt: null,
      });
      const { orca, log } = replay(conn, [
        ok("check", empty(null), ["--run", "run_1"]),
        ok("worker-list", workers([]), ["--run", "run_1"]),
      ]);
      const checked = await checkPass(conn.db, orca, tracker, log, {
        run: "run_1",
        generation: 1,
        host: "local",
        hostName: "h1",
        bypassPath,
        capacity: 2,
        leaseSeconds: launchLeaseSeconds,
        now: () => new Date(),
      });
      orca.assertDone();
      expect(checked.ok).toBe(true);

      const state = stateText();
      expect(state).toContain(`Profile: ${profile} (policy dogfood@1)`);
      expect(state).not.toContain("Profile pending:");

      const brief = runCli(["brief"]);
      expect(brief.status).toBe(0);
      const result = brief.json.result as unknown as BriefJson;
      expect(result.projects).toEqual([
        {
          project: "global",
          profile: null,
          policy: "default@1",
          line: "global: none (policy default@1)",
          digest: expect.objectContaining({ shown: 0, queued: 0 }),
        },
        {
          project: "dogfood",
          profile,
          policy: "dogfood@1",
          line: `dogfood: ${profile} (policy dogfood@1)`,
          digest: expect.objectContaining({ shown: 0, queued: 0 }),
        },
      ]);
      expect(result.stories[0]?.runs[0]).toMatchObject({
        run_id: "run_1",
        profile: null,
        profile_stale: true,
      });
    });
  },
);
