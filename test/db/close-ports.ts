import type { Connection } from "../../src/adapters/postgres/connection.ts";
import type { GitPort } from "../../src/core/ports/git.ts";
import { ok, type TempEntry } from "../orca/temp-fixtures.ts";
import { worktreeId } from "./run-fixture.ts";

export function fakeGit(over: Partial<GitPort> = {}): GitPort {
  return {
    checkout: () => Promise.resolve(null),
    integration: () => Promise.resolve("main"),
    fetch: () => Promise.resolve(true),
    localTip: () => Promise.resolve(null),
    remoteTip: () => Promise.resolve(null),
    checkedOut: () => Promise.resolve(new Map()),
    deleteLocal: () => Promise.reject(new Error("no local delete expected")),
    deleteRemote: () => Promise.reject(new Error("no remote delete expected")),
    ...over,
  };
}

export const removedWorktree = (selector = `id:${worktreeId}`): TempEntry =>
  ok("worktree-rm", { removed: true }, ["--worktree", selector]);

export async function launchedRun(
  conn: Connection,
  worktree = worktreeId,
  host = "local",
): Promise<void> {
  const opKey = `launch-${host}-${worktree}`;
  await conn.db.insertOperation({
    op_key: opKey,
    intent: "tick",
    owner_generation: 0,
    at: new Date(),
  });
  await conn.db.moveOperation(
    opKey,
    "done",
    {
      request: {
        launch: true,
        host,
        project: "pod",
        story: "S-1",
        subject: "manual",
      },
      worktree: {
        id: worktree,
        path: worktree.split("::")[1] ?? "",
        branch: "refs/heads/feature-7",
      },
      run_id: "run_1",
    },
    new Date(),
  );
}
