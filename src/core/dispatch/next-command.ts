import { derivedOpKey } from "../ledger/op-key.ts";
import type { Repo } from "../ports/db.ts";

export async function nextDispatchCommand(
  db: Pick<Repo, "getOperation">,
  {
    generation,
    ...fields
  }: { run_id: string; task_id: string; seat: string; generation: number },
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const key = derivedOpKey("dispatch", {
      ...fields,
      attempt: String(attempt),
    });
    if ((await db.getOperation(key)) === null)
      return `pod dispatch --task ${fields.task_id} --seat ${fields.seat} --generation ${generation} --op-key ${key}`;
  }
}
