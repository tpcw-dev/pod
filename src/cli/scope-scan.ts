import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeScrubber } from "../core/domain/scrub.ts";

export const scopeRoots = [
  "fixtures",
  "docs",
  "src/db/schema",
  "test/db/takeover-unsafe",
];

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) found.push(...filesUnder(path));
    else if (stat.isFile()) found.push(path);
  }
  return found;
}

export function denylistFiles(
  denylist: readonly string[],
  roots: readonly string[] = scopeRoots,
): string[] {
  const scrubber = makeScrubber({
    hosts: [],
    users: [],
    roots: [],
    denylist,
  });
  const matched: string[] = [];
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      if (scrubber.hits(readFileSync(file, "utf8")).length > 0)
        matched.push(file);
    }
  }
  return matched;
}

function main(): void {
  const file = process.argv[2];
  if (file === undefined) {
    console.error("usage: scope-scan <denylist>");
    process.exit(2);
  }
  const denylist = readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const matched = denylistFiles(denylist);
  for (const path of matched) console.log(path);
  if (matched.length > 0) process.exit(1);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href)
  main();
