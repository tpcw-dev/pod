# Pod v1 tech spec

This document is the technical specification for Pod v1. An implementation lead grooms the fifteen candidate stories from it. It is reference material with short explanation paragraphs where a choice needs its reason.

The DDL, TypeScript, YAML, JSON, and directory blocks in this document are sketches, not code. They fix names, shapes, and constraints. The stories write the real files.

## Goal

Pod is a thin coordination layer over Orca. Orca keeps execution. Pod adds four things a full Story on Orca showed were missing:

1. A ledger that records every launch receipt, delivery, push, PR, release, and Gate receipt without a hand-written entry.
2. Gate receipts bound to the candidate SHA and synced to the tracker with readback, so no Story reaches Done on a stale or forged PASS.
3. Reconcile and recovery as commands, so an unknown launch result, a stale delivery, or a second coordinator never causes a double launch.
4. A Decision layer where a decider Seat proposes and an auditor Seat checks against one Evidence manifest, and a person rules only when the policy or the loop requires it.

v1 is a set of `pod` verbs that wrap Orca, one Postgres database with a `config` schema of append-only Revisions and an event `ledger` schema, one Evidence manifest projected into a task view, a state view, and a brief, and a two-Seat Decision loop. v1 runs on one execution host. It has no daemon and no second host.

Every v1 choice keeps the end state in view. That end state is an operator who manages multi-project, multi-host agent work through two entry points. One is a long-running agent of the operator's choice that operates and monitors through the `pod` CLI and brings escalations to the operator. The other is a UI for standups, intake, project kick-off, and project feedback. Both read the same ledger. v1 chooses no agent product.

## Constraints

These constraints come from the PRD and the tech spec ticket, and they bind every story.

- The `pod` CLI, the daemon, and the adapters are TypeScript, the language of the runtime they wrap. An operator's existing scripts in another language may stay beside Pod while they are independent, and each one is ported when it becomes a Pod verb.
- The CLI is a deep module over the runtime. It has a small verb set, JSON in and out, and every error carries `code`, `message`, and `nextSteps[]`.
- The runtime adapter is tested by fixture replay of recorded runtime receipts. No unit test calls a live runtime.
- Postgres holds two logical schemas, `config` for append-only Revisions and `ledger` for events, with the migrations in the repo.
- Pod knows Roles, never names. No person, bot, host, team, or product name of any adopter appears in Pod's schema, process specs, fixtures, or docs. A crew profile maps Roles to Seats.
- The database is the authority for configuration, process, mapping, and Decisions. Orca is the authority for execution state. The tracker is the authority for intake, human priority, cancel, and human verdicts. The ledger holds sourced, timestamped projections. It never decides work.
- Each execution binding has one owner. The host that starts a Dispatch is the only host that stops and releases it.
- Pod does not schedule. The operator's claim authority decides claim and dispatch. Pod executes that authorization and refuses a second crew for the same Story.
- A Revision is immutable. No verb and no admin path updates an existing Revision.
- A completed Task is not a PASS. A Gate passes only on a verified Gate receipt.
- No secret and no transcript enters a table, an Evidence manifest, a fixture, or a view. A transcript locator, the harness and session id of a Dispatch, may enter a table; transcript content never does. Connection strings and tokens are read from the credentials file that the host profile names in `credentials_file`. The session environment is read only when that file is absent.
- v1 does not rely on `LISTEN/NOTIFY`. Connection mode, CAS conflicts, atomic bundle reads, disconnect recovery, and backup and restore are tested on a test database before any story relies on them.
- Linear is the only v1 tracker adapter. Notion is the only v1 docs adapter, and it is read-only.
- Pod does not wrap or duplicate the operator's existing grooming, planning, or docs commands. Until Sessions land, Pod does not wrap or duplicate the operator's kickoff command either.
- Pod never builds an IDE, terminal, diff, browser, or mobile surface, and never adds a second scheduler, an exactly-once promise, or agent authority over production, money, or credentials.

## Design

### Repo layout and packages

Pod is one npm package named `pod`. It is not a monorepo. Directories carry the layers, and an import-boundary lint enforces them.

```
pod/
  package.json            name pod, bin pod, type module, Node 22 LTS, pnpm
  tsconfig.json           strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
  drizzle.config.ts       drizzle-kit config, schema and migrations paths
  src/
    cli/                  the pod binary: argv parsing, verb registry, JSON envelope, exit codes
    core/
      domain/             branded ids, typed models, state machines (Task, Dispatch, Decision, Operation)
      config/             Revision, activation, Snapshot, canonical JSON and content hashing
      ledger/             event, operation, outbox, Gate receipt, Decision, manifest, learning repositories
      process/            spec schema (zod), selector, projector, edges table
      decide/             Decision loop state machine and round protocol
      manifest/           manifest builder, task view, state view, brief render
      ports/              OrcaPort, TrackerPort, DocsPort, Clock, Db interfaces
    adapters/
      orca/               OrcaPort over `orca orchestration <verb> --json`, receipt recorder, fixture replayer
      linear/             TrackerPort, source verification of comments
      notion/             DocsPort, read-only, by section
      postgres/           Db over Drizzle and the `postgres` driver, wraps the Drizzle migrator
    db/schema/            Drizzle schema, config.ts and ledger.ts
  db/migrations/          drizzle-kit output, forward-only SQL and its journal
  specs/
    process/              prd.yaml, design.yaml, impl-small.yaml, impl-medium.yaml, impl-large.yaml, impl-xlarge.yaml
    policy/               policy.yaml reference
    crew/                 crew.example.yaml (Roles to Seats, placeholder runtimes)
  fixtures/orca/          recorded receipts, one directory per scenario
  test/                   vitest: unit over core, replay over adapters, contract tests over the registry
  docs/                   tech-spec.md (this file), contract.md (story S1), adr/0001-drizzle-owns-schema-and-migrations.md
```

#### Import boundaries

dependency-cruiser runs in CI and refuses an import that crosses a layer the wrong way.

| Layer | May import | Must not import |
| --- | --- | --- |
| `src/cli` | `src/core`, `src/adapters` | nothing else in `src` |
| `src/db/schema` | Drizzle only | `src/core`, `src/adapters`, `src/cli` |
| `src/core` | `src/core` only, plus zod | `src/adapters`, `src/cli`, any driver or HTTP client |
| `src/adapters/<name>` | `src/core/ports`, `src/core/domain`, and `src/db/schema` for the postgres adapter only | `src/cli`, another adapter |

`core` holds every rule. Adapters translate between a port and one external system. `cli` wires adapters into `core` and prints the envelope. A daemon (`podd`, phase 2) and a UI (later) become more entry points over the same `core`. Pod splits into packages when a second entry point exists, not before. A pnpm workspace with five packages now was the alternative, and it lost because v1 is fifteen stories, none larger than size l, and the daemon does not exist.

#### Toolchain

Pod runs on Node 22 LTS and TypeScript in strict mode, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on. pnpm manages packages. tsx runs sources in development, and tsup builds the single `pod` bin. vitest runs the unit, replay, and contract tests. zod parses every boundary, which covers argv, stdin JSON, YAML, Orca stdout, HTTP bodies, and `jsonb` rows. The Db adapter uses Drizzle over the `postgres` driver. dependency-cruiser enforces the import boundaries, and eslint and prettier lint and format.

Drizzle owns the schema and the migrations. The schema is TypeScript in `src/db/schema/config.ts` and `src/db/schema/ledger.ts`, and it uses Drizzle's `pgSchema` for the two schemas. `drizzle-kit generate` writes the SQL migration files and their journal into `db/migrations/`. Drizzle's migrator runs them over the `postgres` driver and keeps its own applied-migrations table. `pod db migrate` wraps that migrator and stays idempotent. Queries use Drizzle's query builder over the same driver, with raw SQL only for the append-only triggers. zod still parses every boundary. Hand-written numbered SQL with a `config.migration` table was the alternative, and `docs/adr/0001-drizzle-owns-schema-and-migrations.md` records why it lost. The `postgres` driver holds under Drizzle, and `pg` was the alternative.

### Config schema and ledger schema sketch

Pod uses two Postgres schemas, `config` and `ledger`, in one database. `pod db migrate` runs the Drizzle migrator over `db/migrations/`, and Drizzle tracks each applied migration in its own applied-migrations table. Migrations are forward-only. There are no down migrations. The DDL blocks below are the shapes the Drizzle schema declares, shown as SQL for reading.

S2 may create one database project and one test branch on the existing database account's current plan. No plan upgrade and no new spend. Anything beyond that is a needs-human decision.

The connection string is the credentials file line whose name the host profile gives in `db.url_env`, read from the environment only when the file named by `credentials_file` is absent. Pod never stores it.

`config.revision` and `ledger.event` are append-only. A trigger on each raises on UPDATE and DELETE. The triggers live in a custom SQL migration. `config.activation` is the one `config` table a row replaces, under CAS, and every replacement records an event. Other ledger tables accept the state updates their state machines allow and nothing else.

#### Canonical JSON and content hashing

A Revision id is the sha256 of the canonical JSON of `kind`, `name`, `schema_version`, `scope`, `scope_ref`, `parent`, and `value`. `scope_ref` is in the hash so that two project Revisions with the same value get distinct ids. Canonical JSON has sorted keys, no whitespace, and UTF-8 encoding, in the style of RFC 8785. The same input always gives the same id, so applying an unchanged file returns the existing Revision.

`rev` is a sequence per kind and name across all scopes, assigned at apply as the previous highest plus one, so `kind.name@rev` names exactly one Revision whatever its scope. The Revision row and its activation keep `scope` and `scope_ref`. `pod config export kind.name@rev` and `pod run create --process name@rev`, whose kind is always `process`, therefore need no scope. Two Revisions with different content never share a `rev`, and applying an unchanged file returns the existing `rev` and `id`. `rev` stays out of the hash.

A Snapshot hash is the sha256 of the canonical JSON of the three Revision ids plus the effective gate map. An Evidence manifest id is the sha256 of the canonical JSON of its references.

#### Config tables

`config.revision` holds one immutable version of a crew, process, policy, decision, or host spec, or a Task spec.

```sql
create table config.revision (
  id              text primary key,            -- sha256 of canonical JSON
  parent          text null references config.revision(id),
  kind            text not null check (kind in ('crew', 'process', 'policy', 'task', 'decision', 'host')),
  name            text not null,
  schema_version  int  not null,
  rev             int  not null,
  scope           text not null check (scope in ('global', 'project', 'host', 'run')),
  scope_ref       text not null default '',   -- empty for global scope
  value           jsonb not null,
  actor           text not null,
  reason          text not null,
  created_at      timestamptz not null default now(),
  unique (kind, name, rev)
)
```

A Task spec Revision has kind `task`, scope `run`, `scope_ref` the Run id, and `name` the lineage id. The agreed outcome of a Decision with effect `change_spec` applies one, and the pinned process Snapshot does not change. A Decision with effect `accept_plan` applies no Revision, as "Decision effects" describes. A Task's `spec_revision_id` is immutable, so the projector creates a replacement Task in the same lineage with the new Revision, and the replaced Task moves to `superseded`. "Task states" lists that transition.

`config.activation` chooses which Revision a scope uses for one kind and name.

```sql
create table config.activation (
  scope                 text not null,
  scope_ref             text not null default '',
  kind                  text not null,
  name                  text not null,
  revision_id           text not null references config.revision(id),
  bundle_id             text null,
  activated_by          text not null,
  activated_at          timestamptz not null,
  previous_revision_id  text null references config.revision(id),
  primary key (scope, scope_ref, kind, name)
)
```

An apply that activates carries `expected_revision`. The current row's `revision_id` must equal it, or Pod refuses the apply with `revision_conflict`. `--expected-revision none` is the sentinel for a first activation. It succeeds only when no activation row exists for that scope, kind, and name, and otherwise Pod refuses it with `revision_conflict`. A bundle activates several rows in one transaction and stamps them with one `bundle_id`. A project activation overrides a global one. Every activation change also records an `activation` event, so the activation history survives the row replacement.

Spec clarification: TPC-1479. A Revision that an agent Seat writes waits as a pending request until a person activates it. This adds no column to `config.revision` or `config.activation`. `pod config apply` or `pod config set` without `--activate` from a Seat stores the Revision. It then writes a `ledger.operation` row with intent `config_activate` and status `pending`, and an `activation_requested` event. The row's `result_ref.pending` carries the scope, kind, name, revision id, the expected Revision, the tracker ticket, and the actor. The expected Revision is the one active at the scope when the request was written: for `config set`, the Revision it derived from. The rule covers `crew`, `process`, `policy`, `decision`, and `host`. A run-scope `task` Revision, such as one that `pod decide --effect change_spec` writes, never waits. A person's activation runs the same CAS as `--activate`, through `pod config activate` or a verified tracker comment that `pod check` reads back. It records the `activation` event with `activated_by` set to `person:<principal>`. A Seat write of the Revision already active at its scope writes no request.

`config.snapshot` pins the three Revision ids a Run uses and the gate map they resolve to.

```sql
create table config.snapshot (
  run_id               text primary key,
  crew_revision_id     text not null references config.revision(id),
  process_revision_id  text not null references config.revision(id),
  policy_revision_id   text not null references config.revision(id),
  effective_gate_map   jsonb not null,
  hash                 text not null,
  pinned_at            timestamptz not null
)
```

A Snapshot copies no values. The pinned Revisions are immutable, so the ids rebuild the exact configuration later. An activation change never changes an existing Run's Snapshot hash.

#### Ledger tables

`ledger.story` mirrors the tracker fields Pod reads.

```sql
create table ledger.story (
  provider      text not null,
  external_id   text not null,
  size          text not null check (size in ('xs', 's', 'm', 'l', 'xl')),
  stage         text not null,
  run_id        text null,
  dependencies  jsonb not null,
  synced_at     timestamptz not null,
  primary key (provider, external_id)
)
```

`ledger.run` maps one Story to one Orca Run. Its `state` is `active`, `hold`, `drained`, or `done`. Spec clarification: S18a. `pod run close` sets a Run `done` through its keyed `close` steps, and a Run in `done` with its `close` event is the archive. A Run in `hold` sends every open Task to `hold` and blocks new Dispatches until the operator reconciles and resumes it with `pod check --resume`. Its `coordinator` is the coordinator session, or the decider Dispatch id on an xl Run.

```sql
create table ledger.run (
  run_id               text primary key,         -- Orca run id
  story_provider       text not null,
  story_external_id    text not null,
  host                 text not null,
  coordinator          text not null,
  owner_generation     int  not null,
  snapshot_hash        text not null,
  state                text not null check (state in ('active', 'hold', 'drained', 'done')),
  created_at           timestamptz not null,
  foreign key (story_provider, story_external_id) references ledger.story
)
```

`ledger.task` maps one process step instance to one Orca Task.

```sql
create table ledger.task (
  task_id           text primary key,            -- Orca task id
  run_id            text not null references ledger.run,
  step_id           text not null,
  lineage_id        text not null,
  role              text not null,
  deps              jsonb not null,
  spec_revision_id  text not null references config.revision(id),
  state             text not null,
  created_at        timestamptz not null
)
```

`ledger.dispatch` records one Orca worker attempt and its launch receipt.

```sql
create table ledger.dispatch (
  dispatch_id            text primary key,       -- Orca ctx id
  task_id                text not null references ledger.task,
  run_id                 text not null references ledger.run,
  seat                   text not null,
  role                   text not null,
  requested_launch       jsonb not null,
  effective_launch       jsonb null,
  model_attribution      text not null check (model_attribution in ('receipt', 'unknown')),
  retry_of               text null references ledger.dispatch(dispatch_id),
  op_key                 text not null references ledger.operation,
  settlement             text not null,
  terminal_handle        text null,
  created_at             timestamptz not null,
  settled_at             timestamptz null,
  activity               text not null check (activity in ('running', 'waiting', 'settled')),
  manifest_id            text null references ledger.evidence_manifest,   -- added by S4
  -- reserved for phase 3, always null in v1
  execution_backend      text null,
  owner_host             text null,
  external_execution_id  text null,
  auth_ref               text null,
  output_ref             text null
)
```

`ledger.event` is the append-only record of everything that happened.

```sql
create table ledger.event (
  id           bigserial primary key,
  type         text not null check (type in (
                 'start', 'delivery', 'receipt', 'activation', 'decision', 'self_decision',
                 'push', 'pr', 'deploy', 'release', 'takeover', 'escalate', 'cancel',
                 'stop', 'drain', 'hold', 'resume', 'ignored', 'unknown_launch', 'learning')),
  ts           timestamptz not null,
  host         text not null,
  run_id       text null,
  task_id      text null,
  dispatch_id  text null,
  op_key       text null,
  payload      jsonb not null,
  source       jsonb not null           -- receipt, comment, or command that produced it
)
create index event_run_ts on ledger.event (run_id, ts)
```

Each event type has one kind of producer. A verb that is not listed records no event of its own.

| Producer | Event type |
| --- | --- |
| `pod dispatch`, `pod retry`, each Decision Seat launch inside `pod decide`, and the coordinator pair launch inside `pod run create` and `pod takeover` on an xl Run | `start` |
| `pod check` on a delivery that matches the Dispatch and the owner generation | `delivery` |
| `pod check` on a delivery with a stale `dispatchId` or owner generation | `ignored` |
| every runtime call and every tracker call through a port, and each bypass test run | `receipt` |
| `pod config apply --activate` on every activation change | `activation` |
| `pod decide` when a Decision closes, a Reserved deny hits, a human ruling is verified, or an evidence exchange records a child manifest | `decision` |
| `pod check` or `pod decide` when a Decision's adoption state changes | `decision` |
| `pod decide` with category `self`, below the escalation threshold | `self_decision` |
| `pod check` reading a push, a PR, or a deploy from a delivery, and `pod deploy record` recording an `external_action` deploy | `push`, `pr`, `deploy` |
| `pod release` | `release` |
| `pod takeover` | `takeover` |
| `pod decide` when a Seat, the lead, or the claim authority escalates, and when a Decision enters `needs_human` | `escalate` |
| `pod check` reading a tracker Canceled, and a cancel of a Decision | `cancel` |
| `pod check` reconciling a `worker-stop` | `stop` |
| `pod drain` and `pod drain --end` | `drain` |
| a Run or a Task entering `hold` | `hold` |
| `pod check --resume`, an operator resume of a Run or a Task from `hold` | `resume` |
| `pod check` finding a worker the ledger does not know | `unknown_launch` |
| `pod learning add`, and `pod learning import` once per imported row | `learning` |
| `pod run close`, once per Run, from its `archive` step | `close` |
| `pod run close`, once per p0 leftover, from its `escalate` step | `escalate` |

The PRD lists the event types `start`, `delivery`, `decision`, `push`, `pr`, `deploy`, `release`, `takeover`, `escalate`, and `cancel`. Pod keeps the types beyond that list, which are `receipt`, `activation`, `self_decision`, `stop`, `drain`, `hold`, `resume`, `ignored`, `unknown_launch`, and `learning`. `self_decision` is the PRD's `self` decision event. Spec clarification: S18a. Pod also keeps `close`, whose payload carries the Run's `snapshot_hash`, `report_hash`, the report counts, its Dispatch list, each Seat's end state, its `pr` event ids, `keep_files_reviewed`, and `gone` worktrees. Spec clarification: S18b. The `close` payload also carries `actor`, the S16a identity (`person:<operator>` or `seat:<POD_SEAT>`), and `retro_due`, which is true when the Story size is `m`, `l`, or `xl`, or the Run has a `FAIL` row in `ledger.gate_receipt`. The close output prints `retro: required` when it is true. Spec clarification: S21b. `pod retro run:<id>` acts on a Run whose `close` event carries `retro_due`, and `pod retro record FILE --run <id>` appends one `retro` event with the learning ids and occurrence ids once every finding is written. A p0 leftover's `escalate` event carries `story`, `kind`, `text`, and `actor`, and `pod state` lists it as an open needs-human item with gate `p0 <kind>`. Spec clarification: S18c. The `close` payload also carries `worktrees`, one row per Run worktree started on the closing host, with its Orca selector, path, local repository, branch, and tip, read before any removal; the `worktree` and `branches` steps read this recorded plan, never a fresh read.

`ledger.operation` holds one row per side-effect intent.

```sql
create table ledger.operation (
  op_key            text primary key,
  intent            text not null check (intent in (
                      'run_create', 'project', 'dispatch', 'retry', 'decide_seat', 'decide',
                      'config_apply', 'verdict', 'hqa', 'release', 'takeover', 'drain', 'learning', 'close')),
  status            text not null check (status in ('pending', 'unknown', 'done', 'refused')),
  owner_generation  int  not null,
  result_ref        jsonb null,
  created_at        timestamptz not null,
  updated_at        timestamptz not null
)
```

The status `refused` records a precondition refusal, so the op key is never reused.

Spec clarification: TPC-1479. The intent list gains `config_activate`, and the event types gain `activation_requested`, through migration `0016_config_activate`. A `config_activate` op key is `config_activate:` plus the sha256 of the canonical JSON of the intent, scope, scope_ref, kind, name, expected Revision, revision id, and ticket. So the same Seat write repeated returns its pending row, and a write naming another ticket opens a second request. Once that row is settled, a repeat opens a new request under `<key>:<n>`, the lowest free attempt. A request settles `done` when its Revision activates, with `result_ref.source` naming the comment or the command. Every pending request for that revision id settles with it. A request settles `refused` with `revision_conflict`, the active Revision, and the comment id when no pending request for that revision id expects the Revision active now. A pending `config_apply` row that a TPC-1413 profile request left behind is read as a request of the same shape and settles the same way.

`ledger.outbox` queues tracker writes until a readback confirms them.

```sql
create table ledger.outbox (
  id          bigserial primary key,
  op_key      text not null references ledger.operation,
  target      text not null check (target in ('tracker')),
  payload     jsonb not null,
  tries       int  not null default 0,
  last_error  text null,
  acked_at    timestamptz null,
  readback    jsonb null
)
```

`ledger.gate_receipt` records one verdict on one Gate, bound to its source and its candidate.

```sql
create table ledger.gate_receipt (
  id                 bigserial primary key,
  gate_id            text not null,
  run_id             text not null references ledger.run,
  task_id            text not null references ledger.task,
  scope              text not null,
  spec_revision_id   text not null references config.revision(id),
  candidate_sha      text not null,
  deployed_revision  text null,
  keeper             text not null,
  outcome            text not null check (outcome in ('PASS', 'FAIL')),
  source             jsonb not null,
    -- provider, workspace, issue, comment_id, author_id, relayed_by (null unless relayed),
    -- content_hash, readback_at
  sync_state         text not null check (sync_state in ('pending', 'synced', 'voided')),
  created_at         timestamptz not null
)
```

`ledger.decision` records one Decision lineage, its budget, and its outcome.

```sql
create table ledger.decision (
  id                      text primary key,     -- dec_ op key
  run_id                  text not null references ledger.run,
  task_id                 text null references ledger.task,   -- null when the lead or the claim authority escalates with no Task
  category                text not null,
  effect                  text not null check (effect in ('accept_plan', 'change_spec')),   -- named by the request, see "Decision effects"
  question                text not null,
  options                 jsonb not null,
  manifest_id             text not null references ledger.evidence_manifest,
  state                   text not null,
  outcome                 jsonb null,
  reason                  text null check (reason in (
                            'policy-required', 'disagreement', 'context-missing',
                            'runtime-failure', 'agreed', 'cancelled', 'denied')),
  binding                 text not null check (binding = 'run'),
  budget                  jsonb not null,
  spent                   jsonb not null,
  supersedes_decision_id  text null references ledger.decision(id),
  adoption                text not null default 'pending'
                            check (adoption in ('pending', 'adopted', 'reworked', 'reversed')),   -- current state, history is in events
  adoption_evidence       jsonb not null default '[]',   -- appended on every change, event ids of each rework or the superseding Decision
  created_at              timestamptz not null,
  closed_at               timestamptz null
)
```

`ledger.decision_round` records each round's proposal and audit.

```sql
create table ledger.decision_round (
  decision_id          text not null references ledger.decision,
  round                int  not null check (round between 1 and 3),
  decider_dispatch_id  text not null references ledger.dispatch,
  auditor_dispatch_id  text not null references ledger.dispatch,
  proposal             jsonb not null,
  audit                jsonb not null,
  stance               text not null check (stance in ('agree', 'disagree', 'escalate')),
  manifest_id          text not null references ledger.evidence_manifest,   -- the manifest this round cited
  ts                   timestamptz not null,
  primary key (decision_id, round)
)
```

`ledger.evidence_manifest` holds the fixed list of sources a Dispatch or Decision may cite.

A manifest never changes. When the auditor asks for evidence, Pod records a child manifest whose references are the parent's plus the new ones, with `parent_id` set. `ledger.decision.manifest_id` moves to each child, and each `ledger.decision_round` row cites the manifest that round used.

A round may have several evidence exchanges. Each one records a `decision` event carrying the child manifest id. Pod writes the `decision_round` row once, when the auditor records a stance other than `needs_evidence`, with `manifest_id` set to the last child. On recovery inside a round, Pod reads the current manifest from `ledger.decision.manifest_id`, so no round is spent. Spec clarification: S13b.

```sql
create table ledger.evidence_manifest (
  id          text primary key,                 -- sha256 of content
  run_id      text not null references ledger.run,
  task_id     text null references ledger.task,
  decision_id text null,
  parent_id   text null references ledger.evidence_manifest(id),
  references  jsonb not null,  -- each: source, revision, observed_at, coverage, excerpt
  created_at  timestamptz not null
)
```

`ledger.usage_observation` records what a provider reported about usage, or that it reported nothing.

```sql
create table ledger.usage_observation (
  provider      text not null,
  seat          text not null,
  window_start  timestamptz not null,
  window_end    timestamptz not null,
  value         numeric null,                  -- null means unknown, never zero
  coverage      text not null,
  observed_at   timestamptz not null
)
```

`ledger.learning` holds agent-only context. The docs tool never receives it.

```sql
create table ledger.learning (
  id             bigserial primary key,
  source_story   text not null,
  evidence_refs  jsonb not null,
  text           text not null,
  adoption       text not null check (adoption in ('new', 'proposed', 'adopted', 'rejected', 'done')),
  area           text not null check (area in ('product', 'design', 'impl', 'process')),
  project_id     text null,   -- the project scope id used by --scope project:<id>
  created_at     timestamptz not null,
  kind           text not null,   -- one of the active policy's learning.kinds
  expected       text null,       -- the normalized expected text the repeat match reads
  theme          text null,
  action_story   text null,
  adoption_at    timestamptz not null   -- when adoption last changed
)

create table ledger.learning_occurrence (
  id           bigserial primary key,
  learning_id  bigint not null references ledger.learning(id),
  story        text not null,
  occurred_on  date not null,
  reporter     text not null check (reporter in ('lead', 'retro', 'healthcheck')),
  wording      text not null,
  evidence_id  text not null,
  created_at   timestamptz not null,
  unique (learning_id, evidence_id)
)
```

Spec clarification: S21a. A learning's occurrence count is the count of its `ledger.learning_occurrence` rows; there is no counter column. `evidence_id` is the learning's distinct evidence refs sorted bytewise and joined with one space, so a repeated source is one occurrence. Migration 0018 fills `kind` with `lead` and `adoption_at` with `created_at` on existing rows, and gives each one occurrence; a row whose `evidence_refs` is not a non-empty list of strings gets `evidence_id` `learning:<id>`. `pod learning add` first matches: same `kind` and equal normalized `expected` (NFKC, lowercase, punctuation and symbols to spaces, whitespace collapsed), or same `kind` and a shared `<repo>:<path>` evidence ref, with a trailing `:<line>` or `:<line>-<line>` ignored. Zero matches insert a row and its first occurrence. One match adds an occurrence to that row; a `rejected` row returns to `new` when it has two occurrences written after `adoption_at`, and a `done` row returns to `new` when the occurrence comes within 72 hours of `adoption_at`. Two or more matches refuse `learning_match_ambiguous`. `--repeat-of <id>` skips the match. Every refusal is decided before the operation row, so nothing is written and a retry after the cause is fixed proceeds. The op key is `learning:` plus the sha256 of the canonical JSON of `source_story`, `text`, `area`, `project_id`, `kind`, normalized `expected`, the sorted distinct `evidence_refs`, `reporter`, and `repeat_of`. `pod learning import FILE` writes each row of a YAML list once, keyed `learning:import:<sha256(source_ref)>`, with its occurrences as given and no repeat match; a rerun writes nothing. Its rows carry `source_ref`, `kind`, `area`, `text`, `adoption`, and `occurrences` (each `story`, `occurred_on`, `reporter`, `wording`, `evidence_id`), and optionally `expected`, `theme`, `action_story`, and `project`. The whole file is checked before anything is written, and every imported row's `created_at`, `adoption_at`, and occurrence `created_at` are the import time. It is operator only: an agent Seat is refused `usage`. The `learning` event payload carries `kind` and `occurrence_id`; an imported row's event also carries `source_ref` and `occurrence_ids`.

#### Invariants by table

The table below states who writes each table, what never changes, what a reader may assume, and which story adds it.

| Table | Added by | Written by | Immutable | Readers may assume |
| --- | --- | --- | --- | --- |
| `config.revision` | S2 | `pod config apply`, and `pod decide` for a Task spec Revision | every row, trigger-enforced | an id names exactly one value forever |
| `config.activation` | S2 | `pod config apply --activate` | no, replaced under CAS | one Revision per scope, kind, and name at any moment |
| `config.snapshot` | S2 | `pod run create` | every row | a Run's configuration never changes after it starts |
| `ledger.story` | S2 | tracker sync inside `pod run create` and `pod check` | no, refreshed from the tracker | a mirror with `synced_at`, never the authority |
| `ledger.run` | S2 | `pod run create`, `pod takeover` | `run_id`, story, `snapshot_hash` | `owner_generation` only increases |
| `ledger.task` | S2 | the projector inside `pod run create` and `pod check` | id, step, lineage, spec Revision | `state` moves only along the Task state table |
| `ledger.dispatch` | S2 | `pod dispatch`, `pod retry`, `pod release`, `pod decide`, and `pod run create` and `pod takeover` on an xl Run | launch fields once recorded | `model_attribution` is `receipt` only when a launch receipt named the model |
| `ledger.event` | S2 | every side-effect verb, `pod check` | every row, trigger-enforced | ordered by `ts` within a Run, each with a `source` |
| `ledger.operation` | S2 | every side-effect verb | `op_key`, `intent` | one row per intent, status moves forward only |
| `ledger.gate_receipt` | S6 | `pod verdict post`, `pod hqa record` | all fields except `sync_state` | a PASS is bound to one candidate SHA and one verified source |
| `ledger.outbox` | S6 | `pod verdict post`, `pod hqa record`, `pod check` | `op_key`, `payload` | a row is done only when `readback` confirms it |
| `ledger.evidence_manifest` | S4 | `pod dispatch`, `pod decide` | every row, new evidence makes a child manifest | the same sources give the same id |
| `ledger.learning` | S10 | `pod learning add`, `pod learning import` | `text`, `evidence_refs`, `source_story`, `area`, `project_id`, `kind`, `expected` | never mirrored to the docs tool, `adoption_at` moves with every `adoption` change |
| `ledger.learning_occurrence` | S21a | `pod learning add`, `pod learning import` | every row, trigger-enforced | one row per learning and `evidence_id` |
| `ledger.usage_observation` | S11 | `pod check` only | every row | a null `value` means unknown |
| `ledger.decision` | S12 | `pod decide`, and `pod check` for `adoption` | id, category, `effect`, question, `binding` | `manifest_id` moves only to a child manifest through an evidence exchange, `spent` only increases, `binding` is always `run`, `adoption` moves along `pending` to `adopted`, `adopted` to `reworked` or `reversed`, and `reworked` to `reversed`, every change appends to `adoption_evidence` and records a `decision` event with the new state and its evidence, and the full history is the ordered `decision` events |
| `ledger.decision_round` | S12 | `pod decide` | every row | at most three rounds per Decision |

### CLI framework, verb list, and error shape

Pod uses no CLI framework. Node's `util.parseArgs` parses argv. The verb set is a registry table in `src/cli/verbs.ts` with one row per verb.

```ts
interface VerbRow<I, O> {
  name: string                      // 'config apply'
  input: ZodType<I>
  output: ZodType<O>
  handler: (input: I, ctx: VerbContext) => Promise<O>
  sideEffect: 'none' | 'config' | 'ledger' | 'orca' | 'tracker'
  cancelBy: 'operator' | 'coordinator' | 'nobody'
  evidenceRequired: readonly string[]
}
```

The registry generates `pod --help`. The S1 contract test asserts that every registry row with a side effect appears in `docs/contract.md` with its `cancelBy` and its `evidenceRequired`. The registry is the contract, and a framework would put a second copy of it in decorators or config. That is why Pod has no framework.

#### Verbs

v1 has the PRD's 16 command forms plus `db migrate`. `db migrate` is a setup verb outside the count of the 16 forms. `--resume` on `pod check` is a flag, not a new form, so the forms stay 16.

| Verb | Arguments | Side effect | Records to | Cancel by |
| --- | --- | --- | --- | --- |
| `db migrate` | none | config | Drizzle's applied-migrations table | nobody |
| `config apply` | `FILE`, `--expected-revision R` (`none` for a first activation), optional `--activate --scope S` | config | `config.revision`, `config.activation`, event | nobody, a new Revision replaces it |
| `config export` | `kind.name@rev`, `--out FILE`, or `--all`, optional `--prune` | none | a YAML file, or with `--all` one mirror file per active Revision under the host profile's `mirror_dir` | nobody |
| `config get` | `kind.name`, optional `--scope S` | none | nothing | not applicable |
| `config activate` | `kind.name@rev`, `--scope S`, `--expected-revision R`, optional `--op-key K`, `--reason T` | config | `config.activation`, `ledger.operation`, event | nobody, a new activation replaces it |
| `config set` | `kind.name`, one or more `path=value`, `--unset path`, `--reason R`, optional `--scope S`, `--from kind.name@rev`, `--activate`, `--ticket K`, `--string` | config | `config.revision`, `config.activation`, event | nobody, a new Revision replaces it |
| `run create` | `story:<id>`, optional `--process name@rev` | orca | `ledger.story`, `ledger.run`, `config.snapshot`, `ledger.task`, Orca `run-create` and `task-create`, and on an xl Run the decider and auditor `ledger.dispatch` rows | operator, by a cancel event |
| `dispatch` | `--task T`, `--seat S`, `--generation N`, optional `--op-key K` | orca | `ledger.operation`, `ledger.evidence_manifest`, `ledger.dispatch`, start event, Orca `worker-start` | coordinator or operator, by `worker-stop` then `release` |
| `check` | `--generation N`, optional `--wait`, optional `--resume` | ledger | delivery, ignored, `unknown_launch`, `resume`, `stop`, `activation`, and `decision` events, `ledger.task`, `ledger.run` state, `config.activation` for a change_spec Task spec, Orca `check` ack, `task-create`, `worker-stop`, `request-show`, and the worker list | nobody |
| `retry` | `--dispatch D`, `--generation N`, optional `--op-key K` | orca | `ledger.operation`, `ledger.dispatch` with `retry_of`, Orca `worker-start --retry-of` | coordinator or operator |
| `release` | `--dispatch D`, `--generation N`, optional `--retain --reason R` | orca | release event, Orca `worker-release` | nobody |
| `verdict post` | `FILE`, `--generation N` | tracker | `ledger.gate_receipt`, `ledger.outbox` | operator, by voiding the receipt |
| `hqa record` | `story:<id>`, `--generation N` | tracker | `ledger.gate_receipt`, `ledger.outbox` | operator, by voiding the receipt |
| `deploy record` | `story:<id>`, `--generation N`, `FILE` or `--stdin` | ledger | deploy event, `ledger.task` | operator |
| `decide` | `--task T`, `--category C`, `--effect accept_plan` or `--effect change_spec`, `FILE`, `--generation N` | orca | `ledger.decision`, `ledger.decision_round`, `ledger.evidence_manifest`, `config.revision` for a change_spec Task spec, decider and auditor `ledger.dispatch` rows, Orca `send` | operator or the escalating actor, by a cancel event |
| `state` | optional `--project P`, optional `--decisions` | none | nothing | not applicable |
| `takeover` | `story:<id>` | orca | `ledger.run.owner_generation`, `ledger.run.coordinator`, takeover event, a restore view from the same manifest, Orca `run-use`, and on an xl Run a new decider `ledger.dispatch` row | nobody |
| `brief` | optional `story:<id>`, optional `--html FILE` | none | an HTML file, with each mirror stale Revision marked | not applicable |
| `drain` | optional `--end` | ledger | drain event | operator |
| `learning add` | `FILE`, `--area A` and `--kind K` (required), optional `--project P`, `--reporter lead\|retro\|healthcheck`, `--expected TEXT`, `--repeat-of ID` | ledger | `ledger.learning` when nothing matches, one `ledger.learning_occurrence`, learning event | nobody |
| `learning import` | `FILE` | ledger | per new row: `ledger.learning`, its `ledger.learning_occurrence` rows, learning event | nobody |
| `run close` | `story:<id>`, `--generation N`, optional `FILE`, optional `--keep-files-reviewed` | tracker | one `close` operation per step, one close event, a `learning` row per learning and per leftover with no `p0`, an `escalate` event per p0 leftover, the Story status and one closing comment through the outbox, `ledger.run.state` `done` | nobody |
| `retro` | `run:<id>`, `--seat S`, `--generation N`, optional `--op-key K` | orca | the retro `ledger.task`, `ledger.dispatch`, `ledger.evidence_manifest`, Orca `task-create` and `worker-start` | coordinator, operator, by `worker-stop` then `release` |
| `retro record` | `FILE`, `--run <id>` | ledger | per finding: `ledger.learning` when nothing matches, one `ledger.learning_occurrence`, learning event; then one `retro` operation and `retro` event | nobody |
| `learning query` | optional `--story`, `--adoption`, `--text`, `--area`, `--project` | none | nothing | not applicable |

`pod drain --end` ends a drain and records a `drain` event with `ended: true`. `pod check --resume` records an operator resume of a Run or a Task from `hold` as a `resume` event. `pod takeover` writes a restore view from the same manifest. `pod brief` compares every active Revision with its file in the mirror directory, the host profile's `mirror_dir`, and marks a difference `mirror stale`; `pod config export --all` repairs it.

Spec clarification: TPC-1478. `pod config set <kind>.<name> <path>=<value>... [--unset <path>]... --reason R [--scope S] [--from kind.name@rev] [--activate] [--ticket K] [--string]` derives one Revision from a source and records the source as its `parent`. The source is the active Revision of kind.name at `--scope` (default global), or with `--from` any existing Revision of that kind.name, active or not; with no source it is refused `revision_not_found` and points at `pod config apply FILE`. A path is dotted keys with `[n]` list indexes; a set creates a missing map key on the way, and `[n]` must name an existing element. Values parse as YAML flow, and `--string` keeps every value as text. All sets apply in argv order, then all unsets, and the result is revalidated as `pod config apply` validates a file. With `--activate`, the expected Revision is the one active at the source's scope when it was read, so a change in between returns `revision_conflict`. Both config write verbs record `actor` and `activated_by` as `person:<principal>` or `seat:<Seat Address>`, and store `--ticket` on the Revision. Rows written before TPC-1478 keep `operator`.

Spec clarification: TPC-1479. An agent Seat's `pod config apply` or `pod config set` without `--ticket <key>` is refused with `usage` and a next step naming `--ticket`, and nothing is written. With `--ticket`, the write replies in the `pod config apply` shape, with `activation` null and `pending` set to `{ op_key, profile, comment, ticket, runs_on_old_profile, readback }`. `comment` is the approval comment a person posts on that ticket. Its first line is `config activate <revision-id>`, the full 64-hex id, and note lines may follow. Pod never posts it. `pod config activate kind.name@rev --scope S --expected-revision R` activates an existing Revision as a person, with the CAS that `--activate` uses and the same op key that `pod config apply --activate` derives for that Revision. It replays a done row at that key only while that Revision is still active. A done row for a Revision no longer active, a refused row, or a pending request row at that key sends it to `<key>:<n>`, the lowest free attempt, and it activates there. Its activation event's source is `{ kind: command, verb: config activate }`, and it closes every pending request for that revision id as `done`. Any person activation of that Revision closes them the same way. From a Seat it is refused with `activation_needs_person`. A `--scope` other than the Revision's own is `usage`, an unknown ref is `revision_not_found`, and a stale `--expected-revision` is `revision_conflict`. `pod brief` lists each pending request under `pending_requests` as `{ op_key, ref, scope, ticket, actor, comment }`, and its HTML has a `pending-requests` table. `pod state` prints `Config requests pending: N` in the policies section.

Spec clarification: TPC-1480. The database is the source of configuration, and its mirror is the directory the host profile names in `mirror_dir`, default `$POD_HOME/mirror`, outside any Pod checkout (the operator's ruling of 2026-11-10 on TPC-1480, recorded in `docs/adr/0002-database-is-the-source-of-configuration.md`). The Pod repository's `specs/` holds generic seeds and examples only, and no verb writes it or reads it as the mirror. `pod config export --all [--prune]` writes every active Revision to its mirror path: a global one to `<mirror_dir>/<kind>/<name>.yaml`, any other scope to `<mirror_dir>/<kind>/<scope>/<scope_ref>/<name>.yaml`. A run-scope `task` Revision and a pending Revision are not written. The file holds the envelope with keys in the order kind, name, schema_version, scope, scope_ref, parent, value, and every map inside value sorted by key, so two exports of one database write the same bytes. A kind, name, or off-global scope_ref that is not `[A-Za-z0-9._-]+`, or is only dots, has no mirror path, and the Revision is listed under `skipped`. The reply is `{ dir, files: [{ ref, id, scope, path }], skipped: [{ ref, id, scope, reason }], orphans, pruned, nextSteps }`, with absolute paths. `orphans` lists each `*.yaml` file under the mirror directory that no active Revision wrote; `--prune` deletes them. `nextSteps` names `git -C <dir> add -A` and `git -C <dir> commit`; Pod runs no git command and opens no pull request. A `mirror_dir` that exists and is not a directory is `usage`. `--all` takes no `kind.name@rev` and no `--out`, and `--prune` needs `--all`; otherwise `usage`. `pod brief` reads the same set: its top-level `drift` lists `{ revision_id, ref, kind, name, scope, path, mark: "mirror stale" }` for each active Revision whose mirror file is missing, unreadable, fails the envelope schema, or holds another Revision, with `path` absolute or null when it has none, and `nextSteps` then carries `pod config export --all`. A `mirror_dir` that is a file leaves brief running with every active Revision `mirror stale`. `stories[].drift` is gone. The brief HTML has a `mirror-stale` table.

Spec clarification: TPC-1532. The `host` kind holds one host's settings. A host Revision has `scope: host`, and its `scope_ref` and `name` are both the host id; any other scope or ref is `schema_invalid` naming `scope_ref`. Its value carries `driver`, `hostnames`, `manager`, `slots { default, max }`, `reserved { <project>: n }`, and `projects` (a list of project names, or `"*"` alone, possibly empty), and optionally `decision_seat`, `harnesses`, `notion_harnesses`, `notion`, `scheduler` (`orca` or `nohup`), and `limits { min_available_mb, max_swap_used_pct, crew_memory_max, crew_swap_max }`. Validation refuses with `schema_invalid` and names the field: `slots.default` above `slots.max`, a `reserved` total above `slots.max`, `decision_seat` without `manager`, a `notion_harnesses` entry missing from `harnesses`, and a `projects` entry, a name or `"*"`, that another host's active host Revision already seats, with the other host in the message. Pod stores the value as written and applies no defaults. `pod config get <kind>.<name> [--scope S]` prints the active Revision at the scope as `{ ref, id, scope, scope_ref, value }`. `--scope` takes `global` or `scope:ref`, and defaults to `host:<name>` for kind `host` and to `global` otherwise. It is a read: it resolves no identity and needs neither `operator` nor `POD_SEAT`. With no active Revision it refuses `config_missing`.

The evidence each side-effect verb requires before it acts:

| Verb | Evidence required |
| --- | --- |
| `db migrate` | a reachable database and a `db/migrations/` journal that matches the applied-migrations table |
| `config apply` | a file that passes its schema, every Role filled and every gate id present when the kind is process, and `expected_revision` equal to the active Revision when `--activate` is set |
| `config activate` | an existing Revision at the named scope, run by a person, and `expected_revision` equal to the active Revision |
| `config set` | an existing source Revision, an edit that passes its kind's schema, and the active Revision unchanged since it was read when `--activate` is set |
| `run create` | a groomed Story with a size and a stage, and exactly one selected process Revision |
| `dispatch` | Task state `ready`, every dependency satisfied as "Task states" defines, a free quota slot, which on an xl Run counts the coordinator's slot as released by the dispatch transaction, an authorized Seat for the Role, reviewer independent of developer, no drain in force |
| `check` | the delivery's `payload.dispatchId` matches a recorded Dispatch, and its owner generation matches the Run |
| `retry` | Task state `blocked`, the original placement in `ledger.dispatch`, the worktree `git status` in the task view |
| `release` | the Dispatch is settled or the caller gives a retain reason, and this host owns the terminal |
| `verdict post` | Head SHA equals the current candidate SHA, and the reviewer is not the developer |
| `hqa record` | a source-verified comment by the human gatekeeper, or by the relay principal with a matching content hash, plus a deploy event for `hqa_after_deploy` |
| `deploy record` | a deploy line whose deployed_revision matches the Run's candidate SHA or its tree |
| `decide` | the Reserved check passed, an Evidence manifest is pinned, and the `effect` fits the Task as "Decision effects" requires |
| `takeover` | evidence that the old coordinator has stopped, which on an xl Run is the decider Dispatch |
| `drain` | an owner generation that matches the Run |
| `learning add` | a source Story, at least one evidence reference, and an `area` |
| `learning import` | a FILE of rows, each with a `source_ref` and at least one occurrence |
| `run close` | every Task done, superseded, or failed; no running Dispatch other than the Run's coordinator Dispatch; no open or needs_human Decision; no text in the composer of an open Dispatch terminal other than the coordinator's, read from a rendered screen; and no untracked file and no branch ahead of its upstream in the Run's worktrees, unless `--keep-files-reviewed` is passed |
| `retro` | a `close` event with `retro_due` true, a pinned process with a `retro` step that runs after close, the Run's owner host, and a Seat with no Dispatch in the Run |
| `retro record` | a Run due a retro, a FILE of findings each with at least one evidence reference, and the `tech` kind in the policy's `learning.kinds` |

#### JSON envelope

Every verb prints one JSON object on stdout. The shape matches the one Orca receipts use.

```json
{ "ok": true, "result": { }, "meta": { "pod": "0.1.0", "orca": "1.4.211", "opKey": "...", "ownerGeneration": 3 } }
{ "ok": false, "error": { "code": "revision_conflict", "message": "...", "nextSteps": ["pod config export process.impl-small@2", "..."] } }
```

Identifiers and flags come from argv. A body comes from a file path or stdin, as JSON or as YAML for a spec. Every output is JSON. `--json` is the only mode. A human-readable render exists only in `pod brief` (HTML) and in `nextSteps`.

#### Exit codes

| Code | Meaning | What happened |
| --- | --- | --- |
| 0 | ok | the verb finished |
| 1 | failed | the verb failed after it started, and the error says where |
| 2 | usage or schema error | Pod sent nothing to Orca, the database, or the tracker |
| 3 | refused by a precondition | CAS, owner generation, selector, Reserved, independence, or a budget that ran out before the next step |
| 4 | result unknown | a side effect may have happened, the reservation is held, run the verb again with the same op key or run `pod check` |
| 5 | drained | a drain is in force and the verb would start new work |

#### Error codes

| Code | Exit | Fires when | `nextSteps` carries |
| --- | --- | --- | --- |
| `usage` | 2 | argv does not parse, or a required argument is missing | the verb's `pod --help` line |
| `schema_invalid` | 2 | stdin JSON, a file, or YAML fails its zod schema | the failing path and the expected type |
| `revision_conflict` | 3 | `expected_revision` differs from the active Revision, or it is `none` and an activation row exists | `pod config export` of the active Revision, then apply again with its id |
| `config_missing` | 3 | `pod config get` finds no active Revision of kind.name at the scope | `pod config apply FILE --ticket K`, then a person's `pod config activate` |
| `revision_immutable` | 3 | a caller tries to change an existing Revision | apply a new Revision with `parent` set |
| `selector_none` | 3 | no active process selector matches stage and size, or the Story lacks the stage label or the size | the missing field, or the stage and size read and the active process names |
| `selector_many` | 3 | more than one process matches | the matching Revision ids, and `--process` to name one |
| `selector_conflict` | 3 | `--process` and the `Kickoff:` line differ, or a named Revision's selector does not apply | both values, and a request to fix the Story or drop the flag |
| `role_unfilled` | 3 | a process Role has no authorized Seat in the active crew | the Role, and `pod config apply` of a crew that fills it |
| `reviewer_not_independent` | 3 | the reviewer Seat equals or is not independent of the developer Seat, or a Decision Role repeats on one artifact | the conflicting Seats and Dispatch ids |
| `takeover_unsafe` | 3 | `pod takeover` has no evidence that the old coordinator stopped | the stop command for the old coordinator, and the evidence `pod takeover` accepts |
| `owed_work` | 3 | `pod run close` finds a Task not `done`, `superseded`, or `failed`, a running Dispatch other than the coordinator's, or an open or `needs_human` Decision | each owed item, and `pod state story:<id>` |
| `unanswered_question` | 3 | `pod run close` reads text in the composer row of an open Dispatch terminal's rendered screen, or cannot read that screen | `orca terminal read --terminal <handle> --screen` |
| `needs_file` | 3 | `pod run close` finds an untracked file or a branch ahead of its upstream in a worktree of the Run, and `--keep-files-reviewed` is not passed | each file, each branch ahead, and the close command with `--keep-files-reviewed` |
| `tracker_unconfirmed` | 4 | `pod run close` has no tracker, or the tracker has not acked the outbox row of its `status` or `comment` step | a parked row and its tries, and the same close command again |
| `story_canceled` | 3 | `pod run close` sets the Story status and the tracker shows the Story canceled by a person; the Run is on hold | `pod state story:<id>` |
| `open_pr` | 3 | before its `archive` step is done, `pod run close` reads an open PR for a `pr` event of the Run or for the branch of a Run worktree, or cannot read one | each open PR to merge or close, or the read that failed, and the same close command |
| `wrong_host` | 3 | `pod run close` runs on a host other than the Run's `host` | the close command on the owner host |
| `learning_kind_unknown` | 3 | `pod learning add` or `pod learning import` names a kind outside the active policy's `learning.kinds` for its scope | the allowed kinds, and a policy Revision that adds the kind, activated by a person |
| `learning_match_ambiguous` | 3 | `pod learning add` matches two or more learnings | `pod learning add FILE --area A --kind K --repeat-of <id>` for each matched id |
| `retro_not_due` | 3 | `pod retro` or `pod retro record` names a Run with no `close` event, or one whose `close` event has `retro_due` false | `pod run close story:<id>`, or that nothing is owed |
| `release_refused` | 3 | the Dispatch is not settled and no retain reason is given, or another host owns the terminal | `pod check`, and `--retain --reason` |
| `owner_generation_stale` | 3 | the caller's generation is lower than `ledger.run.owner_generation` | `pod takeover story:<id>` if this session should own the Run |
| `task_not_ready` | 3 | the Task is not `ready`, or a dependency is not satisfied as "Task states" defines | the unsatisfied dependencies, the receipt or delivery each lacks, and the Task state |
| `quota_exhausted` | 3 | no free slot on this host | the Dispatches holding slots, and `pod check --wait` |
| `launch_unknown` | 4 | Orca returned `outcome_unknown` or the reply was lost | the same command with the same `--op-key`, then `pod check` |
| `duplicate_op` | 3 | an op key returns with a different intent | a new op key with `retry_of` |
| `receipt_stale_sha` | 3 | a verdict's Head SHA is not the current candidate SHA, or the deployed revision does not match | the current candidate SHA, and a request for a new review |
| `receipt_no_deploy` | 3 | `pod hqa record` runs for `hqa_after_deploy` and the Run has no deploy event | `pod deploy record story:<id> --generation N` with the deploy event fields |
| `deploy_revision_mismatch` | 3 | a deploy line's `deployed_revision` differs from its `source_commit`, or is neither the Run's candidate SHA nor a commit with the candidate's tree | both SHAs and the Run, and a fetch of both commits into the checkout that runs the verb |
| `deploy_not_waiting` | 3 | `pod deploy record` finds no `ready` `external_action` Task, and the line does not replay the Task's recorded deploy | `pod state story:<id>` |
| `receipt_unverified_source` | 3 | the source is not an accepted human source, the content hash differs, readback failed, or this host has no passing bypass test | the gate id, a note that the Gate stays waiting, and after a failed bypass test the remedy that "Trust boundary and the bypass test" names |
| `receipt_keeper_is_decision_seat` | 3 | a verdict's reviewer is the Seat of a decider or auditor Dispatch of the Run | the Seat, its role, and the Dispatch id |
| `reserved_deny` | 3 | the Decision category or content hits a deny class | none beyond the recorded event |
| `reserved_needs_human` | 3 | the Decision hits a needs-human class, or a needs-existing-authorization class that the Story does not authorize | the brief line, and the tracker comment that awaits the human gatekeeper |
| `decision_budget_exhausted` | 3 | wall clock, relaunches, tool calls, or context tokens run out | the spent budget, and the needs-human item |
| `drained` | 5 | a verb would start a Dispatch while a drain is in force | `pod check` and `pod release`, which still run |
| `orca_version_unsupported` | 3 | the installed Orca version is outside the adapter's range | the supported range and the installed version |
| `identity_missing` | 3 | a `pod config` write finds no `POD_SEAT`, no recorded Seat terminal, and no `operator` in the host profile; or a terminal-less worker, a launch in flight, or an unresolved `unknown_launch` worker on this host could be the caller; or the operator is not a principal of the active global policy | `operator: <principal>` in the host profile, `POD_SEAT` for an agent Seat, and the unresolved Dispatch ids or op keys |
| `activation_needs_person` | 3 | an agent Seat passes `--activate` to `pod config apply` or `pod config set` | the same write without `--activate`, and the activation run by a person from the operator's shell |

Spec clarification: TPC-1478. `identity_missing` and `activation_needs_person` fire before any write, so a refused call stores no Revision. The operator check reads the active global policy's `principals`; when no global policy is active or it lists none, the check passes, so a fresh install can apply its first policy.

#### Op keys

Every side-effect verb takes `--op-key` or derives one from the intent, the Run, the Task, the Seat, and the attempt number. The intent is one of a closed list, which is `run_create`, `project`, `dispatch`, `retry`, `decide_seat`, `decide`, `config_apply`, `verdict`, `hqa`, `release`, `takeover`, `drain`, `learning`, and `close`. Spec clarification: S18a. `close` is one keyed step of `pod run close`, keyed `derivedOpKey("close", { run, step })` with no attempt number, so a re-run converges on the same rows. Spec clarification: S18b. The steps run in order `archive`, `learnings`, `escalate`, `status`, `comment`, `done`. Spec clarification: S18c. The steps run in order `archive`, `learnings`, `escalate`, `worktree`, `branches`, `status`, `comment`, `done`. `worktree` and `branches` are effect steps: the step's operation row is inserted pending in one transaction, the external effect runs outside any transaction, and a second transaction moves the row `done`; each transaction checks the owner generation, and a stale one refuses `owner_generation_stale` with the row left pending. A pending effect step runs its effect again on the next close, which treats an absent worktree or ref as already removed. The `branches` step writes each finished branch outcome to its pending row as `partial` before the next branch, and a re-run reuses a recorded outcome. The `learnings` step writes through `learning add`'s keyed write, `learningOpKey`, in its own transaction, so a re-run adds no row. The `status` and `comment` steps enqueue one `ledger.outbox` row each, keyed by the step, drain the outbox, and are `done` only when the row is acked; the `comment` row is acked only after a readback finds its body hash. A row not acked refuses `tracker_unconfirmed` and leaves the Run as it is; the next close drains it again and never enqueues a second row. `run_create` is the Orca Run creation inside `pod run create`. `project` is one Task projection through `task-create`, inside `pod run create` or `pod check`. `decide` is the Decision request itself. `db migrate` records no operation row, because Drizzle's applied-migrations table is its own record. `dispatch`, `retry`, and `decide_seat` are the three launch intents, and each one calls `worker-start` exactly once. `pod decide` records one `decide_seat` operation for each Decision Seat launch.

The verb inserts a `ledger.operation` row with status `pending` before it calls Orca or the tracker. The same key returns the recorded result, or it reconciles when the status is `unknown`. A retry is a new key with `retry_of`. A content hash is a fingerprint only and never stands in for an op key.

#### Owner generation

`pod run create` sets `owner_generation` to 1 and returns it in `meta`. `pod takeover` increments it. Every side effect checks the caller's `--generation` against the row before the external call, in the same transaction that records the operation. This guard covers dispatch, ack, Gate, sync, release, and Decision write-back. A direct runtime launch on a Pod-managed Run is a contract violation, and `docs/contract.md` states that. `pod check` compares the runtime's worker list for the Run, read through `workerList`, against `ledger.dispatch`. It records an `unknown_launch` event for every worker the ledger does not know and moves the Run to `hold`, which sends every open Task to `hold` and blocks new Dispatches until the operator reconciles. A same-terminal follow-up, a worker whose `agentTerminalHandle` is the terminal of a known Dispatch of the Run and whose `followUpOf` is absent or names that Dispatch, is recorded as `unknown_launch` with `follow_up_of`, stopped with `worker-stop`, and its messages are recorded as `ignored` with reason `follow_up`; it does not hold the Run.

A cancel comes from the tracker. `pod check` reads the Story on every run, and a tracker Canceled records a `cancel` event, which blocks new Dispatches on that Run at once and sends every open Task to `hold`. No Pod verb cancels a Story. An emergency stop is `worker-stop`, which `pod check` then reconciles.

#### Manifest, views, and budgets

Each Dispatch lineage and each Decision lineage has one Evidence manifest. Every reference in it carries its source, its revision, its observed time, and its coverage. Transcripts never enter a manifest. A transcript locator may enter a table; transcript content never does, and a retro packet that names a locator is a prompt input, never a manifest entry.

| View | Word budget |
| --- | --- |
| task view | 2k words |
| state view | 3k words |

A view over its budget is marked `truncated` and lists routing lines for deeper reads, such as `pod state --decisions`, a docs section reference, or an ADR path. Trimming follows these rules.

- Policies in force, Reserved categories, and applicable Decisions are never trimmed.
- The roadmap trims only non-current milestones.
- Only expired Decisions are trimmed.
- A retry task view carries `git status` first.

Every `pod dispatch` records the id of the manifest it used in `ledger.dispatch.manifest_id`. Regenerating a manifest from the same sources gives the same id, so a reader can rebuild the exact view a Seat saw.

`pod state` renders the state view in seven sections.

| State view section | Rule |
| --- | --- |
| roadmap | trims only non-current milestones |
| active Runs and waiting-on | each Run with its state and what it waits on |
| policies in force and Reserved categories | never trimmed |
| applicable Decisions | never trimmed. A Decision older than 30 days that is still in force appears, and an expired one does not |
| usage coverage | usage with no source shows `unknown` with its coverage, never zero |
| open needs-human items | each with its Decision id or Gate id and its reason |
| learnings | adopted learnings for the Story's project |

Each section carries `source_revision` and `observed_at`. `pod brief` renders the same JSON as one self-contained HTML file.

### Runtime adapter boundary and fixture replay

`OrcaPort` is a TypeScript interface in `src/core/ports/orca.ts`. It has one method per Orca verb Pod uses.

```ts
interface OrcaPort {
  version(): Promise<OrcaVersion>
  runCreate(req: RunCreateRequest): Promise<Receipt<RunCreateResult>>
  runUse(req: RunUseRequest): Promise<Receipt<RunUseResult>>
  taskCreate(req: TaskCreateRequest): Promise<Receipt<TaskCreateResult>>
  workerStart(req: WorkerStartRequest): Promise<Receipt<WorkerStartResult>>
  workerStop(req: WorkerStopRequest): Promise<Receipt<WorkerStopResult>>
  workerRelease(req: WorkerReleaseRequest): Promise<Receipt<WorkerReleaseResult>>
  check(req: CheckRequest): Promise<Receipt<CheckResult>>      // includes ack
  send(req: SendRequest): Promise<Receipt<SendResult>>
  requestShow(req: RequestShowRequest): Promise<Receipt<RequestShowResult>>
  workerList(req: WorkerListRequest): Promise<Receipt<WorkerListResult>>
}

interface Receipt<T> {
  verb: string
  exitCode: number
  result: T | null
  raw: unknown            // every field zod did not name, kept
  orcaVersion: string
}
```

Spec clarification: S18c. `OrcaPort` also has `worktreeRemove(req: { worktree, force })`, which runs `orca worktree rm --worktree <selector> [--force] --json` with no `--full`, never `--delete-branch` or `--run-hooks`, and is recorded, scrubbed, and replayed like the other methods; exit 0 with `result.removed` true, or an error code `selector_not_found`, counts as removed. `workerList` reads the runtime's workers for one Run through `worker-list`, which the Orca 1.4.211 help lists. Each method takes a typed request and returns a typed receipt that zod parses from `--json` stdout. Unknown fields go to `raw` and are never dropped. The adapter never parses human text output.

#### The real adapter

The real adapter spawns `orca orchestration <verb> ... --json --full`. From Orca 1.4.246, `--json` prints a concise view, and `--full` restores the full record the schemas parse. `orca terminal show` takes no `--full`. For each call it records a receipt `{verb, argv, exitCode, stdout, stderr, startedAt, endedAt, orcaVersion}` into `ledger.event` as a `receipt` event with source `receipt`. In record mode, set by `POD_ORCA_RECORD=<dir>`, it also writes the receipt as a fixture file.

Exit 1 with `outcome_unknown` maps to the `launch_unknown` path. The operation stays `unknown`, the reservation stays held, and `requestShow` is the first reconcile step. Without evidence that rules out a duplicate, Pod does not start again.

#### Orca facts the adapter encodes

Each row comes from the PRD's Orca facts, observed on Orca 1.4.230 in the proof of concept and on the 1.4.211 help text.

| Orca fact | What the adapter does |
| --- | --- |
| A start receipt on a reused `--terminal` has null `launch.requested` and `launch.effective` | start every Dispatch in a new terminal, and record `model_attribution = 'unknown'` when the receipt has no model |
| A completed Task refuses a new Dispatch with `task_not_startable` | model rework as a new Task in the same lineage |
| After `worker-stop` a Task is `blocked`, not failed, and dependents stay pending | `pod retry` reads the original worktree, agent, and model from `ledger.dispatch` and passes them with `--retry-of` |
| A stopped attempt's heartbeat still reaches the inbox | `pod check` filters deliveries by `payload.dispatchId` and owner generation, and records a mismatch as `ignored` |
| Uncommitted edits stay in a shared worktree after a stop | the retry task view carries `git status` first, and a reviewer uses a detached checkout of the target SHA |
| `send` requires `--subject` and `--body` | `SendRequest` makes both fields required |
| `run-use` is not exclusive, and an old coordinator's `check` still works after a takeover | `pod takeover` refuses until it has evidence that the old coordinator stopped |
| `worker-start` takes `--task/--spec`, `--run`, `--agent`, `--model/--effort`, `--worktree`, `--deps`, `--retry-of`, `--retry-request`, `--json` | `WorkerStartRequest` names exactly these fields |
| A worker Orca starts in a known Dispatch's terminal, such as a follow-up turn on mail the Dispatch had not read, gets its own `dispatchId`; `worker-list` names its terminal as `agentTerminalHandle`, and its messages carry that terminal as `from_handle` | `pod check` matches either against `ledger.dispatch.terminal_handle` in the same Run, records the worker as `unknown_launch` with `follow_up_of`, stops it once under a `stop` op key held on its `stop` event, and records its messages as `ignored` with reason `follow_up` |
| Orca 1.4.211 help lists `request-show`, which asks whether one orchestration mutation already took effect | `requestShow` is the first reconcile step, and its availability per version is an assumption until a fixture records it |

The adapter declares a supported Orca version range and refuses a call outside it with `orca_version_unsupported`. The live range starts at 1.4.246, the first Orca that accepts `--full`; an older Orca rejects the flag with `invalid_argument`. Replay accepts fixtures recorded from 1.4.211, because a recorded `match.argv` without `--full` still matches the live argv as a subsequence.

#### Fixture replay

`ReplayOrca` implements `OrcaPort` over a fixture directory. A fixture file is `fixtures/orca/<scenario>/NNN-<verb>.json`.

```json
{ "verb": "worker-start", "match": { "argv": ["--task", "task_1"] }, "exitCode": 0,
  "stdout": "{...}", "stderr": "", "orcaVersion": "1.4.211", "recordedAt": "2026-10-21T00:00:00Z" }
```

The replayer matches calls in order by verb and by the `match` subset of argv. An unmatched call, an extra call, or a missing call fails the test and prints the diff. Unit tests never call a live Orca.

A test names its scenario directory through `POD_ORCA_FIXTURES=<dir>`. The test file for a scenario is `test/replay/<scenario>.test.ts`.

The first fixtures come from re-recording the proof-of-concept scenarios the PRD names.

| Scenario | What it proves |
| --- | --- |
| `lost-launch-reply` | the same op key returns the existing result or stops with the reservation held, and the recorded calls show no second `worker-start` |
| `two-coordinator-handoff` | the old coordinator's dispatch, ack, verdict, and release are refused before the side effect |
| `stale-dispatch-id` | a delivery with a stale `dispatchId` or owner generation is recorded as `ignored` and moves no state |
| `capacity-1` | a blocking Decision obtains both Seats in sequence, and the waiting Task releases its slot |
| `drain` | no new Dispatch starts, Decision Seats included, while `check`, `release`, and reconcile still run |
| `direct-launch` | a worker the ledger does not know records `unknown_launch` and the Run goes to `hold`. S7 records it. Spec clarification: TPC-1511. A same-terminal follow-up of a known Dispatch records `unknown_launch` with `follow_up_of`, is stopped, has every message recorded `ignored` with reason `follow_up`, and does not hold the Run; `follow-up-launch` replays it |

#### Scrubbing

Fixtures are recorded on an operator's real hosts and the repo is public. The scrubber removes hostnames, paths, and user names at record time, and the denylist lint in CI is the guard that keeps an operator's names out of the repo.

A scrubber runs on record. Hostnames become `host-a` and `host-b`. Worktree paths become `/w/<n>`. User names become `user-<n>`. A fixture lint fails CI when any term from a denylist file outside the repo matches. `POD_SCRUB_DENYLIST` names that file, so the denylist itself never enters the repo. CI reads `POD_SCRUB_DENYLIST` from a CI secret, never from the repo.

Fixtures carry `orcaVersion`. Re-recording against a new Orca version is a story task. A receipt schema change surfaces as a zod parse failure in replay.

#### Tracker and docs ports

`TrackerPort` (Linear) and `DocsPort` (Notion) follow the same pattern. The real adapters record HTTP receipts, and tests replay them. Spec clarification: S18c. `CodeHostPort` in `src/core/ports/code-host.ts` reads a PR's state (`open`, `merged`, or `closed`, its head branch and head SHA, and its merge commit) and lists the open PRs for a branch, in a local repository; a read it cannot make returns null. Its real adapter lives under `src/adapters/code-host/` and is the only place that names the provider, and its fixture adapter reads a JSON file that `POD_CODE_HOST_FIXTURES` names. `GitPort` in `src/core/ports/git.ts` reads a worktree's repository, branch, and tip, the remote's default branch, the remote and local tips, and the branches checked out in worktrees, and deletes a local ref or a remote branch only against an expected commit.

```ts
interface TrackerPort {
  readStory(ref: StoryRef): Promise<Receipt<TrackerStory>>
  readComment(ref: CommentRef): Promise<Receipt<TrackerComment>>     // author id, body, edited flag
  postComment(req: PostCommentRequest): Promise<Receipt<CommentRef>>
  setStatus(req: SetStatusRequest): Promise<Receipt<StatusResult>>
  readback(ref: CommentRef | StoryRef): Promise<Receipt<Readback>>
}

interface DocsPort {
  readSection(ref: DocSectionRef): Promise<Receipt<DocSection>>      // read-only, no write method
}
```

`DocsPort` has no write method, so no learning can reach the docs tool through it. A status projection never overwrites a human Canceled. `setStatus` reads the current status first and refuses when the tracker shows Canceled.

#### Trust boundary and the bypass test

A human Gate receipt or a human ruling counts only from an accepted human source. Pod accepts each source below and never narrows the standard to one of them.

| Accepted human source | What Pod verifies |
| --- | --- |
| a tracker comment by the human gatekeeper's own account | `author_id` is the keeper's account, the content hash matches, and readback confirms the comment |
| a comment the relay principal posts | `author_id` is the relay principal, `relayed_by` carries the relay session id, and the content hash matches |
| a tap on a tracker notification from the person's own account | the tracker attributes the action to the person's account, and readback confirms it |
| a code-host PR approval from the person's own account | the approval's author is the person's account, and the approval is on the current candidate SHA |

The relay principal is an independent principal that posts under its own tracker identity. Its token lives only in the human's interactive session, and no dispatched terminal inherits it. The receipt records `relayed_by` with the relay session id and the content hash. The relay passes on only what the person said. It reads no Story or verdict and judges no PASS. Text a worker Seat posts never counts, even when it is identical.

That a worker cannot produce the human's comment is a premise, not a fact. The premise is that a worker cannot reach the human's tracker token, login session, or the relay's token. The bypass test proves it. With worker-equivalent rights on a controlled test Story, an attempt to post as the human gatekeeper and an attempt to post as the relay principal both land only as the worker identity, and the output contains no secret. A second check feeds the relay a Story whose text says PASS, and the relay posts no PASS of its own. S1 ships the test under `test/bypass/`. Each run records a `receipt` event with source `command`, the host, and the result, and the adoption procedure runs it before the first `pod hqa record`.

When the test fails on a host, every human receipt on that host stays waiting, and `pod hqa record` refuses with `receipt_unverified_source`. The remedy is to move the relay principal to a separate OS user or a separate host and run the test again. Pod does not narrow receipts to the person's own tracker account.

Spec clarification: TPC-1478. Pod reads who runs a `pod config` write from identity. A run with `POD_SEAT` set is the agent Seat it names. Otherwise a run whose `ORCA_TERMINAL_HANDLE` the ledger records on this host, as a Dispatch's terminal or a Run's coordinator, is that Seat; Orca 1.4.253 takes no environment flag on `worker-start`, so this lookup is how Pod marks the terminals it starts. Pod records a Dispatch's terminal from the receipt's top-level `terminalHandle`, else from its `effects` entry of kind `terminal` and role `agent`, which is where Orca 1.4.253 reports it. While this host has an unsettled Dispatch with no terminal, or a `dispatch`, `retry`, or `decide_seat` operation still pending or unknown, any other run is refused `identity_missing`, because it cannot be told apart from that worker. Spec clarification: TPC-1511. The same refusal holds while a Run on this host is in `hold` with an `unknown_launch` that has no `follow_up_of` and no later Run `resume`. Only after that is a run the host profile's `operator`. The premise, like the bypass premise above, is that a worker runs in the terminal Pod recorded or is covered by that refusal, does not unset `ORCA_TERMINAL_HANDLE` or `POD_SEAT`, and that a Seat Pod did not start sets `POD_SEAT`. An agent Seat's `--activate` is refused `activation_needs_person`, and the bypass test checks it from a worker terminal, a terminal-less worker, and a launch in flight.

Spec clarification: TPC-1479. A pending `config_activate` request is activated by an accepted human source from the table above, read back by `pod check`. Each pass reads the comments of each ticket that holds a pending request, once per ticket. A request with no ticket, which only a TPC-1413 profile request can have, reads the Run's Story. A comment counts only when all of these hold: its first non-empty line, trimmed, is `config activate <revision-id>` (or the request's `profile <project> <name> <policy ref>` synonym); it was never edited; it passes `verifySource` against the HQA keepers and principals of the active global policy and this host's bypass line, with the confirming comment read; and its id is not already spent. A comment id is spent once it is on an `activation` event's source or on a settled request row. A refused comment leaves the request pending, with a `receipt_unverified_source` next step naming the reason. A counted comment applies once. The activation is recorded as `person:<keeper>`, or `person:relay` for a relayed comment. When no pending request for that revision id expects the Revision active now, every such request is refused with `revision_conflict`. A worker Seat's comment never counts, and an agent Seat cannot run `pod config activate`. A TPC-1413 profile request refused before this rule stored no comment id, so its comment cannot be told apart from a new one. From TPC-1479 on, every refusal stores it.

Spec clarification: TPC-1531. The premise is that the session environment carries no credential, so the environment a Seat inherits is clean. Pod reads the database URL and the tokens from the credentials file, and does not scrub a Seat's environment, because the runtime starts the Seat process. A recorder replaces every credential value the process read, and the password in a URL's userinfo, with `[credential]` before it writes a fixture, and the scope scan fails on such a password. This stops accidental disclosure only. A Seat that runs under the operator's OS account can still read the credentials file. Closing that needs a separate OS account or a broker, and is later work.

### Process spec loading and the selector

A process spec is a YAML file. zod parses it into the process schema.

| Field | Shape |
| --- | --- |
| `kind` | `process` |
| `schema_version` | integer |
| `name` | string |
| `summary` | string |
| `selector` | `{ stage, size[] }` |
| `roles` | list of Role names |
| `steps[]` | `id`, `type` in `worker`, `external_action`, `human_wait`, `role`, `needs[]`, `produces[]`, `gate`, `decision`, `adapter`, `event_fields`, `binds` |
| `edges[]` | `from`, `on` (string or list), `to`, `new_task`, `then` |
| `limits` | `{ attempts_per_task, rework_per_lineage }` |
| `escalation` | `{ to }` |

#### Validation at apply

`pod config apply` refuses a process spec unless every rule below holds.

- Every step is reachable from the first step.
- Every step has an outgoing edge for each outcome its type allows, as the outcome table below lists. A `decision` step may also have a `rework` edge; the edge is not required (Spec clarification: TPC-1530).
- No edge points to an unknown step. `hold` and `done` are reserved edge targets.
- A `FAIL` or `rework` edge targets `hold` or has `new_task: true`.
- A step has `gate` or `decision`, never both. A `decision` step is a `worker` step, and its `cancelled` edge targets `hold`.
- Every Role has an authorized Seat in the active crew.
- The reviewer is independent of the developer.
- Every gate id exists in the active policy.

A policy or crew Revision validates against its own schema only. A process Revision checks its Roles against the active crew at its scope, or against every project's active crew when its scope is global, and its gate ids against the active policy. Policy and crew therefore apply before any process.

| Step type | Allowed outcomes |
| --- | --- |
| `worker` | `done`, `timeout`, `cancel`, `unknown`, with `PASS` and `FAIL` in place of `done` when the step has a `gate`, and with `agreed` and `cancelled` in place of `done` when the step has a `decision`, which may also take `rework` on an optional edge |
| `human_wait` | `PASS`, `FAIL`, `cancel` |
| `external_action` | `done`, `unknown`, `cancel` |

Every allowed outcome needs an edge.

The canonical JSON of the parsed value is hashed into the Revision id. A process spec names no keeper. Policy owns keepers.

#### Reference excerpt

The excerpt below is `specs/process/impl-small.yaml`.

```yaml
kind: process
schema_version: 1
name: impl-small
summary: xs or s impl, one developer, one independent reviewer, one PR
selector: { stage: impl, size: [xs, s] }
roles: [developer, reviewer]   # apply checks the crew fills them and the reviewer is independent
steps:
  - { id: implement, type: worker, role: developer, produces: [commit] }
  - { id: review, type: worker, role: reviewer, needs: [implement], gate: review }
  - { id: pr, type: worker, role: developer, needs: [review], produces: [pr] }
  - { id: merge, type: human_wait, needs: [pr], gate: merge }   # the existing merge authorization
  - id: deploy
    type: external_action
    needs: [merge]
    adapter: deploy
    event_fields: [environment, deployment_id, deployed_revision, source_commit]
  - { id: hqa, type: human_wait, needs: [deploy], gate: hqa_after_deploy, binds: deployed_revision }
edges:   # all explicit, a missing edge refuses the apply
  - { from: implement, on: done, to: review }
  - { from: implement, on: [timeout, cancel, unknown], to: hold }
  - { from: review, on: PASS, to: pr }
  - { from: review, on: FAIL, to: implement, new_task: true, then: review }
  - { from: review, on: [timeout, cancel, unknown], to: hold }
  - { from: pr, on: done, to: merge }
  - { from: pr, on: [timeout, cancel, unknown], to: hold }
  - { from: merge, on: PASS, to: deploy }
  - { from: merge, on: [FAIL, cancel], to: hold }
  - { from: deploy, on: done, to: hqa }
  - { from: deploy, on: [unknown, cancel], to: hold }
  - { from: hqa, on: PASS, to: done }
  - { from: hqa, on: FAIL, to: implement, new_task: true, then: review }
  - { from: hqa, on: cancel, to: hold }
limits: { attempts_per_task: 3, rework_per_lineage: 3 }
escalation: { to: decision-pair }
```

#### The six reference process specs

| Process | Selector | Steps | Human Gate |
| --- | --- | --- | --- |
| `prd@1` | stage prd | draft (writer), audit (auditor), `prd_review` | `prd_review` |
| `design@1` | stage design | design (designer), taste QA (taste reviewer), `design_clickthrough` | `design_clickthrough` |
| `impl-small@1` | stage impl, size xs or s | implement, review, pr, merge, deploy, `hqa_after_deploy` | `hqa_after_deploy` |
| `impl-medium@1` | stage impl, size m | plan (planner), plan review (Decision pair, automated Gate), implement, story QA (qa), pr, merge, deploy, `hqa_after_deploy` | `hqa_after_deploy` |
| `impl-large@1` | stage impl, size l | plan (planner), plan review (Decision pair, automated Gate) in place of a tech review, implement (several Tasks), review per Task, review of the integrated candidate SHA, pr, merge, deploy, `hqa_after_deploy` | `hqa_after_deploy` |
| `impl-xlarge@1` | stage impl, size xl | the same steps as `impl-large@1`, driven by the coordinator pair. Its plan review is a Decision round of the pair, and the `agreed` outcome advances the plan step with no Gate receipt | `hqa_after_deploy` |

A Story of size xs or s has no plan step. In `impl-medium@1` and `impl-large@1` the plan review is an automated Gate kept by the Decision pair, and a PASS Gate receipt advances the plan step. In `impl-xlarge@1` the plan step is a `worker` step for the planner with `decision: plan` and no `gate`. The planner's delivery moves its Task to `delivered` and opens a `pod decide` request whose scope is the plan Revision. The verified outcome of the step is the `decision` event with outcome `agreed` bound to that plan Revision, and a delivery alone never advances it. The projector, the dependency rule, and the Task transition table under "Task states" all wait for that event. `story-full@1`, which chains and splits across stages, is phase 2.

#### Selector

The selector is a pure function in `core/process`.

```ts
type Size = 'xs' | 's' | 'm' | 'l' | 'xl'

function selectProcess(input: {
  stage: string
  size: Size
  kickoffLine: ProcessRef | null
  cliProcess: ProcessRef | null
  activations: readonly ActiveProcess[]
}): { ok: true, revisionId: RevisionId } | { ok: false, code: SelectorErrorCode }
```

v1 fixes the tracker convention for the selector inputs. The stage is a tracker label, the size is mapped from the tracker's estimate field, and the process override is a `Kickoff:` line in the Story description. `TrackerStory` carries those three fields. The Linear adapter accepts both a numeric estimate (1, 2, 3, 5, 8 map to xs, s, m, l, xl) and Linear's T-shirt estimate scale, so an adopter's team switches scale without a Pod change.

```ts
interface TrackerStory {
  ref: StoryRef
  stageLabel: string | null        // the stage tracker label
  size: Size | null                // mapped from the tracker's estimate
  kickoffLine: ProcessRef | null   // the `Kickoff:` line in the description
  status: string
}
```

Profile-level field mapping is phase 2. Pod refuses a Story that lacks the stage label or the size with `selector_none`, and `nextSteps` names the missing field.

It applies four precedence rules in order.

| Rule | Condition | Result |
| --- | --- | --- |
| 1 | `--process` and the Story's `Kickoff:` line are both present and differ | refuse with `selector_conflict` |
| 2 | one of them names a Revision | check that Revision's selector against stage and size only. A named Revision needs no activation. Refuse with `selector_conflict` when the selector does not apply, and with `selector_none` when no Revision has that `kind.name@rev` |
| 3 | neither is present | match the project activations, then the global activations, by selector. Zero matches refuse with `selector_none`, several refuse with `selector_many` |
| 4 | any case | no override changes the effective gate map. Gates come only from policy |

When `--process` and the `Kickoff:` line name the same Revision, rule 2 applies. Under rule 3, zero project matches fall through to the global activations before a refusal.

A table-driven test enumerates stage, size, `Kickoff:` line, and `--process` offline. Each combination yields exactly one Revision or one refusal code.

#### Projector

The projector is a scribe, not a judge. It turns each step into an Orca Task through `taskCreate`, with `deps` from the step's `needs`. The edge table drives transitions on verified outcomes, and a Gate receipt is the verified outcome for a gated step. A completed Orca Task is never a PASS.

- `new_task: true` creates a Task in the same lineage and counts it against `rework_per_lineage`. At the limit, the lineage goes to `hold`.
- A FAIL edge either creates a rework Task (`new_task: true`) or sends the Task to `hold`. The edge decides, and the Task table follows it.
- A `human_wait` step starts no worker.
- An `external_action` step waits for its event with the listed `event_fields`.
- A step with no Gate and no `decision` treats its recorded delivery as outcome `done`.
- A step with a `decision` treats the `decision` event with outcome `agreed` and effect `accept_plan` bound to its plan Revision as its verified outcome. The projector opens that Decision with `accept_plan` when the Task reaches `delivered`. Its recorded delivery moves the Task to `delivered` and fires no edge. A `cancelled` outcome fires the `cancelled` edge to `hold`.
- Each projection carries its own op key, so replaying an event creates no Task twice.
- `needs` sets the Orca `deps` of each projected Task. Edges decide which step the projector creates next. A downstream Task is created only when its edge fires, and its `deps` name the Tasks that must be `passed`.

#### Task states

`core/domain` models the Task as a typed state machine and refuses any transition the table below does not list.

```ts
type TaskState = 'pending' | 'ready' | 'dispatched' | 'delivered' | 'passed' | 'failed' | 'blocked' | 'hold' | 'done' | 'superseded'
```

A dependency is satisfied when it is `passed`, or `done`, which a Task reaches only through `passed`. `passed` means a PASS Gate receipt for a gated step, the `accept_plan` `decision` event with outcome `agreed` bound to the plan Revision for a step with a `decision`, or a recorded delivery with outcome `done` that matches the Dispatch and the owner generation for a step with neither. A delivery never satisfies a dependency on a step with a `gate` or a `decision`. An ungated `external_action` step has no Dispatch, so its recorded event with outcome `done` stands in for the delivery. `failed` and `superseded` never satisfy `deps`. The `dispatch` evidence row and `task_not_ready` use this definition.

| From | To | Trigger |
| --- | --- | --- |
| `pending` | `ready` | every Task in `deps` is satisfied |
| `ready` | `dispatched` | `pod dispatch` records a start event for a worker step |
| `ready` | `delivered` | `pod deploy record` appends the `external_action` deploy event, or a `human_wait` Gate receipt arrives |
| `dispatched` | `delivered` | `pod check` records a delivery that matches the Dispatch and the owner generation |
| `dispatched` | `blocked` | Orca reports the Task `blocked` after `worker-stop` |
| `blocked` | `dispatched` | `pod retry` starts a new Dispatch with `retry_of` |
| `delivered` | `passed` | a PASS Gate receipt for a gated step, the `decision` event with outcome `agreed` and effect `accept_plan` bound to the plan Revision for a step with a `decision`, or the matching delivery for a step with neither |
| `delivered` | `hold` | a `cancelled` Decision outcome on a step with a `decision`. The operator resumes after reconcile |
| `delivered` | `failed` | a FAIL Gate receipt whose edge has `new_task: true` |
| `delivered` | `hold` | a FAIL Gate receipt whose edge targets `hold`. The receipt stays recorded, and the operator resumes after reconcile |
| `passed` | `done` | the projector records the outgoing edge |
| `failed` | `failed` | none. A failed Task is terminal. The rework Task in the same lineage replaces it, and the projector repoints the dependents' `deps` to the rework Task |
| any state except `done`, `failed`, and `superseded` | `hold` | a `timeout`, `cancel`, or `unknown` outcome, a cancel event, or a lineage at its rework limit |
| `hold` | `ready` | the operator resumes after reconcile with `pod check --resume`, with no automatic retry |
| `pending`, `ready`, or `hold` | `superseded` | a `change_spec` Decision outcome applies a new Task spec Revision, and the replacement Task inherits the dependents |
| `dispatched` or `delivered` | `superseded` | a `change_spec` Decision outcome applies a new Task spec Revision to the escalating Task, or a new plan Revision to a `decision: plan` Task. Pod stops its Dispatch first, so the worker never resumes on the old spec. An `accept_plan` outcome never supersedes |

When the outcome of a `change_spec` Decision applies a new Task spec Revision to a Task whose Dispatch is `waiting` on that Decision, Pod runs `worker-stop` on that Dispatch, records its settlement as `superseded` with `activity` `settled`, moves the Task to `superseded`, and creates the replacement Task `ready` in the same lineage with the new Revision. The replacement's task view carries the worktree's `git status`, because the stopped worker's uncommitted edits stay in the worktree. `pod retry` refuses a Dispatch whose Task is `superseded` with `task_not_ready`.

`superseded` is terminal and never satisfies `deps`. A replacement Task for a `superseded` Task does not count against `rework_per_lineage`.

A `human_wait` or `external_action` step has no Dispatch, so its readiness rule is the same `deps` rule, checked by `pod check` before it records the delivery.

### The decision layer seats

The decider and the auditor are Roles in the crew Revision. They share the host quota with worker Seats and start in sequence, so capacity 1 never deadlocks. There is no quota table. The quota is the host profile's `capacity` minus the slots in use. A slot is in use for each Dispatch on the host with `activity` `running`, worker and Decision Seats counted alike, and for each `ledger.operation` row with a launch intent (`dispatch`, `retry`, or `decide_seat`) and status `pending` or `unknown`, which is a reservation. When the start receipt arrives, the same transaction sets the operation to `done` and inserts the Dispatch row with `activity` `running`, so the slot moves from the reservation to the Dispatch and is never counted twice. An operation left `unknown` keeps its slot until `pod check` reconciles it through `requestShow` or the worker list. S3 may add a table if the count proves too slow.

A Dispatch is `waiting` when its Seat has delivered and waits on a message. That covers a worker blocked on `pod decide` and a Decision Seat between rounds. A `waiting` Dispatch holds no slot. A Dispatch is `settled` once its settlement is recorded. `pod check` and `pod decide` record each `activity` change.

At capacity 1 a blocking Decision runs in four steps.

1. The worker escalates through `pod decide` and goes `waiting`, which frees the slot.
2. The decider starts in the free slot, proposes, and goes `waiting`.
3. The auditor starts in the free slot, audits, and goes `waiting`.
4. Round 2 wakes one Seat at a time, and each Seat goes `waiting` again before the other wakes. The worker's Dispatch is stopped once the outcome applies a new Task spec Revision, and the replacement Task takes the next free slot through `pod dispatch`.

#### Coordinator pair for xl

For an xl Run the decider Seat is the Run's coordinator. It runs the `pod` verbs for the Run and holds the owner generation. The auditor Seat is resident from Run start and audits the plan, each Task's result, and the integrated candidate SHA. Escalations inside the Run use the same pair, and no further Decision Seats open. The pair's audits are Decision rounds, not Gate receipts. The plan review in `impl-xlarge@1` is therefore a Decision round of the pair, and its `agreed` outcome advances the plan step. The plan step carries `decision: plan`, its Decision carries effect `accept_plan`, its evidence is the `decision` event with outcome `agreed` bound to the plan Revision, no Gate receipt is written for it, and the planner's delivery alone leaves the Task `delivered`, as "Task states" describes. Each Task's PR review stays with an independent reviewer Seat, and the human Gates stay with the human gatekeeper.

`pod run create` for an xl Story opens both Dispatches at Run start, in sequence, and records each launch as a `decide_seat` operation. It records the decider Dispatch id as the Run's coordinator in `ledger.run.coordinator`. The decider's session passes `--generation` like any coordinator. `pod takeover` treats the decider Dispatch as the old coordinator. It requires evidence that the decider Dispatch stopped, increments the owner generation, and opens a new decider Dispatch as the new coordinator with the restore view. The resident auditor keeps its Dispatch across a takeover.

Capacity 1 does not deadlock, because a waiting Seat holds no slot and the coordinator's slot passes to the worker before any external call. When the coordinator runs `pod dispatch`, one transaction marks the coordinator Dispatch `waiting` on the new Task and writes the launch reservation. The free-slot precondition of `dispatch` counts the coordinator's slot as released by that transaction, so the reservation takes the slot the coordinator held. Only then does Pod call `worker-start`. When the launch fails, the reconcile path that releases the reservation returns the coordinator Dispatch to `running` in the same transaction. The auditor wake in step 3 follows the same order. The transaction that marks the delivering Seat `waiting` writes the auditor's wake message, and the auditor's slot is counted from that transaction. At capacity 1 an xl Run moves in four steps.

1. The coordinator runs `pod dispatch`. One transaction marks the coordinator Dispatch `waiting` and reserves the slot for the worker, and the worker then starts in that slot.
2. The worker runs in the slot, delivers, and goes `waiting` or settles, which frees the slot.
3. The auditor wakes in the free slot in the same transaction that recorded the worker's delivery, audits the result, and goes `waiting`.
4. The coordinator wakes in the free slot to act on the audit.

Spec clarification: S15b. The auditor wake on delivery in step 3 is deferred to the per-Task audit ticket, which S14 dogfood decides; until it lands, the worker's delivery leaves the auditor `waiting` with no wake message.

Sizes other than xl keep the Decision Seats opened on first need, as "What `pod decide` does" describes.

Spec clarification: S15a. `ledger.run.coordinator_dispatch_id` names the decider Dispatch of an xl Run; `ledger.run.coordinator` keeps that Dispatch's terminal handle, and the column is null on every other Run.

Spec clarification: S15a. The terminal that ran `pod run create` is recorded as `created_by` on the `run_create` operation, not as the coordinator.

Spec clarification: S15a. When the decider or the auditor cannot be opened at Run start, the Run is created in `hold` with `coordinator_dispatch_id` null and the refusal in the output.

#### What `pod decide` does

1. Read the policy's Reserved table first, with the classes deny, needs_human, and needs_existing_authorization, whose members "Policy schema" lists. Cross-check the category against the content and the scope, so a spend question relabeled `tradeoff` still hits the check.
2. Pin an Evidence manifest from the local evidence, the state view, and the applicable Decisions.
3. For sizes other than xl, open the Run's decider Dispatch and auditor Dispatch on first need, usually at plan review, and reuse them after that. On an xl Run both are open from Run start, as "Coordinator pair for xl" describes. `ledger.dispatch` records both with Role `decider` or `auditor`. Both close with the Run, and a Seat reopens only on failure or recovery.
4. Send round 1 through `send` with the manifest reference.
5. Run the round state machine. Rounds 2 and 3 are `send` messages that carry only the audit comments and the points of disagreement, never the manifest again.
6. Record a `decision` event. An agreed outcome takes the effect the request named. `change_spec` applies a new Task spec Revision bound to the Run, as "Config tables" describes. `accept_plan` applies no Revision and passes the plan Task, as "Decision effects" describes.

A Decision authorizes the next step only. `pod verdict post` and `pod hqa record` refuse a Decision outcome as a PASS. A scope or spec change creates a new Revision and makes the earlier review stale.

#### Decision effects

Every Decision request names its `effect`, and `ledger.decision.effect` records it. There are two.

| Effect | Who requests it | What `agreed` does |
| --- | --- | --- |
| `accept_plan` | the projector, when a `decision: plan` step's Task is `delivered` | records the `decision` event bound to the plan Revision, and the plan Task moves `delivered` to `passed`. No Task spec Revision is applied and no Task is superseded |
| `change_spec` | a worker through `pod decide`, the lead, or the claim authority | applies a new Task spec Revision bound to the Run, and the affected Task moves to `superseded` with a replacement created, as "Task states" describes |

A Decision on a `decision: plan` step carries `accept_plan`, and `effect` never changes. When the pair proposes a plan change inside an `accept_plan` Decision, that Decision ends `superseded`, with `by` set to a new `change_spec` Decision that the coordinator opens on the same Run through `pod decide --effect change_spec`, carrying the proposed plan Revision. The new Decision cites the old id in `supersedes_decision_id` and runs its own rounds on the lineage budget, as "Budgets" describes. On `agreed` it applies the new plan Revision and supersedes the plan Task through the `change_spec` path, and the projector creates the replacement plan Task `delivered` on the new plan Revision and opens a new `accept_plan` Decision for it. The `accept_plan` Decision itself never supersedes a Task. `pod decide` refuses `accept_plan` for a Task whose step has no `decision`, and refuses `change_spec` from the projector, both with `usage`.

Spec clarification: TPC-1530. A plan change the pair agrees on travels inside the `accept_plan` Decision, and this replaces the coordinator-opened supersede chain above for that case. A `decision_proposal` payload may carry `plan`, `accept` or `rework`, and `changes`, a list of strings: `rework` names at least one change and `accept` names none, and a proposal that breaks either rule is ignored as `malformed_decision`. A proposal with no `plan` counts as `accept`, and `pod check` adds the nextStep `Decision <id> round <n>: proposal names no plan field; read it before pod dispatch` when it records one on an `accept_plan` Decision. The auditor sees `plan` and `changes` with the proposal, so an `agree` agrees to the changes too. Only an `accept_plan` Decision reads the fields; a `change_spec` Decision ignores them. On `agreed` with `plan: rework` the Decision settles `agreed` with `plan` and `changes` in its outcome, and the plan Task settles with the outcome `rework`: it moves `delivered` to `failed`, and the step's `rework` edge, `{ from: plan, on: rework, to: plan, new_task: true }`, creates a new plan Task in the same lineage with `rework_of` the old one, counted against `rework_per_lineage`, and points the implement Task's deps at it. Implement stays `pending`. The Orca task spec of the new plan Task ends with `Agreed plan change from Decision <id>: <proposal>` and a `Changes:` list. Pod creates it in the `pod check` pass that settles the Decision, after the settle transaction, under the project op key derived from the old plan Task, so a pass that stops between the two writes creates it on the next pass. Its delivery opens a new `accept_plan` Decision as any plan delivery does, and the brief counts the first Decision `reworked`. On a step with no `rework` edge, an agreed `plan: rework` holds the plan Task with hold reason `no_rework_edge` and creates no Task; the Task stays open to `pod decide --effect change_spec --supersedes` or to `pod check --resume` and a new `accept_plan` Decision, and every `pod check` pass while it holds adds the nextStep `Decision <id> agreed a plan rework; step <step> has no rework edge; Task <task> is on hold; change it with pod decide --effect change_spec --supersedes`. `change_spec --supersedes` stays for a change the coordinator finds itself.

#### Round protocol

The decider proposes and must cite the manifest. A proposal without citations is an automatic disagree. The auditor lists constraints and verification results first, then audits the proposal, checks citations, and looks for counterexamples. The auditor answers agree, disagree with reasons, escalate, or needs_evidence. The auditor never proposes.

#### Decision states

```ts
type DecisionState =
  | { kind: 'requested' }
  | { kind: 'reserved_denied' }
  | { kind: 'reserved_needs_human' }
  | { kind: 'round', n: 1 | 2 | 3 }
  | { kind: 'awaiting_evidence', n: 1 | 2 | 3 }
  | { kind: 'agreed' }
  | { kind: 'needs_human', reason: 'policy-required' | 'disagreement' | 'context-missing' | 'runtime-failure' }
  | { kind: 'cancelled' }
  | { kind: 'superseded', by: DecisionId }
```

| From | Event | To |
| --- | --- | --- |
| `requested` | Reserved deny hit | `reserved_denied`, a Decision event is recorded, with no loop and no wait for the human |
| `requested` | Reserved needs_human hit | `reserved_needs_human`, then `needs_human` with reason `policy-required`, with no rounds spent |
| `requested` | Reserved needs_existing_authorization hit, and the Story or an infrastructure Story authorizes it | `round(1)` |
| `requested` | Reserved needs_existing_authorization hit, and nothing authorizes it | `needs_human` with reason `policy-required` |
| `requested` | no Reserved hit | `round(1)` |
| `round(n)` | both agree | dependencies re-checked, then `agreed`, and the outcome applies by its `effect` as "Decision effects" describes |
| `round(n)` or `awaiting_evidence(n)` | the coordinator opens a `change_spec` Decision with `--supersedes` on an open `accept_plan` Decision | `superseded`, with `by` the new `change_spec` Decision the coordinator opens, and no rounds spent on the old Decision after that |
| `round(n)` | both agree, but a dependency's source Revision changed | `needs_human` with reason `context-missing`, and the outcome is not executable |
| `round(n)` | one side escalates | affected actions stop first, the other side evaluates, and continued disagreement counts as a round |
| `round(n)` | auditor answers needs_evidence | `awaiting_evidence(n)`, which is not a round and counts against `tool_calls` |
| `awaiting_evidence(n)` | the evidence joins a child manifest whose `parent_id` is the current manifest | `round(n)`, and the next round cites the child manifest |
| `round(n)`, n below 3 | disagree | `round(n+1)` |
| `round(3)` | disagree | `needs_human` with reason `disagreement`, carrying both final positions and the points of disagreement |
| any open state | deadline, missing data, or an identity Pod cannot verify | `needs_human` with reason `runtime-failure` or `context-missing`, with no rounds spent |
| any open state | budget exhausted | `needs_human` with reason `runtime-failure` |
| any open state | cancel by the escalating actor or the human | `cancelled`, the affected Task goes to `hold`, with no automatic reopen |
| `round(n)` or `awaiting_evidence(n)` | Seat failure or coordinator interruption | `needs_human` with reason `runtime-failure`, with no round spent |
| `needs_human` with reason `runtime-failure` | a source-verified human ruling that says resume, within the `relaunches` budget, after the owner generation check | `round(n)` for the interrupted round, with the same Decision id, rounds, and manifest, and the failed Seat's Dispatch reopened with a summary of earlier positions |
| `needs_human` with reason `runtime-failure` | a resume ruling when `relaunches` is spent | Pod refuses the ruling with `decision_budget_exhausted`, and the Decision stays `needs_human` |
| `needs_human` | a human ruling comment that passes source verification and readback | `agreed` or `cancelled`, as the ruling says |
| `agreed` | a later Decision cites this id | `superseded`, with `by` that Decision |

The human ruling authorizes recovery from a Seat failure, and Pod never relaunches a Decision Seat on its own. A resume ruling reopens the failed Seat's Dispatch with a summary of earlier positions, and the relaunch counts against `relaunches`. The only exits from `needs_human` are a human ruling that resumes, decides, or cancels.

Spec clarification: S13b. A human ruling is a comment on the Run's Story whose first line is `decision <id> resume`, `decision <id> agreed`, or `decision <id> cancelled`, with an optional note on the following lines, by a keeper of any HQA Gate in the pinned policy, verified as an HQA verdict is. `pod decide ruling <id> <verb> [--note TEXT]` prints that text and posts nothing, because the keeper's own account authors it. Each `pod check` pass reads the rulings of the Run's `needs_human` Decisions, newest comment first, and applies the first verified one once; two verified rulings for one id that disagree apply neither. `pod decide cancel <id>` cancels an open Decision for the escalating actor. The auditor's `escalate` counts as a disagree. A dependency's source Revision is a crew, process, or policy Revision that `pod decide` pinned in the root manifest, against the Run snapshot, and the Task's `spec_revision_id` pinned in the root manifest's `task` reference against the Task's current one; references an evidence exchange adds are evidence, not dependencies. A resume ruling is refused with `decision_budget_exhausted` when the relaunches are spent or any other budget field is exhausted. Superseding an agreed `change_spec` Decision refuses its pending supersede operation, and only an `agreed` Decision's operation applies. The coordinator or the lead reads the audit and runs `pod decide --effect change_spec --supersedes <id>`; v1 has no automatic detection of a plan change. Each owed Decision send is a pending `decide` operation written with the state move, and every `pod check` pass sends the Run's pending ones once and marks each done after Orca accepts it.

Spec clarification: S13c. `test/replay/decision-states.test.ts` proves each row of the table above through the CLI with hand-built Seat messages, one test per row. Four rows are proved as the ledger reaches them. Row 8: the Run snapshot is written once at `pod run create` and a Task's `spec_revision_id` once at Task insert, so no verb changes a pinned crew, process, or policy Revision under an open Decision, and a `pod config apply --activate` between rounds leaves the Decision on its pinned snapshot; the scenario proves that, then proves the dependency re-check on a Task spec Revision the test sets on the ledger. Row 9: the auditor's `escalate` is proved as S13b shipped it, a disagree that counts against the round bound; no action stops first. Row 14: the deadline is the `wall_clock` budget, proved by a pass past `created_at + wall_clock`; missing data and an identity Pod cannot verify have no event in `src/core/decide/table.ts`, because a stale or unverifiable Seat message is ignored as `out_of_turn` or `malformed_decision` and settles nothing. Row 17: a Seat failure is a Decision Seat launch Orca refuses with `failed` or `quota_exhausted` after any fallback Seat; a coordinator interruption has no event of its own.

#### Budgets

The budget lives on the `ledger.decision` row. It has four fields, which are wall clock, relaunches, tool calls, and context tokens. `spent` decrements the remaining budget across relaunches and never resets. An injected timeout and relaunch keep the lineage budget. A Decision that supersedes another through `supersedes_decision_id` is in the same lineage and inherits its remaining budget.

Spec clarification: S13a. Each `pod check` pass writes `spent.wall_clock` as the seconds since the Decision's `created_at`, on every open Decision of the Run before it reads deliveries, and a field whose `spent` exceeds `limits.decision_budget` moves the Decision to `needs_human` with reason `runtime-failure`, the field named as `budget_exhausted` in the `decision` event, with no round spent. `relaunches` and `tool_calls` count from S13b. `context_tokens` is not observable, so it stays 0 and never exhausts.

#### Escalation threshold

Only four cases open the loop. They are a change beyond the Story's scope, an effect on another Story, a new dependency, and a choice between two architectures. The policy's `escalate_when` lists them. A process step can narrow the list and never widen it. Anything else, the developer decides and records as a `self_decision` event with no rounds and no Decision Seats.

#### Role exclusion

The author, proposer, auditor, and gatekeeper of one artifact are distinct Seats. Pod checks this against `ledger.dispatch` and `ledger.gate_receipt` for the same artifact. An auditor Seat that wrote an artifact's audit is not that artifact's Decision auditor. On a violation, Pod refuses with `reviewer_not_independent`.

#### Binding

Binding is `run` only. A project or global change is a recommendation that goes to needs-human. It takes effect only as a policy Revision the human gatekeeper authorizes. A Decision can be overruled, never rewritten. A new Decision cites the old id in `supersedes_decision_id`. A reversal records a new Decision that cites the old id, and the old Decision's `adoption` moves to `reversed` with that id in `adoption_evidence`.

#### Policy schema

The policy is `specs/policy/policy.yaml`, a `kind: policy` Revision. It names each Gate's keeper, the Reserved categories, the profiles, the escalation threshold, and the Decision limits. The excerpt below uses generic keeper names.

```yaml
kind: policy
schema_version: 1
name: default
gates:
  review:              { keeper: reviewer-seat, type: AQA }
  merge:               { keeper: lead, type: AQA }
  prd_review:          { keeper: human-gatekeeper, type: HQA }
  design_clickthrough: { keeper: human-gatekeeper, type: HQA }
  hqa_after_deploy:    { keeper: human-gatekeeper, type: HQA }
  staging_review:      { keeper: human-gatekeeper, type: HQA }
profiles:
  autonomous:   # the human gatekeeper names the project, the gate list, and this policy Revision
    replaces: { prd_review: decision-pair-aqa, design_clickthrough: decision-pair-aqa }
    requires: { policy_revision: <id> }
reserved:
  deny: [live_trading, evidence_tamper, safety_limit_removal]
  needs_human:
    [spend, credentials, data_delete, deploy_production,
     gate_change_running_run, policy_change, driver_or_gatekeeper_change]
  needs_existing_authorization: { repo_create: story_spec, vps_ssh: infrastructure_story }
escalate_when: [scope_exceeds_story, affects_other_story, new_dependency, architecture_choice]
story_status: { done: Done, human_wait: In-review }
limits:
  decision_rounds: 3
  decision_budget: { wall_clock: 2h, relaunches: 2, tool_calls: 40, context_tokens: 60k }
```

Spec clarification: S18b. `story_status` names the tracker statuses `pod run close` moves the Story to: `human_wait` while a human Gate is pending, otherwise `done`. A human Gate is pending when a step of the pinned process names a Gate whose pinned policy type is HQA, the pinned profile does not replace it, and the Run's latest non-voided receipt for it is not `PASS`, as with `hqa_after_deploy` before its PASS. The close never moves the Story past `human_wait`, and never moves an epic. A pinned policy with no `story_status` writes no status. Pod's seed names `Done` and `In-review`; a shop's names arrive as a Revision a person activates. A name the tracker lacks fails the write with `status_unknown`; the close then finishes and prints `story:<id>: the tracker has no status <name>; set it by hand`. A Story a person canceled refuses `story_canceled` and stays on hold.

Spec clarification: S18b. The closing comment is posted once through the outbox, signed by the S16a identity, one field per line: `Worktree`, `Branches removed`, `Remote branches kept`, `Learnings` (the learning ids, or `none`), `p0` (`<kind>: <text>` joined by `; `, or `none`), and `Retro due` (`yes` or `no`). Spec clarification: S18c. `Worktree` reads `removed <path>` for each worktree the `worktree` step removed, or `none`. `Branches removed` lists each branch whose remote side was not kept and one side was removed, as `<branch> (local kept: <reason>)` when its local ref was kept. `Remote branches kept` lists each branch whose remote side was kept, as `<branch> (<reason>; local <removed|absent>)` or `<branch> (<reason>; local kept: <reason>)`. Each field is `none` when it lists nothing. Spec clarification: S18c. The branch rule: the candidates are the branch of each recorded worktree and the head branch of each Run `pr` event the code host reads `merged`. The close never touches `main`, `master`, `staging`, or the remote's default branch, and keeps every candidate in a repository whose default branch it cannot read. A branch is deleted only when a Run `pr` event the code host reads `merged` names it as its head branch and no open PR names it. Its local ref is deleted only when it is not checked out in any worktree and its tip equals that PR's head SHA, with that SHA as the expected old value. Its remote branch is deleted only when the remote tip read after a fetch equals that PR's head SHA, with that tip as the push lease. Every other side is kept and records `branch_kept` with its reason, which the close output prints as `branch_kept <branch> (<local|remote>): <reason>`; the Run still closes `done`.

| Reserved class | Members | Result |
| --- | --- | --- |
| deny | live trading, evidence tampering, safety-limit removal | refused at once |
| needs_human | any spend, credentials, data deletion, a production deploy, a Gate change on a running Run, a policy change, a driver or gatekeeper change | needs-human with reason `policy-required` |
| needs_existing_authorization | repo creation, which the Story spec must name, and VPS SSH, which needs an infrastructure Story | the loop runs when the Story authorizes it, and needs-human otherwise |

What a project policy may add to these classes, and the rung a new guardrail takes, is in "Refusals are the last rung" under Gate-lift.

`pod config apply` refuses a policy with `schema_invalid` unless every rule below holds.

- Every Gate has exactly one keeper.
- An HQA keeper is a human account with a verifiable source, one of the sources "Trust boundary and the bypass test" accepts.
- A policy change is a needs-human category. It takes effect only as a new policy Revision that the human gatekeeper applies.
- An agent cannot choose a profile.

The four profiles and their columns are in "Operator pages and profiles".

Spec clarification: S13a. Pod has no Story Revision. A Story's existing authorization is the `authorizations` map of the policy Revision the Run's snapshot pins, keyed by the Story's external id: `authorizations: { <story>: { authorizes: [repo_create, vps_ssh], story_kind: infrastructure } }`. `repo_create` is authorized when the Run's Story entry lists it in `authorizes`. `vps_ssh` is authorized when the entry lists it and carries `story_kind: infrastructure`. Anything else, an absent entry included, ends `needs_human` with reason `policy-required`. `pod config apply` refuses with `schema_invalid` an `authorizes` item that is not a needs_existing_authorization member of that policy, a `story_kind` other than `infrastructure`, an entry with any other key, and an `authorizations` that is not a map. An absent map is `{}` on that policy alone and is never read from the global policy, and the project-scope rule that keeps the global deny and needs_human members does not cover it. The operator applies the policy with `pod config apply` before `pod run create`.

#### Gate-lift

The policy schema validates `profiles`. A profile may replace only `prd_review` and `design_clickthrough` with a Decision-pair automated Gate. `hqa_after_deploy` and `staging_review` stay with the human gatekeeper. A lifted Gate records an automated PASS, never a human one. In v1 the executor refuses every `autonomous` activation and every lift outside the two Gates, and it activates `hands-on`, `standard`, and `hands-off` per project only after a human readback. The schema fixtures cover a lift outside the two Gates, a lift on a running Run, an added Gate, and a missing policy Revision, and each is refused.

What each profile lifts and keeps, and the bar `autonomous` must clear, are in "Operator pages and profiles".

Spec clarification: policy profiles. `specs/policy/default.yaml` defines four profiles. `hands-on` and `standard` lift no Gate. `hands-off` and `autonomous` lift `prd_review` and `design_clickthrough` to `decision-pair-aqa`. A profile carries only `replaces`, `requires`, `deploy_production`, and `method`. `deploy_production` is `needs_human` or `agent`, and `method` is the map of step id to method that "Step method" describes. `active_profile` must name a profile the same Revision defines. A project activates a profile with a project-scope policy Revision that sets `active_profile`, applied with `pod config apply --activate`. The apply stores the Revision and leaves its `config_apply` operation pending. It writes no activation, and it replies with the comment a person posts, `profile <project> <name> <policy ref>`, and with the live Runs still on the old profile. Pod never posts that comment. The request stays pending until a `pod check` pass on some live Run reads that comment back on the Run's Story. The comment is source-verified as a Decision ruling is, against the HQA keepers and principals of the policy currently active at the request's scope, never against the pending Revision. Only then does Pod activate the Revision, with an `activation` event whose source is the tracker comment. `active_profile` at global scope is refused: a profile is activated per project. `autonomous` is still refused with `gate_lift_refused` until the activation conditions in "Operator pages and profiles" hold. Its `deploy_production: agent` drops the `deploy_production` needs_human member only under that active profile. `pod run create --project <ref>` resolves crew and policy at that project with global fallback. The Run snapshot pins the project and the active profile name, and a later activation changes neither. A switch during a live Run is accepted: the Run keeps its snapshot. In v1 lifts are not enforced: `effective_gate_map` stays `{}`, and Gate keepers are unchanged.

Spec clarification: TPC-1479. A profile request is now a `config_activate` request, and it keeps printing `profile <project> <name> <policy ref>` as its comment. The readback accepts that line or `config activate <revision-id>`, on the request's `--ticket` when the person gave one, else on the Story of the Run that `pod check` passes. The keepers and principals come from the active global policy, not from the policy active at the request's scope. A person may also activate the profile directly with `pod config activate`. A profile carries an optional `agent_activates`, a list of kinds drawn from `crew` and `decision`. `policy` or `process` in it is refused with `schema_invalid`, because an agent never activates either, and so is any other value. All four default profiles carry `agent_activates: []`. `docs/adr/0002-database-is-the-source-of-configuration.md` lets this list name the kinds an agent may activate on its own. S16b validates the list and does not honor it: every agent-written Revision still waits for a person, and honoring the list belongs to the ticket that first puts a kind in it.
#### Refusals are the last rung

A verb first does the right thing, its default path. A guardrail beyond that takes the lowest rung that holds the case. Each rung uses a mechanism Pod already has.

| Rung | Mechanism |
| --- | --- |
| observe | a ledger event, such as `self_decision` or `ignored`, and nothing else |
| report | a count or a line in `pod brief` |
| warn | an exit-0 result that carries `nextSteps` |
| hold | a Run or Task `hold`, or a Decision in `needs_human`, waiting on a source-verified human |
| refuse | exit 2 or 3 with an error code and `nextSteps`, and nothing written |

A verb chooses among observe, report, warn, and refuse, and refuse is the last of them. Hold and `needs_human` are human stops. Only the policy's `reserved` classes and the Gates trigger them. They rank above refuse, and their cost is recorded as blocking the operator until a person rules.

A guardrail cites evidence: a learning row or a replay fixture, named in the PR that adds it. A new refusal code cites one recorded occurrence. A new hold condition, or a new `needs_human` or `deny` member of `reserved`, cites two. An irreversible failure earns any rung on one occurrence: spend, credentials, data deletion, or evidence tampering. A data-correctness refusal is an invariant and needs no evidence: a compare-and-set or generation conflict, a schema error, or a selector mismatch.

A guardrail refusal or human stop with no trigger in 30 days is a sunset candidate. A person rules whether to remove it or move it to a lower rung. The data are the `ledger.operation` rows with status `refused` and the `escalate` and `hold` events. Pod has no counter over them yet.

A project-scope policy Revision is a full value, applied with `pod config apply` and activated by a person. It keeps every global `deny` and `needs_human` member, and it may add members and match terms. It may promote a global `needs_human` member to `deny`, and it may not demote or remove one. A project policy that drops a global member, or lists a global `deny` member only under `needs_human`, is `schema_invalid` naming that member. The `deploy_production` exception is the one the Gate-lift Spec clarification on policy profiles states. `needs_existing_authorization` and `authorizations` keep their rules.

`limits.digest_per_day` caps the proposals a digest puts in front of the operator in a day. It is an integer from 1 to 10, and an escalation never counts against it. `specs/policy/default.yaml` seeds 3 at global scope, and a project Revision may set its own. `pod config apply` refuses any other value with `schema_invalid` at `limits.digest_per_day`. Over the cap, proposals queue to the next day, oldest first, and none is refused or dropped. `pod brief` reports the cap per project: the JSON row carries `digest: { cap, shown, queued }`, and the HTML carries one line, `Digest <shown>/<cap>, <queued> queued`. Until the digest ships, Pod validates the cap and reads it nowhere.

Spec clarification: S21a. `ledger.learning.kind` is a not-null text column. Its value must be in the active policy's optional `learning.kinds`, a non-empty list of distinct lowercase names (`^[a-z][a-z0-9_]*$`), read for the learning's project scope with the global fallback; `pod config apply` refuses any other shape with `schema_invalid` at `learning.kinds`. With no active policy, or one without `learning.kinds`, the list is `[lead]`. `specs/policy/default.yaml` seeds `learning: { kinds: [lead] }`, and an adopter adds its kinds through a policy Revision a person activates.

#### Decision measurement

Spec clarification: S14a. Every xl Run records what the coordinator pair cost to open and what came of each Decision, so a dogfood run reads both from the ledger alone.

`ledger.dispatch.prompt_bytes` is a nullable integer: the UTF-8 byte length of the launch text Pod hands over for that Dispatch. For a Decision Seat it is the spec that Pod passes to Orca `task-create` before `worker-start`. For a `pod retry` Dispatch it is the task view that `pod retry` returns for the retry worker. A Dispatch from `pod dispatch`, and a late start that `pod check` records, carry no launch text from Pod, because the Orca task already holds the step spec from projection. Their column is null. A takeover decider counts its spec, which names the restore view's path. The restore view file is not counted. Pod records no vendor token count here, and `Decision.budget.spent.context_tokens` is unchanged.

Cold start is derived, not stored. `cold_start_ms` for a Dispatch is `dispatch.created_at - operation.created_at`, joined on `dispatch.op_key`. Pod writes the operation row before the Orca call. It writes the Dispatch row and its `start` event in one transaction after the receipt. A Dispatch whose operation row is missing has a null cold start.

`pod brief` carries a `measurement` object per Run:

- `pair` is null unless the Run has `coordinator_dispatch_id`. Otherwise it holds `decider`, the Dispatch that column names, and `auditor`, the Run's auditor Dispatch with no Decision owner and the greatest `created_at`, or null. Each is `{ seat, prompt_bytes, cold_start_ms }`.
- `decisions` has one row per `ledger.decision` of the Run: `decision_id`, `state`, `reason` or null, `effect` or null, and `outcome`.
- `escalations` counts the Run's `needs_human` Decisions by `reason` in four buckets, `policy-required`, `disagreement`, `context-missing`, and `runtime-failure`, and counts the Run's `escalate` events as `worker`. `sample` is the Run's Decision count and `target` is 10.

A Decision's `outcome` is the first of these that holds:

| Outcome | Rule |
| --- | --- |
| `reversed` | a later Decision with effect `change_spec` names it in `supersedes_decision_id` |
| `reworked` | it is `agreed`, and the Task it decided gained a rework Task, a Task whose `rework_of` names it. When that Task is `superseded`, its replacement is followed first, so the replacement a `change_spec` outcome creates is not rework |
| `adopted` | it is `agreed` and `reworked` does not hold |
| `open` | any other state |

The brief derives `outcome` on each read. It does not write `ledger.decision.adoption`, which `pod decide` records as `pending`. The seven brief counters are unchanged. `pod brief --html` renders one Measurement table per Run, `measurement-<run_id>`, from the same JSON.

`pod verdict post` refuses with `receipt_keeper_is_decision_seat` before it writes, when the file's `reviewer` is the `seat` of any Dispatch of the Run whose role is `decider` or `auditor`. That covers the resident pair before its first Decision, and every Seat a `ledger.decision_round` names. The HQA keeper rule in the policy schema already refuses a Seat id, and `pod hqa record` is unchanged.

A local deploy is `pnpm deploy:local`, which runs `scripts/deploy-local.sh`. Every refusal prints a line that starts `refused:` and exits nonzero before any tag is written.

1. Fetch origin, and refuse unless the tree is clean and HEAD equals `origin/main`.
2. Read `version` from `package.json`. The tag is `v<version>`. Refuse when the commit a local or origin tag of that name peels to is not HEAD.
3. Preflight. Refuse unless `pnpm bin --global` prints a directory, and unless the database URL the host profile names (`db.url_env`, default `POD_DB_URL`) can be read from the credentials file, or from the environment when that file is absent. The check runs `src/cli/host-profile.ts`, so a malformed or unreadable `host.yaml` refuses with its own message.
4. `pnpm build` into `.deploy/dist`, then `node .deploy/dist/index.js db migrate` with that build, then move it into `dist`, then `pnpm link --global`. The migrate result goes to stderr. A failed migrate refuses with `db migrate failed` and leaves `dist`, the build the linked `pod` runs, as it was.
5. Write the annotated tag `v<version>` when it is missing locally, and push it when origin lacks it. A rerun on the same HEAD runs every step again: `db migrate` applies nothing, and the tag step skips a tag that already peels to HEAD.
6. Print one JSON line, `{"environment":"local","deployment_id":"v<version>","deployed_revision":"<HEAD sha>","source_commit":"<HEAD sha>"}`, which carries the four `event_fields` of the deploy step for the coordinator's deploy delivery.

The version bump belongs to the deployed story's own PR, not to the script. Pod has no `pod deploy` verb and no deploy adapter in v1.

### Versioning, release, and migration policy

| Area | Rule |
| --- | --- |
| Pod version | semver. The CLI JSON envelope and the exit codes are the public interface. A breaking change to the envelope, a verb's input, or an exit code bumps major. A new verb or a new optional field bumps minor. |
| Spec schemas | `schema_version` per kind, versioned independently of Pod. A reader supports the current and the previous schema version. A Run pinned to a Revision older than the previous schema version finishes on the Pod version that can read it, and `pod db migrate` refuses an upgrade that would drop support while such a Run is open. |
| Revisions | never migrated in place. To move a spec forward, the operator exports it, edits it, and applies a new Revision with `parent` set. |
| Database migrations | forward-only. `drizzle-kit generate` writes each migration and its journal entry. A PR that changes the schema ships the generated migration. A hand-edited migration is allowed only for a data backfill and says so in its header. `pod db migrate` is idempotent through Drizzle's applied-migrations table. |
| Protected rows | a migration never rewrites `config.revision` values or `ledger.event` rows, and the append-only triggers live in a custom SQL migration that `drizzle-kit generate --custom` creates. |
| Columns | adding a column is allowed. Dropping or renaming one needs a major release and a two-step migration. The first release adds, backfills, and switches readers. The next release drops. |
| Orca compatibility | the adapter names a supported Orca version range, and fixtures carry the recorded version. A new Orca version is adopted by re-recording the fixture scenarios and bumping the range in one PR. |
| Release | a git tag `vX.Y.Z` and a GitHub release that CI builds from `tsup`. No npm publish in v1. The operator installs from a clone. Publishing is a later milestone. |

Every PR runs typecheck, lint with the import-boundary rule, unit tests, replay tests, the scope scan against `POD_SCRUB_DENYLIST`, and `pod db migrate` against a throwaway Postgres in CI.

The two-schema split stays in one database for v1. Splitting the database is a later decision, and nothing in v1 joins across a boundary a split would break, because `config` and `ledger` reference each other only by Revision id.

### Adoption with a crew profile and a host profile

An operator adopts Pod with two profiles. The host profile describes one machine. The crew profile describes who fills each Role.

#### Host profile

The host profile is a local file outside the repo at `$POD_HOME/host.yaml`, default `~/.pod/host.yaml`. Each execution host has one.

| Field | Meaning |
| --- | --- |
| `host_id` | this host's id in the ledger |
| `orca.server` | the Orca selector |
| `credentials_file` | optional, the credentials file, default `$POD_HOME/credentials`; a relative path is read under `$POD_HOME` |
| `mirror_dir` | optional, the mirror directory `pod config export --all` writes and `pod brief` reads, default `$POD_HOME/mirror`; a relative path is read under `$POD_HOME` |
| `db.url_env` | the name of the credential that holds the connection string |
| `tracker.kind` | `linear` |
| `tracker.token_env` | the name of the credential that holds the tracker token |
| `docs.kind` | `notion` |
| `docs.token_env` | the name of the credential that holds the docs token |
| `capacity` | the Seat quota on this host |
| `operator` | optional, the principal who runs this host's shell, recorded as `person:<operator>`; it must name a principal of the active global policy when that policy lists any |
| `record_dir` | optional, the fixture record directory |

The host profile holds no secrets. It names credentials instead. The host profile is not a Revision because it names local secrets and a local Orca, and a Revision is meant to be shared and pinned.

The credentials file holds the secrets, one `NAME=value` line each, under the names `db.url_env`, `tracker.token_env`, and `docs.token_env` give. Blank lines and `#` lines are skipped, and the value is everything after the first `=`. When the file exists, `pod` reads credentials only from it. A file that group or other can read or write is a usage error whose next step is `chmod 600 <path>`. When the file is absent, `pod` reads the same names from the environment and writes a warning to stderr. When the file exists and the session still exports one of those names, `pod check` and `pod brief` add the next step `<NAME> is exported in this session; Seats inherit it. Remove it from the session environment`. No error, warning, or next step prints a value.

#### Crew profile

The crew profile is `crew.yaml`, a `kind: crew` Revision. It maps each Role to a Seat.

```yaml
kind: crew
schema_version: 1
name: default
seats:
  developer: { runtime: <orca agent id>, model: <model>, effort: <effort>, host_id: host-a }
  reviewer:  { runtime: <orca agent id>, model: <model>, host_id: host-a, independent_of: [developer] }
  decider:   { runtime: <orca agent id>, model: <model>, host_id: host-a, fallback: decider-fallback }
  auditor:   { runtime: <orca agent id>, model: <model>, host_id: host-a, independent_of: [decider] }
```

| Seat field | Meaning |
| --- | --- |
| `runtime` | an Orca agent id |
| `model` | the requested model |
| `effort` | the requested effort |
| `host_id` | the host that may start this Seat |
| `independent_of` | Roles this Seat must not share an identity with |
| `fallback` | an optional Seat. A launch on the fallback is marked in receipts and in the brief, and a fallback the crew does not name blocks |

The operator applies it with `pod config apply crew.yaml --activate --scope project:<id> --expected-revision none` the first time, and with the active Revision id after that.

#### Adopt Pod on a host

1. Clone the Pod repo.
2. Run `pnpm install`.
3. Write the credentials file, `$POD_HOME/credentials` by default, with mode 0600 and one `NAME=value` line each for the database URL, the tracker token, and the docs token. The session environment exports none of those names, so a Seat inherits no credential.
4. Write `$POD_HOME/host.yaml` with the names of those credentials, and `credentials_file` when the file is elsewhere.
5. Run `pod db migrate`.
6. Apply the policy first with `pod config apply specs/policy/policy.yaml --activate --scope global --expected-revision none`.
7. Copy `specs/crew/crew.example.yaml`, fill it, and apply it with `pod config apply crew.yaml --activate --scope project:<id> --expected-revision none`.
8. Apply each of the six reference process specs with `pod config apply specs/process/<name>.yaml --activate --scope global --expected-revision none`. A process apply validates Roles against the active crew and gate ids against the active policy, so it comes last.
9. Run the bypass test under `test/bypass/` and confirm it passes before the first `pod hqa record`.
10. From a worktree that the operator's claim authority chose, run `pod run create story:<id>`. It returns `ownerGeneration` 1 in `meta`.
11. Run `pod dispatch --task T --seat S --generation 1` for each ready Task the claim authority authorizes.
12. Run `pod check --generation 1 --wait` to record deliveries and project the next Tasks.

Rotate a credential: change the value at the provider, edit its line in the credentials file, and run a verb that reads the database, such as `pod db migrate`, to confirm. Then remove the old value from every session that still exports it.

The operator's existing grooming, planning, kickoff, and docs tools stay outside Pod and keep working as they do. Pod refuses to start a second crew for a Story that already has a Run.

### Story order and what each adds

S1 carries the repo scaffold, which is the toolchain, the import-boundary lint, an empty registry, CI, and `docs/contract.md`. Its acceptance test reads `pod --help`, so the scaffold must exist first. This is a grooming note for S1.

The order is S1, then S2, then S3 with S4, then S5 with S6, then S7 with S8, then S10, then S9 with S11 with S12, then S13, then S15, then S14. S10 lands before S11 so the state view can read learnings. S15 lands before S14 because dogfood B depends on the coordinator pair.

| Order | Story | Key | Size | Adds to the tree | First fixture scenarios | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S1 Authorization and completion contract | TPC-1113 | s | `package.json`, `tsconfig.json`, `src/cli/verbs.ts` empty registry, boundary lint config, CI workflow, `docs/contract.md` with the direct-launch violation rule, `test/bypass/` | none, the contract test reads `pod --help` | none |
| 2 | S2 Config revisions and minimum ledger | TPC-1114 | m | `src/core/config`, `src/core/ledger`, `src/adapters/postgres`, the Drizzle schema under `src/db/schema/`, `drizzle.config.ts`, the first generated migration under `db/migrations/` with `config.revision`, `config.activation`, `config.snapshot`, `ledger.story`, `ledger.run`, `ledger.task`, `ledger.dispatch`, `ledger.event`, `ledger.operation`, the append-only triggers as a custom migration, verbs `db migrate`, `config apply`, `config export`. S2 adds the four mapping tables `ledger.story`, `ledger.run`, `ledger.task`, and `ledger.dispatch` beyond the PRD's list, and the S2 groomer re-estimates if size m does not fit. S2 may create one database project and one test branch on the existing database account's current plan, with no plan upgrade and no new spend, and anything beyond that is a needs-human decision | test-database cases for CAS conflict, bundle read, dropped connection, and restore | S1 |
| 3 | S3 Single-host Orca adapter | TPC-1115 | l | `src/core/ports/orca.ts`, `src/adapters/orca`, `fixtures/orca/`, verbs `run create`, `dispatch`, `check` with `--resume`, `retry`, `release`, `takeover` with its restore view, `drain` | `lost-launch-reply`, `two-coordinator-handoff`, `stale-dispatch-id`, `capacity-1`, `drain` | S2 |
| 3 | S4 Evidence manifest, task view, and brief | TPC-1116 | s | `src/core/manifest`, `ledger.evidence_manifest` with `parent_id`, the `ledger.dispatch.manifest_id` column, the 2k word task view budget with `truncated` and routing lines, verb `brief` with drift marking | `retry-git-status`, `planted-secret-scan` | S2, and S3 for the task view |
| 4 | S5 Process schema, selector, and impl-small projector | TPC-1117 | m | `src/core/process`, `specs/process/impl-small.yaml` | `review-fail-rework`, `integration-review` | S2, S3 |
| 4 | S6 Gate receipts and tracker sync | TPC-1118 | m | `src/adapters/linear`, `ledger.gate_receipt`, `ledger.outbox`, verbs `verdict post`, `hqa record` | `tracker-dropped-reply`, `tracker-canceled`, `edited-comment`, `forged-author` | S2 |
| 5 | S7 Integrated failure drill | TPC-1119 | s | `test/drill/`, the `workerList` check in `pod check` | `integrated-drill`, `direct-launch` | S3, S5, S6 |
| 5 | S8 Dogfood A, wiring and measurement | TPC-1120 | xs | `specs/crew/crew.example.yaml`, one real xs or s Story with two Tasks through `impl-small@1`, a ledger with no hand-written entry, brief counters for coordinator operation count, recovery steps, retries and rework, and hand-filled entries, and test results under the standard command and a 60-second-timeout command | `dogfood-a` | S3, S4, S5, S6 |
| 6 | S10 Learning records | TPC-1122 | s | `ledger.learning` with `area` and `project_id`, verbs `learning add` with `--area` and `--project`, `learning query` | none, ledger tests only | S2 |
| 7 | S9 Remaining reference process specs | TPC-1121 | m | `specs/process/prd.yaml`, `design.yaml`, `impl-medium.yaml`, `impl-large.yaml`, `impl-xlarge.yaml`. A size m, l, or xl impl Story selects its own spec and never `impl-small@1` | none, apply tests only | S5 |
| 7 | S11 State view | TPC-1123 | xs | `src/adapters/notion`, `ledger.usage_observation`, verb `state` with the seven state view sections, each with `source_revision` and `observed_at`, the 30-day in-force Decision rule, and the 3k word budget | `docs-section-read` | S4, S10 |
| 7 | S12 Minimal decision loop | TPC-1124 | m | `src/core/decide`, `ledger.decision`, `ledger.decision_round`, verb `decide` | `decision-happy-path`, `decision-fallback` | S3, S4, S11 |
| 8 | S13 Decision failures and authorization | TPC-1125 | m | Reserved checks, the policy schema with `profiles`, Decision recovery through needs-human, every Flow 2 transition replayed, the mixed auditor case set (correct proposal, wrong citation, stale roadmap, out-of-scope proposal, true citation with wrong inference) with misses and false refusals recorded per case, a dependency change between rounds, gate-lift refusals, and a budget kept across relaunch | one scenario per Decision state table row, `gate-lift-refused` | S12 |
| 9 | S15 Coordinator pair for xl | TPC-1205 | m | the xl branch of `pod run create` and `pod takeover`, the resident auditor, `impl-xlarge@1` driven by the pair | `xl-coordinator-pair`, `xl-takeover` | S12, S13 |
| 10 | S14 Dogfood B, decision measurement | TPC-1126 | s | one real xl Story through `impl-xlarge@1` with the coordinator pair, escalations reported by reason with a natural sample reported as such, adoption, rework, and reversal per Decision, the pair's context size and cold-start time per Run, and the reviewer and human receipts bound to the final candidate SHA and the deployed revision with keepers that are not the Decision Seats | `dogfood-b` | S9, S13, S15 |

There are fifteen stories, 2 of size xs, 5 of size s, 7 of size m, and 1 of size l. In position 7, S11 merges before S12 because the Decision manifest reads the state view.

### Operator pages and profiles

This section is the contract that the M2 operator pages and policy profiles build against. It writes no verb and no field. The code lands in later tickets.

#### Operator pages

An operator page is `pod page <kind> <id>`. It reads the same JSON the matching `pod` read returns from the database and renders one self-contained HTML file with the `pod brief --html` renderer. The file loads nothing from a CDN. A page stores nothing and writes nothing outside its HTML file, and a later UI reuses the same JSON. `pod page` is not in the Verbs table yet. It joins the registry when its ticket lands.

| Kind | Object | What the page shows |
| --- | --- | --- |
| `decision` | a Decision | the options, each round's proposal and stance, the citations, and the outcome |
| `escalation` | a needs-human item | the reason, the Reserved class or threshold that raised it, and the options |
| `story-review` | a Story at its HQA Gate | the one-pager for the human gatekeeper, with the review packet diff since the last human PASS |
| `run` | a Run | the snapshot, the Tasks by lineage, the Gate receipts, and the open needs-human items |

`pod brief` is unchanged. The groom page and the standup page stay with the operator's tooling until Pod owns grooming and the standup.

A page that asks for a verdict has a copy-verdict button. The button copies the tracker comment text and posts nothing. A person posts the comment, and `pod check` or `pod hqa record` reads it back and verifies its source, as "Trust boundary and the bypass test" requires. The page is never the source of a verdict.

#### Step method

A process step takes an optional `method: <string>`, and a profile may override it. Pod stores the method and does not interpret it. The task view prints one `Method: <string>` line when the step has one.

Spec clarification: the method in the TASK block. A method is one line of 1 to 200 characters. A process step that breaks the rule is `schema_invalid` at `steps.<i>.method`. A profile overrides it with `profiles.<name>.method: { <step_id>: <string> }`, under the same rule, and a violation is `schema_invalid` at `profiles.<name>.method.<step_id>`. Policy does not know the process, so a step id is not checked, and one profile can serve several processes. A step's method resolves from the Run's pinned Revisions: the override that the snapshot's profile sets in the pinned policy Revision, else the step's `method` in the pinned process Revision, else none. A Run with no profile takes the step's own method. A policy activated after the Run is created does not change it, and the snapshot gains no column. Projection appends a blank line and `Method: <string>` to the spec it hands `task-create`, so the Seat's TASK block carries the line. A rework Task and a `change_spec` replacement keep it, because the line is added at each `task-create` and is not part of the stored spec. `pod retry` prints the same line in its task view, after the git status. With no method, neither prints the line, and the spec is unchanged. `prompt_bytes` keeps its definition.

#### Policy profiles

`specs/policy/default.yaml` defines the four profiles below. The activator is always a person, through the readback that "Gate-lift" describes.

| Profile | `replaces` | `requires` | Human Gates kept | `deploy_production` | Default page | Activatable today |
| --- | --- | --- | --- | --- | --- | --- |
| `hands-on` | none | none | `prd_review`, `design_clickthrough`, `hqa_after_deploy`, `staging_review` | `needs_human` | groom page; Story review page at HQA | yes, after a person's readback |
| `standard` | none | none | `prd_review`, `design_clickthrough`, `hqa_after_deploy`, `staging_review` | `needs_human` | terminal; Story review page at HQA | yes, after a person's readback |
| `hands-off` | `prd_review` and `design_clickthrough` to `decision-pair-aqa` | none | `hqa_after_deploy`, `staging_review` | `needs_human` | auto; Story review page at HQA | yes, after a person's readback |
| `autonomous` | `prd_review` and `design_clickthrough` to `decision-pair-aqa` | none | `hqa_after_deploy`, `staging_review` | `agent` | auto; Story review page at HQA | no, refused with `gate_lift_refused` |

`deploy_production` works as "Gate-lift" ships it. The global `deploy_production` needs_human member stays. Only an active profile whose `deploy_production` is `agent` removes that member, and only for its project. A project policy that drops a global deny or needs_human member from its own `reserved` list is still refused with `schema_invalid`.

Policy `attention`, with `pause_at` and `max_unattended_hours`, waits for M2. Per-project needs_human members and the digest cap are in "Refusals are the last rung" under Gate-lift. Until Pod owns the profile, an adopter may keep its own interim profile configuration.

#### The autonomous north star

`autonomous` is the target state. A Story enters from an initial prompt, a roadmap goal, or E2E-HQA feedback. The loop grooms, plans, operates, and keeps its automated Gates without a person. It stops for a person at authentication, a third-party integration, any spend, and every deny member. It ends when the Story is ready for staging review.

`autonomous` stays refused with `gate_lift_refused` until groom, plan, the operate loop, the gate set with its needs-human exit, and policy `attention` all land. Lifting the refusal is a separate ticket that a person decides.

Operator-facing strings in pages, `nextSteps`, and brief lines follow "Operator-facing strings" in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

### Later milestones this spec keeps room for

Some parts of the layout, schema, and interfaces exist only so that phase 2 and later are not designed out. This section names them and gives no designs.

- `src/core` is the home of a future `podd`. The daemon becomes a second entry point over the same `core`, and that is when Pod splits into packages.
- `ledger.outbox` is the future cross-host channel. Its `target` check allows only `tracker` in v1.
- The reserved `ledger.dispatch` columns `execution_backend`, `owner_host`, `external_execution_id`, `auth_ref`, and `output_ref` leave room for cloud Seats. They stay null in v1.
- `scope: host` on Revisions leaves room for per-host configuration across several hosts.
- `TrackerPort` and `DocsPort` leave room for trackers and docs tools other than Linear and Notion.
- The `pod brief` JSON is the first state snapshot a UI reads.

## Checkpoints

The story order table in "Story order and what each adds" is the checkpoint plan. Each order position ends in a check that proves it before the next position starts.

| Position | Checkpoint |
| --- | --- |
| 1 | `pod --help` prints the registry, and the contract test passes against `docs/contract.md` |
| 2 | `pod db migrate` runs twice with no change, an apply returns `kind.name@rev`, and a stale `expected_revision` exits 3 with `revision_conflict` |
| 3 | the five Orca scenarios replay green, and `pod brief` prints JSON and writes one HTML file from it |
| 4 | the selector enumeration passes, review FAIL replays to a rework Task, and a forged author and a stale SHA are refused |
| 5 | one drill Run shows zero duplicate launches, zero Gate overruns, and zero false Done, and dogfood A's ledger has no hand-written entry |
| 6 | `pod learning add` and `pod learning query` round-trip, and no call reaches `DocsPort` |
| 7 | every reference spec applies against a filling crew and is refused against one that does not, `pod state --json` carries `source_revision` and `observed_at` in every section, and the Decision happy path records manifest hash, rounds, and outcome |
| 8 | every row of the Decision state table replays to its listed state, and every autonomous activation and every lift outside `prd_review` and `design_clickthrough` is refused |
| 9 | an xl Run opens the coordinator pair at start, survives a takeover with the resident auditor kept, and never deadlocks at capacity 1 |
| 10 | dogfood B runs the xl Story through `impl-xlarge@1`, its ledger holds a source-verified reviewer PASS on the final candidate SHA and a source-verified `hqa_after_deploy` PASS on the deployed revision, and neither keeper is a Decision Seat |

## Verification

Four checks verify this spec and the code that follows it.

1. The completion check reads this file and confirms that the nine required sections exist as `###` headings under `## Design`, in the ticket's order, with the later milestones section after them. The nine are "Repo layout and packages", "Config schema and ledger schema sketch", "CLI framework, verb list, and error shape", "Runtime adapter boundary and fixture replay", "Process spec loading and the selector", "The decision layer seats", "Versioning, release, and migration policy", "Adoption with a crew profile and a host profile", and "Story order and what each adds".
2. The scope scan runs the denylist that `POD_SCRUB_DENYLIST` names over this file, `specs/`, `fixtures/`, `docs/`, and `src/db/schema/`. It matches whole words, case-insensitive, and passes only at zero matches.
3. The registry contract test, from S1 on, asserts that every verb row with a side effect appears in `docs/contract.md` with its `cancelBy` and `evidenceRequired`, and that each of the 17 verbs in the table under "Verbs" exists in the registry. The 17 are `db migrate`, `config apply`, `config export`, `run create`, `dispatch`, `check` with `--resume`, `retry`, `release`, `verdict post`, `hqa record`, `decide`, `state`, `takeover`, `brief`, `drain`, `learning add` with `--area`, and `learning query`. Verbs beyond the 17, such as `learning import`, `retro`, and `retro record`, are listed with their side effect in the test's extra list.
4. The docs test `test/docs/tech-spec-operator.test.ts` asserts that "Operator pages and profiles" exists, that its profile table has exactly one row for each of the four profiles, and that it states the conditions that keep `autonomous` refused.
