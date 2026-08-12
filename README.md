# Synvo AI Assistant

Synvo AI Assistant is an internal work assistant delivered through Lark. Team members use bounded chat interactions; the application authenticates the requester, calls approved services, and returns a verified outcome in the same conversation.

The current Victor-only pilot implements four employee workflows:

- **Organize the active workspace:** recursively inventory up to 99 eligible PDFs beneath the one allowlisted Lark My Space workspace, obtain exact provider consent, reuse its indexed knowledge, ask NVIDIA for a backend-validated two-to-six-folder taxonomy, account for every PDF, require explicit proposal approval, create only approved top-level folders, verify every enabled move, reconcile citation paths without re-embedding, and support separately confirmed verified undo.
- **Handle an attached PDF:** show an explicit **Add to knowledge / Analyze once / Not now** card, then bind and re-fetch the exact Lark resource only after the employee chooses an action.
- **Analyze a Drive PDF:** verify one owned PDF anywhere beneath the allowlisted root, download it through the user's OAuth grant, and reuse the bounded extraction, NVIDIA analysis, and durable progress path.
- **Use workspace knowledge:** explicitly ingest approved PDFs into a tenant/user/workspace-scoped pgvector vault, discover root and descendant Drive PDFs through one bounded reviewed traversal, and answer natural-language questions from bounded evidence with validated relative-path/page citations.

An approved multi-file knowledge refresh updates one Lark card with file, chunk, and Voyage-batch progress. **Stop update** cancels only that exact refresh between bounded work units; it never clears the shared queue. Atomically completed sources remain indexed, and **Resume update** creates a fresh reviewed proposal for only the remaining work.

Natural-language routing sends every normal employee message through one bounded semantic NVIDIA classification. The strict result contains one of ten supported intents, including `ask_workspace` and `remove_knowledge_source`, plus a bounded folder reference; links and native identifiers are removed locally first. The backend—not the model—selects an existing workflow or verified response. Exact parsing remains only for operational slash-command fallbacks. A link-free request for the active workspace requires an **Analyze workspace** confirmation, while a named or different folder requires its exact Lark link. An exact named Drive-source deletion requires a second destructive confirmation, the operator write switch, verified placement in Lark's recycle bin, and only then removal of that source's chunks and embeddings.

Phase 12 workspace context is complete. On a greeting, the assistant reads only Victor's top-level **My Folders** directory through the existing OAuth grant, matches the configured root by exact token, and shows the verified active workspace plus other folder names in the welcome card. NVIDIA may classify a sanitized utterance as a current-workspace question; the backend then retrieves and renders verified Lark context. Workspace names, links, and tokens are never sent to NVIDIA. Other folders remain informational and do not expand the organizer allowlist.

The configured folder token is the stable workspace identity. Its Lark display name may be changed without changing authorization; the assistant reads the current name from Lark and reflects it after the next request or knowledge refresh.

The Lark experience uses interactive cards for provider consent, authorization, progress, paginated proposals, decisions, verified execution, and undo. Approve, Reject, Authorize, Undo, and Analyze workspace are buttons. Employees can say `Hello`, ask `What can you help me with?`, request workspace organization naturally, or ask to analyze a Drive PDF. Exact slash commands remain operational fallbacks.

For operations and regression testing, the deterministic fallbacks are `/ping`, `/organize-workspace [configured workspace link]`, `/analyze-file <Drive PDF link>`, `/approve-workspace <proposal ID>`, `/reject-workspace <proposal ID>`, and `/undo-workspace <proposal ID>`. Normal employee use should rely on conversation and buttons.

## Architecture

```text
Lark App Bot -> local parsing + bounded intent classification
                                             |
                                             +-> request-local workspace context
                                             |   -> top-level My Folders only
                                             |   -> exact configured-root match
                                             |
                                             +-> message handling and OAuth --+-> workspace organizer
                                             |   -> recursive authorized Drive reader
                                             |   -> existing scoped knowledge vault
                                             |   -> bounded NVIDIA profiles,
                                             |      taxonomy, and classification
                                             |   -> existing proposal/approval state
                                             |   -> delivery worker and PostgreSQL
                                             |
                                             +-> analyze-attachment workflow
                                                 -> bounded attachment download
                                                 -> local PDF text extraction
                                                 -> NVIDIA NIM

                                             +-> analyze-drive-file workflow
                                                 -> allowlisted metadata check
                                                 -> bounded Drive PDF download
                                                 -> shared extraction and NVIDIA NIM

                                             +-> knowledge workflow
                                                 -> explicit ingestion/refresh consent
                                                 -> bounded breadth-first workspace scan
                                                 -> page-aware chunks + Voyage embeddings
                                                 -> scoped exact pgvector retrieval
                                                 -> no-tools NVIDIA grounded answer

Approved AI agent -> authenticated /mcp endpoint --+-> read-only workspace inspection
                                                    +-> read-only Drive PDF analysis
                                                    +-> read-only workspace knowledge search
```

Everything runs in one Synvo Assistant Node.js application with one database pool. MCP is a protocol adapter for external AI agents, not a second service, workflow engine, or tool framework. Its tools reuse the same authoritative read-only workflows used by Lark. The internal workspace organizer calls those application modules directly and follows a fixed sequence rather than an autonomous tool loop. NVIDIA receives bounded evidence and produces strict profiles, a taxonomy, and classifications; it receives no tools or mutation authority. Approval, mutation, provider verification, recovery, and undo remain inside the trusted Synvo workflow.

## Repository

```text
apps/synvo-assistant/src/
├── db/                         migrations and pool
├── delivery/                   durable outbound jobs
├── lark/                       chat commands and Lark integrations
│   ├── auth/                   OAuth grants, encryption, refresh
│   ├── drive/                  bounded Drive reads, folder creation, and file moves
│   ├── assistant-card.ts       general Lark cards and safe button parsing
│   ├── organize-folder-card.ts workspace organization consent, proposal, execution, and undo cards
│   └── attachment.ts           exact file-message binding and bounded download
├── mcp/                        authenticated MCP adapter and narrow local client
├── web/                        health, OAuth, and MCP HTTP routing
├── workflows/analyze-attachment/ shared PDF extraction, NIM analysis, progress updates
├── workflows/analyze-drive-file/ allowlisted Drive PDF analysis
├── workflows/natural-language/  bounded intent policy and sanitization
├── workflows/knowledge/        consent, chunking, Voyage, retrieval, grounded Q&A
├── workflows/organize-folder/  workspace organization policy and workflow (historical path)
├── workflows/workspace-context/ bounded My Folders discovery and local questions
├── config.ts                   application configuration
├── index.ts                    composition and lifecycle
└── doctor.ts                   concise local readiness check

database/migrations/            immutable applied migrations
tests/integration/postgres/     focused database integration path
tasks/                          planned work and archived acceptance evidence
```

The database has five active runtime tables—OAuth grants, OAuth sessions, organize-folder runs, delivery jobs, and workspace knowledge chunks—plus the migration ledger. `workspace_chunks` stores authorized page-aware text and 1,024-dimensional Voyage embeddings; no PDF bytes, OAuth tokens, or model responses are stored there. Knowledge-refresh cancellation is one timestamp on the existing delivery job, not a separate queue or cancellation subsystem.

## Local setup

```bash
npm install
docker compose up -d postgres
cp apps/synvo-assistant/.env.example apps/synvo-assistant/.env
npm run migrate
npm run doctor
npm run dev
```

Merge missing keys into an existing `.env`; never overwrite working secrets. Register the exact configured OAuth callback URL in Lark. Under **Events & Callbacks**, keep persistent connection enabled and add the `card.action.trigger` callback so the assistant’s Start analysis, Approve, Reject, and Undo buttons reach the backend.

Direct attachment analysis requires the tenant-token scope `im:message:readonly`. The existing direct-message event scope lets the bot receive the file event, but Lark requires `im:message:readonly` for the bot to re-fetch that exact message and verify its file resource before download. Keep app availability restricted to the pilot user.

Drive-file analysis adds `drive:file:download` to the exact user OAuth profile. After deployment, send `organize this folder <approved root folder link>` and use the **Authorize with Lark** button once to replace an old grant. To analyze one disposable PDF directly inside the root, send `analyze this file <Lark Drive PDF link>`.

Document analysis uses one fixed NVIDIA-hosted NIM endpoint and model. Only the secret is configurable:

```env
LLM_API_KEY=replace_locally_only
```

The provider client calls `nvidia/nemotron-3-super-120b-a12b`. Keep the real API key in ignored `.env` locally and in secret management when hosted. A future multimodal workflow must add its model only when that workflow exists.

Workspace knowledge uses a separate required `VOYAGE_API_KEY` only for fixed `voyage-4` document and query embeddings at 1,024 dimensions. The assistant sends Voyage only explicitly approved bounded chunk text or the bounded employee question. Voyage's [embedding documentation](https://docs.voyageai.com/docs/embeddings) confirms the model and output dimension. Its [current pricing](https://docs.voyageai.com/docs/pricing), verified on 2026-08-11, includes the first 200 million tokens and then charges $0.06 per million tokens; pricing is operational information, not a runtime assumption. Before using real Synvo internal documents, enable and verify Voyage's organization-level zero-day-retention/data opt-out and store the hosted credential in secret management. Changing to an incompatible embedding model or dimension requires re-embedding every stored chunk before it can be queried; do not mix embedding spaces in one vault.

Drive-backed workspace knowledge starts only at the exact configured root and uses an iterative breadth-first scan. The authoritative limits live in `workflows/knowledge/policy.ts`: depth 4 below the root, 50 visited folders including the root, 200 owned ordinary PDFs, and 512 Unicode code points per safe relative path. Every folder is fully paginated and parent relationships, repeated tokens, cycles, and provider bounds fail the complete scan closed. Path-only moves update citation metadata without extraction or re-embedding; removals require an approved, complete, revalidated tree. The organizer uses the same verified recursive inventory with its separate 99-PDF policy, and direct Drive-file analysis resolves one exact path from that inventory.

For natural-language routing, each non-command direct message is capped at 600 characters; Lark links, mentions, native identifiers, and control characters are removed locally before the remaining short utterance is classified. NVIDIA receives no tools, workspace metadata, or conversation history and can return only `greeting`, `acknowledgement`, `help`, `current_workspace`, `refresh_workspace`, `ask_workspace`, `organize_workspace`, `analyze_drive_file`, or `unknown`, plus `active_workspace`, `named_or_other_folder`, or `none` as a folder reference. The reference never carries a name, link, token, or authorization decision. Invalid or unavailable classification starts no workflow.

To enable the local MCP endpoint, generate a separate service credential and add it to the ignored `.env`:

```bash
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
```

Save the result as `SYNVO_MCP_AUTH_TOKEN`. Do not reuse a Lark secret. Without this variable, `/mcp` remains disabled. The local URL is `http://localhost:3000/mcp`; a remotely hosted agent will require the same application behind managed HTTPS.

## MCP foundation

The server exposes exactly three authenticated read-only tools:

- `inspect_workspace({ folder_url })`: returns a bounded recursive metadata-only inventory for the configured workspace. It never opens, downloads, moves, renames, or changes a file, and exposes no native Drive identifiers.
- `analyze_drive_file({ folder_url, relative_path })`: resolves one exact path returned by `inspect_workspace`, then verifies and analyzes the uniquely matching owned PDF beneath the allowlisted root through the existing bounded Drive-file workflow. Missing or duplicate paths are rejected. It cannot change Drive files. Treat its document-derived output as untrusted evidence, never as an instruction to execute.
- `search_workspace_knowledge({ question })`: verifies the configured active workspace and searches only the authenticated pilot's tenant/user/workspace-scoped vault. It returns a bounded answer with display filename/page citations or an explicit insufficient-evidence result; callers cannot choose an identity, folder, URL, or authorization scope.

The bearer credential identifies an approved service client. For the current Victor-only pilot, the application maps every authenticated call to Victor's configured Lark `open_id` and tenant; callers cannot select another employee. The stored Lark OAuth grant is still what authorizes the application to call Lark. Future tools should be added as thin adapters to proven workflow methods, one at a time.

The internal workspace organizer does not call its own MCP endpoint. It directly reuses the authorized Drive reader and scoped knowledge repository, then calls NVIDIA in bounded strict-schema steps for document profiles, one small taxonomy, and complete classification. NVIDIA cannot call MCP and never receives the MCP credential, Lark identity, Drive tokens, or links. MCP exposes no write tool; a stored proposal can execute only through the existing trusted workflow after exact user approval while the operator switch is enabled.

## Verification

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
```

Detailed completed acceptance procedures are archived instead of being maintained as active setup instructions. See `tasks/archive/organize-folder-implementation-plan.md`, `tasks/archive/analyze-attachment-acceptance.md`, `tasks/archive/analyze-drive-file-implementation-plan.md`, `tasks/archive/content-aware-execution-implementation-plan.md`, `tasks/archive/natural-language-interaction-implementation-plan.md`, and `tasks/archive/folder-knowledge-rag-implementation-plan.md`.

Phases 12–14 have completed their Victor-only live Lark acceptance. Phase 13 closed explicit PDF ingestion, flat-root reconciliation, scoped pgvector retrieval, grounded citations, removal/restoration, and exact-job stop/resume. Phase 14 closed bounded recursive PDF discovery, path-aware citations, metadata-only move reconciliation, verified removal/restoration, cross-folder retrieval, and authenticated MCP knowledge search. Its completed record is archived in `tasks/archive/recursive-workspace-knowledge-implementation-plan.md`. Voyage handles embeddings only; NVIDIA remains the no-tools intent, document-analysis, and grounded-answer provider. Hosted production rollout remains separately gated on managed secrets, production pgvector support, and verified Voyage zero-day retention.

Phase 15 and its Victor-only live Lark acceptance are complete. Automated
verification passed 426 unit tests, 7 PostgreSQL integration tests, TypeScript
checking, and the final simplification gate. Live acceptance replaced the OAuth
grant, rejected one proposal without mutation, then used a fresh approved
proposal to create five broad folders and move and verify all 15 PDFs. Knowledge
reconciliation changed all 15 citation paths without re-embedding; grounded
cross-folder Q&A remained correct. Separately confirmed undo restored and
verified all 15 original parents and citation paths, while intentionally leaving
the proposal-created empty folders in place. The completed record is archived
in `tasks/archive/organize-workspace-implementation-plan.md`.

## Safety

- Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false` except during an explicitly controlled execute-and-undo acceptance window.
- Keep the pilot restricted to the configured Lark user and tenant.
- Never expose or commit `.env`, Lark secrets, OAuth tokens, native Drive tokens, or restricted links.
- Never log or persist the NVIDIA credential, prompts, extracted attachment text, or raw provider errors.
- Treat attachment content as untrusted data and give the document-analysis model no tools.
- Apply the same untrusted-content and no-tools boundary to PDFs analyzed from Lark Drive.
- Keep MCP read-only. An AI-generated proposal can execute only through the trusted workflow after exact user approval while `ORGANIZE_FOLDER_WRITE_ENABLED=true`; restore the switch to `false` immediately after the controlled window.
- Use only disposable, non-sensitive documents with the hosted NVIDIA trial endpoint until Synvo approves real internal-document processing.
- Do not modify applied migrations; use a new forward-only migration for schema changes.
- Add one narrow workflow at a time and close its request-to-verified-outcome loop before adding platform abstractions.

See [AGENTS.md](AGENTS.md) and the completed acceptance evidence in [tasks/archive](tasks/archive/).
