# 0001. Drizzle owns schema and migrations

## Context

The TPC-1083 tech design review on 2026-10-25 settled how Pod defines its schema and applies migrations. The spec first proposed numbered SQL files under `db/migrations/` and a hand-rolled `config.migration` table that recorded each applied file and its sha256.

## Decision

Drizzle owns the schema and the migrations. The schema is TypeScript in `src/db/schema/config.ts` and `src/db/schema/ledger.ts`, and it uses Drizzle's `pgSchema` for the `config` and `ledger` schemas. `drizzle-kit generate` writes the SQL migration files and their journal into `db/migrations/`. Drizzle's migrator runs them over the `postgres` driver and keeps its own applied-migrations table. `pod db migrate` wraps that migrator and stays idempotent. Queries use Drizzle's query builder over the same driver, with raw SQL only for the append-only triggers. zod still parses every boundary.

## Rejected

Hand-written numbered SQL with a hand-rolled migrator and a `config.migration` table. It duplicates what Drizzle's migrator and journal already give. It puts the schema in two languages, the SQL files and the TypeScript types that read them. It leaves the applied-migrations bookkeeping as Pod code that Pod must test.

## Consequences

- The schema is TypeScript, and the generated SQL is reviewed in the PR that changes the schema.
- The append-only triggers on `config.revision` and `ledger.event` live in a custom SQL migration that `drizzle-kit generate --custom` creates.
- `pod db migrate` is a thin wrapper over the Drizzle migrator.
- The `postgres` driver stays the Db adapter's driver.
