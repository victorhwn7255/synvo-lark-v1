# `/organize-folder` Implementation Plan

Status: Complete

Current phase: Phase 5 closed on 2026-08-08.

Pilot: Victor's Lark My Space folder `Test_Synvo_AI_Assistant`

Persistent write switch: disabled

## 1. Outcome

A Synvo employee sends:

```text
/organize-folder <Lark Drive folder link>
```

The assistant authenticates the requester, inventories an allowlisted folder, proposes a deterministic organization plan, obtains explicit approval, performs only approved moves, verifies the result, and offers undo—all from Lark.

The future target is Lark Wiki. The My Space pilot exists because Victor does not currently have the Wiki permissions needed to build and safely test the full loop there.

## 2. Delivery rule

Close one end-to-end phase before adding the next. Use the smallest architecture that safely supports the current phase. Do not add GPT, cards, or a general agent framework until a current user-facing requirement needs them. MCP is limited to the current requirement: one authenticated read-only adapter over an already proven workflow.

## 3. Pilot fixture

Allowlisted root:

```text
Test_Synvo_AI_Assistant/
├── Product/
├── Research/
├── [product] - Local_Cocoa_PDF_Chunking_Technical_Guide.pdf
├── [product] - Local_Cocoa_Technical_Onboarding_Guide.pdf
├── [research] - Agentic Context Engineering Research.pdf
└── [research] - Anthropic Agentic Engineering.pdf
```

Baseline:

- Exactly two root folders: `Product` and `Research`.
- Exactly four root PDF fixtures.
- Both destination folders are empty.
- Victor owns the root, destinations, and files.
- PDF content is not needed for classification; filename prefixes are sufficient.

The canonical runtime values live in `apps/synvo-assistant/src/workflows/organize-folder/pilot-policy.ts`.

## 4. Current architecture

```text
Lark App Bot -> message connection and OAuth --+
                                                |
Approved AI agent -> authenticated /mcp --------+-> organize-folder workflow
                                                   -> bounded Drive read/move client
                                                   -> delivery worker
                                                   -> PostgreSQL
```

One process, one npm package, one configuration loader, and one database pool are the default. The database contains four active runtime tables plus the migration ledger. Applied migrations remain immutable; a forward-only migration removed the inactive Phase 1 and Phase 3 tables.

## 5. Completed phases

### Phase 0 — sandbox and safety baseline

- [x] Create the My Space root and two destinations.
- [x] Add four disposable PDF fixtures with deterministic prefixes.
- [x] Record the exact root token in ignored configuration.
- [x] Restrict the Lark app to Victor.
- [x] Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false`.

### Phase 1 — App Bot connection

- [x] Configure the Lark App Bot and persistent connection.
- [x] Subscribe to direct message events.
- [x] Implement `/ping` and verify `pong` in Lark.
- [x] Use stable message UUIDs for idempotent replies.

### Phase 2 — OAuth and read-only inventory

- [x] Implement user-bound OAuth with state and PKCE.
- [x] Encrypt access and refresh tokens at rest.
- [x] Implement locked rotating-token refresh.
- [x] Validate the exact user, tenant, redirect URI, and read-only scopes.
- [x] Parse and allowlist the exact Drive root.
- [x] List the root and destinations with bounded pagination.
- [x] Validate metadata, ownership, fixture names, and empty destinations.
- [x] Persist and return a bounded result in Lark.

### Phase 3 — isolated capability proof

- [x] Prove one explicitly confirmed `root -> Research -> root` move using disposable data.
- [x] Verify both directions from provider state.
- [x] Restore the exact baseline and disable writes.
- [x] Archive the redacted evidence.
- [x] Remove the spike tooling from the product code.

### Simplification gate before Phase 4

- [x] Collapse the runtime to one Synvo Assistant package and process.
- [x] Remove the former standalone internal MCP application/client and its duplicated workflow state.
- [x] Move OAuth, Drive, and contracts into local application modules.
- [x] Remove the generic inbox and second scan lease/state machine.
- [x] Use the delivery job as the only retry lease.
- [x] Return the active runtime to the exact read-only OAuth profile.
- [x] Centralize pilot policy.
- [x] Replace large live verifiers with `npm run doctor`.
- [x] Reduce PostgreSQL integration coverage to two focused production paths.
- [x] Update the active documentation to match the code.
- [x] Re-run manual Lark acceptance after the refactor.
- [x] Remove duplicated internal validation and unnecessary child metadata reads.
- [x] Add line-level complexity rules to the engineering guide.
- [x] Colocate workflow authorization and persistence; keep provider OAuth mechanics under `lark/auth`.
- [x] Remove the three inactive Phase 1 and Phase 3 tables through a forward-only migration.
- [x] Remove the obsolete per-run scan attempt, scan lease, and numeric phase columns after the delivery job became their authoritative owner.

Historical proof: `tasks/archive/phase1-3-verification-evidence.md`.

### Read-only MCP foundation before Phase 4

- [x] Reintroduce the official MCP SDK only for the current external-agent boundary.
- [x] Mount Streamable HTTP at `/mcp` in the existing Node.js process.
- [x] Require a separate strong bearer credential and keep the route disabled when it is absent.
- [x] Map the pilot credential to the fixed Victor identity and tenant; accept no actor identity from tool input.
- [x] Expose only `organize_folder_inventory`.
- [x] Reuse the workflow's allowlist, OAuth token broker, Drive reader, and result format.
- [x] Verify discovery and invocation with an official MCP client.
- [x] Add no process, package, database table, registry, or second workflow state machine.

## 6. Phase 4 — deterministic proposal in Lark

Goal: turn the verified inventory into a concrete, reviewable plan without changing Drive.

Implementation status: closed on 2026-08-08 after automated verification and live Lark acceptance.

### Simplicity boundary

Allowed:

- One deterministic classifier for `[product]` and `[research]`.
- One proposal representation owned by the existing organize-folder workflow.
- The existing workflow run ID as the proposal ID.
- Small additions to the existing repository and `organize_folder_runs` record.
- One forward-only migration if the existing columns cannot safely store proposal state.
- `/approve-folder <proposal-id>` and `/reject-folder <proposal-id>` text commands.
- Focused tests and concise Lark text output.

Not allowed in Phase 4:

- A new application, process, service, package, or database table.
- A general proposal, approval, workflow, agent, or plugin framework.
- GPT integration or additional MCP tools.
- Lark cards or a second background worker.
- Any Drive mutation or reachable write path.

### Work

- [x] Add a deterministic classifier for the two approved filename prefixes.
- [x] Reject files with missing, unknown, conflicting, or ambiguous prefixes.
- [x] Build a proposal containing only opaque internal file references, names, and approved destination references.
- [x] Bind the proposal to the inventory snapshot and use the existing run ID as its proposal ID.
- [x] Store the proposal on the existing organize-folder run; do not create another table.
- [x] Persist one proposal status: `PROPOSED`, `APPROVED`, `REJECTED`, or `STALE`.
- [x] Render a concise Lark response:
  - two product files → `Product`
  - two research files → `Research`
  - zero unsupported or ambiguous items
  - no changes made
- [x] Accept `/approve-folder <proposal-id>` and `/reject-folder <proposal-id>`; record the actor and decision time.
- [x] Keep all Drive write code unreachable and keep the write switch false.

### Tests

- [x] Exact four-file proposal.
- [x] Missing, unknown, conflicting, and ambiguous prefixes; duplicate fixture; unexpected folder; and nonempty destination.
- [x] Proposal is tied to one run and cannot be reused for another snapshot.
- [x] Only the configured pilot user and tenant can approve or reject the proposal.
- [x] Duplicate, conflicting, malformed, missing, stale, and unknown proposal decisions fail safely.
- [x] Duplicate command or delivery does not create another proposal.
- [x] Output contains no native Drive tokens or restricted links.

### Exit gate

- [x] Victor receives a deterministic proposal in Lark.
- [x] The proposal matches the provider inventory exactly.
- [x] Approval or rejection is recorded unambiguously.
- [x] No file is opened, downloaded, moved, renamed, or changed.

Live acceptance evidence:

- Proposal `7e95ca24-478e-461a-82e9-eb170d9316d4` was approved; a repeated approval was idempotent and a conflicting rejection was refused without changing the stored decision.
- Proposal `7a2391a1-59c2-4e90-be00-f163065e8c3b` was rejected independently.
- A final provider-backed scan produced proposal `7c70c4a3-0cb6-4aec-a1d6-27a23941bb02` with the same four root files, two empty destinations, and zero unsupported items.
- The master write switch remained false throughout acceptance; no Drive mutation was reachable.

Before closing Phase 4, remove unused code, confirm the source-ownership list still matches the tree, and explain any implementation that exceeded this simplicity boundary.

Do not add GPT in Phase 4. The fixture is intentionally deterministic. GPT becomes useful later when real documents need semantic classification; its output must still pass deterministic policy validation.

## 7. Phase 5 — approved execution, verification, and undo

Begin only after Phase 4 closes.

Goal: execute only a newly approved proposal during an explicitly enabled write window, verify every observed parent, and restore the exact baseline through a separately confirmed undo.

Implementation status: closed on 2026-08-08 after automated verification and the controlled live Lark execution-and-undo round trip.

### Simplicity boundary

Allowed:

- Add `space:document:move` to the exact active OAuth scope profile.
- Add one small Lark Drive move method beside the existing read client.
- Extend the existing run row with the minimum execution and undo state.
- Add at most one forward-only migration.
- Extend the existing delivery job kinds and worker; do not create another worker.
- Add `/undo-folder <proposal-id>` as the separate undo confirmation.

Not allowed:

- A new service, process, package, database table, queue, worker, registry, or workflow framework.
- GPT, content analysis, Lark cards, new MCP tools, or arbitrary-folder support.
- Delete, upload, rename, create-folder, permission, sharing, or outside-root operations.
- Restoring the deleted Phase 3 spike architecture.

### Work

- [x] Support deliberate Victor reauthorization with exactly `drive:drive.metadata:readonly`, `offline_access`, `space:document:retrieve`, and `space:document:move`.
- [x] Refuse execution unless the proposal is newly approved by the configured pilot actor and tenant while the master write switch is enabled.
- [x] Never scan and execute historical approvals automatically at startup.
- [x] Re-read the root and destinations immediately before the first move.
- [x] Compare the provider state with the proposal's bound inventory snapshot; mark it `STALE` and move nothing on any mismatch.
- [x] Queue execution durably through the existing delivery queue only when a new approval is recorded.
- [x] Move only the four proposed files to the two policy-owned destinations.
- [x] Observe the current parent before every write and verify the parent after every write.
- [x] Reconcile provider state after a timeout or ambiguous response before deciding whether a retry is safe.
- [x] Stop before the next move on failed, unknown, or inconsistent state.
- [x] Persist a bounded encrypted execution result with attempted files, observed parents, outcome, and timestamps on the existing run.
- [x] Recover an interrupted execution by observing provider state before issuing another move.
- [x] Report completed, partial, stale, failed, unknown, and untouched outcomes accurately in Lark.
- [x] Add `/undo-folder <proposal-id>` as a separate explicit confirmation.
- [x] Undo only files verified as moved by that proposal, restoring each to its recorded original parent.
- [x] Verify every undo result and make duplicate undo commands idempotent.
- [x] Restore and verify the exact two-empty-folder/four-root-file baseline in automated tests.

### Tests

- [x] Write switch false performs zero Drive writes.
- [x] Proposed, rejected, stale, missing, and unknown proposals cannot execute.
- [x] Wrong user or tenant cannot execute or undo.
- [x] Any pre-execution snapshot mismatch marks the proposal stale and moves nothing.
- [x] The exact approved proposal moves only the four expected files and verifies every observed parent.
- [x] Duplicate approval, event delivery, worker retry, and process recovery cannot duplicate a move.
- [x] Timeout and ambiguous provider results are reconciled before retry.
- [x] Unexpected parent or destination stops execution and persists a truthful partial or unknown result.
- [x] Undo requires its own command and touches only files verified as moved by the proposal.
- [x] Duplicate undo is idempotent and successful undo restores the exact baseline.
- [x] User-facing output contains no native tokens, restricted links, raw provider responses, or ciphertext.
- [x] No delete, upload, rename, create-folder, permission, or outside-root method is reachable.

### Exit gate

- [x] With writes disabled, an approval causes zero Drive changes.
- [x] Victor reauthorizes with exactly `drive:drive.metadata:readonly`, `offline_access`, `space:document:retrieve`, and `space:document:move`.
- [x] During a controlled write-enabled window, a new approved proposal moves all four files to the proposed destinations.
- [x] Duplicate delivery causes no duplicate move.
- [x] `/undo-folder <proposal-id>` restores all four files to the root.
- [x] A final provider-backed scan reports the exact baseline.
- [x] `ORGANIZE_FOLDER_WRITE_ENABLED=false` is restored before Phase 5 closes.

Live acceptance evidence:

- Proposal `18ba21fe-d8d4-4279-bb25-2f0f30b3a339` was approved while writes were disabled; the database recorded zero execution jobs and Drive remained unchanged.
- Victor deliberately created an exact four-scope `phase5_execute` OAuth grant.
- Fresh proposal `0c91c7a5-c446-4bed-ab13-a2cbaa18c4ae` executed through one durable job and verified all four destination parents.
- Repeating its approval created no second job or move.
- A separate `/undo-folder` command completed through one durable job and verified all four original parents.
- The write switch was restored to false immediately after undo and the application restarted in safe mode.
- Final provider-backed proposal `507fba7e-507f-468a-a579-f0814ca5f8ac` proved the exact four-root-file/two-empty-destination baseline with zero unsupported items; it was not approved.
- Live acceptance exposed one inaccurate duplicate-approval sentence; it was corrected without changing behavior and covered by a regression test.

Before closing Phase 5, run the complete verification suite, confirm source ownership, confirm no secret is tracked, delete unused code, and explain any implementation that exceeded this boundary.

## 8. Verification commands

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
npm run dev
```

Manual Lark acceptance:

1. `/ping` returns `pong`.
2. Reauthorize Victor through a new `/organize-folder <allowlisted-link>` request and confirm Lark grants exactly the four active Phase 5 scopes.
3. With `ORGANIZE_FOLDER_WRITE_ENABLED=false`, approve that new proposal and confirm no execution is queued and no file moves.
4. Confirm all four PDFs remain in the root and both destination folders remain empty.
5. Enable `ORGANIZE_FOLDER_WRITE_ENABLED=true` only for the controlled acceptance window and restart the application.
6. Create and approve a new proposal; verify exactly two files move to `Product` and two to `Research`.
7. Repeat the approval or delivery and confirm no file moves twice.
8. Send `/undo-folder <proposal-id>` and verify all four files return to the root.
9. Repeat the undo and confirm it is idempotent.
10. Restore `ORGANIZE_FOLDER_WRITE_ENABLED=false` immediately and restart the application.
11. Run a final provider-backed inventory and confirm four root PDFs, two empty destinations, and zero unsupported items.
