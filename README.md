# Synvo Lark Assistant

Synvo Lark Assistant is a trusted internal work assistant that runs inside Lark.
It turns bounded natural-language requests into permission-aware workflows and returns verified outcomes in the same Lark conversation.

The active pilot is `/organize-folder`, which operates only on one allowlisted Lark My Space sandbox.
Phase 3 is complete: one disposable PDF completed an explicitly confirmed and externally verified `root -> Research -> root` capability spike, and the exact baseline was restored.
Phase 4 is the next milestone: an immutable read-only folder snapshot and deterministic organization proposal.

## Architecture

```text
Lark user
   |
   v
assistant-backend
   |  messaging, OAuth, workflow orchestration, delivery
   v
synvo-lark-mcp
   |  bounded provider-specific Lark capabilities
   v
Lark Open Platform APIs
```

GPT or Codex models may eventually propose structured actions, but deterministic application code owns authorization, policy validation, execution, reconciliation, and verification.
Models never receive Lark credentials or native Drive tokens.

## Repository structure

```text
apps/
├── assistant-backend/       Lark-facing orchestrator and OAuth service
└── synvo-lark-mcp/          Private MCP server for bounded Lark capabilities
    ├── src/                 Production MCP implementation
    └── tools/
        └── drive-move-spike/  Development-only capability verifier

packages/
├── contracts/               Shared typed workflow contracts
└── lark-auth/               OAuth, encrypted grants, and token refresh

database/migrations/         Immutable versioned PostgreSQL migrations
tests/integration/postgres/  PostgreSQL integration tests
tasks/                       Active and archived implementation plans
```

The normal MCP server exposes only the bounded read-only Drive inventory tool.
The Drive move spike is development-only operator tooling and is not part of the normal MCP tool surface.

## Local verification

From the repository root:

```bash
npm install
npm run typecheck
npm test
npm run test:integration
```

PostgreSQL integration tests require `TEST_DATABASE_URL` to reference an isolated migrated development database.
Do not count skipped integration tests as passing database verification.

Useful operational commands:

```bash
npm run migrate
npm run pin:pilot-identity
npm run verify:readonly-inventory
npm run drive-spike:prepare
npm run verify:drive-spike
```

Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false` in persistent configuration.
Never commit `.env`, OAuth tokens, Lark secrets, native Drive tokens, or restricted folder links.

## Project documentation

- [`AGENTS.md`](AGENTS.md) is the canonical project contract and engineering guidance.
- [`tasks/organize-folder-implementation-plan.md`](tasks/organize-folder-implementation-plan.md) is the active executable plan.
- [`apps/assistant-backend/README.md`](apps/assistant-backend/README.md) is the local backend and Lark OAuth runbook.
- [`tasks/archive/organize-wiki-implementation-plan.md`](tasks/archive/organize-wiki-implementation-plan.md) is historical reference material for the blocked Wiki target.

The project is intentionally not a general-purpose autonomous agent platform.
New capabilities are added through small, explicit workflows that close the full request-to-verified-outcome loop.
