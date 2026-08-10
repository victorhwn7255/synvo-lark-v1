# Phase 8: MCP chainability and client acceptance

## Goal

Prove that one approved MCP client can inventory the allowlisted Lark Drive pilot folder, select a returned filename, and analyze that exact PDF through Synvo's existing read-only workflow without exposing Drive tokens or enabling writes.

## Implementation

- Change the MCP contract to `analyze_drive_file({ folder_url, file_name })`.
- Keep Lark `/analyze-file <file URL>` unchanged.
- Resolve `file_name` by listing the exact allowlisted root.
- Require exactly one matching ordinary PDF owned by the configured pilot user and located directly in that root.
- Reuse the existing OAuth recovery, Drive download, PDF extraction, NVIDIA NIM analysis, limits, and safe errors.
- Keep MCP as a thin protocol adapter and both tools read-only.

## Required rejection cases

- Malformed, external, sibling, nested, or otherwise unallowlisted folder URL.
- Missing, duplicate, non-PDF, non-file, wrong-owner, or wrong-parent match.
- Wrong user or tenant, unusable OAuth grant, unsafe provider response, or bounded-processing failure.
- Caller-supplied identity fields or other unknown MCP arguments.

## Verification

- MCP discovery returns exactly `organize_folder_inventory` and `analyze_drive_file`.
- A client can pass a filename from inventory into analysis.
- No MCP tool exposes a Drive mutation path.
- `ORGANIZE_FOLDER_WRITE_ENABLED=false` remains effective.
- `npm run typecheck`
- `npm test`
- `npm run test:integration`
- `npm run doctor`
- `git diff --check`
- Real MCP-client inventory-to-analysis acceptance when local credentials permit it.

## Non-goals

- No autonomous multi-file agent or organization-proposal loop.
- No MCP write tool.
- No new database table, migration, process, package, registry, framework, or generic agent abstraction.
- No multi-user identity model.

## Exit gate

Phase 8 closes only when a real MCP client discovers the two tools, inventories the disposable pilot root, analyzes a selected inventory filename, receives a bounded result, and the application reports Drive writes disabled. If live credentials are unavailable, automated work may pass but the phase remains open with the exact manual action documented.

## Acceptance evidence

Automated verification completed on 2026-08-09:

- TypeScript typecheck passed.
- All 274 unit tests passed.
- All four PostgreSQL integration tests passed.
- Doctor reported the schema and grant ready and `write_enabled: false`.
- `git diff --check` passed.

Live MCP SDK verification completed on 2026-08-09:

- The client discovered exactly `organize_folder_inventory` and `analyze_drive_file`.
- The client called the real inventory tool and received the four disposable root PDFs.
- With explicit approval, the client selected `[research] - Anthropic Agentic Engineering.pdf` from that inventory and called `analyze_drive_file({ folder_url, file_name })`.
- The tool analyzed all 15 pages through NVIDIA NIM; neither extracted input nor model output reached its configured truncation limit.
- A second inventory observation matched the pre-analysis observation.
- The live process reported `write_enabled: false`.

The Phase 8 exit gate is satisfied. The autonomous multi-file organization-proposal loop remains a separate future phase.
