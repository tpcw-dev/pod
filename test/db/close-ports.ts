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
