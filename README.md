# Pod

Pod is a thin coordination layer over [Orca](https://orca.sh). It does not run agents, open terminals, or manage worktrees; Orca does. Pod records what Orca did as a ledger, decides who may do what next from versioned specs, and syncs verdicts to a tracker.

Status: pre-PRD. The design is being turned into a PRD; nothing here runs yet.

## What Pod adds

- A ledger: story, run, task, dispatch, gate receipt, decision, evidence manifest, each tied to Orca's own receipts.
- Versioned specs in a database: crew (who fills each role), process (steps and edges per stage and size), policy (what is reserved for a human). A run pins one immutable revision of each.
- A `pod` CLI that wraps Orca as a deep module: a dozen idempotent verbs, errors that say what to do next.
- A decision layer: a decider seat proposes, an auditor seat checks, a human rules when they still disagree.
- Reconcile and recovery as commands, not memory.

## What Pod is not

Not an IDE, not a runtime, not a scheduler, not a second ledger for secrets or transcripts.

## License

MIT. See [LICENSE](LICENSE).
