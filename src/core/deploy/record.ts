import { fence, StaleGeneration } from "../check/fence.ts";
import type { Deploy } from "../domain/delivery.ts";
import type { Run, Task } from "../domain/ledger.ts";
import { refuse, type Refused } from "../domain/outcome.ts";
import { candidateSha } from "../gate/receipt.ts";
import { moveTask } from "../ledger/move-task.ts";
import { derivedOpKey } from "../ledger/op-key.ts";
import type { Db, Repo } from "../ports/db.ts";
import type { StoryRef } from "../ports/tracker.ts";
import { readProcess, recordDelivery } from "../process/project.ts";

export interface DeployInput {
  story: StoryRef;
  generation: number;
  line: Deploy;
  host: string;
  treeOf: (sha: string) => Promise<string | null>;
  now: () => Date;
}

export interface DeployResult {
  run_id: string;
  task_id: string;
  state: string;
  deployed_revision: string;
  op_key: string;
  replayed: boolean;
}

type Recorded = { ok: true; result: DeployResult } | Refused;

async function externalTasks(tx: Repo, run: Run): Promise<Task[]> {
  const found: Task[] = [];
  for (const task of await tx.listTasks(run.run_id)) {
    const { step } = await readProcess(tx, task, "done");
    if (step.type === "external_action") found.push(task);
  }
  return found;
}

async function revisionRefusal(
  tx: Repo,
  run: Run,
  input: DeployInput,
): Promise<Refused | null> {
  const { deployed_revision: deployed, source_commit: source } = input.line;
  const candidate = await candidateSha(tx, run.run_id);
  const mismatch = (reason: string) =>
    refuse(
      "deploy_revision_mismatch",
      `Run ${run.run_id}: deployed_revision ${deployed} ${reason} the candidate SHA ${candidate ?? "(none)"}`,
      [
        `deploy the candidate ${candidate ?? "SHA the Run pushed"} or a squash of it`,
        "run from a checkout that has both commits (git fetch)",
      ],
    );
  if (deployed !== source)
    return mismatch(`differs from source_commit ${source}, so it is not`);
  if (candidate === null) return mismatch("has no");
  if (deployed === candidate) return null;
  const [deployedTree, candidateTree] = await Promise.all([
    input.treeOf(deployed),
    input.treeOf(candidate),
  ]);
  if (deployedTree !== null && deployedTree === candidateTree) return null;
  return mismatch("is neither, nor has the tree of,");
}

async function write(
  tx: Repo,
  run: Run,
  input: DeployInput,
): Promise<Recorded> {
  await tx.lockRun(run.run_id);
  await fence(tx, run.run_id, input.generation);
  const revision = input.line.deployed_revision;
  const tasks = await externalTasks(tx, run);
  const ready = tasks.filter((task) => task.state === "ready");
  const opKey = (task: Task) =>
    derivedOpKey("deploy", {
      run_id: run.run_id,
      task_id: task.task_id,
      deployed_revision: revision,
    });
  const result = (task: Task, state: string, replayed: boolean) => ({
    ok: true as const,
    result: {
      run_id: run.run_id,
      task_id: task.task_id,
      state,
      deployed_revision: revision,
      op_key: opKey(task),
      replayed,
    },
  });
  if (ready.length > 1)
    return refuse(
      "selector_many",
      `Run ${run.run_id} has ${ready.length} ready external_action Tasks: ${ready.map((task) => task.task_id).join(", ")}`,
      ["settle the other external_action Task first"],
    );
  const [task] = ready;
  if (task === undefined) {
    for (const prior of tasks) {
      const event = await tx.eventWith("deploy", {
        task_id: prior.task_id,
        deployed_revision: revision,
      });
      if (event?.run_id === run.run_id) return result(prior, prior.state, true);
    }
    return refuse(
      "deploy_not_waiting",
      `Run ${run.run_id} has no external_action Task in state ready`,
      [`pod state story:${run.story_external_id}`],
    );
  }
  const refused = await revisionRefusal(tx, run, input);
  if (refused !== null) return refused;
  const at = input.now();
  const source = { kind: "command", verb: "deploy record" };
  await tx.appendEvent({
    type: "deploy",
    ts: at,
    host: input.host,
    run_id: run.run_id,
    task_id: task.task_id,
    dispatch_id: null,
    op_key: opKey(task),
    payload: { task_id: task.task_id, ...input.line },
    source,
  });
  await moveTask(tx, task.task_id, "delivered");
  await recordDelivery(tx, {
    task: task.task_id,
    settlement: "done",
    at,
    host: input.host,
    source,
  });
  const settled = await tx.getTask(task.task_id);
  return result(task, settled?.state ?? "delivered", false);
}

export async function recordDeploy(
  db: Db,
  input: DeployInput,
): Promise<Recorded> {
  const story = await db.getStory(
    input.story.provider,
    input.story.external_id,
  );
  const run = story?.run_id == null ? null : await db.getRun(story.run_id);
  if (run === null)
    return refuse(
      "story_not_found",
      `no Run for story:${input.story.external_id}`,
      [`pod run create story:${input.story.external_id}`],
    );
  try {
    return await db.transaction((tx) => write(tx, run, input));
  } catch (error) {
    if (!(error instanceof StaleGeneration)) throw error;
    return refuse(
      "owner_generation_stale",
      `--generation ${input.generation} differs from the Run's owner generation ${error.run.owner_generation}`,
      [
        `pod takeover story:${run.story_external_id} if this session should own the Run`,
      ],
    );
  }
}
