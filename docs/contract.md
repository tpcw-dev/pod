# Authorization and completion contract

Source: docs/tech-spec.md at 6a7fec0.

Spec clarification: Verification item 3's 17-verb check is the todo table in test/bypass/contract.test.ts until the story that adds the verb. While the registry is empty, the side-effect check also requires this contract's table to list exactly the 13 pinned verbs.
Spec clarification: pod --help prints one JSON object with ok true, result.verbs an array of name, sideEffect, cancelBy, and evidenceRequired, and meta.pod the package version. An empty registry prints result.verbs as an empty array and meta.pod 0.1.0.
Spec clarification: a Cancel by cell holds only operator, coordinator, and nobody. The rest of the spec's cancel-by wording is the Note cell. dispatch and retry use coordinator, operator. decide uses operator, and its Note is the escalating actor.
Spec clarification: the bypass paragraphs are lines 744, 746, and 748 of docs/tech-spec.md at 6a7fec0. Lines 745, 747, and 749 are blank. The contract test pins 744, 746, and 748.
Spec clarification: S2 enforces the config apply envelope and CAS; the Role and gate id checks land with S5, S8, and S13.
Spec clarification: S4 registers brief with side effect none, so it stays out of the side-effect table; its Cancel by is nobody for the spec's not applicable.
Spec clarification: S3a makes the registry's cancelBy an array, because dispatch is cancelled by coordinator, operator. pod --help prints the array, and the contract test compares it joined with ", " against the Cancel by cell.
Spec clarification: S3a takes --size and --stage on pod run create in place of the tracker read, until S6 reads the Story through a TrackerPort and keeps both flags as overrides. A missing --size or --stage is selector_none.
Spec clarification: S3a reads the Run's coordinator from POD_COORDINATOR. pod run create exits usage when it is unset.
Spec clarification: S3a records a dispatch refusal at steps 1 and 3 to 7 under its op key, as the spec's refused status requires, so a key-less pod dispatch for the same Task and Seat replays the refusal. After a transient quota_exhausted or drained, the caller passes a new --op-key; S3b's pod check prints that key, as the S3b line says.
Spec clarification: S3b prints the next key. After a pod check pass that leaves a slot free, each refused dispatch operation of the Run with code quota_exhausted or drained whose Task is ready adds `pod dispatch --task T --seat S --generation N --op-key K` to result.nextSteps, K being the derived dispatch key at the lowest attempt with no operation row.
Spec clarification: S3b adds `--run R` to pod check, because the spec names no Run argument. The pass form takes `--run R --generation N`, with `--wait [--interval S] [--timeout S]`; the resume form takes `--resume` with exactly one of `--run R` or `--task T`.
Spec clarification: S3b's pod check runs from the Run's coordinator terminal, because Orca answers check --run from any other terminal with consumer_fenced. It acks a whole batch by its deliveryId after the batch is recorded, and a message id already on an event is skipped when an un-acked batch is read again.
Spec clarification: S3b records a delivery whose Dispatch is settled, or is not its Task's latest Dispatch, as ignored with reason settled_dispatch; that Dispatch's id is stale in the sense of the ignored event, so a stopped attempt's late message moves nothing after a retry.
Spec clarification: S3b's pod check reconciles an unknown launch operation by moving its Task from hold to dispatched when request-show or the worker list proves the worker, and from hold to ready with a resume event when the worker list shows none. These are reconcile moves, not an operator resume; a pending request-show with no worker keeps the operation unknown.
Spec clarification: S3b leaves a Task delivered when its waiting Dispatch is stopped, because "Task states" lists only dispatched to blocked for worker-stop; pod retry refuses that Task with task_not_ready.
Spec clarification: S3b moves a Task on a delivery only from dispatched, as the S3b outcome table says, and only when the delivery moved its open Dispatch. An unknown outcome holds a dispatched Task; a Task already delivered keeps its state, and the delivery event records the outcome.
Spec clarification: S3b records each Dispatch's worktree as `id:<worktree id>` in requested_launch.worktree from the start receipt or the worker list, and pod retry passes that selector with --retry-of and reads git status in that path. A Dispatch with no recorded id worktree is task_not_ready.
Spec clarification: S3b takes a Dispatch's host from its start event, because ledger.dispatch.owner_host is never written. The release event is the release mark. Only released and already_released finish a Dispatch's release; retained and release_pending leave the next pod release free to call worker-release again. release_unknown leaves the operation unknown and exits 1 failed.
Spec clarification: S3c. On Orca 1.4.211, run-use binds the named coordinator terminal and raises the Run's consumer_generation, and check --run from any other terminal answers consumer_fenced, so after a takeover the old coordinator's check stops working, unlike the Orca facts row at line 675. Pod still requires evidence that the old coordinator stopped, because run-use fences the inbox and not the old coordinator's dispatch or release. The binding and the consumer_generation raise show in the two-coordinator-handoff fixture's 007-run-use receipt; consumer_fenced rests on a probe run on the recording host, not on a committed receipt. Because run-show and run-current read the same for an open and a closed coordinator terminal, pod takeover reads terminal show for each coordinator handle and accepts connected false with an exitCause, or terminal_handle_stale. pod drain takes `--run R`, because the spec names no Run argument.

## Authority

Cited from "Constraints".
- The database is the authority for configuration, process, mapping, and Decisions. Orca is the authority for execution state. The tracker is the authority for intake, human priority, cancel, and human verdicts. The ledger holds sourced, timestamped projections. It never decides work.
- Each execution binding has one owner. The host that starts a Dispatch is the only host that stops and releases it.
- Pod does not schedule. The operator's claim authority decides claim and dispatch. Pod executes that authorization and refuses a second crew for the same Story.

## Side-effect commands

| Verb | Side effect | Cancel by | Note | Evidence required |
| --- | --- | --- | --- | --- |
| `db migrate` | config | nobody |  | a reachable database and a `db/migrations/` journal that matches the applied-migrations table |
| `config apply` | config | nobody | a new Revision replaces it | a file that passes its schema, every Role filled and every gate id present when the kind is process, and `expected_revision` equal to the active Revision when `--activate` is set |
| `run create` | orca | operator | by a cancel event | a groomed Story with a size and a stage, and exactly one selected process Revision |
| `dispatch` | orca | coordinator, operator | by `worker-stop` then `release` | Task state `ready`, every dependency satisfied as "Task states" defines, a free quota slot, which on an xl Run counts the coordinator's slot as released by the dispatch transaction, an authorized Seat for the Role, reviewer independent of developer, no drain in force |
| `check` | ledger | nobody |  | the delivery's `payload.dispatchId` matches a recorded Dispatch, and its owner generation matches the Run |
| `retry` | orca | coordinator, operator |  | Task state `blocked`, the original placement in `ledger.dispatch`, the worktree `git status` in the task view |
| `release` | orca | nobody |  | the Dispatch is settled or the caller gives a retain reason, and this host owns the terminal |
| `verdict post` | tracker | operator | by voiding the receipt | Head SHA equals the current candidate SHA, and the reviewer is not the developer |
| `hqa record` | tracker | operator | by voiding the receipt | a source-verified comment by the human gatekeeper, or by the relay principal with a matching content hash, plus a deploy event for `hqa_after_deploy` |
| `decide` | orca | operator | or the escalating actor, by a cancel event | the Reserved check passed, an Evidence manifest is pinned, and the `effect` fits the Task as "Decision effects" requires |
| `takeover` | orca | nobody |  | evidence that the old coordinator has stopped, which on an xl Run is the decider Dispatch |
| `drain` | ledger | operator |  | an owner generation that matches the Run |
| `learning add` | ledger | nobody |  | a source Story, at least one evidence reference, and an `area` |

## Bypass-test pass condition

Cited from "Trust boundary and the bypass test".
The relay principal is an independent principal that posts under its own tracker identity. Its token lives only in the human's interactive session, and no dispatched terminal inherits it. The receipt records `relayed_by` with the relay session id and the content hash. The relay passes on only what the person said. It reads no Story or verdict and judges no PASS. Text a worker Seat posts never counts, even when it is identical.
That a worker cannot produce the human's comment is a premise, not a fact. The premise is that a worker cannot reach the human's tracker token, login session, or the relay's token. The bypass test proves it. With worker-equivalent rights on a controlled test Story, an attempt to post as the human gatekeeper and an attempt to post as the relay principal both land only as the worker identity, and the output contains no secret. A second check feeds the relay a Story whose text says PASS, and the relay posts no PASS of its own. S1 ships the test under `test/bypass/`. Each run records a `receipt` event with source `command`, the host, and the result, and the adoption procedure runs it before the first `pod hqa record`.
When the test fails on a host, every human receipt on that host stays waiting, and `pod hqa record` refuses with `receipt_unverified_source`. The remedy is to move the relay principal to a separate OS user or a separate host and run the test again. Pod does not narrow receipts to the person's own tracker account.

## Reserved categories

Cited from "Policy schema".
| Reserved class | Members | Result |
| --- | --- | --- |
| deny | live trading, evidence tampering, safety-limit removal | refused at once |
| needs_human | any spend, credentials, data deletion, a production deploy, a Gate change on a running Run, a policy change, a driver or gatekeeper change | needs-human with reason `policy-required` |
| needs_existing_authorization | repo creation, which the Story spec must name, and VPS SSH, which needs an infrastructure Story | the loop runs when the Story authorizes it, and needs-human otherwise |

## Selector precedence

Cited from "Selector".
| Rule | Condition | Result |
| --- | --- | --- |
| 1 | `--process` and the Story's `Kickoff:` line are both present and differ | refuse with `selector_conflict` |
| 2 | one of them names a Revision | check that Revision's selector against stage and size only. A named Revision needs no activation. Refuse with `selector_conflict` when the selector does not apply, and with `selector_none` when no Revision has that `kind.name@rev` |
| 3 | neither is present | match the project activations, then the global activations, by selector. Zero matches refuse with `selector_none`, several refuse with `selector_many` |
| 4 | any case | no override changes the effective gate map. Gates come only from policy |
When `--process` and the `Kickoff:` line name the same Revision, rule 2 applies. Under rule 3, zero project matches fall through to the global activations before a refusal.

## Stop and reconcile

Cited from "Verbs", "Op keys", "Owner generation", "The real adapter", and "Task states".
`pod drain --end` ends a drain and records a `drain` event with `ended: true`. `pod check --resume` records an operator resume of a Run or a Task from `hold` as a `resume` event. `pod takeover` writes a restore view from the same manifest. `pod brief` marks a Revision with no matching file under `specs/` as drift.
The verb inserts a `ledger.operation` row with status `pending` before it calls Orca or the tracker. The same key returns the recorded result, or it reconciles when the status is `unknown`. A retry is a new key with `retry_of`. A content hash is a fingerprint only and never stands in for an op key.
`pod run create` sets `owner_generation` to 1 and returns it in `meta`. `pod takeover` increments it. Every side effect checks the caller's `--generation` against the row before the external call, in the same transaction that records the operation. This guard covers dispatch, ack, Gate, sync, release, and Decision write-back. A direct runtime launch on a Pod-managed Run is a contract violation, and `docs/contract.md` states that. `pod check` compares the runtime's worker list for the Run, read through `workerList`, against `ledger.dispatch`. It records an `unknown_launch` event for every worker the ledger does not know and moves the Run to `hold`, which sends every open Task to `hold` and blocks new Dispatches until the operator reconciles.
A cancel comes from the tracker. `pod check` reads the Story on every run, and a tracker Canceled records a `cancel` event, which blocks new Dispatches on that Run at once and sends every open Task to `hold`. No Pod verb cancels a Story. An emergency stop is `worker-stop`, which `pod check` then reconciles.
Exit 1 with `outcome_unknown` maps to the `launch_unknown` path. The operation stays `unknown`, the reservation stays held, and `requestShow` is the first reconcile step. Without evidence that rules out a duplicate, Pod does not start again.
| From | To | Trigger |
| --- | --- | --- |
| `hold` | `ready` | the operator resumes after reconcile with `pod check --resume`, with no automatic retry |

## Emergency stop

An emergency stop is by a person, at any time, and pod check then reconciles it, with no automatic release or retry.

Cites PRD v1.1.1, Flow 3 step 2.
