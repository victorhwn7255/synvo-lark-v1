# Codebase Simplification Plan

Status: Active; complete before Phase 4  
Objective: Keep the verified Lark workflow and its safety guarantees while reducing the project to the simplest production-ready architecture that can close `/organize-folder`.

## 1. Rule

Every component must serve a current requirement.

Prefer:

1. Delete obsolete code.
2. Reuse an existing component.
3. Combine overlapping components.
4. Add a small local module.
5. Add a package, process, protocol, worker, table, or framework only when the current workflow proves it is needed.

Phase 4 must not begin until this plan's final gate passes.

## 2. Safety controls that stay

Simplification must keep:

- Victor-only pilot access.
- Lark user and tenant binding.
- OAuth state and PKCE validation.
- Encrypted OAuth tokens and safe refresh.
- Exact root-folder allowlisting.
- Bounded Drive pagination, timeouts, and safe errors.
- PostgreSQL durability.
- `ORGANIZE_FOLDER_WRITE_ENABLED=false` in persistent configuration.
- No mutation path before user-facing approval exists.
- Pre-write snapshot validation and post-write verification when writes return.
- Enough action history to support future undo.

Do not rename, rewrite, or delete applied migration files. Do not destructively clean live database or OAuth data during this refactor.

## 3. Target architecture

Use one modular Node.js service, one PostgreSQL database, and direct Lark and future OpenAI clients.

```text
Lark
  |
  v
Synvo AI Assistant
  ├── bot and OAuth
  ├── organize-folder workflow
  ├── Lark Drive client
  ├── one durable job/delivery worker
  └── future OpenAI client
          |
          v
      PostgreSQL
```

Keep logical source modules, but remove unnecessary package and process boundaries.

```text
apps/assistant-backend/src/
├── index.ts
├── config.ts
├── db/
├── lark/
│   ├── bot.ts
│   ├── oauth.ts
│   └── drive.ts
├── workflows/
│   └── organize-folder.ts
└── ops/
    └── doctor.ts
```

MCP is a future adapter. Reintroduce it only when an independently running Codex agent or another application becomes a real consumer.

## 4. Step 1: preserve evidence, then delete completed experiments

### Work

- [ ] Commit the current passing implementation.
- [ ] Tag the verified move-and-restore spike.
- [ ] Save its redacted commands and outcomes in one short archived evidence file.
- [ ] Confirm four root PDFs, two empty destinations, and the disabled write switch.
- [ ] Remove `apps/synvo-lark-mcp/tools/drive-move-spike/`.
- [ ] Remove Drive-spike scripts and spike-specific tests.
- [ ] Remove `pin-pilot-identity.ts`, its tests, and its command; the identity is already pinned in ignored configuration.
- [ ] Remove the large read-only and move-spike live verifiers.
- [ ] Keep applied migrations unchanged, even when their tables become unused.

### Replacement

Add one small `npm run doctor` command that reports only:

1. Configuration validity.
2. Database and migration readiness.
3. Active OAuth-grant usability and identity match.
4. Root-token digest match.
5. Disabled write switch.
6. Latest workflow terminal status.

It must not duplicate workflow logic or reveal sensitive values.

### Gate

- Completed experiments and one-time bootstrap utilities are no longer shipped.
- The current verified state remains recoverable from Git.
- `npm run doctor` returns one concise result.

## 5. Step 2: use one process, one package, and least privilege

### Work

- [ ] Switch the active runtime from the move-spike OAuth profile to the read-only inventory profile.
- [ ] Request only `space:document:retrieve`, `drive:drive.metadata:readonly`, and `offline_access`.
- [ ] Remove move-spike wording and capability state from the normal runtime.
- [ ] Move the Drive reader, link parser, safe errors, and inventory builder into `apps/assistant-backend/src/lark/`.
- [ ] Call the Drive service directly from the workflow.
- [ ] Remove the MCP stdio client, MCP server, child process, duplicate configuration loader, and second database pool.
- [ ] Move the small contracts and OAuth modules into the backend source tree.
- [ ] Remove `packages/contracts`, `packages/lark-auth`, and `apps/synvo-lark-mcp` after their active code has moved.
- [ ] Reduce the repository to one deployable npm package.
- [ ] Remove `@modelcontextprotocol/sdk` from runtime dependencies.

Do not replace MCP with another RPC layer, tool registry, plugin system, provider framework, or dependency-injection container.

### Gate

- One Node process handles Lark messages, OAuth, Drive reads, and workflow orchestration.
- One configuration loader and one PostgreSQL pool exist.
- The active grant and runtime are read-only.
- The same Lark folder inventory still succeeds.

## 6. Step 3: use one workflow run and one durable job

### Target

- `organize_folder_runs.message_id` deduplicates organize-folder requests.
- Lark message UUIDs make replies idempotent.
- One durable job/outbox owns longer work and delivery.
- OAuth sessions and grants remain encrypted and durable.

### Work

- [ ] Remove `PostgresInbox` from normal message handling.
- [ ] Reply to `/ping` directly with a stable Lark UUID.
- [ ] Use the workflow-run unique `message_id` for command deduplication.
- [ ] Keep one simple durable job/outbox for OAuth completion and longer work.
- [ ] Let the job lease own inventory execution; remove the second scan lease.
- [ ] Move inventory preparation and terminal-state updates into the organize-folder workflow.
- [ ] Remove the separate inventory-run claim/cache repository when the job already owns execution.
- [ ] Keep bounded retry with one safe failure message.
- [ ] Do not create a generic workflow engine.

Unused existing tables and columns may remain. Do not add a cosmetic cleanup migration.

### Gate

- One request maps to one workflow run and at most one durable job.
- Duplicate delivery or process restart does not create duplicate runs.
- OAuth safety and durable result delivery still work.

## 7. Step 4: centralize policy and prune tests and documentation

### Runtime policy

- [ ] Put the pilot root name, approved destinations, item limit, and fixture expectations in one `pilot-policy.ts`.
- [ ] Remove duplicate hardcoded fixture lists.
- [ ] Build one canonical read-only snapshot per request.
- [ ] Do not repeat the full scan merely to display a read-only result.
- [ ] Re-read and compare the snapshot immediately before future mutations.
- [ ] Keep pagination, owner checks, allowlisting, limits, and safe errors.

### Tests

Keep tests for:

- [ ] Commands and root allowlisting.
- [ ] OAuth state, PKCE, identity, scopes, encryption, and refresh.
- [ ] Drive pagination, timeouts, malformed responses, and safe errors.
- [ ] Snapshot construction and message idempotency.
- [ ] One real PostgreSQL integration path.
- [ ] One manual Lark acceptance checklist.

Remove tests for deleted spike tools, identity-file mutation, verifier boolean matrices, removed state machines, and duplicate MCP/package boundaries.

Do not introduce a coverage target. Each retained test must protect user behavior, a security boundary, a provider contract, or an important recovery path.

### Documentation

- [ ] Keep `README.md` as the product, setup, and architecture guide.
- [ ] Reduce `AGENTS.md` to current principles and non-negotiable safety rules.
- [ ] Move detailed Phase 1-3 history into one archived evidence file.
- [ ] Merge or shorten the backend README.
- [ ] Remove duplicated status, scope, and test-result prose.
- [ ] Update the organize-folder plan only after this gate passes.

### Gate

- One source of truth defines the pilot policy.
- Tests are materially smaller and behavior-focused.
- Each operational fact has one canonical document.

## 8. Verification

After each step:

```bash
npm run typecheck
npm test
```

At the final gate:

```bash
npm run migrate
npm run test:integration
npm run doctor
npm run dev
```

Manual Lark acceptance:

1. `/ping` returns `pong`.
2. `/organize-folder <allowlisted-link>` returns two folders and four PDFs.
3. Invalid, external, sibling, and unallowlisted links fail safely.
4. A valid read-only OAuth grant is reused.
5. No file is opened, downloaded, moved, renamed, or changed.
6. Duplicate delivery does not create a duplicate workflow run.

## 9. Final gate before Phase 4

- [ ] One deployable service and active npm package.
- [ ] One process, configuration loader, and PostgreSQL pool.
- [ ] No internal MCP subprocess.
- [ ] No active move-spike or identity-pinning code.
- [ ] One concise doctor command.
- [ ] One active read-only OAuth profile.
- [ ] One pilot-policy source of truth.
- [ ] One workflow run and at most one durable job per request.
- [ ] Applied migrations and live OAuth data remain intact.
- [ ] Type checks, retained tests, PostgreSQL integration, and Lark acceptance pass.
- [ ] The refactor is a net deletion of code and concepts.

Only then begin Phase 4: return a deterministic read-only proposal in Lark. Add GPT after the deterministic proposal and approval path work end to end.

## 10. Do not do during simplification

- Do not add GPT, cards, another workflow, a plugin platform, or an agent framework.
- Do not switch databases or add infrastructure services.
- Do not build a generalized provider or workflow abstraction.
- Do not modify the live Drive hierarchy.
- Do not perform destructive database cleanup.
- Do not introduce a new framework to remove an old framework.
- Do not keep code only because it may become useful later.

The desired result is the smallest understandable, secure, production-ready system that reliably closes the Synvo workflow.
