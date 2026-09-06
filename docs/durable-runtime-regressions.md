# Durable runtime regression evidence

All tests create temporary directories or temporary Git repositories. The child
process integration tests run a temporary JSON-RPC fixture server, never the
production Codex server or a registered application project.

| Required behavior                  | Regression coverage                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent implementation attempts | `attempts.test.ts`: V2 defaults and metadata round trip                                                                                                                                                                         |
| REPORT/CONTINUE after changes      | `recovery.test.ts`: same thread, same cwd, existing content inspected, report verified, Architect approval                                                                                                                      |
| Safe retry without changes         | `recovery.test.ts`: previous interrupted attempt retained and explicit new attempt                                                                                                                                              |
| Corrections                        | `task-workspace.test.ts`: requiredChanges, findings, validationRequired, same worktree                                                                                                                                          |
| Quota normalization and polling    | `rate-limit-scheduler.test.ts`, `rate-limit-phases.test.ts`: Unix seconds, persisted nextCheckAt, backoff, all three phases, automatic resume, cancellation while waiting                                                       |
| Transient recovery                 | `reconnect.test.ts`, `runtime.test.ts`: persisted retryAt, bounded backoff, restart before resume, continued approval                                                                                                           |
| Real transport initialization      | `app-server-lifecycle.test.ts`: real client with child-process fixture, initialize/initialized on both generations, three thread resumes                                                                                        |
| Ghost threads                      | `reconnect.test.ts`: each role replaces only the known no-rollout error                                                                                                                                                         |
| Worktree execution                 | `recovery.test.ts`, `task-workspace.test.ts`, `turn-lifetime.test.ts`: actual cwd and sandbox roots, original checkout unchanged, corrections reuse roots, multi-repo and hybrid mappings                                       |
| Approved delivery and integration  | `approved-delivery.test.ts`: approved work is committed and persisted before cleanup, result branches remain reachable, reconstructed runtimes can integrate clean checkouts, and dirty/diverged originals require owner action |
| Git deltas                         | `worktrees.test.ts`, `ownership.test.ts`: modified, staged added, untracked, deleted, rename old/new paths and spaces                                                                                                           |
| Path security                      | `ownership.test.ts`: both rename endpoints, omitted paths, traversal and junction escape                                                                                                                                        |
| Non-Git serialization              | `locking.test.ts`, `runtime.test.ts`: atomic acquisition, competitors, owner-only release, conservative restart adoption, cancellation cleanup, and manual handling of stale foreign locks                                      |
| Non-Git evidence                   | `ownership.test.ts`: snapshot attribution, explicitly distinct from Git; mixed topology tested separately                                                                                                                       |
| Cancellation                       | `cancellation.test.ts`, `runtime.test.ts`: intent before interrupt, keyed concurrent requests, no cleanup on failed interrupt, terminal tombstone, late reports/reviews/completion                                              |
| Startup shutdown ordering          | `startup.test.ts`: SIGINT/SIGTERM handlers exist before recoverable workflow discovery and recovery execution                                                                                                                   |
| Turn lifetime                      | `turn-lifetime.test.ts`: no default timeout, exit/stop rejection, interrupt cleanup, duplicate events, startup persistence failure                                                                                              |
| Migration and durability           | `durability.test.ts`: V1 migration/backup, malformed originals preserved, atomic concurrent workflow writes, and serialized stale-snapshot agent-state merges                                                                   |

## Recovery and ownership rules

- A project execution lease prevents concurrent processes from using its role
  threads. Git tasks use deterministic, orchestrator-owned task worktrees.
- Non-Git leases are placed at the canonical physical repository root and include
  workflow, task, attempt, process, host, session, and App Server PID identities.
  An expired timestamp does not justify takeover. Only the same task can adopt
  a lease after both recorded local processes are demonstrably dead.
- Cancellation from a separate CLI process persists intent and signals the live
  runtime through the workflow store. That runtime interrupts its own stdio
  transport before cleaning resources. An immutable cancellation completion
  marker prevents stale writes from reviving a cancelled workflow.
- Existing V2 workflows receive empty attempt defaults. A legacy interrupted
  implementation with original-checkout baselines but no isolated attempt
  metadata requires manual reconciliation because attribution is ambiguous.
  New interrupted attempts automatically use REPORT/CONTINUE or safe retry.
- Architect approval creates a durable result commit on the orchestrator branch
  before its disposable worktree is removed. `npm run workflow:integrate --
--project <id> --workflow <id>` only fast-forwards a clean, unchanged original
  checkout; otherwise it records `OWNER_ACTION_REQUIRED` and retains the result
  branch and commit for explicit owner integration.

## Validation

`npm.cmd run build` and `npm.cmd test` are the Windows validation commands.
GitHub Actions runs the equivalent npm commands on Linux with Node 22.
No lint script is configured in package.json.
