import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { denylistFiles } from "../../src/cli/scope-scan.ts";

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
