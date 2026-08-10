# Phase 10: Controlled content-aware execution and undo

Status: closed on 2026-08-10 after automated verification and the controlled live Lark execution-and-undo acceptance.

## Goal

Close the first complete content-aware organization loop in Lark:

1. Victor sends `/organize-folder <approved folder URL>`.
2. The existing Phase 9 coordinator inventories and analyzes the four neutral-name PDFs through the two read-only MCP tools.
3. NVIDIA returns the strict Product, Research, or Needs-review decisions.
4. Synvo Assistant stores and displays one evidence-backed proposal.
5. Victor explicitly approves that exact proposal during a controlled write-enabled window.
6. The existing trusted workflow revalidates the provider snapshot, moves only the four approved files, and verifies every destination parent.
7. Victor explicitly requests undo.
8. The existing trusted workflow restores and verifies every original parent.
9. The write switch is restored to `false`, and a final provider-backed inventory proves the original baseline.

Phase 10 is a controlled pilot closure. It does not make the assistant generally autonomous or production-ready for arbitrary folders or multiple employees.

## Architectural decision

Reuse the Phase 9 content-aware proposal path and the Phase 5 execution, verification, and undo path. Do not add an MCP write tool or give NVIDIA access to any operational capability.

```text
Lark /organize-folder
  -> read-only MCP inventory
  -> read-only MCP analysis of four exact PDFs
  -> one no-tools NVIDIA classification
  -> encrypted evidence-backed proposal
  -> explicit Victor approval
  -> trusted workflow snapshot revalidation
  -> four bounded Drive moves
  -> provider-backed verification
  -> explicit /undo-folder
  -> four bounded restorations
  -> provider-backed verification
```

The model proposes semantic destinations only. The existing Synvo workflow remains the sole owner of authorization, approval, mutation, verification, recovery, and undo.

Implementation should primarily be an audit and acceptance phase. Add production code only if the existing Phase 5 machinery cannot safely execute a Phase 9 proposal. Expected production-code change: zero to approximately 100 lines. If more than 150 production lines appear necessary, stop and explain the missing current requirement before continuing.

## Fixed pilot boundary

- One configured Lark user and tenant: Victor in the Synvo tenant.
- One allowlisted My Space Drive root.
- Exactly four disposable, non-sensitive, ordinary PDFs directly inside the root.
- Neutral filenames that do not reveal Product or Research classification.
- Exactly two existing empty destinations: `Product` and `Research`.
- No `Needs review` decision in an executable proposal.
- No nested traversal, non-PDF files, dynamic destinations, or folder creation.
- The MCP endpoint continues to expose exactly two read-only tools.
- `ORGANIZE_FOLDER_WRITE_ENABLED=false` before and after the controlled acceptance window.
- The NVIDIA hosted trial receives only the already-approved bounded extracted content.

## Safety invariants

- Enabling the operator switch never executes a historical approval automatically.
- Only a fresh proposal approved while writes are enabled may queue execution.
- Approval binds to the exact stored proposal, requester, tenant, root, source identities, destination identities, and inventory snapshot.
- Rationale text is untrusted evidence and never controls native Drive identities or mutation targets.
- A `Needs review`, rejected, stale, malformed, incomplete, or wrong-actor proposal cannot execute.
- The workflow re-reads and compares provider state immediately before the first write.
- The workflow observes the current parent before each move and verifies the parent after each move.
- Timeout or ambiguous provider responses are reconciled before retry.
- Undo requires a separate explicit command and touches only files verified as moved by the approved proposal.
- Every completion message reflects observed provider state rather than intended state.
- No native Drive token, OAuth credential, MCP credential, provider body, restricted link, or extracted document text appears in Lark output or logs.

## Work items

### 1. Pre-implementation audit

- [x] Confirm the encrypted Phase 9 proposal and its separately bound encrypted inventory result together preserve the verified source and destination identities, original parents, approved snapshot, decisions, and bounded rationales without duplicating those fields.
- [x] Confirm the execution path uses verified identities and snapshot data rather than filenames or rationale text.
- [x] Confirm a content-aware proposal uses the same authoritative approval, execution, result, and undo states already covered by Phase 5.
- [x] Confirm approval with `ORGANIZE_FOLDER_WRITE_ENABLED=false` queues no execution.
- [x] Confirm enabling writes does not scan for or execute historical approvals.
- [x] Confirm `Needs review` output contains no approval instruction and cannot reach execution.
- [x] Confirm the active OAuth grant includes the exact approved Drive read, download, move, and offline-refresh scopes.
- [x] Confirm Product and Research are empty and the four test PDFs are in the root before live acceptance.

### 2. Minimal implementation

- [x] Reuse the existing Phase 9 coordinator without changing its deterministic MCP and NVIDIA call order.
- [x] Reuse the existing proposal persistence; add no table or migration.
- [x] Reuse the existing approval, durable execution job, move reconciliation, verification, and undo implementation.
- [x] Add or change production code only for a demonstrated incompatibility between a Phase 9 content proposal and the existing execution path.
- [x] Add regression coverage for any demonstrated gap before fixing it.
- [x] Keep the MCP server read-only; add no write tool or generalized tool registry.
- [x] Keep NVIDIA isolated from MCP credentials, Lark credentials, Drive identifiers, links, and write capabilities.

### 3. Automated verification

- [x] A complete content-aware proposal approved with writes enabled queues exactly one execution job.
- [x] Its four verified moves use the stored source and destination identities, not model rationale or filenames.
- [x] Approval with writes disabled creates no execution job and performs zero Drive writes.
- [x] A historical approval does not execute after a restart with writes enabled.
- [x] Rejected, stale, Needs-review, incomplete, wrong-user, and wrong-tenant proposals perform zero writes.
- [x] A changed root item, destination item, identity digest, owner, or parent marks the proposal stale before the first move.
- [x] Duplicate approval, duplicate Lark delivery, worker retry, and process recovery cannot duplicate a move.
- [x] Ambiguous move responses are reconciled against observed provider state before retry.
- [x] Partial, failed, unknown, stale, and completed outcomes remain truthful.
- [x] Undo restores only files verified as moved by the proposal.
- [x] Duplicate undo is idempotent.
- [x] A successful execute-and-undo test restores four root PDFs and two empty destinations.
- [x] The MCP server still exposes only `organize_folder_inventory` and `analyze_drive_file`, both read-only.

### 4. Controlled live acceptance

#### Safe-mode baseline

- [x] Start with `ORGANIZE_FOLDER_WRITE_ENABLED=false` and restart the application.
- [x] Run `npm run doctor` and confirm configuration, schema, pilot identity, MCP, OAuth grant, and allowlisted root are ready while `write_enabled` is false.
- [x] Run a provider-backed inventory and confirm four neutral-name PDFs in the root, Product empty, Research empty, and no unsupported item.
- [x] Confirm again that all four PDFs are disposable and non-sensitive and that bounded content may be sent to NVIDIA NIM.

#### No-write control

- [x] Generate a fresh content-aware proposal while writes are disabled.
- [x] Approve it and confirm no execution is queued and no Drive file moves.
- [x] Inventory again and confirm the baseline is unchanged.

#### Write-enabled execution window

- [x] Set `ORGANIZE_FOLDER_WRITE_ENABLED=true` and restart the application.
- [x] Confirm no historical approved proposal starts executing.
- [x] Generate a new content-aware proposal; do not reuse the no-write control proposal.
- [x] Review all four destinations and rationales in Lark.
- [x] Approve that exact new proposal.
- [x] Confirm one durable execution job is queued.
- [x] Confirm the completion response reports all four files as verified.
- [x] Inventory the provider and confirm exactly two approved files in Product, two in Research, no root PDFs, and no unsupported item.
- [x] Repeat the approval and confirm no second execution job or duplicate move occurs.

#### Verified undo and safe restoration

- [x] Send `/undo-folder <proposal-id>` for the executed proposal.
- [x] Confirm one durable undo job is queued and all four restorations are verified.
- [x] Inventory the provider and confirm four PDFs in the root and both destinations empty.
- [x] Repeat the undo and confirm it is idempotent.
- [x] Immediately restore `ORGANIZE_FOLDER_WRITE_ENABLED=false` and restart the application.
- [x] Run `npm run doctor` and confirm `write_enabled` is false.
- [x] Run one final provider-backed inventory and record the restored baseline.

## Abort conditions

Stop the live acceptance immediately, issue no additional move, and restore the write switch to `false` if:

- The proposal contains an unexpected filename, destination, count, or `Needs review` item.
- The root or either destination differs from the approved snapshot.
- A file has an unexpected owner or parent.
- A duplicate approval creates another execution job.
- A move or undo result is partial, failed, unknown, or cannot be reconciled.
- Lark output or logs reveal a native identifier, credential, extracted document content, or provider body.

After an abort, preserve the database and provider observations for diagnosis. Do not manually move files until the observed state is recorded and the safest recovery path is determined.

## Verification commands

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
git diff --check
```

Before the write-enabled window, `doctor` must report:

- `mcp_enabled: true`
- `write_enabled: false`
- pilot identity, database schema, OAuth grant, and allowlisted root ready

After the final undo and restart, `doctor` must report the same safe state with `write_enabled: false`.

## Exit gate

Phase 10 is complete only when all of the following are true:

- [x] Automated verification passes without weakening an existing Phase 5 or Phase 9 safety test.
- [x] A no-write approval proves the operator switch prevents execution.
- [x] Enabling writes does not execute a historical approval.
- [x] One fresh AI-generated proposal is explicitly approved and moves exactly its four files.
- [x] Provider-backed observations verify every destination parent.
- [x] Duplicate approval produces no duplicate move.
- [x] A separate explicit undo restores exactly those four files to the root.
- [x] Provider-backed observations verify every restored parent.
- [x] Duplicate undo is idempotent.
- [x] The final inventory reports four root PDFs, two empty destinations, and no unsupported item.
- [x] `ORGANIZE_FOLDER_WRITE_ENABLED=false` is restored and verified before the phase closes.
- [x] MCP remains read-only and NVIDIA remains unable to call tools or perform writes.
- [x] Current-state documentation is updated once, and this completed plan is moved to `tasks/archive/` with concise live evidence.

## Non-goals

- No MCP write tool.
- No model-selected or autonomous tool loop.
- No automatic approval or automatic execution.
- No dynamic taxonomy, destination discovery, or folder creation.
- No arbitrary file counts, nested folders, non-PDF files, Wiki, RAG, embeddings, vector database, or knowledge graph.
- No multi-employee identity or authorization model.
- No new service, package, database table, migration, queue, worker, state machine, registry, provider framework, or agent framework.
- No broad production rollout; this phase certifies only the controlled Victor pilot boundary.

## Simplification review

- [x] Confirm the implementation reused the existing proposal, execution, delivery, verification, and undo paths.
- [x] Delete any temporary acceptance-only code or compatibility wrapper.
- [x] Ensure each invariant still has one authoritative owner.
- [x] Review every new validator, retry, and error branch against a demonstrated Phase 10 risk.
- [x] Confirm the source-ownership list in `AGENTS.md` still matches the repository tree.
- [x] Explain any production change beyond the expected small compatibility fix: no production code changed.

## Automated preparation evidence

Verified locally on 2026-08-10 with `ORGANIZE_FOLDER_WRITE_ENABLED=false`:

- [x] `npm run typecheck` exited successfully.
- [x] `npm test` passed all 293 unit tests.
- [x] `npm run test:integration` passed all four PostgreSQL integration tests.
- [x] `npm run doctor` reported configuration, schema, pilot identity, MCP, OAuth grant, and allowlisted root ready.
- [x] `npm run doctor` reported `write_enabled: false` and `mcp_enabled: true`.
- [x] `git diff --check` exited successfully.
- [x] The read-only MCP inventory reported `document-01.pdf` through `document-04.pdf` in the root, Product and Research empty, zero skipped items, zero issues, and `baseline_matches: true`.
- [x] Victor explicitly authorized bounded NVIDIA NIM analysis and the controlled Phase 10 execute-and-undo acceptance on 2026-08-10.
- [x] No-write control proposal `b852c9af-fd96-401f-b3a7-79bfdbf7de04` was approved with execution status `null`, zero execution jobs, and an unchanged provider-backed baseline.
- [x] After the write-enabled restart, `doctor` reported ready with `write_enabled: true`, while historical proposal `b852c9af-fd96-401f-b3a7-79bfdbf7de04` remained approved with execution status `null` and zero execution jobs.
- [x] Content-aware proposal `fbfce77c-8c1a-403c-8a4c-b1a36e48b7c9` completed exactly one execution job; Lark Drive showed zero root PDFs, two Product files, and two Research files; duplicate approval left that state and job count unchanged.
- [x] Existing execution tests now use four neutral filenames and prove model rationale is absent from the mutation record.
- [x] PostgreSQL integration coverage proves an approval recorded without an execution job cannot queue one through a later duplicate approval.
- [x] The audit found no Phase 9-to-Phase 5 production compatibility gap, so Phase 10 adds no production code, dependency, migration, table, service, worker, state, or MCP tool.

## Completion evidence

Recorded on 2026-08-10:

- Automated verification: `npm run typecheck` passed, all 293 unit tests passed, all four PostgreSQL integration tests passed, `npm run doctor` passed in safe mode, and `git diff --check` passed.
- No-write control: proposal `b852c9af-fd96-401f-b3a7-79bfdbf7de04` was approved with execution status `null`, zero execution jobs, and an unchanged provider inventory.
- Historical-approval control: after the write-enabled restart, that proposal remained inert with zero execution jobs.
- Controlled execution: proposal `fbfce77c-8c1a-403c-8a4c-b1a36e48b7c9` queued exactly one execution job and provider-verified `document-01.pdf` through `document-04.pdf`; Lark Drive then reported zero root PDFs, two Product files, and two Research files.
- Duplicate approval: reported the existing approval, queued no execution, and left exactly one completed execution job and the same provider state.
- Verified undo: a separate `/undo-folder` command queued exactly one undo job and provider-verified all four restored parents.
- Duplicate undo: reported the undo already completed and left exactly one completed undo job.
- Final inventory: `document-01.pdf` through `document-04.pdf` were restored to the root, Product and Research were empty, zero items were skipped, no issues were reported, and `baseline_matches: true`.
- Final safe state: the application restarted with `ORGANIZE_FOLDER_WRITE_ENABLED=false`; `doctor` reported `write_enabled: false`, MCP enabled, OAuth and the allowlisted root ready, and the latest run terminal. MCP still exposed exactly its two read-only tools.
