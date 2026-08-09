# Phase 7: Analyze One Lark Drive PDF

Status: Completed on 2026-08-09

## Outcome

Victor sends:

```text
/analyze-file <Lark Drive PDF link>
```

The assistant verifies that the linked file is an owned direct child of the configured pilot root, downloads it with Victor's Lark user grant, reuses the existing bounded PDF extraction and NVIDIA analysis, and updates one durable progress message in Lark.

## Boundaries

- Read-only: no Drive mutation path and `ORGANIZE_FOLDER_WRITE_ENABLED=false`.
- Pilot identity only: configured Lark `open_id` and tenant.
- One ordinary PDF file in the allowlisted root; no native Docs, arbitrary URLs, nested files, OCR, images, audio, or video.
- Existing limits remain: 10 MiB, 50 pages, 100,000 extracted code points, bounded model output, timeout, and one retry.
- Add `drive:file:download` to the exact user OAuth profile. An old grant must be reauthorized once through the existing `/organize-folder` OAuth entrypoint before `/analyze-file` can run.
- Store only an encrypted, temporary job context. Clear it when the job completes or fails.
- Add no service, process, table, worker, queue, provider framework, MCP tool, or agent loop.

## Implementation

1. Parse one exact Lark Drive file link and reject unsupported hosts, paths, queries, fragments, and tokens.
2. Extend the exact Drive OAuth profile with `drive:file:download`.
3. Add one bounded Drive file-download client beside the existing Drive clients.
4. Add one `analyze-drive-file` workflow that:
   - validates the configured actor and usable exact-scope grant;
   - persists an encrypted job context using the existing delivery payload;
   - lists the allowlisted root and requires one matching owned PDF;
   - downloads with the user access token and performs one locked token recovery after an access-token rejection;
   - reuses the current PDF extractor, NVIDIA client, progress-message behavior, and safe errors.
5. Extend the existing delivery worker with one analysis job kind; do not add another worker or table.
6. Route `/analyze-file` in the existing Lark message adapter.
7. Update README and AGENTS only after the code paths exist.

## Required tests

- Command and file-link parsing, including malformed, external, folder, native-doc, nested, and unsupported-query links.
- Wrong actor or tenant, missing/wrong-scope/revoked grant, and duplicate message.
- File outside the root, wrong owner, wrong type, non-PDF, pagination bounds, and malformed provider data.
- Download size, timeout, 401 recovery, repeated 401 revocation, 403, 404, 429, 5xx, and network failures without provider leakage.
- Encrypted job context, progress recovery, safe failure, and completion cleanup.
- Existing attachment, organize-folder, OAuth, execution, undo, delivery, and MCP regressions.

## Exit gate

- [x] Full automated suite passes.
- [x] Victor completes the expanded OAuth consent once.
- [x] One disposable root PDF produces one grounded analysis in Lark.
- [x] Duplicate delivery produces no second job or result.
- [x] No PDF bytes or extracted text remain in PostgreSQL.
- [x] No Drive file changes and no new MCP tool exist.

## Acceptance evidence

- The exact Phase 7 OAuth grant is usable for the configured pilot identity.
- `[research] - Anthropic Agentic Engineering.pdf` produced a grounded 15-page analysis in Lark.
- The durable job completed on its first attempt and cleared its encrypted payload.
- The final readiness check confirmed `write_enabled=false`.
