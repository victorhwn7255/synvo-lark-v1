# Phase 13: Flat workspace knowledge vault and grounded Q&A — complete

Status: locally implemented; automated gates and the scoped live provider/MCP acceptance passed on 2026-08-11. Live Lark UI acceptance now targets one flat, PDF-only workspace root. External production gates remain.

## Goal

Turn the configured active Lark workspace into a persistent, reusable knowledge vault that Synvo employees can update deliberately and question naturally from Lark.

Phase 13 closes two connected loops:

1. **Knowledge ingestion:** a user explicitly approves a supported file, the assistant extracts and chunks it, creates embeddings, and updates the active workspace's knowledge vault.
2. **Grounded question answering:** a user asks a natural-language question, the assistant retrieves relevant authorized chunks and returns an answer with file and page citations.

This phase creates one bounded folder-knowledge workflow, not a general RAG platform.

**Status:** Completed for the Victor-only Lark pilot on 2026-08-11. Hosted production deployment remains separately gated by managed secrets, production pgvector support, and verified Voyage zero-day retention.

## Phase 13 workspace boundary

Phase 13 deliberately uses one flat Lark Drive directory:

```text
My Folders / Test_Synvo_AI_Assistant
├── AGENTIC CONTEXT ENGINEERING.pdf
├── Anthropic Agentic Engineering.pdf
├── Local_Cocoa_PDF_Chunking_Technical_Guide.pdf
├── Local_Cocoa_Technical_Onboarding_Guide.pdf
├── marketing-launch-brief-cocoa-2.pdf
└── Synvo-AI-company-overview.pdf
```

- These six ordinary PDFs are the Drive acceptance corpus.
- Only PDF files that are direct children of this exact configured root are eligible for Drive refresh.
- `test_directory_2`, `test_directory_3`, Shared Folders, and every other My Folders entry remain outside the knowledge boundary.
- Phase 13 does not recursively scan subfolders and does not ingest Markdown, text, HTML, Lark Docs, Sheets, Slides, Wiki nodes, or other formats.
- Recursive and multi-format workspace knowledge is deferred until the flat PDF RAG loop is closed and evaluated.

## Employee experience

### A direct PDF uploaded in chat

When Victor sends a PDF to the assistant, the bot responds with:

```text
Add this file to your workspace knowledge?

I can make Quarterly Product Strategy.pdf searchable in:
My Folders / Test_Synvo_AI_Assistant

The original file will not be changed or copied into Drive.

[Add to knowledge]  [Analyze once]  [Not now]
```

- **Add to knowledge** starts bounded persistent ingestion for the verified active workspace.
- **Analyze once** preserves the existing one-time attachment-analysis workflow and stores no chunks.
- **Not now** stores no content and starts no model call.

The ingestion card updates in place:

```text
Adding this file to workspace knowledge...

Reading the document -> Organizing its content -> Updating the knowledge vault
```

On success:

```text
Added to workspace knowledge

Quarterly Product Strategy.pdf is now searchable in
My Folders / Test_Synvo_AI_Assistant.

[Ask about this file]  [Remove from knowledge]
```

### Workspace knowledge question

Victor can ask:

```text
What do the files in our workspace say about PDF chunking?
```

The assistant responds with a progress card and then a grounded answer:

```text
Local Cocoa separates PDF ingestion, page-aware extraction, chunk creation,
embedding, and retrieval...

Sources
- Local_Cocoa_PDF_Chunking_Technical_Guide.pdf, page 4
- Local_Cocoa_Technical_Onboarding_Guide.pdf, page 7
```

If the vault contains no relevant evidence, the assistant says so instead of inventing an answer.

## Product decisions

### Vault identity

- A knowledge vault is identified by the verified Lark tenant, user, and configured active workspace folder token.
- Display names are presentation metadata only; tokens remain the identity and authorization boundary.
- Phase 13 remains restricted to Victor and `Test_Synvo_AI_Assistant`.
- Other top-level My Folders entries remain informational and cannot be indexed by name.

### Source types

Phase 13 accepts two PDF source types:

1. An owned ordinary PDF directly inside the configured active Drive folder.
2. A PDF uploaded directly by the configured user in the bot's direct chat and explicitly approved for the active vault.

A chat attachment is associated with the folder-scoped knowledge vault but is not silently copied into Lark Drive. A later workflow may add a separately disclosed **Save to Drive and add to knowledge** action if employees demonstrate that need.

### Consent

- Never persist extracted text or embeddings merely because a file event was received.
- Require the explicit **Add to knowledge** card action before ingestion.
- Re-fetch and bind the exact triggering Lark message and resource after the click; never trust a file key or URL supplied in a card value.
- The card states the verified destination vault and whether the source will be copied or changed.
- Duplicate clicks are idempotent.

### Drive synchronization

- Do not add a polling service or assume a real-time Drive-folder change event.
- Reconcile the active folder only when the user explicitly opens or refreshes knowledge, or before a workspace question when the local index is absent or known stale.
- A reconciliation lists only direct children of the allowlisted root. The Phase 13 acceptance workspace is intentionally flat.
- Newly discovered or changed PDFs are proposed for ingestion; they are not automatically indexed.
- A direct-root PDF that is deleted or moved outside the configured root is proposed for removal; its chunks and embeddings are deleted only after the bounded reconciliation is explicitly approved.
- Moving or placing a file in a subfolder is outside Phase 13 rather than an instruction to recurse into that folder.

### Data processing

- Hosted NVIDIA trial endpoints may receive only disposable, non-sensitive pilot documents until Synvo approves real internal data processing.
- Use Voyage AI `voyage-4` for document and query embeddings with 1,024-dimensional float output.
- `voyage-4` supports a 32,000-token input context and a 320,000-token aggregate request limit, but Phase 13 keeps the much smaller application chunk and batch budgets defined below.
- Record the current Voyage usage terms before production deployment. Voyage's official [pricing documentation](https://docs.voyageai.com/docs/pricing), verified on 2026-08-11, states that the first 200 million `voyage-4` tokens are included and subsequent usage is $0.06 per million tokens; pricing is not a runtime assumption and may change.
- Before processing Synvo internal documents, an organization admin must opt out of Voyage data storage/model-training use and verify zero-day retention, or approve an equivalent private deployment. Voyage's official [FAQ](https://docs.voyageai.com/docs/faq) confirms that hosted-endpoint customers can request this zero-day-retention setting; the Synvo organization setting is still pending.
- `voyage-4` and its 1,024-dimensional output define one embedding space. An incompatible model or dimension change requires re-embedding every stored chunk before querying it; never mix embedding spaces in one vault.
- Send only approved chunk text or the bounded employee question to the Voyage embedding endpoint.
- Send only the employee question and retrieved evidence labels/text to the answer model.
- Never send Lark tokens, links, user identifiers, folder/file tokens, chat identifiers, or database identifiers to Voyage or NVIDIA.

## Architecture

Keep the existing Node.js application and PostgreSQL deployment. Add pgvector to the existing database rather than deploying a separate vector service.

```text
Direct PDF event
  -> deterministic consent card
  -> exact card action and message-resource revalidation
  -> existing bounded PDF download and extraction
  -> page-aware chunks
  -> Voyage voyage-4 document embeddings
  -> one atomic PostgreSQL/pgvector replacement
  -> success card

Natural-language workspace question
  -> existing bounded semantic intent classifier
  -> verified active workspace context
  -> Voyage voyage-4 query embedding
  -> tenant/user/workspace-scoped vector search
  -> top bounded evidence chunks
  -> no-tools NVIDIA grounded answer
  -> backend validates citations and renders Lark card
```

The model never chooses a tenant, user, vault, source, SQL filter, provider token, tool name, or write action. The backend resolves and enforces all operational arguments.

## Minimal data model

Add the pgvector extension and one forward-only migration for one table:

```text
workspace_chunks
├── tenant_key
├── user_open_id
├── workspace_folder_token
├── source_kind                 # drive_file | chat_attachment
├── source_key                  # provider identity, never model-visible
├── source_name
├── source_version_or_hash
├── page_number
├── heading
├── chunk_index
├── chunk_text
├── embedding                     # vector(1024), voyage-4
└── indexed_at
```

Required behavior:

- Unique source-version/chunk identity prevents duplicate ingestion.
- Replace all chunks for one source in a single transaction; a failed update leaves the last complete version intact.
- Scope every read and delete by tenant, user, and workspace before source identity.
- Store no raw PDF bytes, OAuth tokens, Lark URLs, model prompts, or model responses in this table.
- Do not add an approximate vector index for the small pilot. Use exact cosine search after authorization filters. Add HNSW only when measured corpus size or latency requires it.
- Do not add a second source table unless implementation proves that the closed loop cannot safely represent source lifecycle with this table and existing job/delivery records.

Threat statement: the tenant/user/workspace filters prevent one authenticated employee or service mapping from retrieving another vault's stored chunks. Production storage encryption and database access controls protect persistent document text from infrastructure-level unauthorized access; do not add application-layer encryption without a separately documented DB-only compromise threat and key-management design.

## Chunking contract

Implement one plain page-aware chunking function:

- Reuse the existing bounded PDF extraction path.
- Preserve source file, page number, and nearby heading metadata.
- Prefer paragraph and heading boundaries over arbitrary character cuts.
- Target approximately 600-1,000 model tokens per chunk.
- Use at most 10-15% overlap between adjacent chunks.
- Do not merge text across source files.
- Do not split or duplicate empty pages.
- Bound chunks per file, text per chunk, total indexed text, embedding batches, and elapsed time.
- Produce deterministic chunks for the same normalized extracted text and policy version.

The exact limits belong in one knowledge policy module and must be protected by focused tests.

## Retrieval and answer contract

### Retrieval

- Add one natural-language intent: `ask_workspace`.
- Keep employee phrasing semantic; do not add exact question-pattern matching.
- Create the query embedding with the same embedding model/version used for stored chunks.
- Filter by the verified tenant, user, and active workspace before ordering by vector similarity.
- Retrieve a small fixed top K, initially 8-12 chunks.
- Apply a fixed maximum evidence-text budget before the answer call.
- Do not add a dedicated reranker in Phase 13.

### Grounded answer

- Give the answer model no tools.
- Treat the question and chunks as untrusted text.
- Require one strict structured result containing the answer and citations to opaque evidence labels such as `S1`, never provider identifiers.
- Validate the model result once at the NVIDIA boundary.
- Reject citations to labels that were not supplied.
- Map valid labels back to source name, page, and locally generated open link only after validation.
- If evidence is absent or insufficient, say that the current workspace knowledge does not contain a supported answer.
- Do not use general model knowledge to fill evidence gaps.

## Work items

### 0. Preflight and provider decision

- [x] Confirm Phase 13 live acceptance uses only disposable, non-sensitive PDFs.
- [x] Create a 24-case human-labeled retrieval fixture covering direct, paraphrased, cross-document, and insufficient-evidence questions in `tests/fixtures/phase13-retrieval-evaluation.json`.
- [x] Select Voyage AI `voyage-4` as the single Phase 13 embedding model.
- [x] Fix float output at 1,024 dimensions, a 32,000-token provider input maximum, and a 320,000-token provider aggregate-request maximum; application limits remain smaller.
- [ ] Current official Voyage pricing, dimensions, and zero-day-retention option were verified on 2026-08-11; complete and verify the organization-level opt-out before processing real Synvo internal documents.
- [x] Add required bounded `VOYAGE_API_KEY` parsing, an ignored local value, and an environment example. Keep the model ID and dimension as authoritative knowledge-policy constants rather than adding runtime model routing.
- [ ] Store `VOYAGE_API_KEY` in hosted secret management before deployment.
- [ ] Confirm the production Postgres provider supports pgvector.
- [x] Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false`; knowledge ingestion writes only to the Synvo database, never to Drive.

### 1. PostgreSQL vector foundation

- [x] Change the local Postgres image to a pinned PostgreSQL 16 + pgvector image while preserving the existing named volume and verifying the existing schema and row counts after recreation.
- [x] Add a forward-only migration that enables `vector` and creates `workspace_chunks` with the fixed embedding dimension.
- [x] Add authorization-first indexes and source uniqueness constraints.
- [x] Implement the smallest repository methods needed to replace, search, list, and delete one scoped source.
- [x] Keep exact vector search for the pilot; do not add HNSW or a second database.

### 2. Embedding and chunking boundary

- [x] Add one small Voyage embedding client owned by the knowledge workflow; do not modify the NVIDIA chat-completions client or create a provider framework.
- [x] Embed indexed chunks with `input_type=document` and employee questions with `input_type=query`.
- [x] Validate the embedding response dimension and finite numeric values once at the provider boundary.
- [x] Implement deterministic page-aware PDF chunking in a small knowledge module.
- [x] Reuse existing PDF size, download, page, timeout, and extraction enforcement where applicable.
- [x] Batch embeddings within the smaller application bounds while remaining below Voyage's request limits.
- [x] Ensure extracted text, chunks, and vectors are absent from logs and outbound Lark payloads.

### 3. Explicit ingestion consent

- [x] Replace automatic direct-PDF analysis with a friendly consent card containing **Add to knowledge**, **Analyze once**, and **Not now**.
- [x] Keep **Analyze once** routed to the existing workflow unchanged.
- [x] Parse exact card action values locally and bind the action to the configured user, tenant, chat, message, and resource.
- [x] Re-fetch and revalidate the exact attachment after **Add to knowledge**.
- [x] Render one updateable ingestion progress card.
- [x] Extract, chunk, embed, and atomically replace one source's chunks.
- [x] Update the card to success, already-current, unsupported, or safe failure.
- [x] Add **Remove from knowledge** with explicit confirmation and scoped deletion.
- [x] Make repeated callbacks and process interruption safe to retry without duplicate chunks.

### 4. Active-folder ingestion and reconciliation

- [x] Add one **Refresh workspace knowledge** action to an appropriate workspace card.
- [x] Reuse the existing exact active-root match and direct-child Drive inventory.
- [x] Identify supported new, changed, unchanged, and removed PDF sources without recursively scanning.
- [x] Present new or changed sources for explicit approval before extracting or embedding them.
- [x] Reuse the existing allowlisted Drive-file validation and download path.
- [x] Remove stale chunks only when the provider state is verified and the bounded reconciliation policy authorizes removal.
- [x] Never index another top-level folder merely because its name is mentioned.

### 5. Natural-language workspace Q&A

- [x] Add `ask_workspace` to the strict semantic intent contract and varied paraphrase tests.
- [x] Route it through one explicit backend branch to a small knowledge-question workflow.
- [x] Verify the current user, tenant, OAuth grant, and active workspace before retrieval.
- [x] If the vault is empty, offer **Prepare workspace knowledge** rather than answering from general model knowledge.
- [x] Create a query embedding and perform authorization-scoped top-K vector search.
- [x] Call NVIDIA once with the bounded question and evidence.
- [x] Validate grounded citations and render a friendly Lark answer card with source names and pages. No safe provider open-link field is available in the current bounded read contract.
- [x] Add safe insufficient-evidence, provider-unavailable, authorization, and stale-vault responses.

### 6. Reusable read-only MCP capability

- [x] Expose one `search_workspace_knowledge({ question })` MCP tool through the existing authenticated endpoint, reusing the locally verified retrieval owner. Authenticated live MCP acceptance passed on 2026-08-11.
- [x] Map the MCP credential to the configured pilot identity; accept no actor, tenant, folder token, URL, or authorization override from tool arguments.
- [x] Reuse the same retrieval owner as the Lark workflow.
- [x] Return a bounded answer with source display names and pages; never return native identifiers, stored vectors, or unrestricted chunk dumps.
- [x] Keep MCP read-only and give it no ingestion, deletion, approval, or Drive-write action.

### 7. Documentation and simplification

- [x] Update `README.md`, `AGENTS.md`, environment examples, Docker instructions, and source ownership to current implemented behavior.
- [x] Document the Voyage credential, fixed model/dimension, current pricing, zero-day-retention requirement, and re-index requirement if the embedding space ever changes.
- [x] End with a deletion pass for wrappers, duplicate validators, repeated provider logic, unused result fields, and speculative configuration.
- [x] Archive this plan after automated and live exit gates pass.

### 8. Refresh progress and bounded cancellation

- [x] Update the existing refresh card in place with completed/total files, the current filename, created chunks, and completed/total Voyage batches.
- [x] Add one **Stop update** action bound to the exact knowledge-refresh job, configured employee, tenant, and chat.
- [x] Stop before starting another file, embedding batch, or stale-source deletion; never cancel or clear another employee's job or the shared delivery queue.
- [x] Let an already-running provider request finish or time out, disable further work for that job, and replace the progress card with a terminal stopped result.
- [x] Keep every atomically completed source indexed so the next approved refresh can resume without duplicate chunks.
- [x] Persist the cancellation request on the existing delivery job through one forward-only migration; add no cancellation service, new job table, or workflow framework.

## Required tests

### Consent and identity

- [x] Direct PDF from the configured user receives the consent card.
- [x] Group messages, other users, non-PDF files, pasted resource keys, arbitrary URLs, and callbacks from another actor are rejected.
- [x] **Not now** performs no download, model call, or persistence.
- [x] **Analyze once** preserves existing behavior and stores no chunks.
- [x] **Add to knowledge** binds and re-fetches the exact originating resource.
- [x] Duplicate card callbacks produce one indexed source version.

### Chunking and embeddings

- [x] Empty, malformed, encrypted, oversized, excessive-page, and extraction-timeout PDFs fail safely.
- [x] Chunk boundaries, overlap, page metadata, determinism, and total budgets are tested.
- [x] Voyage timeout, 401, 403, 429, 5xx, malformed JSON, wrong dimension, non-finite values, and excessive response fail safely.
- [x] A failed replacement leaves the previous complete source version queryable.
- [x] No document text, embeddings, provider bodies, or credentials appear in logs.

### Retrieval isolation

- [x] Every query filters tenant, user, and workspace before similarity ordering.
- [x] Same-name sources in another vault cannot appear.
- [x] MCP callers cannot provide or override identity or workspace.
- [x] Empty and irrelevant vaults return insufficient evidence.
- [x] Retrieval respects top-K and evidence-text budgets.
- [x] Removed sources no longer appear.

### Grounding and citations

- [x] Valid citations resolve only to supplied evidence labels.
- [x] Unknown, duplicate, malformed, excessive, and out-of-range citations are rejected safely.
- [x] Answers do not expose opaque labels, tokens, identifiers, raw links, or unrestricted chunks.
- [x] The model receives no tools and document instructions cannot trigger another workflow.
- [x] A question unsupported by the evidence produces a clear limitation rather than a fabricated answer.

### Regression

- [x] Greetings, acknowledgements, help, current workspace, folder organization, Drive-file analysis, approvals, rejection, execution, undo, attachment analysis, `/ping`, OAuth, delivery recovery, and all three read-only MCP tools remain green.
- [x] `ORGANIZE_FOLDER_WRITE_ENABLED=false` throughout automated and live Phase 13 acceptance.
- [x] Refresh progress reports monotonic file/chunk/batch counts on one updateable card.
- [x] Stopping a pending or in-progress refresh affects only the exact refresh job; completed sources remain searchable and the next refresh resumes the remainder.
- [x] Repeated, unauthorized, wrong-chat, and already-terminal stop actions are bounded and cannot cancel another delivery job.

## Failure behavior

- Embedding or answer provider unavailable: update the card with a retryable safe message; do not replace a valid prior index.
- Database unavailable: report that workspace knowledge is temporarily unavailable; do not fall back to ungrounded generation.
- Authorization unavailable: request the existing Lark authorization path; do not expose stored knowledge before identity and workspace verification.
- File changed during ingestion: stop and ask the user to retry; never publish mixed-version chunks.
- Unsupported or textless file: explain that it could not be added and persist no partial chunks.
- Stale or removed source: exclude it after verified reconciliation.
- Process interruption: a repeated explicit action may safely restart ingestion without duplicate or partial visible state.

No failure may broaden the active workspace, query another user's chunks, call an operational MCP tool, modify Drive, or generate an answer without retrieved evidence.

## Non-goals

- Automatic ingestion without explicit employee consent.
- Copying chat attachments into Drive.
- Recursive subfolder indexing.
- Wiki, Sheets, Slides, images, audio, video, or arbitrary binary ingestion.
- Multiple active workspaces or workspace switching.
- Organization-wide crawling or company-wide memory.
- A standalone vector database, ingestion service, queue service, scheduler, polling daemon, or distributed worker.
- LangChain, LangGraph, a generic RAG framework, autonomous tool selection, or a provider registry.
- A dedicated reranking model, hybrid search, HNSW index, knowledge graph, or conversation-memory system.
- Model-generated SQL, tool names, URLs, native identifiers, or authorization decisions.
- Multiple embedding providers, runtime embedding-model switching, or an embedding-provider registry.

## Complexity budget

The phase may add only the infrastructure inherently required by persistent vector retrieval:

- One pgvector extension in the existing Postgres deployment.
- One `workspace_chunks` table and forward-only migration.
- One small knowledge workflow module containing chunking, ingestion, retrieval, and grounded-answer ownership.
- One small Voyage client with document-embedding and query-embedding calls to the same fixed model.
- Small card and dispatcher additions.
- At most one new read-only MCP tool after the Lark loop is proven.

Do not add another service, npm package boundary, generic provider abstraction, workflow registry, source table, job table, or state machine without stopping and documenting why the current exit gate cannot be met through existing components and idempotent transactions.

## Verification commands

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
git diff --check
npm run evaluate:phase13
```

The Postgres integration suite must exercise the real pgvector migration, scoped vector search, atomic source replacement, deletion, and duplicate ingestion behavior.

### Local verification record — 2026-08-11

- `npm run typecheck`: passed.
- `npm test`: passed the current full suite after the refresh progress/cancellation addition.
- `npm run test:integration`: passed 7 real PostgreSQL/pgvector and delivery-state tests, including exact-job pending and in-progress cancellation.
- `npm run doctor`: passed with `schema_ready: true`, `voyage_embedding_configured: true`, and `write_enabled: false`.
- `npm run evaluate:phase13`: fixture contract usable; 24 cases, 22 answerable, 2 insufficient-evidence, 10 referenced PDFs.

### Scoped live provider and MCP acceptance — 2026-08-11

- User authorization covered four disposable, non-sensitive synthetic PDFs in `docs/pdf/`, their bounded extracted text for Voyage embeddings, and bounded questions/retrieved evidence for NVIDIA NIM.
- Four PDFs were indexed into an isolated temporary tenant/user/workspace scope in real PostgreSQL/pgvector; each produced two chunks.
- Re-ingesting the same source was idempotent and did not duplicate chunks.
- Five grounded questions passed, including one cross-document question; every answer cited the expected source and page.
- One unrelated question returned insufficient evidence with no citation.
- `search_workspace_knowledge` passed through the real authenticated MCP endpoint and cited the expected expense-policy page.
- Scoped source removal passed and the removed source disappeared from the vault.
- Acceptance rows were deleted afterward; no Lark Drive read or mutation path was used.
- `ORGANIZE_FOLDER_WRITE_ENABLED` remained `false` throughout.
- Voyage returned HTTP 429 during initial rapid batch attempts. The production delivery worker already provides bounded exponential retry; the acceptance harness was paced below the observed trial-endpoint request limit. Provider capacity must be confirmed before multi-employee production rollout.

## Live Lark acceptance

Use only approved disposable, non-sensitive PDFs. Keep the Drive workspace flat throughout Phase 13.

### A. Direct-chat consent loop — passed

1. [x] Upload a PDF directly to the Synvo Assistant chat.
2. [x] Verify the consent card names the file and active workspace and states that Drive will not change.
3. [x] Click **Not now** and verify no extraction, model call, or ingestion occurs.
4. [x] Upload it again and click **Analyze once**; verify analysis succeeds and no chunks are stored.
5. [x] Upload it again and click **Add to knowledge**.
6. [x] Verify one progress card updates to success and duplicate clicks do not duplicate chunks.

### B. Flat-root Drive refresh

1. [x] Verify the root contains exactly the six acceptance PDFs listed in **Phase 13 workspace boundary**, with no Phase 13 subfolder dependency. Confirmed from the flat Lark Drive workspace on 2026-08-11.
2. [x] Click **Refresh workspace knowledge** and verify the review card proposes only new or changed direct-root PDFs. Passed when only `marketing-launch-brief-cocoa-2.pdf` was proposed.
3. [x] Approve the refresh and verify all six PDFs become indexed with stored chunks and 1,024-dimensional embeddings. Five existing PDFs were database-verified and the sixth completed an approved refresh and cited retrieval on 2026-08-11.
4. [x] Refresh again without changing the files and verify no PDF is re-embedded and no duplicate chunk is created. The unchanged refresh reported no new or changed PDFs.
5. [x] Add one disposable PDF directly to the root, refresh, explicitly approve it, and retrieve a cited answer from it. Passed with `marketing-launch-brief-cocoa-2.pdf` on 2026-08-11.

### C. Retrieval quality and grounding

1. [x] Ask at least five differently worded questions across at least three of the six Drive PDFs. Questions covered expense policy, Local Cocoa retrieval, ACE, Anthropic context engineering, company positioning, and the launch brief.
2. [x] Include at least one cross-document question that requires evidence from two PDFs. The launch-positioning comparison cited both the launch brief and Synvo company overview.
3. [x] Verify grounded answers cite only the correct display filename and page. Live Lark tests passed with `expense-reimbursement-policy.pdf` and `marketing-launch-brief-cocoa-2.pdf` on 2026-08-11.
4. [x] Ask one question not answered by the vault and verify the assistant reports insufficient evidence. Passed with the fictional Mars-colony share-price question on 2026-08-11.
5. [x] Confirm the answer card never exposes Lark tokens, resource identifiers, raw links, chunk identifiers, or unrestricted source text. Internal evidence-label leakage was fixed and the corrected answer was verified live.

### D. Flat-root source removal

1. [x] Choose one disposable indexed PDF and record one question answerable only by that file.
2. [x] Delete it or move it outside `Test_Synvo_AI_Assistant`, then click **Refresh workspace knowledge**.
3. [x] Verify the review card shows **Sources to remove from knowledge: 1** and lists the correct filename. Passed with `marketing-launch-brief-cocoa-2.pdf`.
4. [x] Approve the update and verify the source's PostgreSQL chunks and embeddings are deleted. The update reported one removed source.
5. [x] Ask the recorded question and verify the removed file cannot be retrieved or cited. The assistant returned insufficient evidence.
6. [x] Restore the PDF to the flat root, explicitly approve a refresh, and verify it becomes searchable once without duplicate chunks. The restored source returned the expected cited answer.

### E. Progress, stop, and resume

1. [x] Place at least two new disposable PDFs directly in the root and approve one multi-file refresh.
2. [x] Verify one card reports monotonic completed/total file, current filename, chunk, and embedding-batch progress.
3. [x] Click **Stop update** while work remains and verify the same card changes to **Stopping safely...**, then to a terminal stopped result with completed and remaining counts.
4. [x] Select **Resume update**, review a fresh remaining-work proposal, and verify atomically completed sources are skipped while the final source finishes. The live card completed the remaining one of three files.
5. [x] Verify stopping this refresh does not cancel another delivery job or clear the shared queue. Covered by the exact-job PostgreSQL integration tests.

### F. MCP parity and final safety gate

1. [x] Call authenticated `search_workspace_knowledge({ question })` and verify it returns the same scoped evidence and citations as Lark. Live MCP acceptance cited the expected expense-policy page.
2. [x] Verify the MCP caller cannot provide or override tenant, employee, workspace, folder token, URL, or authorization scope. Covered by the MCP contract and authorization tests.
3. [x] Verify no Drive file was modified by ingestion, retrieval, removal from knowledge, stop, or resume. Only PostgreSQL knowledge rows changed; Drive remained read-only.
4. [x] Verify `test_directory_2`, `test_directory_3`, and Shared Folders were never scanned or indexed. The exact configured flat root remained the only Drive knowledge boundary.
5. [x] Run the complete verification command set and confirm `npm run doctor` reports `schema_ready: true`, `voyage_embedding_configured: true`, and `write_enabled: false`.

## Exit gate

Phase 13 is complete only when:

- A configured employee can explicitly add one direct-chat PDF and one allowlisted Drive PDF to the active workspace vault through Lark.
- The flat `Test_Synvo_AI_Assistant` acceptance root indexes its six direct-child PDFs exactly once and an unchanged refresh performs no re-embedding.
- One persistent pgvector-backed chunk index is isolated by verified tenant, user, and active workspace.
- Duplicate and interrupted ingestion cannot expose partial or duplicate source versions.
- Natural-language workspace questions retrieve bounded evidence and return grounded answers with validated file/page citations.
- Unsupported questions produce an honest insufficient-evidence response.
- Employees can decline ingestion and remove an indexed source.
- Reconciliation detects supported new, changed, and removed direct-child PDFs without polling, recursion, subfolder access, or automatic ingestion.
- The proven retrieval owner is available through one authenticated read-only MCP tool without caller-selected identity or workspace.
- Voyage receives only approved bounded chunk text or the bounded employee question; NVIDIA receives only the question and retrieved evidence needed for the grounded answer.
- Neither model provider receives credentials, Lark identifiers, links, workspace metadata, database identifiers, or tools.
- All automated checks and live acceptance pass with Drive writes disabled.
- The final simplification review confirms that no speculative service, framework, table, state machine, or dependency was added.

All Phase 13 exit criteria passed for the Victor-only local Lark pilot on 2026-08-11. The later production rollout gates listed under preflight remain operational deployment work rather than unfinished Phase 13 product behavior.
