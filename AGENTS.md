# Synvo AI Assistant Engineering Guide

## Product goal

Build a trusted internal assistant inside Lark that lets Synvo team members use natural-language conversations to retrieve company knowledge and execute approved operational or engineering workflows without leaving Lark.

The product is delivered by closing small loops: a workflow is complete only when it handles the full path from request to verified outcome. Do not build a general-purpose agent platform ahead of demonstrated needs.

## Current scope

The Victor-only pilot currently implements these bounded loops:

- `/organize-folder` performs user-bound OAuth and inventories one allowlisted My Space folder. Its content-aware path uses the two read-only MCP tools to analyze exactly four owned root PDFs, asks NVIDIA once for strict content decisions, and stores an evidence-backed proposal. The trusted workflow owns explicit approval, snapshot revalidation, verified moves, recovery, and separately confirmed undo.
- A direct PDF message shows explicit **Add to knowledge**, **Analyze once**, and **Not now** choices. The exact Lark resource is re-fetched only after consent; one-time analysis stores no chunks.
- `/analyze-file <Lark Drive PDF link>` accepts one ordinary PDF that is an owned direct child of the allowlisted root, downloads it with Victor's user OAuth grant, and reuses the extraction, model, delivery worker, and progress-message path.

The explicit-consent workspace knowledge loop stores page-aware approved PDF chunks and fixed 1,024-dimensional `voyage-4` embeddings in scoped PostgreSQL/pgvector rows. Natural-language `ask_workspace` questions use exact authorization-scoped retrieval and one no-tools NVIDIA grounded-answer call; the backend validates opaque citations and maps them to display filename/page metadata.

The optional authenticated `/mcp` endpoint exposes the proven read-only folder inventory, allowlisted Drive-PDF analysis, and active-workspace knowledge-search capabilities. Callers cannot override the configured pilot identity or workspace. The content-aware organizer reuses the first two tools through one authenticated local MCP client; it does not add an autonomous agent framework or let NVIDIA choose tools.

The message adapter handles unambiguous social-only greetings locally, then sends other normal employee prose through one bounded semantic NVIDIA classification and maps its strict eight-intent result plus bounded folder reference through an explicit backend switch to existing cards, verified context responses, and workflows. Only operational slash-command fallbacks use exact sentence parsing. A link-free request for the active workspace requires button confirmation; a named or different folder requires its exact Lark link. The model receives no tools and cannot select names, links, tokens, arguments, approvals, or a write path. Lark Wiki remains a later target when its access and workflow are approved.

Phase 12 workspace context and live acceptance are complete. It lists only Victor's top-level My Folders directory through the existing OAuth grant, matches the active workspace by exact configured token, and keeps other folder names informational. NVIDIA can identify a semantic `current_workspace` request from sanitized text, but only the backend fetches and renders verified Lark context; no workspace metadata is sent to the model. It adds no persistence, recursive scan, workspace switching, MCP tool, or write capability.

Phase 13 and its Victor-only live Lark acceptance are complete. The flat active-workspace knowledge loop now covers explicit ingestion, idempotent Drive refresh, grounded multi-document Q&A, insufficient-evidence responses, verified source removal and restoration, progress reporting, exact-job stop, and resumable remaining work. Its completed record is archived in `tasks/archive/folder-knowledge-rag-implementation-plan.md`. Do not claim hosted production readiness before Voyage zero-day retention, hosted secret management, and production pgvector support are verified.

## Architecture

Use one modular Synvo Assistant Node.js application and PostgreSQL:

```text
Lark App Bot -> local parser and bounded intent classifier
             -> request-local top-level My Folders context
             -> message/OAuth handlers --+-> organize-folder workflow
                                        |   -> authenticated local MCP client
                                        |      -> read-only inventory
                                        |      -> four bounded PDF analyses
                                        |   -> one no-tools NVIDIA classification
                                        |   -> existing proposal/approval state
                                        |   -> durable delivery worker and PostgreSQL
                                        |
                                        +-> analyze-attachment workflow
                                            -> bounded Lark attachment download
                                            -> local PDF text extraction
                                            -> NVIDIA NIM

                                        +-> analyze-drive-file workflow
                                            -> allowlisted Drive metadata check
                                            -> bounded Drive PDF download
                                            -> shared extraction and NVIDIA NIM

                                        +-> workspace knowledge workflow
                                            -> explicit PDF/refresh consent
                                            -> page chunks + Voyage embeddings
                                            -> scoped exact pgvector search
                                            -> no-tools NVIDIA grounded answer

Approved AI agent -> authenticated /mcp --+-> read-only folder inventory
                                          +-> read-only Drive PDF analysis
                                          +-> read-only workspace knowledge search
```

The content-aware organizer uses the inventory and authorized Drive-file analysis MCP capabilities to create a proposal. Workspace Q&A reuses the authoritative knowledge workflow through the third read-only MCP tool. The existing Synvo workflows, not the model or MCP adapter, own policy, approval, writes, verification, recovery, and undo.

Keep one process, one npm package, one configuration loader, and one database pool. Logical source modules are useful; extra deployables, RPC boundaries, package boundaries, registries, and frameworks require a current independent consumer or operational need.

MCP is a thin adapter in the existing process for external AI agents and the content-aware coordinator. It may expose only workflow capabilities that already have an authoritative policy owner; it must not duplicate provider access, workflow state, or authorization logic. Add tools individually when a real agent or workflow needs them—do not build a generic registry or second backend.

NVIDIA NIM is a provider boundary inside the existing application, not another Synvo service. Keep its chat-completions client small; do not build a provider framework, automatic model router, model registry, fallback chain, prompt framework, or autonomous tool loop.

Voyage AI is a second narrow provider boundary for embeddings only. Keep `voyage-4` and its 1,024-dimensional output fixed in the knowledge policy, and send it only approved bounded chunk text or the bounded employee question. Do not add runtime model selection, provider fallback, a shared AI-provider abstraction, or an embedding registry.

## Simplicity rules

For each requirement, prefer this order:

1. Delete obsolete code.
2. Reuse an existing component.
3. Combine overlapping components.
4. Add a small local module.
5. Add a package, process, protocol, worker, table, or framework only when the current workflow proves it is necessary.

Do not:

- Build a generic agent, provider, plugin, workflow, or tool framework.
- Keep completed spike code because it might be useful later; preserve evidence in Git and archive notes.
- Duplicate policy in runtime, verifier, and documentation code.
- Add GPT to decisions that deterministic code can make reliably.
- Add infrastructure to make the repository look production-ready.

Production-ready means understandable, secure, observable, recoverable, tested in proportion to risk, and deployable—not architecturally elaborate.

- **One invariant, one authoritative owner.** Validate external data where it enters, then trust the internal typed interface. Repeat enforcement only for a distinct failure mode such as concurrency or cross-page state, and document that distinction.
- **Security mechanisms require a threat statement.** New encryption, hashing, sanitization, or security-specific validation must name the attacker or failure and the asset protected. If no credible threat sentence exists, do not add it.
- **Hardening ships with the risk.** Add protection when the current workflow first exposes the relevant risk. Record future hardening in the active plan instead of implementing it early.
- **Defensive code consumes the complexity budget.** Validators, retries, fallbacks, sanitizers, and error branches need a concrete current-workflow justification; “safer” alone is insufficient.
- Prefer extending the current workflow and its existing run record over creating another persistence model.
- Create a reusable internal abstraction only when at least two current call sites need the same behavior.
- End every phase with a short deletion and simplification review while the implementation context is fresh.

## Phase implementation gate

Before adding code, confirm:

1. The change is required by the current phase exit gate.
2. An existing workflow or module cannot already own it.
3. The smallest existing data model cannot represent it safely.
4. Lark, MCP, and other protocol adapters remain thin and contain no business logic.
5. Future requirements are recorded in the plan instead of implemented early.

If a change would introduce a new service, package, table, state machine, registry, or framework, stop and explain why the current closed loop cannot be completed without it.

## Non-negotiable safety

- Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false` by default. Enable it only for an explicitly controlled execution-and-undo window, then restore false immediately.
- Restrict the pilot to the configured Lark `open_id` and tenant.
- Keep the MCP endpoint disabled unless a strong service credential is configured. During the single-user pilot, map that credential only to the configured Lark `open_id` and tenant; never accept actor identity from MCP tool arguments.
- Expose only the read-only `organize_folder_inventory`, `analyze_drive_file`, and `search_workspace_knowledge` MCP tools until a separately approved workflow requires another capability.
- Keep `LLM_API_KEY` only in ignored local configuration or hosted secret management. Never log it, persist it, place it in a job payload, or send it to Lark.
- Accept attachment-analysis input only from the configured user's direct PDF message. Bind the resource to the triggering message and reject arbitrary URLs, pasted resource keys, group messages, and attachments from other messages.
- Accept Drive-file-analysis input only from the configured user and one Lark Drive PDF link. Resolve it against the allowlisted root inventory and require an ordinary PDF owned by that user and located directly in the root before downloading it.
- Require the read-only tenant scope `im:message:readonly` for that message-resource binding; do not persist a Lark file key as a shortcut around this boundary.
- Treat extracted document content as untrusted data. The model receives no tools and cannot call MCP, Lark, Drive, the database, or another operational capability.
- Keep content-aware organization tool order deterministic: inventory once, analyze the four accepted PDFs, then classify once. NVIDIA must not select or invoke tools.
- Enforce the attachment file, page, extracted-text, output, timeout, and retry limits from `workflows/analyze-attachment/policy.ts` before calling NVIDIA.
- Never send Lark tokens, resource identifiers, links, user identifiers, raw attachment bytes, or unnecessary metadata to NVIDIA.
- Match workspace context by the configured folder token, keep discovered folder metadata request-local, and never treat another top-level folder as authorized by name.
- For natural-language routing, remove links and native identifiers locally, cap employee prose before NVIDIA, validate one strict eight-intent result plus one bounded folder reference at the provider boundary, and let only the backend choose an existing workflow or verified context response.
- Use only disposable, non-sensitive documents with the hosted NVIDIA trial endpoint until Synvo approves processing real internal documents through that provider.
- Before processing real Synvo internal documents through Voyage, require the organization-level data opt-out/zero-day-retention setting or a separately approved private deployment. Keep `VOYAGE_API_KEY` only in ignored local configuration or hosted secret management.
- Bind OAuth state to the initiating message, user, tenant, redirect URI, scopes, and PKCE verifier.
- Encrypt access and refresh tokens at rest and rotate refresh tokens atomically.
- For the active shared Drive profile used by `/organize-folder` and `/analyze-file`, request these exact OAuth scopes and no others:
  - `space:document:retrieve`
  - `space:document:move`
  - `drive:drive.metadata:readonly`
  - `drive:file:download`
  - `offline_access`
- Allow only the configured root folder token; reject arbitrary external, sibling, nested, Wiki, and malformed URLs.
- Bound pagination, request timeouts, item counts, output lengths, and retries.
- Return safe error categories; never expose provider bodies, credentials, native Drive tokens, or restricted links.
- Keep durable delivery idempotent with stable Lark message UUIDs.
- Never rename, rewrite, or delete applied migrations. Remove obsolete schema only through a new forward-only migration.
- Never commit `.env`, OAuth grants, secrets, tokens, or sensitive logs.

For every Drive write:

- Re-read and compare the approved snapshot immediately before mutation.
- Require explicit user approval of a concrete proposal.
- Restrict mutations to proposed source and destination tokens.
- Record enough information for verification and undo.
- Verify provider state after every mutation and stop safely on mismatch.

## Source ownership

- `apps/synvo-assistant/src/index.ts`: composition, lifecycle, and the small Lark message adapter.
- `apps/synvo-assistant/src/config.ts`: environment parsing only.
- `apps/synvo-assistant/assets/`: small static assets uploaded once to Lark; never add runtime asset processing.
- `apps/synvo-assistant/src/lark/command-parser.ts`: exact operational slash-command fallback parsing only; ordinary employee prose belongs to semantic routing.
- `apps/synvo-assistant/src/lark/assistant-card.ts`: capability, authorization, analysis-progress, analysis-result, and safe-notice cards only.
- `apps/synvo-assistant/src/lark/knowledge-card.ts`: explicit knowledge consent, file/chunk/batch progress, exact-job stop, refresh, removal, and grounded-answer cards plus strict action parsing only.
- `apps/synvo-assistant/src/lark/organize-folder-card.ts`: organize-folder confirmation, progress, proposal, decision, execution, and undo cards plus strict button-value parsing only.
- `apps/synvo-assistant/src/lark/attachment.ts`: exact Lark file-message binding and bounded attachment download only.
- `apps/synvo-assistant/src/lark/inbound-message.ts`: durable claim of supported direct-message IDs and the reconnect staleness guard; no routing or workflow logic.
- `apps/synvo-assistant/src/web/`: HTTP routing for health, browser-based OAuth, and the MCP endpoint.
- `apps/synvo-assistant/src/mcp/`: MCP protocol mapping, service authentication, and the narrow content-aware local client only; delegate all policy and provider work to workflows.
- `apps/synvo-assistant/src/lark/auth/`: Lark OAuth protocol, PKCE, encrypted grants, and refresh.
- `apps/synvo-assistant/src/lark/drive/`: Drive link parsing, provider response validation, bounded reads, inventory observations, and the single file-move operation.
- `apps/synvo-assistant/src/workflows/organize-folder/`: authorization sessions, bounded content coordinator, PostgreSQL persistence, workflow policy, state transitions, and user-facing formatting.
- `apps/synvo-assistant/src/workflows/analyze-attachment/`: direct-PDF event policy, local extraction, NVIDIA NIM analysis, and progress-message orchestration.
- `apps/synvo-assistant/src/workflows/analyze-drive-file/`: allowlisted Drive-PDF policy and reuse of the existing extraction, analysis, and progress path.
- `apps/synvo-assistant/src/workflows/natural-language/`: bounded sanitization and the strict semantic intent and folder-reference contract only.
- `apps/synvo-assistant/src/workflows/knowledge/`: fixed knowledge policy, page-aware chunking, Voyage boundary, scoped repository, resumable ingestion/refresh jobs with exact-job cancellation, retrieval, and grounded-answer ownership.
- `apps/synvo-assistant/src/workflows/workspace-context/`: bounded top-level My Folders discovery and exact active-root matching; semantic intent recognition remains in the existing natural-language boundary.
- `apps/synvo-assistant/src/delivery/`: durable outbound jobs and retry behavior.
- `apps/synvo-assistant/src/db/` and `database/migrations/`: database lifecycle and immutable schema history.
- `apps/synvo-assistant/src/doctor.ts`: concise readiness checks; do not duplicate workflow logic.

Each active pilot policy has one owner: Drive-fixture policy is in `apps/synvo-assistant/src/workflows/organize-folder/pilot-policy.ts`; attachment limits are in `apps/synvo-assistant/src/workflows/analyze-attachment/policy.ts`.

## Engineering workflow

Before editing:

- Read this guide and the current task plan when one exists.
- Inspect existing code before adding abstractions.
- Preserve user changes and ignored local configuration.

While editing:

- Make the smallest coherent change.
- Use plain TypeScript and explicit functions.
- Keep provider-specific behavior near the provider client.
- Keep workflow decisions in the workflow.
- Prefer deletion over compatibility wrappers for internal code with no external consumer.

Before handing off:

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
```

Then perform the manual Lark acceptance in the root README when behavior or integration boundaries change.

## Definition of done

A workflow phase is done when:

- The user can complete it through Lark.
- Authorization and policy boundaries are explicit.
- The outcome is verified against provider state.
- Duplicate events and process restarts are safe.
- Failures are bounded, recoverable, and do not leak sensitive data.
- Tests protect user behavior, security boundaries, provider contracts, or important recovery paths.
- Documentation describes the current implementation once, without duplicated phase history.
- Every path named in the source-ownership list exists and still has the stated responsibility.

For current status, use the root README. Completed plans and acceptance evidence belong in `tasks/archive/`; create a new active plan only for the next approved loop.
