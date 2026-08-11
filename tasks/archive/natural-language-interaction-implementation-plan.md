# Phase 11: Natural-language interaction and bounded tool routing

Status: completed on 2026-08-11; implementation, automated verification, safe-mode Lark acceptance, and simplification review passed.

## Goal

Let Victor use the existing Synvo AI Assistant loops through ordinary Lark conversation instead of remembering slash commands.

Phase 11 closes these interaction paths:

1. A greeting such as `Hello`, `Good morning`, or `Are you online?` returns the personalized welcome card.
2. A natural request containing an approved Lark Drive folder link starts the existing read-only organize-folder workflow.
3. A natural organize request without a link presents one explicit confirmation for the single allowlisted pilot root.
4. Confirming that card starts the existing content-aware workflow, which inventories and analyzes through the two read-only MCP tools and produces the existing proposal.
5. Unclear, unsupported, or unsafe requests receive one friendly clarification and perform no operational action.
6. Existing slash commands remain available as hidden deterministic fallbacks for tests and operations.

This phase improves how users express intent. It does not change the trusted proposal, approval, execution, verification, or undo boundaries.

## Product examples

| Employee message | Expected response |
| --- | --- |
| `Hello` | Personalized `Welcome to Synvo AI, Victor` card |
| `What can you help me with?` | Existing friendly capabilities card |
| `Could you organize this messy folder? <approved folder link>` | Validate the link and start the existing read-only analysis |
| `My folder is getting messy. Can you organize it?` | Confirm use of the single approved pilot folder with a button |
| `Please organize the Finance folder` | Ask for its Lark link unless it is the explicitly confirmed pilot root |
| `Analyze this file <approved PDF link>` | Route to the existing Drive-file analysis workflow |
| An unrelated or ambiguous request | Ask one concise clarification; call no tool or write path |

## Architectural decision

Add one small intent-classification module and one deterministic dispatcher inside the existing Node.js application.

```text
Lark direct text message
  -> current exact command/link parsing first
  -> bounded natural-language intent classification when needed
  -> validated intent result
  -> deterministic backend dispatch
       greeting          -> personalized welcome card
       help              -> capabilities card
       analyze file      -> existing analyze-drive-file workflow
       organize + link   -> existing organize-folder workflow
       organize, no link -> confirm the one configured pilot root
       unknown           -> one clarification card

Confirmed organize request
  -> existing organize-folder workflow
  -> authenticated local MCP client
  -> organize_folder_inventory
  -> analyze_drive_file for each accepted PDF
  -> existing proposal and approval boundary
```

NVIDIA may classify the user's intent into a strict schema. It receives no tools and cannot call MCP, Lark, Drive, PostgreSQL, or a workflow. The application owns tool and workflow selection.

NVIDIA NIM does not connect to MCP directly. The existing Synvo backend remains the orchestrator that invokes the existing authenticated MCP client after deterministic policy checks.

Do not add new infrastructure unless a current Phase 11 requirement clearly needs it.

## Fixed Phase 11 boundary

- One configured Lark user and tenant: Victor in the Synvo pilot.
- One configured and allowlisted Drive root.
- Existing Product and Research pilot destinations and four-PDF policy remain unchanged.
- Only direct text messages from the configured pilot user are classified.
- Group messages, bot messages, files, and other event types keep their current handlers and boundaries.
- Natural-language routing may start only the existing greeting, help, analyze-drive-file, and organize-folder paths.
- The MCP endpoint continues to expose exactly two read-only tools.
- The model receives no MCP tool definitions, credentials, Drive links, native identifiers, or OAuth tokens.
- `ORGANIZE_FOLDER_WRITE_ENABLED=false` throughout implementation and live acceptance.
- Live acceptance uses only benign, non-sensitive test utterances with the hosted NVIDIA endpoint.

## Intent contract

Use one small discriminated result validated at the NVIDIA response boundary:

```ts
type NaturalLanguageIntent =
  | { intent: "greeting" }
  | { intent: "help" }
  | { intent: "organize_folder" }
  | { intent: "analyze_drive_file" }
  | { intent: "unknown" };
```

Links and native identifiers are extracted and retained by deterministic local code before classification. They are never copied into the model request or trusted from model output.

Do not use model-generated confidence as an authorization signal. If deterministic context is insufficient to identify one supported action, ask the user to clarify.

## Routing rules

1. Preserve current exact slash commands and existing accepted natural link phrases as the first deterministic path.
2. Treat an obvious greeting-only message locally when it cannot contain another requested action.
3. For other unmatched bounded direct text, remove links, mentions, control characters, and unnecessary identifiers before sending only the remaining short utterance to NVIDIA.
4. Validate the returned intent once at the provider boundary.
5. Map the validated intent through an explicit switch to one existing workflow or card.
6. Never execute a model-provided function name, URL, arguments object, or arbitrary MCP tool request.
7. If NVIDIA is unavailable, return a friendly capabilities/manual-link fallback; do not retry indefinitely or guess an action.

Actionable requests take precedence over greetings. For example, `Hello, could you organize this folder?` must not stop at the greeting path.

## Folder resolution behavior

### Request includes a folder link

- Extract the link locally.
- Reuse the existing Lark Drive parser and exact root allowlist.
- Reject external, sibling, nested, Wiki, malformed, or unsupported links before starting MCP work.
- Start the existing organize-folder workflow with the original validated link.

### Request does not include a folder link

- Do not search all of My Space in Phase 11.
- Do not guess that a named folder is the allowlisted root.
- Present a card explaining that the pilot can work with its approved folder.
- Provide a `Start folder analysis` button and a `Use another folder` instruction.
- Bind the button value to one fixed action; do not place a native folder token in the card payload.
- On button click, verify the configured pilot actor and tenant, then start the existing workflow using the configured root.
- Use the callback message ID as the stable idempotency key so duplicate clicks cannot create competing runs.

A future multi-folder phase may add an authorized folder finder or picker only after its permissions and ambiguity policy are approved.

## Work items

### 1. Natural-language policy and provider boundary

- [x] Add one bounded natural-language intent module under `workflows/natural-language/`.
- [x] Reuse the existing NVIDIA HTTP behavior where practical without turning it into a provider framework.
- [x] Limit the input length and accept only direct text from the configured pilot.
- [x] Extract and remove Lark URLs locally before the NVIDIA request.
- [x] Remove Lark mentions, control characters, and native-looking identifiers from model input.
- [x] Use one fixed prompt and strict structured response for the five declared intents.
- [x] Give NVIDIA no tools and no conversation history.
- [x] Bound timeout, response size, and retry behavior using the smallest current policy.
- [x] Return a typed safe failure rather than provider text.

### 2. Deterministic dispatcher

- [x] Keep the current command parser as the first path.
- [x] Add a greeting-only fast path that cannot swallow an actionable request.
- [x] Route each validated intent through one explicit switch.
- [x] Reuse the existing personalized online card for greetings.
- [x] Reuse the existing capabilities card for help.
- [x] Reuse the existing Drive-file workflow when one valid file link is present.
- [x] Reuse the existing organize-folder workflow when one valid folder link is present.
- [x] Return a friendly clarification when a required link is missing or ambiguous.
- [x] Do not add conversation memory, session persistence, or a new delivery job kind.

### 3. One-root confirmation card

- [x] Add one friendly confirmation card for a link-free organize request.
- [x] Add a `Start folder analysis` button with one strict action value.
- [x] Keep the root token and native identifiers out of the card payload.
- [x] Verify callback actor and tenant using the existing pilot boundary.
- [x] Start the existing organize-folder workflow with a stable idempotency key.
- [x] Show the existing loading card immediately after confirmation.
- [x] Keep proposal approval, rejection, execution, and undo cards unchanged.

### 4. Natural and safe fallback responses

- [x] Replace the generic unknown-command response with one concise clarification card.
- [x] Tell users how to attach a PDF or share a Lark link without exposing slash commands.
- [x] If the intent provider is unavailable, keep existing deterministic commands operational.
- [x] Never claim a workflow started unless its existing start method accepted the request.
- [x] Never imply that a file will move before the existing proposal approval.

### 5. Documentation

- [x] Update `AGENTS.md` current scope and source ownership only after implementation matches it.
- [x] Update the root README with employee-facing natural-language examples and the hidden fallback commands.
- [x] Record the hosted-NVIDIA privacy boundary and the single-root limitation once.
- [x] Move this plan to `tasks/archive/` only after live acceptance passes.

## Required tests

### Intent behavior

- [x] Greeting variants route to the personalized welcome card.
- [x] Greeting plus an actionable organize request routes to organize, not greeting.
- [x] Help and capability questions route to the capabilities card.
- [x] Multiple natural organize paraphrases produce the organize intent.
- [x] Multiple natural Drive-file analysis paraphrases produce the analyze intent.
- [x] Unsupported and ambiguous messages produce clarification and no workflow call.
- [x] Existing slash commands continue to behave exactly as before.

### Privacy and untrusted input

- [x] Lark URLs, native tokens, mentions, and control characters do not reach NVIDIA.
- [x] Overlong messages are rejected or bounded before the model call.
- [x] Prompt-injection text cannot introduce a new intent, tool name, URL, argument, or write action outside the declared contract.
- [x] Malformed, missing, extra, and unknown NVIDIA output fails safely.
- [x] Provider 401, 403, 429, 5xx, timeout, and malformed-response paths reveal no provider body or credential.

### Routing and safety

- [x] A valid allowlisted folder link starts exactly one existing organize-folder run.
- [x] An external, sibling, nested, Wiki, or malformed folder link starts no run and calls no MCP tool.
- [x] A link-free organize request performs no MCP or Drive call before confirmation.
- [x] The confirmation button accepts only the configured pilot actor and tenant.
- [x] Duplicate confirmation callbacks cannot create competing runs.
- [x] Confirmation starts the existing loading/proposal path and no alternate workflow.
- [x] A natural request cannot approve a proposal, enable writes, move a file, or request undo.
- [x] MCP still exposes exactly `organize_folder_inventory` and `analyze_drive_file`, both read-only.
- [x] Existing execution, verification, recovery, and undo tests remain green.

## Failure behavior

- Intent classification failure: show a friendly manual-help response; perform no operational action.
- Missing folder identity: ask for confirmation or a Lark folder link.
- Invalid or unallowlisted link: use the existing safe link error and perform no MCP call.
- Missing OAuth grant: reuse the existing authorization card and callback.
- MCP or content-analysis failure after a confirmed start: reuse the existing bounded retry and terminal result behavior.
- Duplicate message or button callback: reuse existing idempotency and return the existing run/result.

No fallback may silently select another folder, infer a write action, or bypass approval.

## Verification commands

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
git diff --check
```

Final automated verification completed on 2026-08-11:

- `npm run typecheck`: passed
- `npm test`: 334 tests passed
- `npm run test:integration`: 4 tests passed
- `npm run doctor`: ready with `write_enabled: false`
- `git diff --check`: passed

Live acceptance confirmed personalized greetings and help, natural folder organization with and without a link, the explicit link-free confirmation, provider-backed proposals, visible rejection results, natural Drive-file analysis, safe handling of a named non-pilot folder, ambiguous-message fallback, and `/ping` backward compatibility. Both proposals were rejected, the provider-backed inventory remained at four root PDFs with empty Product and Research destinations, and writes remained disabled.

Before live acceptance, `doctor` must report:

- pilot identity ready
- database and OAuth grant ready
- MCP enabled
- `write_enabled: false`

## Live Lark acceptance

Run with `ORGANIZE_FOLDER_WRITE_ENABLED=false` and the four disposable, non-sensitive test PDFs restored to the approved root.

1. [x] Send `Hello` and receive the personalized Victor welcome card.
2. [x] Send another greeting variant and receive a natural response without a tool call.
3. [x] Send `What can you help me with?` and receive the capabilities card.
4. [x] Send a natural organize request containing the approved folder link.
5. [x] Confirm the existing loading card appears and one evidence-backed proposal is delivered.
6. [x] Reject that proposal and verify no file changed.
7. [x] Send a natural organize request without a link.
8. [x] Confirm no MCP or Drive work begins before clicking `Start folder analysis`.
9. [x] Click the button and receive one new loading card and one proposal.
10. [x] Reject the proposal and verify the provider-backed inventory remains unchanged.
11. [x] Send an ambiguous unsupported request and receive one clarification with no workflow run.
12. [x] Send the existing slash-command form once and confirm backward compatibility.
13. [x] Run a final provider-backed inventory proving four root PDFs, empty Product and Research folders, and no unsupported item.

## Abort conditions

Stop acceptance and investigate if:

- A natural message causes a Drive mutation or proposal decision.
- A link-free request starts analysis without the required confirmation.
- The model receives a Lark link, native identifier, credential, or more user text than the bounded classifier needs.
- An invalid or unallowlisted link reaches MCP.
- A duplicate message or button produces a competing workflow run.
- An unknown intent selects an operational path.
- `ORGANIZE_FOLDER_WRITE_ENABLED` is true.

## Exit gate

Phase 11 is complete only when:

- [x] Employees can greet the assistant naturally and receive a personalized response.
- [x] Natural help requests produce the existing capabilities guidance.
- [x] A natural request with an approved folder link reaches the existing proposal loop.
- [x] A natural link-free organize request requires one explicit root confirmation, then reaches the same proposal loop.
- [x] Natural Drive-file requests reuse the existing allowlisted analysis path.
- [x] Unknown, ambiguous, provider-failed, and malicious inputs perform no operational action.
- [x] NVIDIA receives only bounded sanitized intent text and no tools or protected identifiers.
- [x] The model cannot authorize, approve, write, verify, or undo.
- [x] Existing commands, OAuth, delivery recovery, MCP tools, proposal approval, execution, and undo remain intact.
- [x] Automated verification and the safe-mode live acceptance pass.
- [x] Final provider inventory is unchanged and `write_enabled: false`.
- [x] A simplification pass removes unnecessary wrappers and confirms the documented tree matches the implementation.

## Non-goals

- No general-purpose agent, company Q&A, or conversation memory.
- No model-selected tools, write actions, proposal decisions, or automatic mutations.
- No arbitrary-folder discovery, dynamic taxonomy, nested traversal, or new OAuth scope.
- No new service, framework, persistence model, or deployment boundary.

## Simplification review

- [x] Confirm one small intent module and one explicit dispatch switch are sufficient.
- [x] Confirm no model response directly names executable code or tool arguments.
- [x] Confirm no new persistence was added for a one-message decision.
- [x] Reuse existing cards, workflows, OAuth, delivery worker, MCP client, and idempotency behavior.
- [x] Delete temporary aliases, duplicated greeting logic, and obsolete unknown-command copy.
- [x] Review every sanitizer, retry, and fallback against a demonstrated Phase 11 input or provider risk.
- [x] Confirm each new invariant has one authoritative owner.
- [x] Confirm `AGENTS.md` source ownership matches the final tree.
