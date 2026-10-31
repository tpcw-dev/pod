import type { Selector, Size } from "./schema.ts";

export interface ProcessRef {
  name: string;
  rev: number;
}

export interface ActiveProcess extends ProcessRef {
  revisionId: string;
  selector: Selector;
}

export type SelectorErrorCode =
  "selector_conflict" | "selector_none" | "selector_many";

export type Selected =
  { ok: true; revisionId: string } | { ok: false; code: SelectorErrorCode };

export interface SelectInput {
  stage: string;
  size: Size;
  kickoffLine: ProcessRef | null;
  cliProcess: ProcessRef | null;
  activations: readonly ActiveProcess[];
  named: ActiveProcess | null;
}

function same(a: ProcessRef, b: ProcessRef): boolean {
  return a.name === b.name && a.rev === b.rev;
}

export function fits(selector: Selector, stage: string, size: Size): boolean {
  return selector.stage === stage && selector.size.includes(size);
}

export function selectProcess(input: SelectInput): Selected {
  const { stage, size, kickoffLine, cliProcess } = input;
  if (
    kickoffLine !== null &&
    cliProcess !== null &&
    !same(kickoffLine, cliProcess)
  )
    return { ok: false, code: "selector_conflict" };
  const ref = cliProcess ?? kickoffLine;
  if (ref !== null) {
    const found =
      input.activations.find((active) => same(active, ref)) ??
      (input.named !== null && same(input.named, ref) ? input.named : null);
    if (found === null) return { ok: false, code: "selector_none" };
    return fits(found.selector, stage, size)
      ? { ok: true, revisionId: found.revisionId }
      : { ok: false, code: "selector_conflict" };
  }
  const matches = input.activations.filter((active) =>
    fits(active.selector, stage, size),
  );
  const [only] = matches;
  if (only === undefined) return { ok: false, code: "selector_none" };
  return matches.length === 1
    ? { ok: true, revisionId: only.revisionId }
    : { ok: false, code: "selector_many" };
}
