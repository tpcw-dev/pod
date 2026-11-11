import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { denylistFiles, scopeRoots } from "../../src/cli/scope-scan.ts";

test("the scope scan uses the scrubber boundary, including a serialized escape", () => {
  const root = mkdtempSync(join(tmpdir(), "pod-scope-"));
  mkdirSync(join(root, "nested"));
  writeFileSync(
    join(root, "nested", "escaped.txt"),
    String.raw`{"note":"head\nsecretco: PASS"}`,
  );
  writeFileSync(join(root, "stuck.txt"), String.raw`\nsecretcoextra`);
  writeFileSync(join(root, "word.txt"), "secretco keeps the gate");
  const denylist = ["secretco"];
  expect(denylistFiles(denylist, [root]).sort()).toEqual(
    [join(root, "nested", "escaped.txt"), join(root, "word.txt")].sort(),
  );
});

test("a file holding a userinfo password is reported", () => {
  const root = mkdtempSync(join(tmpdir(), "pod-scope-"));
  writeFileSync(
    join(root, "url.md"),
    "connect to scheme://user:example-not-a-secret@db.invalid/pod\n",
  );
  writeFileSync(
    join(root, "redacted.md"),
    "connect to scheme://user:[credential]@db.invalid/pod\n",
  );
  writeFileSync(join(root, "plain.md"), "connect to https://db.invalid/pod\n");
  expect(denylistFiles([], [root])).toEqual([join(root, "url.md")]);
});

test("a denylisted word under specs/ fails the scan", () => {
  const root = mkdtempSync(join(tmpdir(), "pod-scope-"));
  for (const scope of scopeRoots)
    mkdirSync(join(root, scope), { recursive: true });
  mkdirSync(join(root, "specs", "nested"), { recursive: true });
  writeFileSync(
    join(root, "specs", "nested", "spec.md"),
    "secretco keeps the gate\n",
  );
  const roots = scopeRoots.map((scope) => join(root, scope));
  expect(denylistFiles(["secretco"], roots)).toEqual([
    join(root, "specs", "nested", "spec.md"),
  ]);
});
