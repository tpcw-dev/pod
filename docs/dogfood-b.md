# Dogfood B

Recorded Run `run_89963994885a`. Process `impl-xlarge@1`. The Story was one real xl Story, the policy profiles story, with three Checkpoints. `pod run create` opened the coordinator pair at Run start. The decider Dispatch is `ctx_e477711cb6c3` and the auditor Dispatch is `ctx_7e7698e06f4d`. The environment is `local`.

The plan, implement, review, integration_review, and pr Tasks were worker Dispatches. The plan Task passed through one `accept_plan` Decision of the pair. The merge and `hqa_after_deploy` Tasks waited on the keeper. The deploy Task was delivered by `pod deploy record` after `pnpm deploy:local`.

## Measurement

This is the Measurement table that `pod brief --html` rendered for the Run, `measurement-run_89963994885a`.

| seat | id | prompt bytes | cold start ms |
| --- | --- | --- | --- |
| decider | decider | 629 | 5748 |
| auditor | auditor | 1364 | 3681 |

| decision | state | reason | effect | outcome |
| --- | --- | --- | --- | --- |
| `dec_d00a5b0eb02b2f910afcbd056fd579b22b80006304fae1f2a1b7d9b155d21f2b` | agreed | agreed | accept_plan | adopted |

| policy-required | disagreement | context-missing | runtime-failure | worker | sample |
| --- | --- | --- | --- | --- | --- |
| 0 | 0 | 0 | 0 | 0 | 1/10 |

Escalations by reason: policy-required 0, disagreement 0, context-missing 0, runtime-failure 0, and worker 0. The natural sample is 1 of 10 target. One Decision is not a sample from which a rate can be read.

The one Decision has outcome `adopted`. The decider proposed to accept the plan as written, with its one addition beyond the Story's Constraints: an optional `pod run create --project` and a snapshot `project` column. The auditor agreed in round 1. No later Decision superseded it, and no rework Task followed.

The pair cost 629 prompt bytes and a 5748 ms cold start for the decider, and 1364 prompt bytes and a 3681 ms cold start for the auditor. Both cold starts are `dispatch.created_at - operation.created_at` on the live ledger.

## Deploy and receipts

`pnpm deploy:local` on `origin/main` printed tag `v0.1.1` and SHA `ff0fe227b83a2d37b50b398d9e3aed17075fc27c` as both `deployed_revision` and `source_commit`. That SHA is the squash merge of the candidate `0cbc3ee2bca8c5da657ee80ff746674c9280b02e`. `pod deploy record` admitted it because both commits have the same tree.

| Receipt | Verb | Keeper | Bound to |
| --- | --- | --- | --- |
| review PASS | `verdict post` | seat `reviewer` | candidate `0cbc3ee2bca8c5da657ee80ff746674c9280b02e` |
| integration_review PASS | `verdict post` | seat `integrator` | candidate `0cbc3ee2bca8c5da657ee80ff746674c9280b02e` |
| merge PASS | `hqa record` | `keeper` | candidate `0cbc3ee2bca8c5da657ee80ff746674c9280b02e` |
| hqa_after_deploy PASS | `hqa record` | `keeper` | deployed revision `ff0fe227b83a2d37b50b398d9e3aed17075fc27c` |

No keeper is a Decision Seat. The Decision Seats are `decider` and `auditor`. The `verdict post` keepers are crew reviewer seats. The `hqa record` keeper is the operator's own tracker account, whose comments `pod hqa record` verified at the source. No `receipt_keeper_is_decision_seat` refusal occurred.

Wall clock is from the first ledger event of the Run at 2026-11-08 22:26:30.629+00 to the `hqa_after_deploy` receipt at 2026-11-09 23:45:06.454+00, which is 25h 18m 35.825s. It includes both human waits and the deploy gap described in finding 8.

`pod brief` counters for the Run:

| Figure | Dogfood B |
| --- | --- |
| coordinator_operations | 21 |
| recovery_steps | 2 |
| retries | 0 |
| rework_tasks | 0 |
| hand_filled | 6 |
| fallback_launches | 0 |
| model_mismatches | 0 |

## Operator steps

The operator ran every `pod` verb from the terminal that ran `pod run create`. Finding 2 says why. The operator also sent these messages. Each one is a hand step that the ledger does not count:

1. To the decider before the first round, it sent the `decision_gate` proposal form that the `decider` template carries.
2. To the developer of the implement Task, it sent where the agreed plan is, that all three slices are its work, and that `worker_done` carries `head`. It sent the same text again as the reply to the developer's question.
3. To the reviewer, it sent the order of the verdict and `worker_done`. To the integrator, it sent the order of `worker_done`, a read-only poll, and then the verdict.
4. To the pr Task's developer, it sent the PR brief. Later the operator typed into that Seat's terminal that it should rerun the suite in directory chunks, after it had killed a test run that stalled.

## Findings

1. Orca 1.4.253 prints a concise view for `orchestration <verb> --json`. Pod's adapter read only the full record, so the first `pod run create` exited 4 `launch_unknown`. That was fixed before this recording, by passing `--full`.
2. The decider Seat cannot run the Run's `pod` verbs. Orca refuses a Dispatch that coordinates its own Run with `worker_cannot_coordinate_own_run`. The decider's own first `pod check` is in the recording as that refusal. The operator terminal is the Orca Run's coordinator, and it ran every verb at generation 1.
3. The xl decider opens with the `coordinator_open` template, which has no `decision_gate` reply form. In the first recording, the decider answered round 1 with a plain reply, and `pod check` ignored it as `no_dispatch`.
4. The implement step's spec is the process text "Several Tasks, one per slice of the plan." Pod projects one implement Task and passes no plan to it. In both recordings, the developer asked first which plan and which slice.
5. A worker brief names no `worker_done` payload contract. In the first recording, the implement `worker_done` carried no `head`, so that Run had no candidate SHA. A `status` message that carries `head` is acked and records nothing.
6. `pod verdict post` needs the review Task `delivered`. A reviewer that posts while its Dispatch is still open is refused `task_not_ready`. The reviewer's question delivery moved the Task to `delivered`, and the reviewer then posted.
7. After a Seat's `worker_done`, Orca started a follow-up worker for an operator message that it counted unread. `pod check` recorded `unknown_launch` and held the Run. `pod check --resume` returned it to `active`. The follow-up had closed the integrator's terminal, so the operator posted the integrator's unedited verdict file. That receipt's keeper is `integrator`.
8. Pod had no path that delivered the `external_action` deploy Task, so `hqa_after_deploy` could not be recorded. `pod deploy record` was added after the deploy. It delivered the deploy Task from the `pnpm deploy:local` line, and the hqa Task became ready.
9. `pnpm deploy:local` does not run `pod db migrate`. The ledger needed `pod db migrate` for migration 0013 before the first `pod config apply` on the new build. The script's `pnpm link --global` also needs `PNPM_HOME`. Without it, the first run stopped after the tag. A rerun on the same HEAD resumed.
10. The first recording, `run_4fa85deae9c8`, stopped at integration_review. Its crew had one reviewer-role seat. `pod verdict post` refuses `reviewer_not_independent` for a seat that delivered a Task the step needs, and the Run pins its crew. This recording's crew adds the `integrator` seat.
11. The pr Task's first full test run on the shared test database stalled with no CPU. Directory chunks on an embedded database all passed.
12. The recording spans several `pod` processes. The tracker scrubber rewrites the Story key inside comment bodies, and it numbers comment ids per process. The replay test restores the key in comment bodies, so the outbox and receipt hashes compare as they did live. The fixture set ends at the `hqa_after_deploy` receipt. The closing `pod check` after it read comments by ids that an earlier process had numbered, and it is left out. That check delivered nothing.
13. Each worker start for the reviewer runtime recorded `model_attribution` `unknown`, because that runtime starts with no model flag.

## Follow-ups

These findings are filed under the epic:

| Finding | Follow-up |
| --- | --- |
| 1 | TPC-1475, merged before this recording |
| 2 | TPC-1485 |
| 3 | TPC-1486 |
| 4 | TPC-1487 |
| 5 | TPC-1488 |
| 7 | TPC-1511 |
| 8 | TPC-1490, merged before the deploy record |
| 9 | TPC-1512 |
| 12 | TPC-1510 |

Findings 6, 10, 11, and 13 are operating notes. Finding 6 is the documented gate order. Finding 10 was a crew setup error. Finding 11 is a test database stall. Finding 13 is the known runtime attribution.
