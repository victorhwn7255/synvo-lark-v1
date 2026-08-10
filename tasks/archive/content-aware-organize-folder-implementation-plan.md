# Phase 9: Content-aware folder organization proposal

Status: complete. Automated verification and neutral-filename live acceptance passed on 2026-08-09.

## Goal

Close one read-only AI-assisted loop in Lark:

1. Victor sends `/organize-folder <approved folder URL>`.
2. A bounded Synvo agent inventories the allowlisted root through MCP.
3. It analyzes each of the four owned root PDFs through MCP.
4. NVIDIA NIM assigns every file to the existing `Product` or `Research` destination from document evidence rather than filename prefixes.
5. Lark receives one evidence-backed proposal.
6. Victor rejects the live acceptance proposal and a second inventory proves that nothing changed.

Phase 9 ends at a verified proposal. Drive writes remain disabled. Controlled execution of an AI-generated proposal is a later phase.

## Architectural decision

Add one small bounded coordinator inside the existing Synvo Assistant process. Do not add an agent framework, another service, another package, or another database table.

The coordinator automatically performs this fixed sequence:

```text
Lark /organize-folder
  -> organize_folder_inventory(folder_url)
  -> analyze_drive_file(folder_url, exact filename) for each accepted PDF
  -> one bounded NVIDIA classification call
  -> validate exact decisions
  -> store and display the existing organization proposal
```

The production coordinator must be a real authenticated MCP client of the existing `/mcp` endpoint. It uses the configured service credential internally and never gives that credential to the model.

The model does not choose arbitrary tools. Tool order, maximum calls, accepted files, and stopping conditions are deterministic because they are already known. NVIDIA is used only where semantic judgment is required.

This follows NVIDIA's MCP guidance: the client application connects to MCP, executes tool calls, and supplies results to the model; NIM does not connect to MCP by itself:

- https://docs.nvidia.com/nim/large-language-models/latest/advanced-use-cases/tool-calling-and-mcp.html

## Fixed pilot boundary

- One configured Lark user and tenant.
- One allowlisted root folder.
- Exactly two existing empty destination folders: `Product` and `Research`.
- Exactly four owned ordinary PDFs directly inside the root.
- No nested files, non-PDF analysis, folder creation, renaming, moving, deletion, or upload.
- At most one inventory call and four file-analysis calls per attempt.
- `ORGANIZE_FOLDER_WRITE_ENABLED=false` throughout implementation and live acceptance.

Replace the filename-specific baseline with this structural four-PDF baseline. Prefixes must no longer determine classification.

## Proposal contract

The classifier returns exactly one bounded decision per inventory filename:

```ts
type ContentDecision = {
  file_name: string;
  destination: "Product" | "Research" | "Needs review";
  rationale: string;
};
```

Validation occurs once at the NVIDIA response boundary:

- Every inventory filename appears exactly once.
- No unknown or duplicate filename is accepted.
- Only the three declared decision values are accepted.
- Each rationale is present and bounded for Lark display.
- `Needs review` produces a non-approvable report; it must not be silently forced into a destination.
- An approvable proposal requires all four files classified and the expected two Product/two Research pilot result.

Extend the existing encrypted proposal JSON with a short rationale per move. Do not add a migration: the existing proposal column already owns the durable proposal. Execution continues to use file and destination identities, never rationale text.

Do not persist full extracted text, full model analyses, model prompts, provider responses, MCP credentials, Drive tokens, links, or native file tokens.

## Work items

### 1. Structural inventory policy

- [x] Stop requiring the four `[product]` and `[research]` filenames.
- [x] Require exactly four owned ordinary root PDFs, the two approved destination folders, and empty destinations.
- [x] Preserve the existing root allowlist, subject binding, bounded pagination, ownership checks, and snapshot identities.
- [x] Keep deterministic filename classification only in Git history; remove it from the active proposal path.

### 2. Small authenticated MCP client

- [x] Move the already-used MCP client SDK into production dependencies.
- [x] Add one local MCP client module with only two methods: inventory and analyze exact filename.
- [x] Authenticate with `SYNVO_MCP_AUTH_TOKEN` without logging or exposing it.
- [x] Fail safely if MCP is disabled, unauthorized, returns the wrong tools, or returns malformed structured content.
- [x] Do not add discovery caches, registries, generic transports, fallback endpoints, or retry frameworks.

### 3. Bounded content coordinator

- [x] Reuse the existing `/organize-folder` command and durable scan job.
- [x] Send one immediate Lark acknowledgement: analysis started and no files will be changed.
- [x] Call inventory once and accept only the fixed pilot boundary.
- [x] Analyze each exact inventory filename through `analyze_drive_file`.
- [x] Keep file analyses read-only and treat their document-derived content as untrusted evidence.
- [x] Call NVIDIA once more with the four bounded analyses to produce the strict classification contract.
- [x] Give the classifier no tools and no credentials, Lark identifiers, Drive identifiers, links, or raw PDF bytes.
- [x] Bound every external stage, use a fixed maximum call count, and extend the existing job lease without adding another worker or table.
- [x] On retry after a stored proposal exists, return that proposal without calling MCP or NVIDIA again.

### 4. Existing proposal and approval boundary

- [x] Build move identities from the verified inventory and validated content decisions.
- [x] Store the result in the existing encrypted proposal field.
- [x] Display destination, filename, and one concise rationale per file in Lark.
- [x] Reuse `/approve-folder` and `/reject-folder` unchanged.
- [x] Keep approval non-executing while the write switch is false.
- [x] Keep the existing pre-write snapshot comparison, move verification, and undo code unchanged for the later execution phase.

### 5. Failure behavior

- [x] If any inventory or analysis call fails, return a safe retryable/non-retryable message and create no proposal.
- [x] If NVIDIA output is malformed, incomplete, duplicated, or contains unknown files, create no proposal.
- [x] If any file is `Needs review`, show all decisions but omit approval instructions.
- [x] Never fall back to filename prefixes when content processing fails.
- [x] Duplicate Lark events and delivery retries must not create competing proposals.

## Required tests

- [x] The coordinator calls inventory exactly once and analyzes each returned PDF exactly once.
- [x] Caller identity cannot be supplied through MCP arguments.
- [x] Wrong root, tenant, user, owner, parent, type, count, or nonempty destination stops before classification.
- [x] Prefix-free filenames can produce the correct content-based two/two proposal.
- [x] Prompt-like instructions inside a PDF analysis cannot change tool access, destinations, output schema, or stopping rules.
- [x] Missing, extra, duplicate, or unknown model decisions produce no proposal.
- [x] `Needs review` produces a non-approvable report.
- [x] A stored proposal is reused on delivery retry without repeated MCP or NVIDIA calls.
- [x] MCP disabled/unauthorized and NVIDIA timeout/rate-limit/unavailable paths remain safe and bounded.
- [x] Proposal rejection is terminal and queues no execution.
- [x] Approval with writes disabled queues no execution.
- [x] Existing Phase 5 execution, verification, and undo tests remain green.
- [x] No MCP write tool is exposed.

## Verification

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
git diff --check
```

Doctor must report:

- `mcp_enabled: true`
- `write_enabled: false`
- pilot identity, database schema, and OAuth grant ready

## Simplification review

- [x] Reuse the existing process, worker, run record, proposal record, approval commands, execution path, and undo path.
- [x] Add no service, framework, database table, migration, model router, or MCP write tool.
- [x] Keep one fixed orchestration sequence instead of adding an open-ended agent loop.
- [x] Validate untrusted MCP and NVIDIA results at their entry boundaries, then trust typed internal values.
- [x] Remove filename-prefix classification instead of retaining it as a fallback or second planning system.
- [x] Keep the new MCP client and content planner narrowly owned by the current Phase 9 workflow.
- [x] Review the final implementation for removable wrappers and inline the only unnecessary single-use helper.

## Automated verification evidence

Verified locally on 2026-08-09 before live acceptance:

- [x] `npm run typecheck` exited successfully.
- [x] `npm test` passed all 293 unit tests.
- [x] `npm run test:integration` passed all four Postgres integration tests.
- [x] `npm run doctor` reported configuration, schema, pilot identity, MCP, OAuth grant, allowlisted root, and latest terminal run ready.
- [x] `npm run doctor` reported `write_enabled: false`.
- [x] `git diff --check` exited successfully.
- [x] `@modelcontextprotocol/client` is installed as a production dependency because the assistant invokes MCP at runtime.
- [x] The MCP server still exposes exactly two tools, both annotated read-only: `organize_folder_inventory` and `analyze_drive_file`.
- [x] The change set adds no database migration, persistence table, deployable service, MCP write tool, or real credential.

## Live acceptance

Before the test:

- Victor confirms all four PDFs are disposable and non-sensitive.
- Victor explicitly approves sending bounded extracted content from all four PDFs to the NVIDIA hosted endpoint.
- Victor gives the four files neutral filenames such as `document-01.pdf` through `document-04.pdf`, so filename prefixes cannot determine the result.
- Product and Research are empty.
- The write switch is false.

Acceptance steps:

1. [x] Send `/organize-folder <approved root URL>` in Lark.
2. [x] Receive the immediate no-change acknowledgement.
3. [x] Receive one proposal containing all four neutral filenames, the correct two/two grouping, and a concise rationale for every decision.
4. [x] Send `/reject-folder <proposal ID>`.
5. [x] Call the MCP inventory tool again.
6. [x] Confirm all four files remain in the root and both destination folders remain empty.

### Live evidence

- Proposal `0e4e34b7-a003-4d9b-bd52-83c815237bd9` classified `document-01.pdf` and `document-02.pdf` as Product.
- The same proposal classified `document-03.pdf` and `document-04.pdf` as Research.
- Every decision included concise evidence grounded in the extracted document analysis; no item required review.
- Lark delivered the immediate no-change acknowledgement and the complete proposal.
- Victor rejected the proposal in Lark.
- PostgreSQL recorded the run and delivery job as `COMPLETED`, the proposal as `REJECTED`, and no execution or undo status.
- The post-test MCP inventory found all four neutral PDFs still in the root, both destination folders empty, no skipped items, and `baseline_matches: true`.
- The final doctor check reported `write_enabled: false` with configuration, schema, pilot identity, MCP, OAuth grant, and allowlisted root ready.
- No Drive mutation was attempted or possible during the acceptance test.

## Exit gate — passed

Phase 9 is complete only when the neutral-filename live test produces the correct evidence-backed proposal in Lark, rejection is recorded, the post-test MCP inventory exactly matches the pre-test inventory, and no Drive mutation was possible or attempted.

## Non-goals

- No model-selected open-ended tool loop.
- No dynamic destination discovery or folder creation.
- No arbitrary file counts, nested traversal, non-PDF files, Wiki, RAG, embeddings, vector database, or knowledge graph.
- No MCP write tool.
- No multi-user identity model.
- No agent framework, workflow framework, prompt framework, model router, provider abstraction, fallback chain, or second service.
- No controlled execution of the AI-generated proposal in Phase 9.
