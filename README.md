# Synvo AI Assistant

Synvo AI Assistant is an internal work assistant delivered through Lark. Team members use bounded chat interactions; the application authenticates the requester, calls approved services, and returns a verified outcome in the same conversation.

The deterministic `/organize-folder` foundation is complete through Phase 5. It authorizes Victor, validates one allowlisted Lark My Space folder, inventories two destination folders and four PDF fixtures, proposes moves from approved filename prefixes, requires explicit approval, verifies every move, and supports verified undo. The controlled live round trip closed on 2026-08-08, the exact baseline was restored, and the write switch is disabled.

The full AI-powered `/organize-folder` workflow is not complete. It must eventually read and analyze the contents of messy files, infer useful categories and relationships, and create an evidence-backed organization proposal before reusing the existing approval, move, verification, and undo machinery.

Phase 6 `/analyze-attachment` is also complete. A direct PDF message is bound to its exact Lark resource, downloaded and extracted within fixed limits, analyzed through NVIDIA NIM without tools, and returned by updating one durable progress message. The controlled live acceptance passed on 2026-08-09.

Phase 7 `/analyze-file <Lark Drive PDF link>` is complete. It verifies that one ordinary PDF is owned by Victor and directly inside the allowlisted pilot root, downloads it through Victor's user OAuth grant, and reuses the Phase 6 extraction, NVIDIA analysis, durable job, and single progress message. The live acceptance passed on 2026-08-09; the job completed on its first attempt, its temporary payload was cleared, and Drive writes remained disabled.

Phase 8 MCP chainability is complete. A real MCP SDK client discovered exactly the inventory and Drive-file analysis tools, inventoried the four disposable root PDFs, selected one returned filename, and analyzed the approved 15-page PDF through NVIDIA NIM. The result was untruncated, the observed Drive inventory was unchanged afterward, and writes remained disabled.

## Architecture

```text
Lark App Bot -> message handling and OAuth --+-> organize-folder workflow
                                             |   -> Lark Drive client
                                             |   -> delivery worker
                                             |   -> PostgreSQL
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

Everything runs in one Synvo Assistant Node.js application with one database pool. MCP is a protocol adapter, not a second service, workflow engine, or tool framework. Its tools reuse the same allowlisted read-only inventory and Drive-file analysis paths used by Lark.

The MCP endpoint now exposes the proven Drive-file analysis capability as `analyze_drive_file`. A separately planned agent loop can combine folder inventory with per-file content analysis to propose how a messy folder should be organized. The agent loop itself is not implemented yet.

## Repository

```text
apps/synvo-assistant/src/
├── db/                         migrations and pool
├── delivery/                   durable outbound jobs
├── lark/                       chat commands and Lark integrations
│   ├── auth/                   OAuth grants, encryption, refresh
│   ├── drive/                  bounded Drive reads and one file-move operation
│   └── attachment.ts           exact file-message binding and bounded download
├── mcp/                        authenticated MCP protocol adapter
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

Merge missing keys into an existing `.env`; never overwrite working secrets. Register the exact configured OAuth callback URL in Lark.

Phase 6 also requires the tenant-token scope `im:message:readonly`. The existing direct-message event scope lets the bot receive the file event, but Lark requires `im:message:readonly` for the bot to re-fetch that exact message and verify its file resource before download. Keep app availability restricted to the pilot user.

Phase 7 adds `drive:file:download` to the exact user OAuth profile. After deploying Phase 7, send `/organize-folder <approved root folder link>` and complete OAuth once to replace the old grant. Then copy the link of one disposable PDF directly inside the root and send `/analyze-file <Lark Drive PDF link>`.

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

## Verification

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
```

Detailed completed acceptance procedures are archived instead of being maintained as active setup instructions. See `tasks/archive/organize-folder-implementation-plan.md`, `tasks/archive/analyze-attachment-acceptance.md`, and `tasks/archive/analyze-drive-file-implementation-plan.md`.

## Safety

- Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false` except during an explicitly controlled execute-and-undo acceptance window.
- Keep the pilot restricted to the configured Lark user and tenant.
- Never expose or commit `.env`, Lark secrets, OAuth tokens, native Drive tokens, or restricted links.
- Never log or persist the NVIDIA credential, prompts, extracted attachment text, or raw provider errors.
- Treat attachment content as untrusted data and give the Phase 6 model no tools.
- Apply the same untrusted-content and no-tools boundary to PDFs analyzed from Lark Drive.
- Use only disposable, non-sensitive documents with the hosted NVIDIA trial endpoint until Synvo approves real internal-document processing.
- Do not modify applied migrations; use a new forward-only migration for schema changes.
- Add one narrow workflow at a time and close its request-to-verified-outcome loop before adding platform abstractions.

See [AGENTS.md](AGENTS.md) and the completed acceptance evidence in [tasks/archive](tasks/archive/).
