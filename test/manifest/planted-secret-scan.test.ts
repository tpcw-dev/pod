import { expect, test } from "vitest";
import { exportManifest } from "../../src/core/manifest/scrub.ts";
import type { ManifestReference } from "../../src/core/manifest/references.ts";

const planted = "zzzzzzzzzzzzzzzzzzzzYYYYYYYYYYYYYYYYYYYY";

test("an exported manifest replaces a planted key and the stored reference stays raw", () => {
  const references: ManifestReference[] = [
    {
      source: "story",
      revision: "abc",
      observed_at: "2026-10-26T00:00:00.000Z",
      coverage: "full",
      excerpt: `before ${planted} after`,
    },
  ];
  const exported = exportManifest({ references }, [planted.toLowerCase()]);
  expect(exported).not.toContain(planted);
  expect(exported).not.toContain(planted.toLowerCase());
  expect(exported).toContain("[scrubbed]");
  expect(references[0]?.excerpt).toContain(planted);
});

test("an empty denylist term is skipped", () => {
  const references: ManifestReference[] = [
    {
      source: "git_status",
      revision: "abc",
      observed_at: "2026-10-26T00:00:00.000Z",
      coverage: "full",
      excerpt: "clean",
    },
  ];
  expect(exportManifest({ references }, [""])).toContain("clean");
  expect(exportManifest({ references }, [""])).not.toContain("[scrubbed]");
});
