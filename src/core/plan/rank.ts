import type { Held, Place, Ranked } from "../domain/plan.ts";
import type { ListedStory } from "../ports/tracker.ts";
import { selectProcess, type ActiveProcess } from "../process/select.ts";
import type { InForce } from "./overrides.ts";
import type { UsageGate } from "./usage.ts";

export interface PlanStory extends ListedStory {
  project: string;
  current: string | null;
}

export interface RankInput {
  stories: readonly PlanStory[];
  overrides: InForce;
  activations: readonly ActiveProcess[];
  reserved: Readonly<Record<string, number>>;
  providers: Readonly<Record<string, readonly string[]>>;
  usage: readonly UsageGate[];
}

export interface ReservedSlots {
  project: string;
  slots: number;
  covers: string[];
}

export interface Ranking {
  ranked: Ranked[];
  held: Held[];
  reserved: ReservedSlots[];
}

const heldLabels = ["blocked", "needs-jerry"];
const launchablePoints = [1, 2, 3];
const places: readonly Place[] = ["current", "milestone", "unlisted"];

function placeOf(story: PlanStory): Place | "parked" {
  const milestone = story.milestone?.trim() ?? "";
  if (milestone === "") return "unlisted";
  if (milestone.toLowerCase() === "parked") return "parked";
  return milestone === story.current ? "current" : "milestone";
}

interface Gates {
  holds: ReadonlyMap<string, string>;
  activations: readonly ActiveProcess[];
  providers: Readonly<Record<string, readonly string[]>>;
  usage: ReadonlyMap<string, UsageGate>;
}

function storyGates(story: PlanStory, gates: Gates): UsageGate[] {
  return (gates.providers[story.project] ?? []).flatMap((provider) => {
    const gate = gates.usage.get(provider);
    return gate === undefined ? [] : [gate];
  });
}

function heldReason(story: PlanStory, gates: Gates): string | null {
  const label = heldLabels.find((name) => story.labels.includes(name));
  if (label !== undefined) return `label ${label}`;
  if (story.points === null || !launchablePoints.includes(story.points))
    return `points ${story.points ?? "none"}`;
  if (story.size === null) return "size none";
  if (story.priority === null) return "priority none";
  if (story.blockers.length > 0)
    return `blocked by ${story.blockers.join(", ")}`;
  if (story.stageLabel === null) return "stage none";
  const selected = selectProcess({
    stage: story.stageLabel,
    size: story.size,
    kickoffLine: story.kickoffLine,
    cliProcess: null,
    activations: gates.activations,
    named: null,
  });
  if (!selected.ok) return `process ${selected.code}`;
  const held = storyGates(story, gates).find((gate) => gate.state === "held");
  if (held !== undefined) return `usage: ${held.provider}`;
  return gates.holds.get(story.ref.external_id) ?? null;
}

function indexIn(list: readonly string[] | undefined, item: string): number {
  const index = list?.indexOf(item) ?? -1;
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function keyNumber(key: string): number {
  const match = /(\d+)$/u.exec(key);
  return match?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

interface Placed {
  story: PlanStory;
  place: Place;
}

function sortKey(each: Placed, overrides: InForce): (number | string)[] {
  const { story } = each;
  const key = story.ref.external_id;
  return [
    indexIn(overrides.order?.keys, key),
    indexIn(overrides.priority?.projects, story.project),
    story.priority ?? Number.MAX_SAFE_INTEGER,
    places.indexOf(each.place),
    story.points ?? Number.MAX_SAFE_INTEGER,
    story.createdAt,
    keyNumber(key),
    key,
  ];
}

function compare(a: (number | string)[], b: (number | string)[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === right || left === undefined || right === undefined) continue;
    return left < right ? -1 : 1;
  }
  return 0;
}

function reasonsOf(each: Placed, overrides: InForce, gates: Gates): string[] {
  const { story } = each;
  const order = overrides.order?.keys.indexOf(story.ref.external_id) ?? -1;
  const project = overrides.priority?.projects.indexOf(story.project) ?? -1;
  return [
    ...(order === -1 ? [] : [`order ${order + 1}`]),
    ...(project === -1 ? [] : [`project priority ${project + 1}`]),
    `tracker priority ${story.priority ?? "none"}`,
    `place ${each.place}`,
    ...storyGates(story, gates)
      .filter((gate) => gate.state === "unknown")
      .map((gate) => `usage unknown: ${gate.provider}`),
  ];
}

function entryOf(each: Placed, overrides: InForce, gates: Gates): Ranked {
  const { story } = each;
  return {
    key: story.ref.external_id,
    project: story.project,
    title: story.title,
    points: story.points,
    place: each.place,
    priority: story.priority,
    driver: story.driverLabel,
    seats: [],
    reasons: reasonsOf(each, overrides, gates),
  };
}

export function rankPlan(input: RankInput): Ranking {
  const { overrides } = input;
  const gates: Gates = {
    holds: new Map(overrides.holds.map((hold) => [hold.key, hold.reason])),
    activations: input.activations,
    providers: input.providers,
    usage: new Map(input.usage.map((gate) => [gate.provider, gate])),
  };
  const candidates = new Set(input.stories.map((each) => each.ref.external_id));
  const held: Held[] = [];
  const open: Placed[] = [];
  for (const story of input.stories) {
    const place = placeOf(story);
    if (place === "parked") continue;
    const reason = heldReason(story, gates);
    if (reason === null) open.push({ story, place });
    else
      held.push({
        key: story.ref.external_id,
        reason,
        project: story.project,
      });
  }
  for (const hold of overrides.holds)
    if (!candidates.has(hold.key))
      held.push({
        key: hold.key,
        reason: hold.reason,
        ...(hold.project === undefined ? {} : { project: hold.project }),
      });
  const ranked = open
    .map((each) => ({ each, key: sortKey(each, overrides) }))
    .sort((a, b) => compare(a.key, b.key))
    .map(({ each }) => entryOf(each, overrides, gates));
  return {
    ranked,
    held,
    reserved: Object.entries(input.reserved).map(([project, slots]) => ({
      project,
      slots,
      covers: ranked
        .filter((entry) => entry.project === project)
        .slice(0, slots)
        .map((entry) => entry.key),
    })),
  };
}
