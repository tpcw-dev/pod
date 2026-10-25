import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/cli/index.ts" },
  format: ["esm"],
  outDir: "dist",
  target: "node22",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
