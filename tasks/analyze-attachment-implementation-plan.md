# `/analyze-attachment` Implementation Plan

Status: Ready to start

Current phase: Phase 6

Pilot user: Victor

## 1. Outcome

Victor sends one disposable PDF directly to the Synvo AI Assistant in a Lark direct message. The file message is the Phase 6 `/analyze-attachment` request; the pilot must not add a two-message upload session.

The assistant:

1. Authenticates the Lark event, user, tenant, and message.
2. Downloads only that message's attachment through Lark.
3. Validates and extracts bounded text locally.
4. Sends a progress message and updates it while work runs.
5. Sends the extracted text to the configured NVIDIA NIM primary model.
6. Returns a concise, grounded analysis in the same Lark conversation.
7. Reports a safe failure when any boundary cannot be verified.

Phase 6 is complete only when this full loop works in Lark and survives duplicate delivery and a process restart without producing duplicate user-visible results.

## 2. Simplicity boundary

Allowed:

- One new `analyze-attachment` workflow inside the existing application.
- One small Lark attachment download method near the Lark integration.
- One local PDF text extractor and one NVIDIA NIM chat-completions client.
- One new job kind in the existing durable delivery worker if asynchronous execution is required.
- One progress message that the existing application creates and updates.
- Small extensions to existing configuration and command/event dispatch.

Not allowed in Phase 6:

- A new service, process, package boundary, queue, worker, database table, or deployment.
- A generic LLM provider, model router, agent, prompt, document-processing, or plugin framework.
- A new MCP tool or an MCP-based implementation of this workflow.
- Automatic fallback across models.
- Persistence added solely to promise exactly-once execution of an external model call.
- OCR, image, audio, or video processing.
- Drive, Wiki, task, calendar, or other write operations.
- Arbitrary URLs, Drive file keys, or attachments from another message.

Use the primary model only:

```text
nvidia/nemotron-3-super-120b-a12b
```

The configured multimodal specialist remains unused until a separately approved workflow has real image, audio, or video input:

```text
nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
```

## 3. Relationship to `/organize-folder`

Phase 6 proves one reusable document-analysis capability, but only through a Lark chat attachment. It does not complete the AI-powered `/organize-folder` workflow.

After Phase 6 closes, plan and approve the next loop separately:

1. Adapt the proven extraction and NVIDIA analysis capability to authorized Lark Drive files.
2. Expose it through one narrow read-only MCP tool, such as `analyze_lark_file`, only when an approved AI agent is ready to consume it.
3. Let that agent combine `organize_folder_inventory` with per-file analysis to create an evidence-backed organization proposal.
4. Keep approval, Drive mutation, verification, and undo inside the existing Synvo workflow boundary.

Do not add the Drive-file MCP tool, content-based folder agent, or intelligent organization logic during Phase 6.

## 4. Pilot input and limits

Initial supported input:

- One PDF sent in a direct conversation with the bot.
- A disposable, non-sensitive test document for live acceptance.
- A verified file resource belonging to the triggering Lark message.

Initial hard limits:

- Maximum file size: 10 MiB.
- Maximum PDF pages: 50.
- Maximum extracted text: 100,000 Unicode code points.
- Maximum one attachment per workflow run.
- Maximum one bounded retry for a retryable NVIDIA response.
- Explicit timeouts for Lark download and NVIDIA inference.

Reject encrypted, malformed, empty, unsupported, oversized, or image-only PDFs. Do not silently switch to OCR or the multimodal model.

These limits live once in the workflow policy. Provider clients enforce transport bounds but do not duplicate workflow decisions.

## 5. Planned flow

```text
Lark PDF message
  -> authenticate fixed pilot user and tenant
  -> claim the message idempotently
  -> send one progress message
  -> download the exact Lark message resource
  -> validate PDF and extract bounded text locally
  -> call NVIDIA NIM with the primary model
  -> validate and format the final analysis
  -> update the progress message with success or safe failure
```

The model receives no tools in Phase 6. It analyzes text but cannot call MCP, Lark, Drive, the database, or any operational function.

## 6. Analysis contract

The prompt requests a bounded result with:

- Document title or filename.
- Executive summary.
- Key insights.
- Important decisions or recommendations found in the document.
- Action items only when explicitly supported by the document.
- A limitations note when extraction was truncated or evidence was unclear.

Document text is untrusted data, not an instruction source. The system instruction must tell the model to ignore commands, credentials requests, tool instructions, or role changes embedded in the document.

The final Lark response must not include hidden reasoning, raw provider responses, API credentials, native Lark resource keys, or database identifiers.

## 7. Security and privacy boundary

Threat statement: a malicious or accidental attachment may contain instructions intended to redirect the model or disclose internal data; Phase 6 protects the current Lark conversation and Synvo credentials by giving the model no tools, treating document content only as quoted data, and sending only the bounded extracted text required for analysis.

- Keep `LLM_API_KEY` only in ignored `.env` locally and secret management in hosted environments.
- Never persist the NVIDIA credential, include it in job payloads, or log request headers.
- Never pass Lark access tokens, resource keys, message tokens, links, or user identifiers to NVIDIA.
- Do not retain attachment bytes or extracted text after the workflow finishes unless a current recovery requirement proves persistence necessary.
- Use only disposable, non-sensitive PDFs during the NVIDIA hosted-endpoint pilot.
- Obtain Synvo approval before sending real internal documents to a third-party hosted inference endpoint.
- Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false`; attachment analysis has no Drive write path.

## 8. Work items

### Configuration and client

- [ ] Load and validate `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, and `LLM_MULTIMODAL_MODEL`.
- [ ] Require the exact NVIDIA NIM provider and HTTPS hosted base URL for the pilot.
- [ ] Add one small chat-completions client with a timeout and bounded error mapping.
- [ ] Keep model-specific reasoning parameters next to the NVIDIA client.
- [ ] Never log prompts, extracted document text, credentials, or raw provider errors.

### Lark attachment input

- [ ] Capture the exact shape of one disposable Lark PDF message event as a redacted test fixture.
- [ ] Accept only direct file messages from the configured user and tenant.
- [ ] Bind the attachment resource to the triggering message; accept no arbitrary resource key from user text.
- [ ] Download the resource using the application's existing tenant authentication and `im:resource` scope.
- [ ] Bound download size, time, redirects, and content type.

### Local extraction

- [ ] Add one PDF extraction dependency only if the platform cannot perform the required extraction directly.
- [ ] Validate the PDF header and parser result at the extraction boundary.
- [ ] Enforce file, page, and text limits.
- [ ] Reject empty or image-only PDFs with a clear message.
- [ ] Keep temporary content in memory or an OS temporary file and remove it after the attempt.

### Workflow and Lark progress

- [ ] Use the triggering Lark message ID as the idempotency owner.
- [ ] Reuse the existing delivery worker for durable asynchronous processing; add no second worker.
- [ ] Send one progress message and store only the minimum identifier required to update it.
- [ ] Update the same message for downloading, analyzing, success, or safe failure.
- [ ] Ensure duplicate events do not create another job or final message.
- [ ] After an ambiguous in-flight provider failure, allow only the bounded retry and do not claim exactly-once NVIDIA execution.
- [ ] Format one concise final analysis for Lark.

### NVIDIA analysis

- [ ] Send only the bounded extracted text and the minimum document metadata.
- [ ] Use `nvidia/nemotron-3-super-120b-a12b` for every Phase 6 request.
- [ ] Do not expose tools to the model.
- [ ] Parse only the final answer; discard any separate reasoning field.
- [ ] Normalize authentication, permission, rate-limit, timeout, malformed-response, and provider-failure errors.
- [ ] Retry at most once and only for a clearly retryable failure.

### Documentation and simplification

- [ ] Update source ownership only after the new paths exist.
- [ ] Update README setup and live acceptance instructions to match implemented behavior.
- [ ] End Phase 6 with a deletion pass and remove any unused abstraction or compatibility code.
- [ ] Keep the MCP server unchanged with exactly one read-only tool.

## 9. Required tests

- [ ] Missing, placeholder, and malformed NVIDIA configuration.
- [ ] Correct primary and multimodal model configuration.
- [ ] Wrong user, wrong tenant, group message, unsupported message type, and duplicate event.
- [ ] Missing resource, wrong resource binding, unsupported MIME type, oversized file, timeout, and malformed PDF.
- [ ] Empty, image-only, over-page-limit, and over-text-limit PDFs.
- [ ] Deterministic truncation and limitations reporting.
- [ ] NVIDIA 401, 403, 429, timeout, 5xx, malformed JSON, empty output, and unexpected response shape.
- [ ] Embedded prompt injection is treated as document text and receives no tool access.
- [ ] Progress creation and update success, update failure, retry, and restart recovery.
- [ ] Duplicate delivery creates no second job or final message; ambiguous provider completion remains bounded and is reported truthfully.
- [ ] Logs and user-visible errors contain no secrets, attachment text, resource keys, or raw provider bodies.
- [ ] Existing `/ping`, `/organize-folder`, execution, undo, OAuth, delivery, and MCP tests remain green.

## 10. Exit gate

- [ ] Victor sends one disposable text-based PDF directly to the bot.
- [ ] Lark displays one progress message and then one grounded final analysis.
- [ ] The response contains a useful summary, key insights, and only evidence-supported action items.
- [ ] A repeated delivery produces no second job or duplicate final message.
- [ ] One controlled restart demonstrates safe recovery.
- [ ] An unsupported or oversized attachment fails clearly without reaching NVIDIA.
- [ ] No Drive object is read or changed by the attachment workflow.
- [ ] No new MCP tool, service, worker, table, or generic framework exists.
- [ ] The full automated verification suite passes.
- [ ] Live acceptance is recorded without attachment contents or credentials.

## 11. Verification commands

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
npm run dev
```

After the automated suite passes, complete the live Lark acceptance with a disposable PDF and restore the application to its normal safe configuration.
