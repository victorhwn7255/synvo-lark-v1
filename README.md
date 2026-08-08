# Synvo AI Assistant

Synvo AI Assistant is an internal work assistant currently delivered through Lark. Team members use bounded chat commands; the application authenticates the requester, calls approved services, and returns a verified outcome in the same conversation.

The active pilot is `/organize-folder` against one allowlisted Lark My Space folder. Its current production path authorizes Victor, validates the folder, inventories two destination folders and four PDF fixtures, and returns a deterministic two-Product/two-Research proposal. Victor can approve or reject that proposal in Lark, but Phase 4 records intent only: it never opens, downloads, moves, or changes files.

## Architecture

```text
Lark App Bot --------> message handling and OAuth --+
                                                    |
Approved AI agent --> authenticated /mcp endpoint --+--> organize-folder workflow
                                                         --> Lark Drive client
                                                         --> delivery worker
                                                         --> PostgreSQL
```

Everything runs in one Synvo Assistant Node.js application with one database pool. MCP is a protocol adapter, not a second service, workflow engine, or tool framework. Its first tool reuses the same allowlisted read-only inventory path used by Lark.

## Repository

```text
apps/synvo-assistant/src/
├── db/                         migrations and pool
├── delivery/                   durable outbound jobs
├── lark/                       chat commands and Lark integrations
│   ├── auth/                   OAuth grants, encryption, refresh
│   └── drive/                  bounded read-only Drive client
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

The database has four active runtime tables—OAuth grants, OAuth sessions, organize-folder runs, and delivery jobs—plus the migration ledger. Obsolete Phase 1 and Phase 3 tables are removed by a forward-only migration.

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

Manual Lark acceptance:

1. `/ping` returns `pong`.
2. `/organize-folder <allowlisted-folder-link>` returns exactly two Product and two Research moves plus a proposal ID.
3. `/approve-folder <proposal-id>` records approval and a repeated approval is idempotent.
4. A conflicting `/reject-folder <proposal-id>` fails safely.
5. Run `/organize-folder <allowlisted-folder-link>` again and use `/reject-folder <new-proposal-id>` to verify rejection.
6. External, sibling, malformed, and unknown proposal inputs fail safely.
7. All four PDFs remain in the root and both destination folders remain empty.

## Safety

- Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false`.
- Keep the pilot restricted to the configured Lark user and tenant.
- Never expose or commit `.env`, Lark secrets, OAuth tokens, native Drive tokens, or restricted links.
- Do not modify applied migrations; use a new forward-only migration for schema changes.
- Add one narrow workflow at a time and close its request-to-verified-outcome loop before adding platform abstractions.

See [AGENTS.md](AGENTS.md) and [the active organize-folder plan](tasks/organize-folder-implementation-plan.md).
