# `/analyze-attachment` Phase 6 Acceptance

Status: Complete  
Closed: 2026-08-09  
Lark app version: `0.1.2`

## Outcome

Victor sent one disposable, text-based PDF directly to the Synvo AI Assistant. The existing Node.js application:

1. Accepted only the configured user's direct file message.
2. Re-fetched that exact Lark message and downloaded only its bound resource.
3. Validated a PDF under 10 MiB and 50 pages and extracted at most 100,000 Unicode code points in memory.
4. Created one durable job and one progress message.
5. Sent only bounded extracted text and the filename to NVIDIA NIM.
6. Updated the same Lark message with a grounded analysis and page count.

The live test analyzed a 14-page PDF successfully. The durable job completed in one attempt, recorded no error, and cleared its temporary encrypted progress-message payload.

## Implementation boundary

- Primary model: `nvidia/nemotron-3-super-120b-a12b`.
- Hosted endpoint: NVIDIA NIM.
- The model received no tools and could not call MCP, Lark, Drive, or the database.
- Attachment bytes and extracted text remained in memory for the current attempt.
- No new service, process, worker, queue, table, provider framework, or MCP tool was added.
- `ORGANIZE_FOLDER_WRITE_ENABLED` remained false.

The selected future multimodal specialist, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, is not configured or called until a real image, audio, or video workflow is approved.

## Verified behavior

Automated coverage includes:

- Wrong user, tenant, chat, or message type and duplicate events.
- Exact message-resource binding, missing resources, MIME and size limits, timeouts, and malformed PDFs.
- Empty, image-only, over-page, and over-text-limit PDFs.
- NVIDIA authentication, rate-limit, timeout, server, malformed, empty, and oversized responses.
- Prompt-injection text receiving no tool access.
- Progress creation, update, retry, duplicate delivery, and restart recovery.
- Regression coverage for `/ping`, `/organize-folder`, OAuth, execution, undo, delivery, and MCP.

The completion suite passed:

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
```

No document contents, Lark resource key, prompt, credential, or provider response is retained in this record.

## Next separately planned loop

Adapt the proven extraction and analysis path to one authorized Lark Drive file. Expose it as a narrow read-only MCP capability only when an approved AI agent is ready to combine it with `organize_folder_inventory`. The existing Synvo workflow must continue to own proposal approval, Drive writes, verification, and undo.
