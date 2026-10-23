# Pod v1 tech spec

This document is the technical specification for Pod v1. An implementation lead grooms the fourteen candidate stories from it. It is reference material with short explanation paragraphs where a choice needs its reason.

The DDL, TypeScript, YAML, JSON, and directory blocks in this document are sketches, not code. They fix names, shapes, and constraints. The stories write the real files.

## Goal

Pod is a thin coordination layer over Orca. Orca keeps execution. Pod adds four things a full Story on Orca showed were missing:

1. A ledger that records every launch receipt, delivery, push, PR, release, and Gate receipt without a hand-written entry.
2. Gate receipts bound to the candidate SHA and synced to the tracker with readback, so no Story reaches Done on a stale or forged PASS.
3. Reconcile and recovery as commands, so an unknown launch result, a stale delivery, or a second coordinator never causes a double launch.
4. A Decision layer where a decider Seat proposes and an auditor Seat checks against one Evidence manifest, and a person rules only when the policy or the loop requires it.

v1 is a set of `pod` verbs that wrap Orca, one Postgres database with an append-only `config` schema and an event `ledger` schema, one Evidence manifest projected into a task view, a state view, and a brief, and a two-Seat Decision loop. v1 runs on one execution host. It has no daemon and no second host.

Every v1 choice keeps the end state in view. That end state is an operator who manages multi-project, multi-host agent work through a long-running agent and a UI, both reading the same ledger and calling the same `core`.

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
- No secret and no transcript enters a table, an Evidence manifest, a fixture, or a view. Connection strings and tokens are read from environment variables that a profile names.
- v1 does not rely on `LISTEN/NOTIFY`. Connection mode, CAS conflicts, atomic bundle reads, disconnect recovery, and backup and restore are tested on a test database before any story relies on them.
- Linear is the only v1 tracker adapter. Notion is the only v1 docs adapter, and it is read-only.
- Pod does not wrap or duplicate the operator's existing grooming, planning, kickoff, or docs commands.
- Pod never builds an IDE, terminal, diff, browser, or mobile surface, and never adds a second scheduler, an exactly-once promise, or agent authority over production, money, or credentials.

## Design

### Repo layout and packages

Pod is one npm package named `pod`. It is not a monorepo. Directories carry the layers, and an import-boundary lint enforces them.

```
pod/
  package.json            name pod, bin pod, type module, Node 22 LTS, pnpm
  tsconfig.json           strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
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
      postgres/           Db over the `postgres` driver, migration runner
  db/migrations/          NNNN_name.sql, forward-only, two schemas config and ledger
  specs/
    process/              prd.yaml, design.yaml, impl-small.yaml, impl-3pt.yaml, impl-planned.yaml
    policy/               policy.yaml reference
    crew/                 crew.example.yaml (Roles to Seats, placeholder runtimes)
  fixtures/orca/          recorded receipts, one directory per scenario
  test/                   vitest: unit over core, replay over adapters, contract tests over the registry
  docs/                   tech-spec.md (this file), contract.md (story S1), adr/
```

#### Import boundaries

dependency-cruiser runs in CI and refuses an import that crosses a layer the wrong way.

| Layer | May import | Must not import |
| --- | --- | --- |
| `src/cli` | `src/core`, `src/adapters` | nothing else in `src` |
| `src/core` | `src/core` only, plus zod | `src/adapters`, `src/cli`, any driver or HTTP client |
| `src/adapters/<name>` | `src/core/ports`, `src/core/domain` | `src/cli`, another adapter |

`core` holds every rule. Adapters translate between a port and one external system. `cli` wires adapters into `core` and prints the envelope. A daemon (`podd`, phase 2) and a UI (later) become more entry points over the same `core`. Pod splits into packages when a second entry point exists, not before. A pnpm workspace with five packages now was the alternative, and it lost because v1 is about 35 points and the daemon does not exist.

#### Toolchain

Pod runs on Node 22 LTS and TypeScript in strict mode, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on. pnpm manages packages. tsx runs sources in development, and tsup builds the single `pod` bin. vitest runs the unit, replay, and contract tests. zod parses every boundary, which covers argv, stdin JSON, YAML, Orca stdout, HTTP bodies, and `jsonb` rows. The Db adapter uses the `postgres` driver with hand-written SQL. dependency-cruiser enforces the import boundaries, and eslint and prettier lint and format.

Pod uses no ORM and no query builder. The schema is small and append-only, and the migrations are SQL anyway. An ORM would add a second schema language for no gain.

### Config schema and ledger schema sketch

Pod uses two Postgres schemas, `config` and `ledger`, in one database. `pod db migrate` applies numbered SQL files from `db/migrations/` and records each file in `config.migration` with its sha256. It refuses a file whose hash changed after it was applied. Migrations are forward-only. There are no down migrations.

The connection string is read from the environment variable that the host profile names in `db.url_env`. Pod never stores it.

`config` is append-only. A trigger on `config.revision` and on `ledger.event` raises on UPDATE and DELETE. Other ledger tables accept the state updates their state machines allow and nothing else.

#### Canonical JSON and content hashing

A Revision id is the sha256 of the canonical JSON of `kind`, `name`, `schema_version`, `scope`, `scope_ref`, `parent`, and `value`. `scope_ref` is in the hash so that two project Revisions with the same value get distinct ids. Canonical JSON has sorted keys, no whitespace, and UTF-8 encoding, in the style of RFC 8785. The same input always gives the same id, so applying an unchanged file returns the existing Revision.

A Snapshot hash is the sha256 of the canonical JSON of the three Revision ids plus the effective gate map. An Evidence manifest id is the sha256 of the canonical JSON of its references.

#### Config tables

`config.revision` holds one immutable version of a crew, process, or policy spec.

```sql
create table config.revision (
  id              text primary key,            -- sha256 of canonical JSON
  parent          text null references config.revision(id),
  kind            text not null check (kind in ('crew', 'process', 'policy')),
  name            text not null,
  schema_version  int  not null,
  scope           text not null check (scope in ('global', 'project', 'host', 'run')),
  scope_ref       text null,
  value           jsonb not null,
  actor           text not null,
  reason          text not null,
  created_at      timestamptz not null default now()
)
```

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

An apply that activates carries `expected_revision`. The current row's `revision_id` must equal it, or Pod refuses the apply with `revision_conflict`. A bundle activates several rows in one transaction and stamps them with one `bundle_id`. A project activation overrides a global one. Every activation change also records an event, so the activation history survives the row replacement.

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

`config.migration` records each applied migration file.

```sql
create table config.migration (
  filename    text primary key,
  sha256      text not null,
  applied_at  timestamptz not null
)
```

#### Ledger tables

`ledger.story` mirrors the tracker fields Pod reads.

```sql
create table ledger.story (
  provider      text not null,
  external_id   text not null,
  points        int  not null check (points in (1, 2, 3, 5, 8)),
  stage         text not null,
  run_id        text null,
  dependencies  jsonb not null,
  synced_at     timestamptz not null,
  primary key (provider, external_id)
)
```

`ledger.run` maps one Story to one Orca Run.

```sql
create table ledger.run (
  run_id               text primary key,         -- Orca run id
  story_provider       text not null,
  story_external_id    text not null,
  host                 text not null,
  coordinator          text not null,
  owner_generation     int  not null,
  snapshot_hash        text not null,
  state                text not null,
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
                 'start', 'delivery', 'decision', 'push', 'pr', 'deploy', 'release',
                 'takeover', 'escalate', 'cancel', 'stop', 'drain', 'ignored',
                 'self_decision', 'learning')),
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

`ledger.operation` holds one row per side-effect intent.

```sql
create table ledger.operation (
  op_key            text primary key,
  intent            text not null,
  status            text not null check (status in ('pending', 'unknown', 'done', 'refused')),
  owner_generation  int  not null,
  result_ref        jsonb null,
  created_at        timestamptz not null,
  updated_at        timestamptz not null
)
```

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
  task_id                 text not null references ledger.task,
  category                text not null,
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
  stance               text not null check (stance in ('agree', 'disagree', 'escalate', 'needs_evidence')),
  ts                   timestamptz not null,
  primary key (decision_id, round)
)
```

`ledger.evidence_manifest` holds the fixed list of sources a Dispatch or Decision may cite.

```sql
create table ledger.evidence_manifest (
  id          text primary key,                 -- sha256 of content
  run_id      text not null references ledger.run,
  task_id     text null references ledger.task,
  decision_id text null,
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
  adoption       text not null check (adoption in ('new', 'adopted', 'rejected')),
  created_at     timestamptz not null
)
```

#### Invariants by table

The table below states who writes each table, what never changes, what a reader may assume, and which story adds it.

| Table | Added by | Written by | Immutable | Readers may assume |
| --- | --- | --- | --- | --- |
| `config.migration` | S2 | `pod db migrate` | every row | a listed file ran once with that hash |
| `config.revision` | S2 | `pod config apply` | every row, trigger-enforced | an id names exactly one value forever |
| `config.activation` | S2 | `pod config apply --activate` | no, replaced under CAS | one Revision per scope, kind, and name at any moment |
| `config.snapshot` | S2 | `pod run create` | every row | a Run's configuration never changes after it starts |
| `ledger.story` | S2 | tracker sync inside `pod run create` and `pod check` | no, refreshed from the tracker | a mirror with `synced_at`, never the authority |
| `ledger.run` | S2 | `pod run create`, `pod takeover` | `run_id`, story, `snapshot_hash` | `owner_generation` only increases |
| `ledger.task` | S2 | the projector inside `pod run create` and `pod check` | id, step, lineage, spec Revision | `state` moves only along the Task state table |
| `ledger.dispatch` | S2 | `pod dispatch`, `pod retry`, `pod release`, `pod decide` | launch fields once recorded | `model_attribution` is `receipt` only when a launch receipt named the model |
| `ledger.event` | S2 | every side-effect verb, `pod check` | every row, trigger-enforced | ordered by `ts` within a Run, each with a `source` |
| `ledger.operation` | S2 | every side-effect verb | `op_key`, `intent` | one row per intent, status moves forward only |
| `ledger.gate_receipt` | S6 | `pod verdict post`, `pod hqa record` | all fields except `sync_state` | a PASS is bound to one candidate SHA and one verified source |
| `ledger.outbox` | S6 | `pod verdict post`, `pod hqa record`, `pod check` | `op_key`, `payload` | a row is done only when `readback` confirms it |
| `ledger.evidence_manifest` | S4 | `pod dispatch`, `pod decide` | every row | the same sources give the same id |
| `ledger.learning` | S10 | `pod learning add` | `text`, `evidence_refs`, `source_story` | never mirrored to the docs tool |
| `ledger.usage_observation` | S11 | `pod check`, `pod state` | every row | a null `value` means unknown |
| `ledger.decision` | S12 | `pod decide` | id, category, question, `manifest_id`, `binding` | `spent` only increases, `binding` is always `run` |
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

v1 has the PRD's 16 command forms plus `db migrate`, a setup verb.

| Verb | Arguments | Side effect | Records to | Cancel by |
| --- | --- | --- | --- | --- |
| `db migrate` | none | config | `config.migration` | nobody |
| `config apply` | `FILE`, `--expected-revision R`, optional `--activate --scope S` | config | `config.revision`, `config.activation`, event | nobody, a new Revision replaces it |
| `config export` | `kind.name@rev`, `--out FILE` | none | a YAML file | nobody |
| `run create` | `story:<id>`, optional `--process name@rev` | orca | `ledger.story`, `ledger.run`, `config.snapshot`, `ledger.task`, Orca `run-create` and `task-create` | operator, by a cancel event |
| `dispatch` | `--task T`, `--seat S`, `--generation N`, optional `--op-key K` | orca | `ledger.operation`, `ledger.evidence_manifest`, `ledger.dispatch`, start event, Orca `worker-start` | coordinator or operator, by `worker-stop` then `release` |
| `check` | optional `--wait`, `--generation N` | ledger | delivery and ignored events, `ledger.task`, Orca `check` ack and `task-create` | nobody |
| `retry` | `--dispatch D`, `--generation N`, optional `--op-key K` | orca | `ledger.operation`, `ledger.dispatch` with `retry_of`, Orca `worker-start --retry-of` | coordinator or operator |
| `release` | `--dispatch D`, `--generation N`, optional `--retain --reason R` | orca | release event, Orca `worker-release` | nobody |
| `verdict post` | `FILE`, `--generation N` | tracker | `ledger.gate_receipt`, `ledger.outbox` | operator, by voiding the receipt |
| `hqa record` | `story:<id>`, `--generation N` | tracker | `ledger.gate_receipt`, `ledger.outbox` | operator, by voiding the receipt |
| `decide` | `--task T`, `--category C`, `FILE`, `--generation N` | orca | `ledger.decision`, `ledger.decision_round`, `ledger.evidence_manifest`, decider and auditor `ledger.dispatch` rows, Orca `send` | operator or the escalating actor, by a cancel event |
| `state` | optional `--project P`, optional `--decisions` | none | nothing | not applicable |
| `takeover` | `story:<id>` | orca | `ledger.run.owner_generation`, takeover event, Orca `run-use` | nobody |
| `brief` | optional `story:<id>`, optional `--html FILE` | none | an HTML file | not applicable |
| `drain` | optional `--end` | ledger | drain event | operator |
| `learning add` | `FILE` | ledger | `ledger.learning`, learning event | nobody |
| `learning query` | optional `--story`, `--adoption`, `--text` | none | nothing | not applicable |

The evidence each side-effect verb requires before it acts:

| Verb | Evidence required |
| --- | --- |
| `run create` | a groomed Story with points in 1, 2, 3, 5, or 8 and a stage, and exactly one selected process Revision |
| `dispatch` | Task state `ready`, every dependency passed by Gate receipt, a free quota slot, an authorized Seat for the Role, reviewer independent of developer, no drain in force |
| `check` | the delivery's `payload.dispatchId` matches a recorded Dispatch, and its owner generation matches the Run |
| `retry` | Task state `blocked`, the original placement in `ledger.dispatch`, the worktree `git status` in the task view |
| `release` | the Dispatch is settled or the caller gives a retain reason, and this host owns the terminal |
| `verdict post` | Head SHA equals the current candidate SHA, and the reviewer is not the developer |
| `hqa record` | a source-verified comment by the human gatekeeper, or by the relay principal with a matching content hash, plus a deploy event for `hqa_after_deploy` |
| `decide` | the Reserved check passed, and an Evidence manifest is pinned |
| `takeover` | evidence that the old coordinator has stopped |

#### JSON envelope

Every verb prints one JSON object on stdout. The shape matches the one Orca receipts use.

```json
{ "ok": true, "result": { }, "meta": { "pod": "0.1.0", "orca": "1.4.211", "opKey": "...", "ownerGeneration": 3 } }
{ "ok": false, "error": { "code": "revision_conflict", "message": "...", "nextSteps": ["pod config export process.impl-small@2", "..."] } }
```

Every input is JSON on stdin or a file path. Every output is JSON. `--json` is the only mode. A human-readable render exists only in `pod brief` (HTML) and in `nextSteps`.

#### Exit codes

| Code | Meaning | What happened |
| --- | --- | --- |
| 0 | ok | the verb finished |
| 1 | failed | the verb failed after it started, and the error says where |
| 2 | usage or schema error | Pod sent nothing to Orca, the database, or the tracker |
| 3 | refused by a precondition | CAS, owner generation, selector, Reserved, or independence |
| 4 | result unknown | a side effect may have happened, the reservation is held, run the verb again with the same op key or run `pod check` |
| 5 | drained | a drain is in force and the verb would start new work |

#### Error codes

| Code | Exit | Fires when | `nextSteps` carries |
| --- | --- | --- | --- |
| `usage` | 2 | argv does not parse, or a required argument is missing | the verb's `pod --help` line |
| `schema_invalid` | 2 | stdin JSON, a file, or YAML fails its zod schema | the failing path and the expected type |
| `revision_conflict` | 3 | `expected_revision` differs from the active Revision | `pod config export` of the active Revision, then apply again with its id |
| `revision_immutable` | 3 | a caller tries to change an existing Revision | apply a new Revision with `parent` set |
| `selector_none` | 3 | no active process selector matches stage and points | the stage and points read, and the active process names |
| `selector_many` | 3 | more than one process matches | the matching Revision ids, and `--process` to name one |
| `selector_conflict` | 3 | `--process` and the `Kickoff:` line differ, or a named Revision's selector does not apply | both values, and a request to fix the Story or drop the flag |
| `role_unfilled` | 3 | a process Role has no authorized Seat in the active crew | the Role, and `pod config apply` of a crew that fills it |
| `reviewer_not_independent` | 3 | the reviewer Seat equals or is not independent of the developer Seat, or a Decision Role repeats on one artifact | the conflicting Seats and Dispatch ids |
| `owner_generation_stale` | 3 | the caller's generation is lower than `ledger.run.owner_generation` | `pod takeover story:<id>` if this session should own the Run |
| `task_not_ready` | 3 | the Task is not `ready`, or a dependency has no PASS receipt | the missing receipts and the Task state |
| `quota_exhausted` | 3 | no free slot on this host | the Dispatches holding slots, and `pod check --wait` |
| `launch_unknown` | 4 | Orca returned `outcome_unknown` or the reply was lost | the same command with the same `--op-key`, then `pod check` |
| `duplicate_op` | 3 | an op key returns with a different intent | a new op key with `retry_of` |
| `receipt_stale_sha` | 3 | a verdict's Head SHA is not the current candidate SHA, or the deployed revision does not match | the current candidate SHA, and a request for a new review |
| `receipt_unverified_source` | 3 | the comment author is not the keeper or the relay principal, the content hash differs, or readback failed | the gate id, and a note that the Gate stays waiting |
| `reserved_deny` | 3 | the Decision category or content hits a deny class | none beyond the recorded event |
| `reserved_needs_human` | 3 | the Decision hits a needs-human class, or a needs-existing-authorization class that the Story does not authorize | the brief line, and the tracker comment that awaits the human gatekeeper |
| `decision_budget_exhausted` | 3 | wall clock, relaunches, tool calls, or context tokens run out | the spent budget, and the needs-human item |
| `drained` | 5 | a verb would start a Dispatch while a drain is in force | `pod check` and `pod release`, which still run |
| `orca_version_unsupported` | 3 | the installed Orca version is outside the adapter's range | the supported range and the installed version |

#### Op keys

Every side-effect verb takes `--op-key` or derives one from the intent, which is the verb, Run, Task, Seat, and attempt number. The verb inserts a `ledger.operation` row with status `pending` before it calls Orca or the tracker. The same key returns the recorded result, or it reconciles when the status is `unknown`. A retry is a new key with `retry_of`. A content hash is a fingerprint only and never stands in for an op key.

#### Owner generation

`pod run create` sets `owner_generation` to 1 and returns it in `meta`. `pod takeover` increments it. Every side effect checks the caller's `--generation` against the row before the external call, in the same transaction that records the operation. This guard covers dispatch, ack, Gate, sync, release, and Decision write-back. It protects only the Pod path. A direct Orca command bypasses it, and `docs/contract.md` states that.

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
}

interface Receipt<T> {
  verb: string
  exitCode: number
  result: T | null
  raw: unknown            // every field zod did not name, kept
  orcaVersion: string
}
```

Each method takes a typed request and returns a typed receipt that zod parses from `--json` stdout. Unknown fields go to `raw` and are never dropped. The adapter never parses human text output.

#### The real adapter

The real adapter spawns `orca orchestration <verb> ... --json`. For each call it records a receipt `{verb, argv, exitCode, stdout, stderr, startedAt, endedAt, orcaVersion}` into `ledger.event` with source `receipt`. In record mode, set by `POD_ORCA_RECORD=<dir>`, it also writes the receipt as a fixture file.

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
| Orca 1.4.211 help lists `request-show`, which asks whether one orchestration mutation already took effect | `requestShow` is the first reconcile step, and its availability per version is an assumption until a fixture records it |

The adapter declares a supported Orca version range and refuses a call outside it with `orca_version_unsupported`. The first range starts at 1.4.211.

#### Fixture replay

`ReplayOrca` implements `OrcaPort` over a fixture directory. A fixture file is `fixtures/orca/<scenario>/NNN-<verb>.json`.

```json
{ "verb": "worker-start", "match": { "argv": ["--task", "task_1"] }, "exitCode": 0,
  "stdout": "{...}", "stderr": "", "orcaVersion": "1.4.211", "recordedAt": "2026-10-21T00:00:00Z" }
```

The replayer matches calls in order by verb and by the `match` subset of argv. An unmatched call, an extra call, or a missing call fails the test and prints the diff. Unit tests never call a live Orca.

The first fixtures come from re-recording the proof-of-concept scenarios the PRD names.

| Scenario | What it proves |
| --- | --- |
| `lost-launch-reply` | the same op key returns the existing result or stops with the reservation held, and the recorded calls show no second `worker-start` |
| `two-coordinator-handoff` | the old coordinator's dispatch, ack, verdict, and release are refused before the side effect |
| `stale-dispatch-id` | a delivery with a stale `dispatchId` or owner generation is recorded as `ignored` and moves no state |
| `capacity-1` | a blocking Decision obtains both Seats in sequence, and the waiting Task releases its slot |
| `drain` | no new Dispatch starts, Decision Seats included, while `check`, `release`, and reconcile still run |

#### Scrubbing

A scrubber runs on record. Hostnames become `host-a` and `host-b`. Worktree paths become `/w/<n>`. User names become `user-<n>`. A fixture lint fails CI when any term from a denylist file outside the repo matches. `POD_SCRUB_DENYLIST` names that file, so the denylist itself never enters the repo.

Fixtures carry `orcaVersion`. Re-recording against a new Orca version is a story task. A receipt schema change surfaces as a zod parse failure in replay.

#### Tracker and docs ports

`TrackerPort` (Linear) and `DocsPort` (Notion) follow the same pattern. The real adapters record HTTP receipts, and tests replay them.

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

### Process spec loading and the selector

A process spec is a YAML file. zod parses it into the process schema.

| Field | Shape |
| --- | --- |
| `kind` | `process` |
| `schema_version` | integer |
| `name` | string |
| `summary` | string |
| `selector` | `{ stage, points[] }` |
| `roles` | list of Role names |
| `steps[]` | `id`, `type` in `worker`, `external_action`, `human_wait`, `role`, `needs[]`, `produces[]`, `gate`, `adapter`, `event_fields`, `binds` |
| `edges[]` | `from`, `on` (string or list), `to`, `new_task`, `then` |
| `limits` | `{ attempts_per_task, rework_per_lineage }` |
| `escalation` | `{ to }` |

#### Validation at apply

`pod config apply` refuses a process spec unless every rule below holds.

- Every step is reachable from the first step.
- Every step has an outgoing edge for each outcome its type allows, from `done`, `PASS`, `FAIL`, `timeout`, `cancel`, and `unknown`.
- No edge points to an unknown step. `hold` and `done` are reserved edge targets.
- Every Role has an authorized Seat in the active crew.
- The reviewer is independent of the developer.
- Every gate id exists in the active policy.

The canonical JSON of the parsed value is hashed into the Revision id. A process spec names no keeper. Policy owns keepers.

#### Reference excerpt

The excerpt below is `specs/process/impl-small.yaml`.

```yaml
kind: process
schema_version: 1
name: impl-small
summary: 1 or 2 point impl, one developer, one independent reviewer, one PR
selector: { stage: impl, points: [1, 2] }
roles: [developer, reviewer, lead]   # apply checks the crew fills them and the reviewer is independent
steps:
  - { id: implement, type: worker, role: developer, produces: [commit] }
  - { id: review, type: worker, role: reviewer, needs: [implement], gate: review }
  - { id: pr, type: worker, role: developer, produces: [pr] }
  - { id: merge, type: human_wait, gate: merge }   # the existing merge authorization
  - id: deploy
    type: external_action
    adapter: deploy
    event_fields: [environment, deployment_id, deployed_revision, source_commit]
  - { id: hqa, type: human_wait, gate: hqa_after_deploy, binds: deployed_revision }
edges:   # all explicit, a missing edge refuses the apply
  - { from: implement, on: done, to: review }
  - { from: review, on: PASS, to: pr }
  - { from: review, on: FAIL, to: implement, new_task: true, then: review }
  - { from: review, on: [timeout, cancel, unknown], to: hold }
  - { from: pr, on: done, to: merge }
  - { from: merge, on: PASS, to: deploy }
  - { from: deploy, on: done, to: hqa }
  - { from: hqa, on: PASS, to: done }
  - { from: hqa, on: FAIL, to: implement, new_task: true, then: review }
limits: { attempts_per_task: 3, rework_per_lineage: 3 }
escalation: { to: decision-pair }
```

#### The five reference process specs

| Process | Selector | Steps | Human Gate |
| --- | --- | --- | --- |
| `prd@1` | stage prd | draft (writer), audit (auditor), `prd_review` | `prd_review` |
| `design@1` | stage design | design (designer), taste QA (taste reviewer), `design_clickthrough` | `design_clickthrough` |
| `impl-small@1` | stage impl, points 1 or 2 | implement, review, pr, merge, deploy, `hqa_after_deploy` | `hqa_after_deploy` |
| `impl-3pt@1` | stage impl, points 3 | plan (planner), plan review (Decision pair, automated Gate), implement, story QA (qa), pr, merge, deploy, `hqa_after_deploy` | `hqa_after_deploy` |
| `impl-planned@1` | stage impl, points 5 or 8 | plan (planner), plan review (Decision pair, automated Gate), implement (several Tasks), review per Task, review of the integrated candidate SHA, pr, merge, deploy, `hqa_after_deploy` | `hqa_after_deploy` |

A 1 or 2 point Story has no plan step. `story-full@1`, which chains and splits across stages, is phase 2.

#### Selector

The selector is a pure function in `core/process`.

```ts
function selectProcess(input: {
  stage: string
  points: 1 | 2 | 3 | 5 | 8
  kickoffLine: ProcessRef | null
  cliProcess: ProcessRef | null
  activations: readonly ActiveProcess[]
}): { ok: true, revisionId: RevisionId } | { ok: false, code: SelectorErrorCode }
```

It applies four precedence rules in order.

| Rule | Condition | Result |
| --- | --- | --- |
| 1 | `--process` and the Story's `Kickoff:` line are both present and differ | refuse with `selector_conflict` |
| 2 | one of them names a Revision | check that Revision's selector against stage and points, and refuse with `selector_conflict` when it does not apply |
| 3 | neither is present | match the project activations, then the global activations, by selector. Zero matches refuse with `selector_none`, several refuse with `selector_many` |
| 4 | any case | no override changes the effective gate map. Gates come only from policy |

A table-driven test enumerates stage, points, `Kickoff:` line, and `--process` offline. Each combination yields exactly one Revision or one refusal code.

#### Projector

The projector is a scribe, not a judge. It turns each step into an Orca Task through `taskCreate`, with `deps` from the step's `needs`. The edge table drives transitions on verified outcomes, and a Gate receipt is the verified outcome for a gated step. A completed Orca Task is never a PASS.

- `new_task: true` creates a Task in the same lineage and counts it against `rework_per_lineage`. At the limit, the lineage goes to `hold`.
- A `human_wait` step starts no worker.
- An `external_action` step waits for its event with the listed `event_fields`.
- A step with no Gate treats its recorded delivery as outcome `done`.
- Each projection carries its own op key, so replaying an event creates no Task twice.

#### Task states

`core/domain` models the Task as a typed state machine and refuses any transition the table below does not list.

```ts
type TaskState = 'pending' | 'ready' | 'dispatched' | 'delivered' | 'passed' | 'failed' | 'blocked' | 'hold' | 'done'
```

| From | To | Trigger |
| --- | --- | --- |
| `pending` | `ready` | every Task in `deps` is `passed` or `done` |
| `ready` | `dispatched` | `pod dispatch` records a start event for a worker step |
| `ready` | `delivered` | an `external_action` event or a `human_wait` Gate receipt arrives |
| `dispatched` | `delivered` | `pod check` records a delivery that matches the Dispatch and the owner generation |
| `dispatched` | `blocked` | Orca reports the Task `blocked` after `worker-stop` |
| `blocked` | `dispatched` | `pod retry` starts a new Dispatch with `retry_of` |
| `delivered` | `passed` | a PASS Gate receipt, or a delivery on a step with no Gate |
| `delivered` | `failed` | a FAIL Gate receipt |
| `passed` | `done` | the projector records the outgoing edge |
| `failed` | `done` | the projector creates the rework Task, and the failed Task never reopens |
| any state except `done` | `hold` | a `timeout`, `cancel`, or `unknown` outcome, a cancel event, or a lineage at its rework limit |
| `hold` | `ready` | the operator resumes after reconcile, with no automatic retry |

### The decision layer seats

The decider and the auditor are Roles in the crew Revision. They share the quota table with worker Seats and start in sequence, so capacity 1 never deadlocks.

#### What `pod decide` does

1. Read the policy's Reserved table first, with the classes deny, needs_human, and needs_existing_authorization. Cross-check the category against the content and the scope, so a spend question relabeled `tradeoff` still hits the check.
2. Pin an Evidence manifest from the local evidence, the state view, and the applicable Decisions.
3. Open or reuse the Run's decider Dispatch and auditor Dispatch. `ledger.dispatch` records both with Role `decider` or `auditor` and Run lifetime.
4. Send round 1 through `send` with the manifest reference.
5. Run the round state machine. Rounds 2 and 3 are `send` messages that carry only the audit comments and the points of disagreement, never the manifest again.
6. Record a `decision` event. An agreed outcome becomes a new Task spec Revision bound to the Run.

A Decision authorizes the next step only. `pod verdict post` and `pod hqa record` refuse a Decision outcome as a PASS. A scope or spec change creates a new Revision and makes the earlier review stale.

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
| `round(n)` | both agree | dependencies re-checked, then `agreed` |
| `round(n)` | both agree, but a dependency's source Revision changed | `needs_human` with reason `context-missing`, and the outcome is not executable |
| `round(n)` | one side escalates | affected actions stop first, the other side evaluates, and continued disagreement counts as a round |
| `round(n)` | auditor answers needs_evidence | `awaiting_evidence(n)`, which is not a round and counts against `tool_calls` |
| `awaiting_evidence(n)` | the evidence joins the manifest | `round(n)` |
| `round(n)`, n below 3 | disagree | `round(n+1)` |
| `round(3)` | disagree | `needs_human` with reason `disagreement`, carrying both final positions and the points of disagreement |
| any open state | deadline, missing data, Seat failure, or an identity Pod cannot verify | `needs_human` with reason `runtime-failure` or `context-missing`, with no rounds spent |
| any open state | budget exhausted | `needs_human` with reason `runtime-failure` |
| any open state | cancel by the escalating actor or the human | `cancelled`, the affected Task goes to `hold`, with no automatic reopen |
| any open state | Seat failure or coordinator interruption, then recovery | the same Decision id and state, with rounds and manifest kept, after the owner generation check |
| `needs_human` | a human ruling comment that passes source verification and readback | `agreed` or `cancelled`, as the ruling says |
| `agreed` | a later Decision cites this id | `superseded` |

On recovery, Pod reopens the failed Seat's Dispatch with a summary of earlier positions. The reopen counts against `relaunches`.

#### Budgets

The budget lives on the `ledger.decision` row. It has four fields, which are wall clock, relaunches, tool calls, and context tokens. `spent` decrements the remaining budget across relaunches and never resets. An injected timeout and relaunch keep the lineage budget.

#### Escalation threshold

Only four cases open the loop. They are a change beyond the Story's scope, an effect on another Story, a new dependency, and a choice between two architectures. The policy's `escalate_when` lists them. A process step can narrow the list and never widen it. Anything else, the developer decides and records as a `self_decision` event with no rounds and no Decision Seats.

#### Role exclusion

The author, proposer, auditor, and gatekeeper of one artifact are distinct Seats. Pod checks this against `ledger.dispatch` and `ledger.gate_receipt` for the same artifact. An auditor Seat that wrote an artifact's audit is not that artifact's Decision auditor. On a violation, Pod refuses with `reviewer_not_independent`.

#### Binding

Binding is `run` only. A project or global change is a recommendation that goes to needs-human. It takes effect only as a policy Revision the human gatekeeper authorizes. A Decision can be overruled, never rewritten. A new Decision cites the old id in `supersedes_decision_id`.

#### Gate-lift

The policy schema validates `profiles`. A profile may replace only `prd_review` and `design_clickthrough` with a Decision-pair automated Gate. `hqa_after_deploy` and `staging_review` stay with the human gatekeeper. A lifted Gate records an automated PASS, never a human one. In v1 the executor refuses every profile activation. The schema fixtures cover a lift outside the two Gates, a lift on a running Run, an added Gate, and a missing policy Revision, and each is refused.

### Versioning, release, and migration policy

| Area | Rule |
| --- | --- |
| Pod version | semver. The CLI JSON envelope and the exit codes are the public interface. A breaking change to the envelope, a verb's input, or an exit code bumps major. A new verb or a new optional field bumps minor. |
| Spec schemas | `schema_version` per kind, versioned independently of Pod. A reader supports the current and the previous schema version. |
| Revisions | never migrated in place. To move a spec forward, the operator exports it, edits it, and applies a new Revision with `parent` set. |
| Database migrations | forward-only numbered SQL. A PR that changes a table ships its migration. `pod db migrate` is idempotent. |
| Protected rows | a migration never rewrites `config.revision` values or `ledger.event` rows. |
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
| `db.url_env` | the name of the environment variable that holds the connection string |
| `tracker.kind` | `linear` |
| `tracker.token_env` | the name of the environment variable that holds the tracker token |
| `docs.kind` | `notion` |
| `docs.token_env` | the name of the environment variable that holds the docs token |
| `capacity` | the Seat quota on this host |
| `record_dir` | optional, the fixture record directory |

The file holds no secrets. It names environment variables instead. The host profile is not a Revision because it names local secrets and a local Orca, and a Revision is meant to be shared and pinned.

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

The operator applies it with `pod config apply crew.yaml --activate --scope project:<id>`.

#### Adopt Pod on a host

1. Clone the Pod repo.
2. Run `pnpm install`.
3. Set the environment variables for the database URL, the tracker token, and the docs token.
4. Write `$POD_HOME/host.yaml` with the names of those variables.
5. Run `pod db migrate`.
6. Apply the five reference process specs from `specs/process/` with `pod config apply --activate --scope global`.
7. Apply `specs/policy/policy.yaml` with `--activate`.
8. Copy `specs/crew/crew.example.yaml`, fill it, and apply it with `pod config apply crew.yaml --activate --scope project:<id>`.
9. From a worktree that the operator's claim authority chose, run `pod run create story:<id>`.
10. Run `pod dispatch --task T --seat S` for each ready Task the claim authority authorizes.
11. Run `pod check --wait` to record deliveries and project the next Tasks.

The operator's existing grooming, planning, kickoff, and docs tools stay outside Pod and keep working as they do. Pod refuses to start a second crew for a Story that already has a Run.

### Story order and what each adds

S1 carries the repo scaffold, which is the toolchain, the import-boundary lint, an empty registry, CI, and `docs/contract.md`. Its acceptance test reads `pod --help`, so the scaffold must exist first. This is a grooming note for S1.

The order is S1, then S2, then S3 with S4, then S5 with S6, then S7 with S8, then S10, then S9 with S11 with S12, then S13, then S14. S10 lands before S11 so the state view can read learnings.

| Order | Story | Key | Points | Adds to the tree | First fixture scenarios | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S1 Authorization and completion contract | TPC-1113 | 2 | `package.json`, `tsconfig.json`, `src/cli/verbs.ts` empty registry, boundary lint config, CI workflow, `docs/contract.md` | none, the contract test reads `pod --help` | none |
| 2 | S2 Config revisions and minimum ledger | TPC-1114 | 3 | `src/core/config`, `src/core/ledger`, `src/adapters/postgres`, `db/migrations/0001` with `config.revision`, `config.activation`, `config.snapshot`, `config.migration`, `ledger.story`, `ledger.run`, `ledger.task`, `ledger.dispatch`, `ledger.event`, `ledger.operation`, verbs `db migrate`, `config apply`, `config export` | test-database cases for CAS conflict, bundle read, dropped connection, and restore | S1 |
| 3 | S3 Single-host Orca adapter | TPC-1115 | 5 | `src/core/ports/orca.ts`, `src/adapters/orca`, `fixtures/orca/`, verbs `run create`, `dispatch`, `check`, `retry`, `release`, `takeover`, `drain` | `lost-launch-reply`, `two-coordinator-handoff`, `stale-dispatch-id`, `capacity-1`, `drain` | S2 |
| 3 | S4 Evidence manifest, task view, and brief | TPC-1116 | 2 | `src/core/manifest`, `ledger.evidence_manifest`, verb `brief` | `retry-git-status`, `planted-secret-scan` | S2, and S3 for the task view |
| 4 | S5 Process schema, selector, and impl-small projector | TPC-1117 | 3 | `src/core/process`, `specs/process/impl-small.yaml` | `review-fail-rework`, `integration-review` | S2, S3 |
| 4 | S6 Gate receipts and tracker sync | TPC-1118 | 3 | `src/adapters/linear`, `ledger.gate_receipt`, `ledger.outbox`, verbs `verdict post`, `hqa record` | `tracker-dropped-reply`, `tracker-canceled`, `edited-comment`, `forged-author` | S2 |
| 5 | S7 Integrated failure drill | TPC-1119 | 2 | `test/drill/` | `integrated-drill` | S3, S5, S6 |
| 5 | S8 Dogfood A, wiring and measurement | TPC-1120 | 1 | `specs/crew/crew.example.yaml`, brief counters | `dogfood-a` | S3, S4, S5, S6 |
| 6 | S10 Learning records | TPC-1122 | 2 | `ledger.learning`, verbs `learning add`, `learning query` | none, ledger tests only | S2 |
| 7 | S9 Remaining reference process specs | TPC-1121 | 3 | `specs/process/prd.yaml`, `design.yaml`, `impl-3pt.yaml`, `impl-planned.yaml` | none, apply tests only | S5 |
| 7 | S11 State view | TPC-1123 | 1 | `src/adapters/notion`, `ledger.usage_observation`, verb `state` | `docs-section-read` | S4, S10 |
| 7 | S12 Minimal decision loop | TPC-1124 | 3 | `src/core/decide`, `ledger.decision`, `ledger.decision_round`, verb `decide` | `decision-happy-path`, `decision-fallback` | S3, S4, S11 |
| 8 | S13 Decision failures and authorization | TPC-1125 | 3 | Reserved checks, `profiles` schema, Decision recovery | one scenario per Decision state table row, `gate-lift-refused` | S12 |
| 9 | S14 Dogfood B, decision measurement | TPC-1126 | 2 | measurement fields in the brief | `dogfood-b` | S9, S12, S13 |

The points total 35. In position 7, S11 merges before S12 because the Decision manifest reads the state view.

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
| 8 | every row of the Decision state table replays to its listed state, and every gate-lift activation is refused |
| 9 | dogfood B's ledger holds a source-verified reviewer PASS on the final candidate SHA and a source-verified `hqa_after_deploy` PASS on the deployed revision, and neither keeper is a Decision Seat |

## Verification

Three checks verify this spec and the code that follows it.

1. The completion check reads this file and confirms that the nine required sections exist as `###` headings under `## Design`, in the order they appear there, with the later milestones section after them.
2. The scope scan runs the denylist that `POD_SCRUB_DENYLIST` names over this file, `specs/`, `fixtures/`, and `docs/`. It matches whole words, case-insensitive, and passes only at zero matches.
3. The registry contract test, from S1 on, asserts that every verb row with a side effect appears in `docs/contract.md` with its `cancelBy` and `evidenceRequired`, and that every verb in the table under "Verbs" exists in the registry.

## Open questions

Each question carries the default this spec assumes. A story that needs the answer confirms the default or changes it in its own PR.

| Question | Default |
| --- | --- |
| Does `db migrate` count toward the PRD's 16 command forms? | No. It is a setup verb outside the count. |
| Does S1 carry the repo scaffold? | Yes. S1's acceptance test reads `pod --help`, so the scaffold lands with it. |
| Which hash algorithm and canonical form does Pod use for content hashing? | sha256 over RFC 8785 style canonical JSON. |
| Does the Db adapter use the `postgres` driver or `pg`? | `postgres`. |
| How does a drain end? | The operator runs `pod drain --end`, which records a drain event with `ended: true`. |
