# Synvo AI Assistant Engineering Guide

## Product goal

Build a trusted internal assistant inside Lark that lets Synvo team members use natural-language conversations to retrieve company knowledge and execute approved operational or engineering workflows without leaving Lark.

The product is delivered by closing small loops: a workflow is complete only when it handles the full path from request to verified outcome. Do not build a general-purpose agent platform ahead of demonstrated needs.

## Current scope

The active pilot is `/organize-folder` for Victor's allowlisted Lark My Space folder, `Test_Synvo_AI_Assistant`.

Current behavior:

- `/ping` proves the App Bot connection.
- `/organize-folder <folder-link>` performs user-bound OAuth when needed.
- The Synvo Assistant application validates the exact root token.
- It builds a bounded read-only inventory of `Product`, `Research`, and four PDF fixtures.
- It deterministically proposes two Product and two Research moves from the approved filename prefixes.
- `/approve-folder <proposal-id>` and `/reject-folder <proposal-id>` record Victor's decision without executing it.
- It returns the proposal and decision result in Lark without opening, downloading, or changing files.
- An optional authenticated `/mcp` endpoint exposes the same inventory capability to approved AI agents without duplicating the workflow.

The long-term target is Lark Wiki, once the application has appropriate Wiki access. The Drive pilot proves the same analysis, proposal, approval, execution, verification, and undo loop in a controlled sandbox.

## Architecture

Use one modular Synvo Assistant Node.js application and PostgreSQL:

```text
Lark App Bot -> message/OAuth handlers --+
                                        |
Approved AI agent -> authenticated /mcp +-> organize-folder workflow
                                           -> direct Lark Drive client
                                           -> durable delivery worker
                                           -> PostgreSQL
```

Keep one process, one npm package, one configuration loader, and one database pool. Logical source modules are useful; extra deployables, RPC boundaries, package boundaries, registries, and frameworks require a current independent consumer or operational need.

MCP is a thin adapter in the existing process for external AI agents. It may expose only workflow capabilities that already have an authoritative policy owner; it must not duplicate provider access, workflow state, or authorization logic. Add tools individually when a real agent or workflow needs them—do not build a generic registry or second backend.

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

- Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false` throughout Phase 4; approval records intent only and must not reach a Drive mutation.
- Restrict the pilot to the configured Lark `open_id` and tenant.
- Keep the MCP endpoint disabled unless a strong service credential is configured. During the single-user pilot, map that credential only to the configured Lark `open_id` and tenant; never accept actor identity from MCP tool arguments.
- Expose only the read-only `organize_folder_inventory` MCP tool until a separately approved workflow requires another capability.
- Bind OAuth state to the initiating message, user, tenant, redirect URI, scopes, and PKCE verifier.
- Encrypt access and refresh tokens at rest and rotate refresh tokens atomically.
- Request the exact active read-only scopes:
  - `space:document:retrieve`
  - `drive:drive.metadata:readonly`
  - `offline_access`
- Allow only the configured root folder token; reject arbitrary external, sibling, nested, Wiki, and malformed URLs.
- Bound pagination, request timeouts, item counts, output lengths, and retries.
- Return safe error categories; never expose provider bodies, credentials, native Drive tokens, or restricted links.
- Keep durable delivery idempotent with stable Lark message UUIDs.
- Never rename, rewrite, or delete applied migrations. Remove obsolete schema only through a new forward-only migration.
- Never commit `.env`, OAuth grants, secrets, tokens, or sensitive logs.

Before future writes:

- Re-read and compare the approved snapshot immediately before mutation.
- Require explicit user approval of a concrete proposal.
- Restrict mutations to proposed source and destination tokens.
- Record enough information for verification and undo.
- Verify provider state after every mutation and stop safely on mismatch.

## Source ownership

- `apps/synvo-assistant/src/index.ts`: composition and lifecycle only.
- `apps/synvo-assistant/src/config.ts`: environment parsing only.
- `apps/synvo-assistant/src/lark/command-parser.ts`: Lark chat command parsing only.
- `apps/synvo-assistant/src/web/`: HTTP routing for health, browser-based OAuth, and the MCP endpoint.
- `apps/synvo-assistant/src/mcp/`: MCP protocol mapping and service authentication only; delegate all policy and provider work to workflows.
- `apps/synvo-assistant/src/lark/auth/`: Lark OAuth protocol, PKCE, encrypted grants, and refresh.
- `apps/synvo-assistant/src/lark/drive/`: Drive link parsing, provider response validation, API reads, and inventory building.
- `apps/synvo-assistant/src/workflows/organize-folder/`: authorization sessions, PostgreSQL persistence, workflow policy, state transitions, and user-facing formatting.
- `apps/synvo-assistant/src/delivery/`: durable outbound jobs and retry behavior.
- `apps/synvo-assistant/src/db/` and `database/migrations/`: database lifecycle and immutable schema history.
- `apps/synvo-assistant/src/doctor.ts`: concise readiness checks; do not duplicate workflow logic.

The active pilot policy belongs in one file: `apps/synvo-assistant/src/workflows/organize-folder/pilot-policy.ts`.

## Engineering workflow

Before editing:

- Read this guide and the active task plan.
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

For current status and next actions, use `tasks/organize-folder-implementation-plan.md`. Historical Phase 1-3 evidence is in `tasks/archive/phase1-3-verification-evidence.md`.
