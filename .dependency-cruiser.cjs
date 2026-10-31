module.exports = {
  forbidden: [
    {
      name: "cli-not-db",
      severity: "error",
      from: { path: "^src/cli/" },
      to: { path: "^src/db/" },
    },
    {
      name: "schema-not-core",
      severity: "error",
      from: { path: "^src/db/schema/" },
      to: { path: "^src/core/" },
    },
    {
      name: "schema-not-adapters",
      severity: "error",
      from: { path: "^src/db/schema/" },
      to: { path: "^src/adapters/" },
    },
    {
      name: "schema-not-cli",
      severity: "error",
      from: { path: "^src/db/schema/" },
      to: { path: "^src/cli/" },
    },
    {
      name: "decide-core-only",
      severity: "error",
      from: { path: "^src/core/decide/" },
      to: {
        path: "^src/",
        pathNot: "^src/core/(decide|domain|ports|process|manifest|dispatch)/",
      },
    },
    {
      name: "core-not-adapters",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/adapters/" },
    },
    {
      name: "core-not-cli",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/cli/" },
    },
    {
      name: "core-not-db",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/db/" },
    },
    {
      name: "core-not-driver-or-http",
      severity: "error",
      from: { path: "^src/core/" },
      to: {
        path: "^(node:)?(http|https|net|tls)$|^(postgres|pg|drizzle-orm|undici)(/|$)",
      },
    },
    {
      name: "adapter-not-cli",
      severity: "error",
      from: { path: "^src/adapters/" },
      to: { path: "^src/cli/" },
    },
    {
      name: "adapter-not-other-adapter",
      severity: "error",
      from: { path: "^src/adapters/([^/]+)/" },
      to: { path: "^src/adapters/", pathNot: "^src/adapters/$1/" },
    },
    {
      name: "adapter-not-core-interior",
      severity: "error",
      from: { path: "^src/adapters/" },
      to: { path: "^src/core/", pathNot: "^src/core/(ports|domain)/" },
    },
    {
      name: "adapter-not-db-unless-postgres",
      severity: "error",
      from: { path: "^src/adapters/(?!postgres/)" },
      to: { path: "^src/db/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};
