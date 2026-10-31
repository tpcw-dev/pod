# Glossary

Terms Pod uses. Orca's words keep Orca's meaning.

- **Story**: the unit of work a tracker holds. One story, one run.
- **Outbox**: the ledger queue of tracker writes. A row is done only when a readback shows the write.
- **Readback**: a tracker read after a write that shows whether the write landed.
- **Size**: the magnitude of a story, one of xs, s, m, l, xl. The tracker's estimate maps onto it.
- **Run**: Orca's run for one story. A run pins one revision each of crew, process, and policy.
- **Coordinator**: the agent session that runs the `pod` verbs for one run and holds its owner generation. Not Orca's orchestration layer.
- **Coordinator pair**: the xl coordinator. The decider seat coordinates, the auditor seat is resident and audits, and neither keeps a gate.
- **Task**: Orca's task. One step of a process for one story. A completed task is never reopened. Rework is a new task.
- **Dispatch**: Orca's worker attempt on a task. One dispatch, one launch receipt.
- **Seat**: a configured place a role runs: runtime, model, host, credentials. Crew maps roles to seats.
- **Role**: what a seat does in a process: developer, reviewer, planner, decider, auditor, and so on. Pod knows roles. Names of people and bots live in a crew profile.
- **Process**: the steps, edges, roles, limits, and selector that run a story of one stage and size range. A process is a revision.
- **Step**: one unit of a process. A worker step runs a role, an external action waits on an outside event, and a human wait waits on a person.
- **Edge**: a rule that sends a step's outcome to the next step, to hold, or to done.
- **Lineage**: the tasks of one step in one run, the first task and each rework task that replaced it.
- **Projector**: the part of Pod that turns process steps into tasks and moves them along the edges.
- **Selector**: the stage and sizes a process fits, and the rules that pick one process revision for a run.
- **Gate**: a point in a process that needs a verdict before the run continues. A gate kept by a person is a human gate. A gate kept by an agent is an automated gate.
- **Gate receipt**: the recorded verdict on a gate, bound to its source, the candidate revision, and the time it was read back.
- **Plan review**: the review of a plan before implementation starts. In impl-medium and impl-large it is an automated gate kept by the decision pair. In impl-xlarge it is a decision round of the pair.
- **Integration review**: the review of the integrated candidate SHA after each task's review passes.
- **Candidate SHA**: the commit a gate verdict binds to, the head of the run's newest recorded push.
- **Relay principal**: a tracker identity that posts only what the human gatekeeper said, marking each comment with its relay session.
- **Decision**: a request to choose between options, its rounds, and its outcome. A decision authorizes the next step in a stated scope. It is not a gate verdict.
- **Evidence manifest**: the fixed list of sources a dispatch or decision may cite, each with its version, read time, and coverage.
- **Revision**: an immutable, content-addressed version of a crew, process, or policy spec. Activation chooses which revision a scope uses.
- **Snapshot**: the three revision ids and the effective gate map a run pinned at start.
- **Reserved**: policy classes a decision cannot settle on its own: deny, needs a human, needs an existing authorization.
- **Area**: the classification of a learning, one of product, design, impl, process.
- **Learning**: a record of one agent-only lesson, with a source story, evidence, text, and an adoption state.
- **Adoption**: the state of a learning, one of new, adopted, rejected.
- **Docs port**: Pod's read-only port to a docs tool. It reads one section of one page and never writes.
- **Section**: the heading, paragraphs, and tables under one heading_2 of a docs page, up to the next heading.
