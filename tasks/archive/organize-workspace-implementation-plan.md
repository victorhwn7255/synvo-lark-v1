# Phase 15: Content-aware workspace organization at scale

Status: **completed on 2026-08-12**.

Automated gate: `npm run typecheck`, all 426 unit tests, all 7 PostgreSQL
integration tests, and `git diff --check` passed. The implementation also
completed the required line-level simplification review.

Live Lark acceptance passed with the 15 disposable PDFs in `Synvo_Wiki`:

- Victor replaced the old OAuth grant and verified ordinary folder creation.
- A first proposal was rejected without changing Drive.
- A fresh approved proposal created five broad folders and moved and verified
  all 15 PDFs.
- Knowledge reconciliation updated all 15 citation paths without re-embedding
  unchanged content.
- Cross-folder grounded questions continued to return correct answers and
  current relative-path/page citations.
- Separately selected undo restored and verified all 15 original parents and
  reconciled all 15 knowledge paths without re-embedding.
- The completion card correctly reported that proposal-created empty folders
  remain after undo.
- The final live run after strict taxonomy parsing fixes again completed both
  organization and undo successfully.

The committed/example write default remains `false`. Victor later explicitly
instructed that the ignored local `ORGANIZE_FOLDER_WRITE_ENABLED` value remain
`true` until he asks to disable it. That operator override is not a production
default and does not broaden OAuth, workspace, proposal, or verification
boundaries.

## Goal

Replace the exact four-file `/organize-folder` pilot with one complete
`/organize-workspace` loop for the configured `Synvo_Wiki` workspace:

1. A Synvo employee asks naturally to organize the active workspace.
2. The backend discovers every eligible PDF beneath the exact configured root,
   up to the fixed workspace-organization limit.
3. After explicit consent, it refreshes only new or changed workspace
   knowledge and reuses the indexed content for unchanged PDFs.
4. NVIDIA proposes a small, useful taxonomy and classifies every eligible PDF
   from document evidence.
5. The employee reviews one exact organization proposal in Lark.
6. After explicit approval and only while the operator write switch is enabled,
   the backend revalidates the proposal, reuses or creates the approved folders,
   moves the approved files, and verifies every observed parent.
7. Workspace-knowledge paths are reconciled without re-embedding unchanged
   content.
8. A separately selected undo restores every moved PDF to its original parent.

This phase replaces the old organizer. It must not create a parallel workflow,
an autonomous agent platform, or a second knowledge system.

## Confirmed product decisions

The following decisions were confirmed before planning:

- Consider all eligible PDFs recursively beneath `Synvo_Wiki`, including PDFs
  already stored in subfolders.
- Preserve a PDF's existing location when its current top-level folder already
  fits the approved taxonomy.
- Reuse suitable existing top-level folders and create only missing approved
  folders.
- Require one explicit confirmation before sending new or changed document
  content to Voyage or bounded document evidence to NVIDIA.
- Require a separate exact proposal approval before any Drive mutation.
- Undo restores each PDF to its original parent but leaves newly created empty
  folders in place.
- Use a preferred taxonomy range of two to six folders, targeting three or four.
- User-selected folder counts and user-supplied taxonomies are future features,
  not Phase 15 requirements.

## Starting baseline

The current system already provides:

- One configured employee, tenant, and workspace root token.
- Recursive, fully paginated PDF discovery beneath that root.
- Page-aware extraction and chunking, fixed `voyage-4` embeddings, and scoped
  PostgreSQL/pgvector storage.
- New, changed, unchanged, path-only changed, and removed-source reconciliation.
- Natural-language routing, Lark progress cards, durable delivery, stop/resume,
  and grounded workspace Q&A.
- A four-file organizer with OAuth, encrypted proposals, explicit approval,
  verified moves, durable recovery, and verified undo.

The existing organizer also contains obsolete pilot assumptions that Phase 15
must remove:

- Exactly four PDFs.
- Exactly two existing empty folders named `Product` and `Research`.
- Exactly two files per destination.
- Direct-root source files only.
- A single NVIDIA response containing at most four decisions.
- Proposal and Lark-card types hard-coded to `Product`, `Research`, and
  `Needs review`.

## Employee experience

### Starting the workflow

The primary interaction is natural language:

```text
Could you organize our current workspace?
```

The exact fallback is:

```text
/organize-workspace
```

The assistant verifies the active workspace locally and shows a consent card:

```text
Prepare a workspace organization plan?

I found 15 PDFs in Synvo_Wiki.

I’ll refresh any new or changed workspace knowledge, then use document content
to propose a small set of useful folders. Nothing will move during analysis.

[Analyze workspace]  [Not now]
```

The confirmation covers the bounded provider processing required by this exact
request. It does not approve folder creation or file movement.

### Reviewing the proposal

The result should be concise at the top level:

```text
Workspace organization proposal

4 folders · 15 PDFs · 12 moves · 3 already well placed

Product & Engineering       5 PDFs   New folder
Research                    4 PDFs   Reuse existing folder
Go-to-Market                3 PDFs   New folder
Company Operations          3 PDFs   New folder

Needs review                0 PDFs

[Review files]  [Approve organization]  [Reject]
```

`Review files` pages through every exact decision and rationale without placing
all 99 possible entries into one oversized card. Approval always applies to the
entire encrypted proposal snapshot, not only the visible page.

### Execution and undo

After approval, the existing durable worker updates one card while it:

1. Revalidates the workspace snapshot.
2. Creates only approved missing folders.
3. Moves only approved PDFs that are not already well placed.
4. Verifies each final parent.
5. Reconciles knowledge paths without re-embedding unchanged PDFs.

The completed card reports folder creation, preserved files, verified moves,
and any untouched `Needs Review` files. It offers **Undo organization**.

Undo restores exact original parents and verifies the result. Empty folders
created by the accepted proposal remain in Drive and the card says so clearly.

## Fixed Phase 15 policy

Keep these limits in one organizer policy module and protect them with focused
tests:

- Maximum eligible PDFs: **99**.
- Taxonomy target: **3–4 folders**.
- Normal taxonomy range: **2–6 folders**.
- A one-folder result is allowed only when fewer than three eligible PDFs exist
  or splitting would be demonstrably artificial.
- Hard maximum generated or selected destination folders: **6**.
- Destination depth: **one top-level folder beneath the configured root**.
- Prefer at least two PDFs per newly created folder.
- Never create an empty folder.
- `Needs Review` is a proposal section, never a Drive folder.
- Reuse Phase 14's depth, visited-folder, pagination, ownership, path-length,
  file-size, page, and extraction limits.
- If more than 99 eligible PDFs are discovered, fail the complete organization
  request safely. Never organize a silent subset.

These are product policy, not user-configurable environment variables.

## Taxonomy rules

The proposed taxonomy must be broad, stable, and useful across repeated use:

- Favor the fewest folders that materially improve navigation.
- Avoid one folder per document, project, person, date, or narrow topic.
- Avoid overlapping labels whose distinction is not clear from the documents.
- Prefer an existing suitable top-level folder over a synonymous new folder.
- Do not rename, merge, move, or delete existing folders in Phase 15.
- Do not flatten a correctly placed nested PDF. If its first verified path
  segment matches its assigned destination, preserve its current parent.
- Files with insufficient or materially ambiguous evidence stay in place under
  `Needs Review`.

Backend validation, not prompt text alone, enforces:

- Folder-count bounds.
- Unique normalized names.
- Safe bounded names without separators, control characters, `.` or `..`.
- Nonempty assignments for every new folder.
- Exact use of an existing verified folder token or an approved new name.
- Every eligible PDF appears exactly once as preserved, moved, or needs review.
- No model-provided token, URL, function name, or arbitrary destination is used.

## Content-planning design

Do not send all PDF text in one giant prompt and do not re-download unchanged
PDFs for organization.

Use the existing workspace vault as the analysis layer:

1. Run the existing verified recursive comparison.
2. After consent, complete the existing knowledge refresh for new or changed
   PDFs.
3. Read bounded representative evidence for every eligible PDF from the scoped
   knowledge repository.
4. Ask NVIDIA in bounded batches for one compact document profile per opaque
   backend document ID.
5. Ask NVIDIA once for a two-to-six-folder taxonomy using only those compact
   profiles and safe existing top-level folder names.
6. Classify profiles in bounded batches into only that validated taxonomy or
   `Needs Review`.
7. Join opaque IDs back to trusted Drive identities in the backend.

The model receives no tools, Lark links, native tokens, OAuth values, database
IDs, or write capability. Filenames, folder names, and extracted text remain
untrusted data. Provider output is validated once at the NVIDIA boundary and
then converted into trusted internal proposal types.

Do not add a document-profile table. Profiles exist only for the current
planning run and the final encrypted proposal evidence. Existing chunks remain
the durable source of document knowledge.

## Strict model contracts

The exact schemas may use Zod at the provider boundary, but their semantics are:

```ts
type WorkspaceDocumentProfile = {
  document_id: string;
  summary: string;
  themes: string[];
};

type WorkspaceTaxonomy = {
  folders: Array<{
    name: string;
    description: string;
    reuse_existing: boolean;
  }>;
};

type WorkspaceOrganizationDecision = {
  document_id: string;
  destination: string | "Needs Review";
  rationale: string;
};
```

The backend supplies opaque document IDs and the validated destination set.
NVIDIA cannot introduce a destination during classification.

## Proposal contract

Extend the existing encrypted proposal JSON rather than adding another table:

```ts
type OrganizeWorkspaceProposal = {
  proposal_id: string;
  workspace_identity_digest: string;
  taxonomy: Array<{
    name: string;
    description: string;
    action: "REUSE" | "CREATE";
    existing_folder_ref?: string;
    existing_folder_identity_digest?: string;
  }>;
  files: Array<{
    file_ref: string;
    file_identity_digest: string;
    file_name: string;
    original_parent_ref: string;
    original_relative_path: string;
    decision: "PRESERVE" | "MOVE" | "NEEDS_REVIEW";
    destination_name?: string;
    rationale: string;
  }>;
};
```

Native references remain encrypted and never appear in Lark or model input.
Execution records use the existing durable proposal/execution JSON ownership.
Applied migrations remain immutable.

## OAuth and Drive operations

The current application permission set includes folder creation, but the exact
user OAuth profile does not request it. Phase 15 must:

- Add `drive:drive` and `space:folder:create` to the exact shared Drive OAuth scope set.
- Require reauthorization when the stored grant lacks that scope.
- Add one narrow Drive operation for creating an ordinary folder directly
  beneath the configured root.
- Keep folder creation inside the trusted workflow; expose no MCP write tool.
- Never let the caller or model supply a native parent token.
- Create only missing folders named in the exact approved proposal.

The complete shared Drive OAuth set becomes:

- `space:document:retrieve`
- `space:document:move`
- `space:folder:create`
- `drive:drive`
- `drive:drive.metadata:readonly`
- `drive:file:download`
- `offline_access`

No delete scope is required. Undo intentionally leaves newly created empty
folders in place.

## Architecture

```text
Lark natural-language request or /organize-workspace
  -> exact employee, tenant, and workspace verification
  -> recursive PDF inventory and knowledge comparison
  -> explicit analysis/provider consent
  -> refresh only new or changed knowledge
  -> bounded repository evidence -> compact document profiles
  -> NVIDIA taxonomy -> backend validation
  -> NVIDIA batched classification into validated taxonomy
  -> encrypted exact proposal -> paginated Lark review
  -> explicit approve or reject
  -> durable worker and operator write switch
  -> complete snapshot revalidation
  -> reuse or create approved top-level folders
  -> move and verify exact approved PDFs
  -> path-only knowledge reconciliation
  -> verified result and separately selected undo
```

Use the existing Node.js process, database pool, OAuth grant store, delivery
worker, organizer run/proposal/execution records, knowledge repository, Voyage
client, NVIDIA client, Lark cards, and Drive move operation.

Do not add another process, package, queue, service, vector database, table,
workflow engine, agent framework, generic tool loop, taxonomy registry, provider
framework, or conversation-memory system.

## MCP boundary

The organizer remains an authoritative Synvo workflow, not a model-controlled
MCP write loop.

- Keep `analyze_drive_file` and `search_workspace_knowledge` read-only.
- Replace the obsolete four-file `organize_folder_inventory` contract with one
  clearly named read-only `inspect_workspace` capability only if no current
  external consumer depends on the old contract.
- `inspect_workspace` may return bounded safe paths and object types from the
  active configured workspace; it accepts no root override and returns no native
  tokens or content.
- The Phase 15 internal coordinator should reuse the authoritative Drive and
  knowledge functions directly rather than calling its own HTTP endpoint.
- Expose no folder-create, move, approval, execution, or undo MCP tool in this
  phase.

## Work items

### 0. Preflight and fixture protection

- [x] Record the current `Synvo_Wiki` tree, indexed-source count, chunk count,
  and write-switch state.
- [x] Confirm all 15 live acceptance PDFs are disposable and non-sensitive.
- [x] Keep the current working RAG vault intact until the new organizer passes
  automated tests.
- [x] Confirm an unchanged knowledge refresh proposes no provider work.
- [x] Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false` during implementation.

### 1. Replace the four-file policy

- [x] Create one authoritative workspace-organization policy with the 99-PDF,
  two-to-six-folder, one-level, and safe-name limits.
- [x] Remove exact four-file, Product/Research, two/two, root-only, and empty-
  destination invariants from production code.
- [x] Generalize proposal, execution, message, and card types to validated
  destination names.
- [x] Rename the employee-facing intent, fallback command, cards, and source
  ownership to `organize-workspace`.
- [x] Remove the obsolete `/organize-folder` runtime path after confirming no
  current automation depends on it; do not keep a second organizer.
- [x] Preserve historical applied table and migration names rather than adding a
  cosmetic database rename.

### 2. Analysis consent and knowledge readiness

- [x] Add one natural-language `organize_workspace` intent and exact
  `/organize-workspace` fallback.
- [x] Verify the active configured workspace before presenting consent.
- [x] Show current eligible, new, and changed PDF counts without exposing tokens.
- [x] Bind the consent action to the exact user, tenant, chat, workspace, and
  expiring inventory snapshot.
- [x] Reuse the existing knowledge refresh for new or changed PDFs.
- [x] Continue automatically into planning only after that exact refresh reaches
  a verified terminal state.
- [x] If knowledge is already current, perform no Voyage document embedding.

### 3. Bounded document profiles and taxonomy

- [x] Add one scoped repository read for bounded representative chunks grouped
  by verified Drive source.
- [x] Generate compact profiles in fixed-size NVIDIA batches with strict output.
- [x] Propose a taxonomy from profiles and safe existing top-level folder names.
- [x] Validate the taxonomy once at the provider boundary and enforce all backend
  folder-count/name/nonempty constraints.
- [x] Resolve exact-name existing folders locally; never let NVIDIA select a
  native folder identity.
- [x] Classify all document profiles in fixed-size batches into the validated
  taxonomy or `Needs Review`.
- [x] Require exact, unique coverage of all eligible opaque document IDs.
- [x] Build preserve, move, and needs-review decisions from verified paths.
- [x] Store no profile table, raw model response, prompt, or extracted document
  corpus in the organizer record.

### 4. Proposal and Lark review

- [x] Extend the existing encrypted proposal with taxonomy, folder action,
  original parent/path, decision, and rationale.
- [x] Render a concise summary with folder counts, reused/new markers, move count,
  preserved count, and needs-review count.
- [x] Add bounded previous/next detail pages for all exact file decisions.
- [x] Keep one proposal ID and one approve/reject decision across every page.
- [x] Disable approval if provider output, coverage, taxonomy, or inventory is
  invalid.
- [x] Show that analysis changed no Drive file or folder.

### 5. Folder creation and verified execution

- [x] Add `drive:drive` and `space:folder:create` to the exact OAuth grant and
  reauthorization checks.
- [x] Add one narrow Lark create-folder client operation.
- [x] Re-read and compare the complete approved tree immediately before writes.
- [x] Reuse verified existing destinations and create only approved missing
  top-level folders.
- [x] Persist newly created destination identities in the existing execution
  record before moving files.
- [x] Move only `MOVE` decisions; never move `PRESERVE` or `NEEDS_REVIEW` files.
- [x] Verify every observed parent and update one monotonic progress card.
- [x] Stop safely on the first mismatch and report exact completed/pending counts.
- [x] Make duplicate approvals, callbacks, and worker retries idempotent.

### 6. Knowledge reconciliation and undo

- [x] After verified execution, run the existing complete-tree comparison.
- [x] Apply path-only knowledge updates without Voyage for unchanged PDFs.
- [x] Report a successful Drive organization separately if knowledge-path
  reconciliation temporarily fails, and offer the existing refresh recovery.
- [x] Offer undo only for verified executed moves.
- [x] Restore exact original parents and verify every restored PDF.
- [x] Reconcile restored knowledge paths without re-embedding.
- [x] State clearly that newly created empty folders remain after undo.
- [x] Keep the committed/example write default false. Record Victor's later
  explicit instruction to leave the ignored local switch enabled until he asks
  to disable it.

### 7. MCP, documentation, and deletion pass

- [x] Remove or replace the obsolete four-file inventory MCP contract as defined
  in the MCP boundary above.
- [x] Keep all MCP capabilities read-only and authenticated.
- [x] Update `README.md` and `AGENTS.md` only after implementation matches the
  new behavior.
- [x] Remove obsolete four-file tests, cards, messages, constants, and local MCP
  self-calls rather than retaining compatibility layers.
- [x] Confirm the source-ownership list matches the final tree.
- [x] Run a line-level simplification review before live acceptance.
- [x] Archive this completed plan after closing the Phase 15 goal.

## Required automated tests

### Scope and discovery

- [x] One, 15, and 99 eligible PDFs produce complete deterministic inventories.
- [x] More than 99 eligible PDFs fails safely without a partial proposal.
- [x] Root and nested PDFs are included; siblings, Shared Folders, Wiki,
  shortcuts, unsupported objects, and unowned files remain excluded.
- [x] Repeated tokens/cursors, excessive depth/folders/path length, malformed
  pages, and provider errors retain Phase 14's fail-closed behavior.
- [x] Existing suitable top-level folders are resolved by verified provider
  observation, never by a caller-supplied token.

### Consent, knowledge, and privacy

- [x] No Voyage or NVIDIA document-content call occurs before exact consent.
- [x] Current unchanged knowledge causes no Drive download or Voyage embedding.
- [x] New or changed knowledge completes before organization planning.
- [x] Every knowledge and proposal operation filters tenant, employee, and
  workspace before source identity.
- [x] Cards, logs, model requests, and MCP results expose no native tokens,
  OAuth values, database IDs, service credentials, or raw links.
- [x] Prompt-like document and filename content cannot alter tools, schemas,
  folder limits, approval, or write behavior.

### Taxonomy and classification

- [x] Fifteen representative PDFs normally produce two to six broad nonempty
  folders, targeting three or four.
- [x] More than six folders, duplicate normalized names, unsafe names, empty new
  folders, or an undeclared classification destination is rejected.
- [x] A one-folder result is accepted only under the explicit small/artificial-
  split exception.
- [x] Every eligible PDF appears exactly once across preserve, move, and needs
  review.
- [x] Missing, duplicate, extra, or unknown document decisions produce no
  proposal.
- [x] `Needs Review` files stay in place and no Drive folder named Needs Review
  is created.
- [x] Existing correctly placed nested PDFs are preserved without flattening.
- [x] A provider-declared reused folder must exactly match a verified existing
  folder; contradictory reuse decisions are rejected.

### Proposal and interaction

- [x] All decisions remain reviewable across bounded detail pages.
- [x] Pagination cannot change proposal identity, contents, or approval scope.
- [x] Reject is terminal and performs no Drive mutation.
- [x] Approval with the write switch false records the decision and queues no
  execution.
- [x] Expired, stale, different-user, different-tenant, different-chat, and
  replayed actions fail safely.

### Execution, recovery, and undo

- [x] A complete unchanged snapshot creates only approved missing folders and
  moves only approved PDFs.
- [x] Folder-name collision, source/version/parent change, destination change,
  or incomplete revalidation stops before the first move.
- [x] Folder-create and move retries are idempotent and cannot create duplicate
  folders or duplicate execution records.
- [x] Partial provider failure records verified completed work and never reports
  unverified success.
- [x] Process restart resumes the existing execution safely.
- [x] Duplicate approval or delivery events do not execute twice.
- [x] Undo restores every moved PDF to its exact original parent.
- [x] Undo never deletes a folder and reports created empty folders honestly.
- [x] Repeated undo is idempotent.

### RAG and regression

- [x] Successful execution updates citation paths without document re-embedding.
- [x] Preserved files retain their chunks and paths.
- [x] Undo restores citation paths without re-embedding.
- [x] Grounded Q&A before and after execution returns equivalent facts with the
  correct current paths.
- [x] Attachment analysis, Drive-file analysis, workspace Q&A, recursive refresh,
  stop/resume, OAuth, delivery recovery, workspace context, and `/ping` remain
  green.
- [x] All remaining MCP tools remain authenticated and read-only.

## Live Lark acceptance with the 15-PDF demo workspace

### A. Clean read-only baseline

1. [x] Place the 15 disposable PDFs from `docs/pdf` beneath `Synvo_Wiki`.
2. [x] Confirm their contents are non-sensitive and approved for Voyage and
   NVIDIA processing.
3. [x] Confirm the write switch is false before the controlled execution window.
4. [x] Refresh knowledge and verify all 15 PDFs become indexed exactly once.
5. [x] Ask one single-document and one cross-document question with valid paths
   and page citations.

### B. Proposal without mutation

1. [x] Ask naturally to organize the current workspace.
2. [x] Review and accept the analysis/provider consent card.
3. [x] Verify the resulting taxonomy contains two to six broad folders and
   normally targets three or four.
4. [x] Verify all 15 PDFs appear exactly once across preserve, move, and needs
   review, each with a concise evidence-based rationale.
5. [x] Page through the proposal details.
6. [x] Reject the first proposal and verify the complete Drive tree is unchanged.

### C. Controlled execution

1. [x] Request a fresh proposal after the rejected test.
2. [x] Enable writes only under explicit operator authorization.
3. [x] Approve the exact fresh proposal.
4. [x] Verify approved missing folders are created once and suitable existing
   folders are reused.
5. [x] Verify every approved move reaches its exact destination and every
   preserved or needs-review PDF remains in its original parent.
6. [x] Refresh Drive manually if Lark's sidebar cache is stale and compare the
   provider tree with the completion card.
7. [x] Verify a second approval cannot execute anything again.

### D. Knowledge continuity

1. [x] Confirm the automatic reconciliation reports path-only updates.
2. [x] Verify no unchanged PDF is sent to Voyage again.
3. [x] Repeat the single-document and cross-document questions.
4. [x] Confirm facts remain correct and citations use the new relative paths.

### E. Verified undo

1. [x] Select **Undo organization** separately.
2. [x] Verify every moved PDF returns to its original parent.
3. [x] Verify citation paths return to the restored locations without
   re-embedding.
4. [x] Verify any Phase 15-created empty folders remain and the card reports
   that behavior.
5. [x] Keep the committed/example default false; retain the ignored local
   override only because Victor explicitly instructed it to remain enabled.

### F. Final safety gate

1. [x] Verify no PDF outside `Synvo_Wiki` was read, proposed, or changed.
2. [x] Verify no unsupported or needs-review file was moved.
3. [x] Verify no model received tools, native identifiers, credentials, or an
   executable write path.
4. [x] Verify PostgreSQL contains no duplicate chunks or organizer records.
5. [x] Verify authenticated MCP search still returns the same scoped knowledge
   and no MCP write tool exists.

## Failure behavior

- An incomplete or over-budget inventory creates no proposal.
- Temporary provider failure produces a bounded retryable result and performs no
  Drive mutation.
- Invalid taxonomy or incomplete classification creates no proposal.
- Any tree change after proposal creation makes the proposal stale.
- Any pre-write mismatch stops before mutation.
- Any mid-execution failure preserves verified state for safe recovery or undo;
  it never claims the remaining moves succeeded.
- Knowledge reconciliation failure never rolls back a verified Drive result or
  fabricates updated citations.
- Database failure never falls back to ungrounded classification or generation.

No failure may broaden the workspace, silently omit eligible PDFs, create an
unapproved folder, move a needs-review file, expose a token, enable writes, or
give NVIDIA operational control.

## Non-goals

- More than 99 eligible PDFs in one organization run.
- User-selected folder counts, organization style presets, or user-supplied
  taxonomy.
- More than one generated folder level.
- Renaming, merging, moving, or deleting folders.
- Deleting newly created empty folders during undo.
- Organizing Markdown, text, HTML, Lark Docs, Sheets, Slides, Wiki, images,
  audio, video, or arbitrary binaries.
- Scheduled or automatic background organization.
- Multiple active workspaces or organization-wide crawling.
- An autonomous tool-choosing agent, MCP write tool, generic workflow engine,
  taxonomy registry, graph clustering service, or new vector database.
- Changes to the proven embedding, chunking, retrieval, or grounded-answer
  models unless Phase 15 evaluation demonstrates a concrete regression.

## Complexity budget

Phase 15 may add:

- One replacement workspace-organization policy.
- Small scoped knowledge-repository reads for representative document evidence.
- Two strict NVIDIA response contracts: profiles/taxonomy and classification.
- One narrow create-folder Drive operation.
- Generalized proposal/card/execution logic and bounded proposal pagination.

It should add no new table, deployable, queue, package, registry, framework, or
provider abstraction. If the implementation appears to require one, stop and
document why the existing run/proposal/execution record cannot close the current
loop.

The old four-file coordinator, policy, MCP self-call, and Product/Research-only
branches must be deleted as the replacement becomes authoritative. Net runtime
complexity matters more than the number of new lines in intermediate commits.

## Verification commands

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
git diff --check
```

Doctor must report the configured employee, tenant, root, database schema,
OAuth grant including folder creation, and knowledge providers ready. It must
report `write_enabled: false` before and after controlled live acceptance.

## Exit gate

Phase 15 is complete only when:

- Natural language and `/organize-workspace` start the same authoritative
  workflow.
- A complete bounded run supports all 15 live PDFs and synthetic coverage proves
  the 99-PDF boundary.
- The taxonomy is backend-enforced to a small useful range and no empty,
  duplicate, unsafe, or unapproved folder can be created.
- Existing suitable folders are reused and correctly placed nested PDFs are
  preserved.
- Every eligible PDF is exactly accounted for and every ambiguity stays put.
- One exact employee-approved snapshot controls all created folders and moves.
- Provider state verifies every mutation and a separately selected undo restores
  every original parent.
- RAG knowledge remains queryable and citations follow move/undo paths without
  re-embedding unchanged content.
- Duplicate events, provider failures, and process restarts are safe.
- MCP remains authenticated and read-only.
- The obsolete four-file organizer is removed rather than retained beside the
  new workflow.
- Automated verification, live Lark acceptance, and a final simplification pass
  all succeed. The committed/example write default is false; the ignored local
  switch remains enabled only under Victor's later explicit operator override.
