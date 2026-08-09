# Synvo AI Assistant

Synvo AI Assistant is an internal work assistant delivered through Lark. Team members use bounded chat interactions; the application authenticates the requester, calls approved services, and returns a verified outcome in the same conversation.

The deterministic `/organize-folder` foundation is complete through Phase 5. It authorizes Victor, validates one allowlisted Lark My Space folder, inventories two destination folders and four PDF fixtures, proposes moves from approved filename prefixes, requires explicit approval, verifies every move, and supports verified undo. The controlled live round trip closed on 2026-08-08, the exact baseline was restored, and the write switch is disabled.

The full AI-powered `/organize-folder` workflow is not complete. It must eventually read and analyze the contents of messy files, infer useful categories and relationships, and create an evidence-backed organization proposal before reusing the existing approval, move, verification, and undo machinery.

The active Phase 6 target is `/analyze-attachment`. Victor will send one disposable, text-based PDF directly to the bot. The existing application will download that exact message resource, extract bounded text locally, update one Lark progress message, analyze the text with NVIDIA NIM, and return a grounded result. This paragraph describes the active plan, not implemented behavior.

## Architecture

```text
Lark App Bot -> message handling and OAuth --+-> organize-folder workflow
                                             |   -> Lark Drive client
                                             |   -> delivery worker
                                             |   -> PostgreSQL
                                             |
                                             +-> planned analyze-attachment workflow
                                                 -> bounded attachment download
                                                 -> local PDF text extraction
                                                 -> NVIDIA NIM

Approved AI agent -> authenticated /mcp endpoint -> read-only inventory capability
```

Everything runs in one Synvo Assistant Node.js application with one database pool. MCP is a protocol adapter, not a second service, workflow engine, or tool framework. Its first tool reuses the same allowlisted read-only inventory path used by Lark.

After Phase 6 is proven, the next separately planned loop may expose the reusable Drive-file analysis capability as a narrow read-only MCP tool such as `analyze_lark_file`. An approved AI agent can then combine folder inventory with per-file content analysis to propose how a messy folder should be organized. Phase 6 does not implement that MCP tool or agent loop.

## Repository

```text
apps/synvo-assistant/src/
├── db/                         migrations and pool
├── delivery/                   durable outbound jobs
├── lark/                       chat commands and Lark integrations
│   ├── auth/                   OAuth grants, encryption, refresh
│   └── drive/                  bounded Drive reads and one file-move operation
├── mcp/                        authenticated MCP protocol adapter
├── web/                        health, OAuth, and MCP HTTP routing
├── workflows/organize-folder/  authorization, persistence, policy, workflow
├── config.ts                   application configuration
├── index.ts                    composition and lifecycle
└── doctor.ts                   concise local readiness check

database/migrations/            immutable applied migrations
tests/integration/postgres/     focused database integration path
tasks/                          active plans and archived evidence
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

Phase 6 uses the NVIDIA-hosted NIM API through provider-neutral configuration:

```env
LLM_PROVIDER=nvidia_nim
LLM_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_API_KEY=replace_locally_only
LLM_MODEL=nvidia/nemotron-3-super-120b-a12b
LLM_MULTIMODAL_MODEL=nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
```

The primary model is the only Phase 6 inference model. The multimodal specialist is reserved for a future workflow with real image, audio, or video input. Keep the real API key in ignored `.env` locally and in secret management when hosted.

To enable the local MCP endpoint, generate a separate service credential and add it to the ignored `.env`:

```bash
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
```

Save the result as `SYNVO_MCP_AUTH_TOKEN`. Do not reuse a Lark secret. Without this variable, `/mcp` remains disabled. The local URL is `http://localhost:3000/mcp`; a remotely hosted agent will require the same application behind managed HTTPS.

## MCP foundation

The server currently exposes exactly one tool:

- `organize_folder_inventory({ folder_url })`: returns bounded metadata for the configured pilot root and approved destinations. It never opens, downloads, moves, renames, or changes a file.

The bearer credential identifies an approved service client. For the current Victor-only pilot, the application maps every authenticated call to Victor's configured Lark `open_id` and tenant; callers cannot select another employee. The stored Lark OAuth grant is still what authorizes the application to call Lark. Future tools should be added as thin adapters to proven workflow methods, one at a time.

## Verification

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
```

Completed deterministic `/organize-folder` foundation regression acceptance:

1. `/ping` returns `pong`.
2. `/organize-folder <allowlisted-folder-link>` returns exactly two Product and two Research moves plus a proposal ID.
3. With writes disabled, approval records the decision and performs zero Drive mutations.
4. After exact-scope reauthorization, enable writes only for the controlled test and approve a new proposal.
5. Verify exactly two files in `Product`, two in `Research`, and none in the root; duplicate delivery must not move again.
6. `/undo-folder <proposal-id>` restores all four files and is idempotent when repeated.
7. Verify all four PDFs are back in the root, both destinations are empty, and restore the write switch to false.

The planned Phase 6 live acceptance is defined in `tasks/analyze-attachment-implementation-plan.md`. Do not treat it as implemented until its automated tests and Lark exit gate pass.

## Safety

- Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false` except during an explicitly controlled execute-and-undo acceptance window.
- Keep the pilot restricted to the configured Lark user and tenant.
- Never expose or commit `.env`, Lark secrets, OAuth tokens, native Drive tokens, or restricted links.
- Never log or persist the NVIDIA credential, prompts, extracted attachment text, or raw provider errors.
- Treat attachment content as untrusted data and give the Phase 6 model no tools.
- Use only disposable, non-sensitive documents with the hosted NVIDIA trial endpoint until Synvo approves real internal-document processing.
- Do not modify applied migrations; use a new forward-only migration for schema changes.
- Add one narrow workflow at a time and close its request-to-verified-outcome loop before adding platform abstractions.

See [AGENTS.md](AGENTS.md), [the active analyze-attachment plan](tasks/analyze-attachment-implementation-plan.md), and [the completed deterministic organize-folder foundation plan](tasks/archive/organize-folder-implementation-plan.md).
