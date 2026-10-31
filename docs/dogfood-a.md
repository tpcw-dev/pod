# Dogfood A

Recorded Run `run_0e13621dc8ea`. Process `impl-small@1`. The implement, review, and pr Tasks were worker Dispatches. The review receipt came from `verdict post`. The merge receipt came from `hqa record`. Deploy stayed ready and was not dispatched. The ledger rows come from those verbs. `hand_filled` is 2: one `verdict post` and one `hqa record`. `config apply` counts on no Run. This Run has no `config apply` event.

`coordinator_operations` does not count an operation that was refused before it wrote an event or a dispatch. The refused `run create` and the failed dispatch on `run_6ce7039a94fc`, and the refused check on `run_1afe9444c336`, are not on this Run.

Wall clock is from the first ledger event at 2026-10-31 21:04:03.249+00 to the `hqa record` event at 2026-10-31 21:59:05.052+00, which is 55m 1.803s. The merge gate is PASS on head `3be3115f623a06e7e17c5e063a050d34e535e33e`. poker-room pull request 41 carries that head.

The worker_done tests on the implement delivery are the two results below. The start receipt recorded a null effective model and a null effort, so `model_attribution` is `unknown`.

TPC-1058 is `not recorded`. `openrig-learning/poc/TPC-1058/` is not on this host.

| Figure | Dogfood A | TPC-1058 |
| --- | --- | --- |
| coordinator_operations | 11 | not recorded |
| recovery_steps | 0 | not recorded |
| retries | 0 | not recorded |
| rework_tasks | 0 | not recorded |
| hand_filled | 2 | not recorded |
| `npm test` | exit 0, 11.765s, timeout null | not recorded |
| `timeout 60 npm test` | exit 0, 11.425s, timeout 60 | not recorded |
| wall clock to the merge receipt | 55m 1.803s | not recorded |

On this Run, `select count(*) from ledger.event where run_id = 'run_0e13621dc8ea' and source->>'kind' not in ('command','receipt')` prints 0. The Run has 196 rows of source kind `receipt` and 14 of source kind `command`. Both are recorded verb sources. `delivery` and `readback` are event types, not source kinds.

## Findings

1. On `run_6ce7039a94fc`, `pod run create` wrote the Run and then exited 1. The tracker read still matched one denylist term, so `001-readStory.json` was not written. A later `pod check` on that Run refused the same way.
2. On that same Run, `pod dispatch` of the implement Task failed. Orca 1.4.211 exited 1 with `invalid_argument`: agent grok does not support launch-time model selection. The worker-start argv included `--model` and `--effort`. `worker-start` now omits both flags when the agent is grok. The third recording's three worker-start receipts exit 0 without those flags.
3. On `run_1afe9444c336`, `pod check --wait` for review recorded the delivery and then exited 1. The check receipt still matched a denylist term after host, user, and path replacement. Replacements were applied only on the tracker recorder. The shared scrubber now applies them before the denylist check. The ack had already gone out, and the next check returned no delivery. The recording database was reset. The fixtures are the third recording. There is no fourth recording.
4. `pod hqa record` did not treat a ready `human_wait` Task as waiting. It now does when the step has a gate, moves that Task to delivered, and then records the receipt. `test/db/hqa.test.ts` covers a ready human_wait gate. `docs/contract.md` has the Spec clarification line.
5. A denylist term that follows a backslash-n, backslash-r, backslash-t, or backslash-quote in serialized text was not a whole word. `makeScrubber` treats that escape as a boundary for replacement and for the denylist check. The CI scope scan uses that same boundary. `test/orca/scrub.test.ts` covers the backslash-n case. The recorded fixture set was scrubbed again with that boundary. `064-readback.json` and `065-readComment.json` were the only files that changed.
