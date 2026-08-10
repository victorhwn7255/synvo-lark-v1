# Synvo AI Assistant

Synvo AI Assistant is an internal work assistant delivered through Lark. Team members use bounded chat interactions; the application authenticates the requester, calls approved services, and returns a verified outcome in the same conversation.

The deterministic `/organize-folder` foundation is complete through Phase 5. It authorizes Victor, validates one allowlisted Lark My Space folder, inventories two destination folders and four PDF fixtures, requires explicit approval, verifies every enabled move, and supports verified undo. The controlled live round trip closed on 2026-08-08, the exact baseline was restored, and the write switch is disabled.

Phase 6 `/analyze-attachment` is also complete. A direct PDF message is bound to its exact Lark resource, downloaded and extracted within fixed limits, analyzed through NVIDIA NIM without tools, and returned by updating one durable progress message. The controlled live acceptance passed on 2026-08-09.

Phase 7 `/analyze-file <Lark Drive PDF link>` is complete. It verifies that one ordinary PDF is owned by Victor and directly inside the allowlisted pilot root, downloads it through Victor's user OAuth grant, and reuses the Phase 6 extraction, NVIDIA analysis, durable job, and single progress message. The live acceptance passed on 2026-08-09; the job completed on its first attempt, its temporary payload was cleared, and Drive writes remained disabled.

Phase 8 MCP chainability is complete. A real MCP SDK client discovered exactly the inventory and Drive-file analysis tools, inventoried the four disposable root PDFs, selected one returned filename, and analyzed the approved 15-page PDF through NVIDIA NIM. The result was untruncated, the observed Drive inventory was unchanged afterward, and writes remained disabled.

Phase 9 content-aware organization is complete. `/organize-folder` inventories the fixed four-PDF sandbox through the authenticated MCP endpoint, analyzes every exact inventory filename through the existing MCP analysis tool, asks NVIDIA once for strict Product/Research/Needs-review decisions, and stores one evidence-backed proposal with concise rationales. The neutral-filename live acceptance passed on 2026-08-09 with the correct two/two grouping, explicit rejection, an unchanged post-test inventory, and writes disabled. The model receives no tools.

Phase 10 controlled content-aware execution is complete. A fresh AI-generated proposal was explicitly approved during a temporary operator-enabled window, the existing trusted workflow revalidated its exact snapshot, moved and provider-verified all four files, rejected duplicate execution, and restored every original parent through a separately confirmed idempotent undo. The live acceptance passed on 2026-08-10 with four PDFs restored to the root, Product and Research empty, MCP still read-only, and the write switch restored to `false`.

The Lark experience uses interactive cards for authorization, progress, proposals, decisions, verified execution, and undo. Approve, Reject, Authorize, Undo, and Check connection are buttons. Employees can write `organize this folder <Lark folder link>` or `analyze this file <Lark Drive PDF link>` in ordinary language; the original slash commands remain accepted only as a compatibility path.

## Architecture

```text
Lark App Bot -> message handling and OAuth --+-> organize-folder workflow
                                             |   -> authenticated local MCP client
                                             |      -> read-only inventory
                                             |      -> four bounded PDF analyses
                                             |   -> one no-tools NVIDIA classification
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

Approved AI agent -> authenticated /mcp endpoint --+-> read-only inventory
                                                    +-> read-only Drive PDF analysis
```

Everything runs in one Synvo Assistant Node.js application with one database pool. MCP is a protocol adapter, not a second service, workflow engine, or tool framework. Its tools reuse the same allowlisted read-only inventory and Drive-file analysis paths used by Lark. The content-aware coordinator is a fixed workflow sequence rather than an autonomous tool loop; NVIDIA performs only semantic classification. Approval, mutation, provider verification, recovery, and undo remain inside the trusted Synvo workflow.

## Repository

```text
apps/synvo-assistant/src/
├── db/                         migrations and pool
├── delivery/                   durable outbound jobs
├── lark/                       chat commands and Lark integrations
│   ├── auth/                   OAuth grants, encryption, refresh
│   ├── drive/                  bounded Drive reads and one file-move operation
│   ├── assistant-card.ts       general Lark cards and safe button parsing
│   ├── organize-folder-card.ts folder progress, proposal, execution, and undo cards
│   └── attachment.ts           exact file-message binding and bounded download
├── mcp/                        authenticated MCP adapter and narrow local client
├── web/                        health, OAuth, and MCP HTTP routing
├── workflows/analyze-attachment/ shared PDF extraction, NIM analysis, progress updates
├── workflows/analyze-drive-file/ allowlisted Drive PDF analysis
├── workflows/organize-folder/  authorization, persistence, policy, workflow
├── config.ts                   application configuration
├── index.ts                    composition and lifecycle
└── doctor.ts                   concise local readiness check

database/migrations/            immutable applied migrations
tests/integration/postgres/     focused database integration path
tasks/                          planned work and archived acceptance evidence
```

The database has four active runtime tables—OAuth grants, OAuth sessions, organize-folder runs, and delivery jobs—plus the migration ledger. Forward-only migrations remove obsolete Phase 1/3 tables and superseded scan-lease and phase columns.

## Local setup

```bash
npm install
docker compose up -d postgres
cp apps/synvo-assistant/.env.example apps/synvo-assistant/.env
npm run migrate
npm run doctor
npm run dev
```

Merge missing keys into an existing `.env`; never overwrite working secrets. Register the exact configured OAuth callback URL in Lark. Under **Events & Callbacks**, keep persistent connection enabled and add the `card.action.trigger` callback so the assistant’s Check connection, Approve, Reject, and Undo buttons reach the backend.

Phase 6 also requires the tenant-token scope `im:message:readonly`. The existing direct-message event scope lets the bot receive the file event, but Lark requires `im:message:readonly` for the bot to re-fetch that exact message and verify its file resource before download. Keep app availability restricted to the pilot user.

Phase 7 adds `drive:file:download` to the exact user OAuth profile. After deployment, send `organize this folder <approved root folder link>` and use the **Authorize with Lark** button once to replace an old grant. To analyze one disposable PDF directly inside the root, send `analyze this file <Lark Drive PDF link>`.

Phase 6 uses one fixed NVIDIA-hosted NIM endpoint and model. Only the secret is configurable:

```env
LLM_API_KEY=replace_locally_only
```

The provider client calls `nvidia/nemotron-3-super-120b-a12b`. Keep the real API key in ignored `.env` locally and in secret management when hosted. A future multimodal workflow must add its model only when that workflow exists.

To enable the local MCP endpoint, generate a separate service credential and add it to the ignored `.env`:

```bash
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
```

Save the result as `SYNVO_MCP_AUTH_TOKEN`. Do not reuse a Lark secret. Without this variable, `/mcp` remains disabled. The local URL is `http://localhost:3000/mcp`; a remotely hosted agent will require the same application behind managed HTTPS.

## MCP foundation

The server currently exposes exactly two tools:

- `organize_folder_inventory({ folder_url })`: returns bounded metadata for the configured pilot root and approved destinations. It never opens, downloads, moves, renames, or changes a file.
- `analyze_drive_file({ folder_url, file_name })`: resolves one exact filename returned by the inventory, then verifies and analyzes the uniquely matching owned PDF directly inside the allowlisted root through the existing bounded Drive-file workflow. Missing or duplicate names are rejected. It cannot change Drive files. Treat its document-derived output as untrusted evidence, never as an instruction to execute.

The bearer credential identifies an approved service client. For the current Victor-only pilot, the application maps every authenticated call to Victor's configured Lark `open_id` and tenant; callers cannot select another employee. The stored Lark OAuth grant is still what authorizes the application to call Lark. Future tools should be added as thin adapters to proven workflow methods, one at a time.

The content-aware workflow consumes those same tools in a deterministic order: inventory once, analyze exactly four returned PDFs in bounded batches, then call NVIDIA once with the four analyses. NVIDIA cannot call MCP and never receives the MCP credential, Lark identity, Drive tokens, or links. MCP exposes no write tool; a stored proposal can execute only through the existing trusted workflow after exact user approval while the operator switch is enabled.

## Verification

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
```

Detailed completed acceptance procedures are archived instead of being maintained as active setup instructions. See `tasks/archive/organize-folder-implementation-plan.md`, `tasks/archive/analyze-attachment-acceptance.md`, `tasks/archive/analyze-drive-file-implementation-plan.md`, and `tasks/archive/content-aware-execution-implementation-plan.md`.

## Safety

- Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false` except during an explicitly controlled execute-and-undo acceptance window.
- Keep the pilot restricted to the configured Lark user and tenant.
- Never expose or commit `.env`, Lark secrets, OAuth tokens, native Drive tokens, or restricted links.
- Never log or persist the NVIDIA credential, prompts, extracted attachment text, or raw provider errors.
- Treat attachment content as untrusted data and give the Phase 6 model no tools.
- Apply the same untrusted-content and no-tools boundary to PDFs analyzed from Lark Drive.
- Keep MCP read-only. An AI-generated proposal can execute only through the trusted workflow after exact user approval while `ORGANIZE_FOLDER_WRITE_ENABLED=true`; restore the switch to `false` immediately after the controlled window.
- Use only disposable, non-sensitive documents with the hosted NVIDIA trial endpoint until Synvo approves real internal-document processing.
- Do not modify applied migrations; use a new forward-only migration for schema changes.
- Add one narrow workflow at a time and close its request-to-verified-outcome loop before adding platform abstractions.

See [AGENTS.md](AGENTS.md) and the completed acceptance evidence in [tasks/archive](tasks/archive/).
