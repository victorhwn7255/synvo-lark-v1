# Phase 14: Recursive workspace PDF knowledge

Status: planned; implementation has not started.

## Goal

Expand the proven Phase 13 knowledge loop from PDFs stored directly in the configured workspace root to PDFs stored anywhere beneath that same approved workspace.

Phase 14 closes one bounded loop:

1. The employee requests a workspace knowledge refresh.
2. The backend discovers supported PDFs in the root and approved descendant folders.
3. The employee reviews one exact proposal covering additions, content changes, path changes, and removals.
4. After approval, the existing knowledge workflow indexes only new or changed content, updates path-only metadata without re-embedding, and removes sources that no longer exist beneath the workspace.
5. Natural-language questions return grounded answers with relative-path and page citations.

This phase adds recursive PDF discovery, not a general crawler or multi-format ingestion platform.

## Starting baseline

At the start of Phase 14, `My Folders / Test_Synvo_AI_Assistant` is intentionally flat and contains no subfolders. Phase 13 already provides:

- Explicit refresh review and approval.
- PDF extraction, page-aware chunking, and fixed `voyage-4` embeddings.
- Tenant/user/workspace-scoped PostgreSQL/pgvector storage.
- Natural-language grounded Q&A with validated citations.
- New, changed, unchanged, and removed source reconciliation for direct-root PDFs.
- Progress, exact-job stop, and resume of remaining work.
- The authenticated read-only `search_workspace_knowledge` MCP tool.

Phase 14 must preserve the flat-root behavior before nested acceptance fixtures are introduced.

## Employee experience

After nested folders exist, **Refresh workspace knowledge** should present a review similar to:

```text
Review the workspace knowledge update

PDFs to add or refresh
• Product / Local Cocoa Onboarding.pdf
• Research / Agentic AI / Context Engineering.pdf

Paths to update without reprocessing
• Research / ACE.pdf
  Previously: Archive / ACE.pdf

Sources to remove from knowledge
• Old Research / Retired Notes.pdf

[Update knowledge]
```

After approval, the existing progress card remains the single source of progress and offers **Stop update**. A stopped update offers **Resume update**, which creates a fresh review of only the remaining current work.

A grounded citation should display a safe relative path:

```text
Sources
• Research / Agentic AI / Context Engineering.pdf, page 4
```

No folder token, file token, OAuth value, database identifier, or raw link may appear in the card or model input.

## Fixed workspace boundary

- The configured `ORGANIZE_FOLDER_ROOT_TOKEN` remains the only authorized workspace root.
- Discovery may descend only through folder objects returned beneath that exact root.
- A folder name never grants authorization; provider tokens and observed parent relationships establish ancestry.
- Keep the pilot restricted to the configured Lark employee and tenant.
- Continue accepting only ordinary owned PDF files.
- Preserve direct-chat PDF ingestion from Phase 13; chat attachments remain associated with the workspace vault but are not part of Drive traversal.
- Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false`. Recursive discovery, indexing, retrieval, and reconciliation never modify Lark Drive.
- Do not scan `test_directory_2`, `test_directory_3`, Shared Folders, Wiki, or any sibling workspace.
- Do not follow shortcuts, aliases, links, or document references as folders.

## Bounded discovery policy

Implement product-level recursive behavior with a small iterative breadth-first scan. Do not use unbounded language recursion, a graph library, or another service.

Keep the exact limits in the existing knowledge policy module and protect them with focused tests. Initial pilot limits:

- Maximum descendant depth: 4 levels below the configured root.
- Maximum folders visited: 50, including the root.
- Maximum supported PDFs discovered: 200.
- Reuse the existing bounded pagination limit for every listed folder.
- Maximum safe relative display path: 512 Unicode code points.
- Reject repeated folder tokens, repeated file tokens, inconsistent parent tokens, and repeated pagination cursors.
- Fail the complete proposal if any bound or provider invariant is violated; never present a partial scan as complete.

The implementation may lower these limits if Lark card or provider constraints demonstrate a smaller safe bound. Do not make them configurable without a current operational requirement.

## Source identity and path behavior

- The Lark file token remains the stable source identity inside the verified tenant/user/workspace scope.
- The relative path is display metadata, not identity or authorization.
- Store the bounded relative path in the existing `source_name` field for Drive sources; do not add a source table solely for paths.
- A file whose token and content version are unchanged but whose relative path changed must receive a metadata-only `source_name` update.
- A path-only move or rename must not call Voyage, replace chunks, or change embeddings.
- A content-version change must atomically replace that source's chunks through the existing repository transaction.
- A file missing from the complete verified tree is proposed for removal and deleted from knowledge only after explicit approval.
- A file moved outside the approved root is treated as removed; do not follow it into the new location.

## Architecture

```text
Refresh workspace knowledge
  -> verify configured employee, tenant, OAuth grant, and root token
  -> breadth-first list root and bounded descendant folders
  -> produce verified PDFs with stable token, version, and relative path
  -> compare against existing scoped knowledge sources
  -> show one exact encrypted review snapshot
  -> employee approves
  -> revalidate the current tree
  -> new/content-changed PDFs: existing extract -> chunk -> Voyage -> atomic replace
  -> path-only changes: metadata update only
  -> verified missing PDFs: scoped knowledge deletion
  -> update the existing progress card
```

Reuse the existing Node.js process, OAuth grant, Drive reader, knowledge workflow, delivery queue, PostgreSQL table, Voyage client, NVIDIA grounded-answer path, cards, and MCP tool.

Do not add another process, queue, table, vector database, crawler, scheduler, polling daemon, workflow framework, or agent framework.

## Work items

### 0. Preflight and flat-root regression

- [ ] Record the current flat-root inventory and scoped knowledge-source count before implementation.
- [ ] Confirm an unchanged Phase 13 refresh proposes no work and performs no embeddings.
- [ ] Keep all acceptance documents disposable and non-sensitive.
- [ ] Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false` throughout implementation and acceptance.

### 1. Bounded recursive Drive inventory

- [ ] Add one iterative workspace-tree inventory function using the existing fully paginated folder-list operation.
- [ ] Start only from the exact configured root token.
- [ ] For every response, require each item's `parent_token` to equal the folder that was listed.
- [ ] Queue only ordinary child folders that remain within the depth and folder budgets.
- [ ] Collect only owned ordinary PDFs with a provider modification version.
- [ ] Build a bounded relative display path locally from verified folder segments.
- [ ] Sort folders and files deterministically for stable proposals and tests.
- [ ] Reject repeated folder/file tokens, cycles, excessive depth, excessive counts, malformed pages, and partial scans.
- [ ] Keep sibling roots, Shared Folders, and shortcuts outside the traversal.

### 2. Knowledge reconciliation

- [ ] Extend the trusted knowledge-file result with a bounded relative display path.
- [ ] Compare current files with stored sources by stable token and content version.
- [ ] Classify each source as new, content-changed, unchanged, path-only changed, or removed.
- [ ] Add a small repository operation that updates `source_name` for one scoped Drive source without replacing chunks.
- [ ] Keep the existing atomic replacement and deletion operations authoritative for content changes and removals.
- [ ] Include the exact recursive file set and path metadata in the encrypted, expiring approval snapshot.
- [ ] Revalidate current ancestry and version before each download and before final removal reconciliation.

### 3. Lark review, progress, and citations

- [ ] Update the refresh review card to group additions/content refreshes, path-only updates, and removals.
- [ ] Display only safe relative paths; hide empty sections.
- [ ] Reuse the existing **Update knowledge**, **Stop update**, and **Resume update** interactions.
- [ ] Keep file/chunk/batch progress monotonic on one updateable card.
- [ ] Render Drive citations with relative path plus page number.
- [ ] Keep chat-attachment citations filename-only because they have no Drive path.
- [ ] Ensure long paths and large proposals remain within existing Lark card budgets.

### 4. MCP and existing workflow compatibility

- [ ] Keep `search_workspace_knowledge({ question })` arguments and authorization unchanged.
- [ ] Return relative-path citations through the existing MCP result; expose no native tokens or links.
- [ ] Keep `organize_folder_inventory` and `analyze_drive_file` behavior unchanged in Phase 14.
- [ ] Keep direct-chat **Add to knowledge**, **Analyze once**, **Not now**, and **Remove from knowledge** behavior unchanged.
- [ ] Do not give NVIDIA or Voyage a folder tree, path tokens, or traversal control.

### 5. Documentation and simplification

- [ ] Update `README.md` and `AGENTS.md` only after the recursive loop is implemented.
- [ ] Replace flat-root claims with the exact bounded recursive policy in one authoritative location.
- [ ] Run a deletion pass for duplicate traversal, validation, path, and reconciliation logic.
- [ ] Confirm source ownership matches the actual tree.
- [ ] Archive this plan only after automated and live exit gates pass.

## Required automated tests

### Traversal boundary

- [ ] A flat root still returns the same supported PDFs as Phase 13.
- [ ] PDFs at root, depth 1, and maximum allowed depth are discovered with correct relative paths.
- [ ] A folder deeper than the maximum fails the complete scan safely.
- [ ] Excessive folder count, file count, pages, or path length fails safely.
- [ ] Repeated folder tokens, repeated file tokens, repeated cursors, cycles, and inconsistent `parent_token` values fail safely.
- [ ] Shortcuts and unsupported objects are not traversed or indexed.
- [ ] Sibling My Folders entries and Shared Folders are never requested.
- [ ] Expired access refreshes once; revoked, wrong-scope, 401, 403, 404, 429, timeout, 5xx, and malformed responses remain normalized.

### Reconciliation and idempotency

- [ ] New nested PDF produces one approved source replacement.
- [ ] Content-changed nested PDF replaces only that source atomically.
- [ ] Unchanged nested PDF performs no download, Voyage request, or database write.
- [ ] Path-only move or rename updates display metadata without extraction, chunking, or embedding.
- [ ] Deleted or outside-root source is removed only after a complete verified scan and explicit approval.
- [ ] Failed replacement leaves the previous source version queryable.
- [ ] Duplicate callbacks and worker retries do not duplicate chunks.
- [ ] Stop preserves completed sources; resume proposes and processes only remaining current work.

### Authorization and privacy

- [ ] Every query and mutation filters exact tenant, employee, and workspace before source identity.
- [ ] Another workspace with the same folder or filename cannot enter the vault.
- [ ] Cards, logs, NVIDIA, Voyage, and MCP results expose no folder tokens, file tokens, OAuth values, database IDs, or raw links.
- [ ] Document text remains untrusted and neither model receives tools.
- [ ] Drive remains read-only throughout the suite.

### Retrieval and citations

- [ ] Questions retrieve evidence from root and nested PDFs in the same scoped vault.
- [ ] Cross-folder questions can cite multiple relative paths.
- [ ] Same-name PDFs in different subfolders remain distinguishable by relative path.
- [ ] A moved source cites its new path without re-embedding.
- [ ] A removed source cannot be retrieved or cited.
- [ ] Insufficient evidence remains honest and grounded-answer citations remain validated.

### Regression

- [ ] Direct attachment consent and one-time analysis remain green.
- [ ] Flat-root refresh, Q&A, removal, progress, stop, and resume remain green.
- [ ] Natural-language routing, workspace context, folder organization, Drive-file analysis, OAuth, delivery recovery, and `/ping` remain green.
- [ ] All three read-only MCP tools remain green.

## Live Lark acceptance

The workspace is flat before this acceptance. The employee manually creates the following disposable fixture after implementation; the assistant must not create or move folders for this test:

```text
Test_Synvo_AI_Assistant/
├── <one existing root PDF>
├── Product/
│   └── <one disposable PDF>
└── Research/
    ├── <one disposable PDF>
    └── Agentic AI/
        └── <one disposable PDF>
```

### A. Flat baseline

1. [ ] Before creating subfolders, refresh the current flat workspace.
2. [ ] Verify no unchanged PDF is proposed or re-embedded.
3. [ ] Ask one existing question and verify the answer and citation remain correct.

### B. Recursive discovery and ingestion

1. [ ] Manually create `Product`, `Research`, and `Research / Agentic AI` beneath the approved workspace.
2. [ ] Place one disposable PDF in each acceptance location while keeping at least one PDF in the root.
3. [ ] Refresh and verify the review card lists the correct relative paths.
4. [ ] Approve once and verify one progress card completes all new nested PDFs.
5. [ ] Refresh again and verify no unchanged PDF is proposed or re-embedded.

### C. Retrieval across folders

1. [ ] Ask a question answerable from the root PDF.
2. [ ] Ask a question answerable from a depth-1 PDF.
3. [ ] Ask a question answerable from the depth-2 PDF.
4. [ ] Ask one cross-folder comparison question.
5. [ ] Verify every citation displays the correct relative path and page.

### D. Move without re-embedding

1. [ ] Record the indexed chunk count and answer for one nested PDF.
2. [ ] Manually move that unchanged PDF to another folder beneath the workspace.
3. [ ] Refresh and verify the proposal identifies only a path update.
4. [ ] Approve and verify no Voyage document-embedding request occurs for that file.
5. [ ] Ask the recorded question and verify the answer cites the new path.

### E. Removal and restoration

1. [ ] Move one disposable PDF outside the approved workspace or delete it.
2. [ ] Refresh and verify the proposal lists the exact relative path under sources to remove.
3. [ ] Approve and verify its chunks disappear from PostgreSQL and retrieval.
4. [ ] Restore the PDF beneath the workspace, approve a new refresh, and verify it is indexed once.

### F. Stop and resume

1. [ ] Add at least two new disposable nested PDFs and approve one refresh.
2. [ ] Stop while work remains.
3. [ ] Verify the card reaches a terminal stopped state with accurate counts.
4. [ ] Select **Resume update**, review the fresh remaining-work proposal, and finish.
5. [ ] Verify completed files were not duplicated or re-embedded.

### G. Final safety gate

1. [ ] Verify no Lark Drive file or folder was created, moved, renamed, edited, or deleted by the assistant.
2. [ ] Verify sibling My Folders entries and Shared Folders never entered any proposal, log, stored source, or citation.
3. [ ] Verify authenticated MCP knowledge search returns the same scoped relative-path citations as Lark.
4. [ ] Run the complete verification commands and confirm the write switch remains false.

## Failure behavior

- Any incomplete or over-budget tree scan fails closed and produces no removal proposal.
- A folder or file that changes during approval or processing invalidates the affected snapshot and requires a fresh review.
- A temporary Lark or Voyage failure uses the existing bounded retry path and never publishes a partial source version.
- A stopped update preserves atomically completed sources and starts no additional file or embedding batch.
- Missing OAuth or workspace verification exposes no indexed knowledge and starts no traversal.
- Database failure never falls back to ungrounded generation.

No failure may broaden the root, follow a shortcut, traverse a sibling, remove knowledge from a partial scan, modify Drive, or let a model choose what to access.

## Non-goals

- Markdown, plain text, HTML, Lark Docs, Sheets, Slides, Wiki, images, audio, video, or arbitrary binary ingestion.
- Automatic background crawling, scheduled refresh, webhook-driven indexing, or polling.
- Multiple active workspaces or user-controlled workspace switching.
- Organization-wide or Shared Folder crawling.
- Folder creation, organization, or any other Drive mutation.
- A new vector database, source table, job table, queue, service, crawler process, graph library, RAG framework, or agent framework.
- Hybrid search, reranking, HNSW, knowledge graphs, or conversation memory.
- Changes to the existing embedding model, chunking policy, retrieval threshold, or answer model unless Phase 14 evaluation demonstrates a concrete regression.

Multi-format ingestion should be considered only after this recursive PDF loop is closed and evaluated, ideally one format family at a time.

## Complexity budget

Phase 14 should require only:

- One small bounded workspace-tree inventory function.
- Small extensions to the existing trusted Drive knowledge-file type.
- One metadata-only scoped source-name update in the existing repository.
- Small proposal/card/path formatting changes.
- Focused unit and PostgreSQL integration tests.

If implementation appears to require a new service, table, state machine, registry, framework, or more than one new runtime module, stop and document the demonstrated requirement before proceeding.

## Verification commands

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
git diff --check
```

Keep the Phase 13 retrieval fixture as the regression baseline. Add only the minimum path-aware cases needed to prove recursive discovery and citation behavior.

## Exit gate

Phase 14 is complete only when:

- Flat-root Phase 13 behavior remains unchanged.
- A complete bounded scan discovers supported PDFs at root and approved descendant depths without leaving the configured workspace.
- One exact reviewed refresh indexes only new or content-changed PDFs.
- Path-only moves update citations without re-embedding.
- Verified removed or outside-root sources disappear only after approval.
- Grounded Lark and MCP answers cite correct safe relative paths and pages.
- Stop and resume preserve completed work across nested files.
- No model receives workspace structure, native identifiers, credentials, links, or tools.
- No Drive object is modified.
- Automated checks, live acceptance, and the final simplification review pass.
