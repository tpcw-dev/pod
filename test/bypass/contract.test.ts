import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { verbs } from "../../src/cli/verbs.ts";

const sideEffectVerbs = [
  "db migrate",
  "config apply",
  "config set",
  "config activate",
  "run create",
  "run launch",
  "dispatch",
  "check",
  "retry",
  "release",
  "reply",
  "verdict post",
  "hqa record",
  "decide",
  "decide cancel",
  "takeover",
  "drain",
  "learning add",
  "learning import",
  "digest post",
  "digest decide",
  "digest assign",
  "deploy record",
  "run close",
  "retro",
  "retro record",
  "usage record",
  "plan",
  "plan hold",
  "plan release",
  "plan priority",
  "plan order",
  "plan stretch",
  "plan reset-available",
  "plan reset-used",
  "tick",
  "standup done",
  "standup skip",
] as const;

const expectedVerbs: readonly {
  story: string;
  name: string;
  status: "done" | "todo";
}[] = [
  { story: "S2", name: "db migrate", status: "done" },
  { story: "S2", name: "config apply", status: "done" },
  { story: "S2", name: "config export", status: "done" },
  { story: "S3", name: "run create", status: "done" },
  { story: "S3", name: "dispatch", status: "done" },
  { story: "S3", name: "check", status: "done" },
  { story: "S3", name: "retry", status: "done" },
  { story: "S3", name: "release", status: "done" },
  { story: "S3", name: "takeover", status: "done" },
  { story: "S3", name: "drain", status: "done" },
  { story: "S4", name: "brief", status: "done" },
  { story: "S6", name: "verdict post", status: "done" },
  { story: "S6", name: "hqa record", status: "done" },
  { story: "S10", name: "learning add", status: "done" },
  { story: "S10", name: "learning query", status: "done" },
  { story: "S11", name: "state", status: "done" },
  { story: "S12", name: "decide", status: "done" },
];

const extraVerbs = [
  { story: "S11", name: "docs read", sideEffect: "none" },
  { story: "S13", name: "decide ruling", sideEffect: "none" },
  { story: "S13", name: "decide cancel", sideEffect: "ledger" },
  { story: "TPC-1490", name: "deploy record", sideEffect: "ledger" },
  { story: "TPC-1478", name: "config set", sideEffect: "config" },
  { story: "TPC-1495", name: "run close", sideEffect: "tracker" },
  { story: "TPC-1479", name: "config activate", sideEffect: "config" },
  { story: "TPC-1532", name: "config get", sideEffect: "none" },
  { story: "TPC-1506", name: "learning import", sideEffect: "ledger" },
  { story: "TPC-1507", name: "retro", sideEffect: "orca" },
  { story: "TPC-1507", name: "retro record", sideEffect: "ledger" },
  { story: "S21c", name: "digest prepare", sideEffect: "none" },
  { story: "S21c", name: "digest post", sideEffect: "ledger" },
  { story: "S21c", name: "digest decide", sideEffect: "ledger" },
  { story: "S21c", name: "digest queue", sideEffect: "none" },
  { story: "S21c", name: "digest assign", sideEffect: "ledger" },
  { story: "TPC-1482", name: "config list", sideEffect: "none" },
  { story: "TPC-1518", name: "usage record", sideEffect: "ledger" },
  { story: "S23c", name: "usage", sideEffect: "none" },
  { story: "TPC-1498", name: "plan", sideEffect: "ledger" },
  { story: "TPC-1498", name: "plan hold", sideEffect: "ledger" },
  { story: "TPC-1498", name: "plan release", sideEffect: "ledger" },
  { story: "TPC-1498", name: "plan priority", sideEffect: "ledger" },
  { story: "TPC-1498", name: "plan order", sideEffect: "ledger" },
  { story: "TPC-1500", name: "plan stretch", sideEffect: "ledger" },
  { story: "TPC-1500", name: "plan reset-available", sideEffect: "ledger" },
  { story: "TPC-1500", name: "plan reset-used", sideEffect: "ledger" },
  { story: "TPC-1513", name: "tick", sideEffect: "ledger" },
  { story: "S26c", name: "log", sideEffect: "none" },
  { story: "TPC-1514", name: "run launch", sideEffect: "orca" },
  { story: "TPC-1523", name: "standup", sideEffect: "none" },
  { story: "TPC-1523", name: "standup done", sideEffect: "ledger" },
  { story: "TPC-1523", name: "standup skip", sideEffect: "ledger" },
  { story: "S22o", name: "reply", sideEffect: "orca" },
] as const;

function trim(value: string): string {
  return value.trim();
}

function contractRows(
  markdown: string,
): Map<string, { cancelBy: string; evidence: string }> {
  const rows = new Map<string, { cancelBy: string; evidence: string }>();
  let inTable = false;
  for (const line of markdown.split("\n")) {
    if (line === "## Side-effect commands") {
      inTable = true;
      continue;
    }
    if (inTable && line.startsWith("## ")) break;
    if (!inTable || !line.includes("`")) continue;
    const cells = line.split("|").map(trim);
    if (cells.length < 6) continue;
    const name = cells[1]?.replaceAll("`", "");
    const cancelBy = cells[3];
    const evidence = cells[5];
    if (name === undefined || cancelBy === undefined || evidence === undefined)
      continue;
    rows.set(name, { cancelBy, evidence });
  }
  return rows;
}

test("side-effect verbs in the registry match the contract", () => {
  const markdown = readFileSync("docs/contract.md", "utf8");
  const rows = contractRows(markdown);
  expect([...rows.keys()].sort()).toEqual([...sideEffectVerbs].sort());
  for (const verb of verbs) {
    if (verb.sideEffect === "none") continue;
    const row = rows.get(verb.name);
    expect(row, verb.name).toBeDefined();
    expect(row?.cancelBy).toBe(verb.cancelBy.join(", "));
    expect(row?.evidence).toBe(verb.evidenceRequired.join(" "));
  }
});

test("each of the 17 verbs is todo until its story registers it", () => {
  expect(expectedVerbs).toHaveLength(17);
  const names = new Set(verbs.map((verb) => verb.name));
  for (const row of expectedVerbs) {
    if (row.status === "todo") {
      expect(names.has(row.name), row.name).toBe(false);
    }
  }
  for (const name of names) {
    if (extraVerbs.some((item) => item.name === name)) continue;
    const row = expectedVerbs.find((item) => item.name === name);
    expect(row, name).toBeDefined();
    expect(row?.status).not.toBe("todo");
  }
});

test("verbs beyond the 17 are registered with their side effect", () => {
  for (const extra of extraVerbs) {
    const verb = verbs.find((item) => item.name === extra.name);
    expect(verb, extra.name).toBeDefined();
    expect(verb?.sideEffect).toBe(extra.sideEffect);
  }
});

test("the tick row names --agenda meta and --slot", () => {
  const row = contractRows(readFileSync("docs/contract.md", "utf8")).get(
    "tick",
  );
  expect(row?.evidence).toContain("`--agenda meta`");
  expect(row?.evidence).toContain("`--slot NAME`");
});

test("the contract copies the bypass paragraphs", () => {
  const spec = readFileSync("docs/tech-spec.md", "utf8").split("\n");
  const contract = readFileSync("docs/contract.md", "utf8").split("\n");
  for (const lineNumber of [927, 929, 931]) {
    const line = spec[lineNumber - 1];
    expect(line?.length).toBeGreaterThan(0);
    expect(contract).toContain(line);
  }
});
