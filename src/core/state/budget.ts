import type { StateView } from "../domain/state.ts";
import { renderState } from "./render.ts";

interface Trim {
  routing: (view: StateView) => string;
  drop: (view: StateView) => StateView | null;
}

function dropLastWhere<T>(
  items: readonly T[],
  removable: (item: T) => boolean,
): T[] | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && removable(item))
      return [...items.slice(0, index), ...items.slice(index + 1)];
  }
  return null;
}

const trims: readonly Trim[] = [
  {
    routing: (view) =>
      `pod docs read --page ${view.roadmap.status === "ok" ? view.roadmap.page : ""} --heading Milestones`,
    drop: (view) => {
      const roadmap = view.roadmap;
      if (roadmap.status !== "ok") return null;
      const milestones = dropLastWhere(
        roadmap.milestones,
        (row) => !row.current,
      );
      return milestones === null
        ? null
        : { ...view, roadmap: { ...roadmap, milestones } };
    },
  },
  {
    routing: (view) =>
      `pod learning query --adoption adopted${view.scope.project === null ? "" : ` --project ${view.scope.project}`}`,
    drop: (view) => {
      const learnings = dropLastWhere(view.learnings.learnings, () => true);
      return learnings === null
        ? null
        : { ...view, learnings: { ...view.learnings, learnings } };
    },
  },
  {
    routing: (view) =>
      `pod brief${view.scope.story === null ? "" : ` story:${view.scope.story}`}`,
    drop: (view) => {
      const items = dropLastWhere(view.needs_human.items, (item) => !item.open);
      return items === null
        ? null
        : { ...view, needs_human: { ...view.needs_human, items } };
    },
  },
];

function words(view: StateView): number {
  return renderState(view).match(/\S+/g)?.length ?? 0;
}

export function fitBudget(view: StateView, limit: number): StateView {
  let fitted = view;
  for (const trim of trims) {
    const marked = (state: StateView): StateView => ({
      ...state,
      truncated: true,
      routing: [...fitted.routing, trim.routing(state)],
    });
    let trimmed: StateView | null = null;
    while (words(trimmed === null ? fitted : marked(trimmed)) > limit) {
      const next = trim.drop(trimmed ?? fitted);
      if (next === null) break;
      trimmed = next;
    }
    if (trimmed !== null) fitted = marked(trimmed);
  }
  return fitted;
}
