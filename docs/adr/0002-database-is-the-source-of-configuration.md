# 0002. The database is the source of configuration; seed files are its mirror

## Context

Pod stores configuration as append-only Revisions in `config.revision`, activates one Revision per scope, kind, and name in `config.activation`, and pins a Run's Revisions in `config.snapshot`. Until this decision the files under `specs/` were the source: `pod config apply FILE` read a whole file into the database, `actor` was the constant `operator`, and no human approval guarded an apply or an activation. An operator who adopts Pod also keeps more configuration as files in their own process repository, each changed only by a pull request, and keeps holds, priorities, and usage resets as local files with no history. The operator decided on 2026-11-08 that every configuration lives in the database, seeded from files, changeable by a person's ask or approval, with no pull request for a configuration change.

## Decision

The database is the source of configuration. A seed file under `specs/` is a mirror written by `pod config export --all`, kept in the repository so a fresh install can seed itself and so a reviewer can read the active configuration in one place. The mirror lays out one file per active Revision.

Writes go through two verbs. `pod config apply FILE` stays for whole-file seeding. `pod config set <kind>.<name> <path>=<value> --reason "<why>"` derives a new Revision from the active one, changes the named paths, and records the parent. Both record `actor` from identity, as `person:<principal>` or `seat:<Seat Address>`. Nothing writes `operator` as a constant.

Identity comes from the host and the Seat. The host profile keeps `operator: <principal>`, which names a principal of the active global policy and marks the operator's shell. `POD_SEAT` marks an agent Seat, and a terminal the ledger records as a Pod-started Seat is that Seat. A write with no identity is refused `identity_missing`, and an agent's activation is refused `activation_needs_person`.

Activation needs a person. A Revision an agent writes is pending until a person activates it. The pending state is a `ledger.operation` request. A person activates it with `pod config activate` from the operator's shell, or with a source-verified tracker comment `config activate <revision-id>` on the ticket the agent named with `--ticket`, verified the way a human ruling is verified. A person can activate any Revision at any scope at any time. A policy's `agent_activates` setting governs which of the kinds crew, process, policy, and decision an agent may activate without a person; `task` Revisions are exempt, because Pod writes and activates them inside a Decision.

Holds, priorities, and usage resets are ledger events, not configuration. New configuration kinds for hosts, projects, models, and schedules are separate decisions, one per kind.

## Rejected

Keeping `specs/` as the source and the database as a copy. It makes every configuration change a pull request, which is what the operator is removing, and it leaves the ledger unable to say who changed what and why.

A single `config` table edited in place. The append-only Revision with a parent is what lets a Run pin its configuration and lets a person read the history of a change.

An agent that activates the policy that governs it under any profile without a person's approval. An agent that can change the policy that governs it has no policy.

Setting `POD_SEAT` in each terminal through the runtime. The runtime at the time of this decision takes no environment on a worker launch, so Pod marks the terminals it starts by the terminal handle it records, and refuses a caller it cannot tell apart from a worker without a terminal.

## Consequences

- Rows written before this decision keep `actor` and `activated_by` as `operator`. There is no backfill.
- `pod brief` already flags a Revision with no matching seed file as drift. After this decision drift reads "mirror stale", and `pod config export --all` repairs it. Opening the code-host pull request for the mirror is a follow-up.
- The host profile keeps its fields, `operator` included, until a later decision moves host settings into the database.
- The operator retires each process configuration file in the same change that lands the Pod kind replacing it.
