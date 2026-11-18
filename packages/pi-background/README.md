# Pi background context and notifications

Small internal library, **not a Pi extension**. Plan, artifacts and Herdr share only workflow restrictions, revocable delivery ownership, holds, work status and bounded notification handling. Execution, persistence and approval remain with their respective extensions; this is not an agent framework or recovery daemon.

## Contract

`WorkflowScope` publishes a synchronous, versioned `pi.events` request/response snapshot: session, stable scope, delivery/review hold, and optional allowed names, parent-only exclusions and child guidance. Replacement/revocation emits a scope event before asynchronous cancellation. No assumption is made that event-bus emission awaits handlers. Conflicting context providers or notification dispatchers are rejected rather than composed.

`backgroundRuntime(pi)` finds or attaches one dispatcher per Pi event bus, including consumers loading separate copies of this library. Producers capture a `Recipient` before asynchronous work and check ownership again before publication. Session replacement, tree navigation, abort and workflow replacement invalidate old recipients; disposal removes event subscriptions. Ordinary turns and compaction do not cancel jobs.

`NotificationQueue` is bounded to 128 pending items and 4096 remembered event IDs per runtime session. Events carry stable event/job IDs, recipient scope, topic, bounded summary/result reference and wake preference. Topics are descriptive, not authority. At most 20 events are batched per eligible boundary. Idle follow-ups are limited to four per user-input group and each item can request a wake only once. Artifact producers use `wake: false`.

Blocking UI prompts, compaction, explicit review and pending user messages hold delivery. Boundary entries preserve entries proposed by other handlers. Queue claims and explicit result retrieval are provisional until the dispatcher sees stable IDs in committed custom messages/tool results. Uncommitted claims are recoverable. A `sendMessage()` call is not a receipt, and no end-to-end exactly-once guarantee is made.

There is no durable inbox or replay on reload. Crashes can prevent automatic delivery without losing producer-owned durable results. Historical queries do not revive notifications or jobs. Progress remains a human status concern and cannot wake the model.

`backgroundStatus()` aggregates associated active/unconfirmed work and pending notifications for Plan readiness. `verifiedSubagentTools()` checks package entrypoint provenance rather than trusting tool names; only our five implementations receive new-workflow defaults.

## Development

Build this library before its consumers. The root build/install scripts specify that order explicitly. Use `bun run test packages/pi-background/test/` for queue, contract and dispatcher tests. This package has its own manifest, TypeScript configuration and MIT license, and is intentionally absent from root `pi.extensions`.
