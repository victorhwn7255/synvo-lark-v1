# Phase 12: My Folders workspace context

Status: completed on 2026-08-11; automated verification and live Lark acceptance passed.

## Goal

Give the Synvo AI Assistant a small, current picture of Victor's top-level **My Folders** directory so it can:

1. Show the configured active workspace in the welcome card.
2. Show the other top-level folders that are visible to Victor.
3. Understand varied natural-language questions about the current workspace and answer from verified Lark context.
4. Open the active workspace from a Lark card button.

This phase adds location context, not document knowledge or general memory.

## Employee experience

The first relevant message, such as `Hello`, produces a card similar to:

```text
Welcome to Synvo AI, Victor 👋

Your AI work assistant is connected and ready.

Current workspace
📁 My Folders / Test_Synvo_AI_Assistant
[Open workspace]

Other folders in My Folders
test_directory_2 · test_directory_3

Here are a few things I can do for you:
📄 Analyze a File
🗂️ Organize a Folder
```

`Which folder are we at now?` returns:

```text
We're currently working in My Folders / Test_Synvo_AI_Assistant.
```

The response may mention that other folders exist, but it must not imply that the current organizer is authorized to modify them.

## Current system behavior

- The configured `ORGANIZE_FOLDER_ROOT_TOKEN` is the only active and allowlisted workspace.
- The current Drive client lists a specified folder with full bounded pagination.
- Victor already has a user-bound OAuth grant with the required Drive scopes.
- The welcome card does not currently receive Drive context.
- Current-workspace questions use the existing bounded intent classifier and then resolve through verified backend context.
- No Lark event identifies a user's currently open Drive folder; “current workspace” therefore means the configured Synvo workspace, not the folder visible in Victor's desktop UI at that instant.

## Architectural decision

Add one small read-only workspace-context path inside the existing Node.js application.

```text
Greeting, or a sanitized utterance classified as current_workspace
  -> verify the configured pilot actor and tenant
  -> get the existing user OAuth token
  -> list My Folders top level (omit folder_token)
  -> match ORGANIZE_FOLDER_ROOT_TOKEN
  -> return bounded local workspace context
  -> render the welcome or current-workspace card
```

The Lark Drive file-list endpoint accepts an optional `folder_token`; omitting it lists the user's My Space root. It returns one directory level and does not recursively list nested content. Reuse the existing provider response validation, pagination limits, normalized errors, OAuth refresh, and one-retry token recovery.

Do not run discovery at application startup. Resolve it on the first relevant user message because startup has no target chat, the OAuth grant belongs to a user, and Drive contents may change between launches.

## Fixed boundary

- Victor-only pilot and the existing tenant allowlist.
- Read only the top level of **My Folders**.
- Accept folders only; ignore top-level files for this feature.
- Match the active workspace by exact configured token, never by name.
- Use the provider folder name only for display.
- Bound pagination, item count, rendered names, and card size.
- Keep folder names, folder tokens, OAuth tokens, and generated URLs out of NVIDIA requests and logs. For semantic workspace questions, NVIDIA receives only the bounded sanitized user utterance. The configured folder token may appear only inside the HTTPS URL behind the explicit `Open workspace` button.
- Keep the list in request-local memory only; do not persist or cache it in Phase 12.
- Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false` for implementation and live acceptance.
- Do not change the organizer's existing root allowlist.

## Work items

### 1. Read-only My Folders discovery

- [x] Extend the existing Lark Drive reader with one root-list operation that omits `folder_token`.
- [x] Give root-list responses their own provider schema because `parent_token` may be absent at the My Space root.
- [x] Reuse the existing request timeout, response-size checks, error normalization, cursor checks, duplicate-token checks, page budget, and item budget.
- [x] Return only bounded folder metadata needed by the UI: token and display name.
- [x] Do not recursively list any discovered folder.
- [x] Do not fetch folder contents, file metadata, or document contents.

### 2. Workspace context

- [x] Add one small `workflows/workspace-context/` module.
- [x] Obtain Victor's access token through the existing token broker.
- [x] Reuse `withReadOnlyDriveTokenRecovery` for one rejected-token recovery attempt.
- [x] Find the active workspace by exact `ORGANIZE_FOLDER_ROOT_TOKEN` equality.
- [x] Sort other top-level folder names for stable display.
- [x] Return a small typed result: active workspace plus other visible folder names.
- [x] Treat a missing configured root as an unavailable context; never select a similarly named folder.

### 3. Natural-language routing

- [x] Add `current_workspace` to the existing strict NVIDIA intent contract.
- [x] Cover varied semantic forms such as `Which folder are we at?`, `Where are we doing our work?`, and `Remind me which workspace this is` without exact-sentence matching.
- [x] Route only to the read-only workspace-context path.
- [x] Let only the backend resolve the intent to verified Lark context; do not give NVIDIA tools, workspace metadata, conversation history, or a write path.
- [x] If the question is ambiguous, preserve the existing clarification behavior.

### 4. Lark cards

- [x] Extend the personalized welcome card to accept optional workspace context.
- [x] Show `My Folders / <verified active folder name>`.
- [x] Add one `Open workspace` URL button using the configured active root.
- [x] Show other visible top-level folders as informational metadata only.
- [x] Add a concise current-workspace response card.
- [x] If discovery is unavailable, keep the existing welcome card useful and show no invented folder data.
- [x] Sanitize and bound every provider-derived display name using the existing card-display policy.

### 5. Composition and documentation

- [x] Compose the workspace-context function in the existing `index.ts`; do not add a service or worker.
- [x] Reuse the existing pilot identity, Drive reader, token broker, and card delivery path.
- [x] Update `README.md` and `AGENTS.md` to describe the implemented behavior and explicitly retain the pending live gate.
- [ ] Archive this plan only after the exit gate passes.

## Required tests

### Drive boundary

- [x] Root listing omits `folder_token` and uses the user access token.
- [x] Root listing follows valid pagination and rejects repeated cursors.
- [x] Duplicate tokens, malformed responses, excessive pages/items, timeouts, 401, 403, 404, 429, and 5xx responses fail safely.
- [x] Root items without `parent_token` are accepted only by the root-list schema.
- [x] No recursive or child-folder request is made.

### Context behavior

- [x] Exact configured token resolves `Test_Synvo_AI_Assistant` as active.
- [x] `test_directory_2` and `test_directory_3` are returned as other folders in stable order.
- [x] A same-name folder with another token cannot become active.
- [x] A missing active token produces unavailable context rather than a guess.
- [x] Expired access is refreshed once; revoked or wrong-scope grants fail safely.
- [x] OAuth values are absent from logs, cards, and NVIDIA input; folder tokens are absent from visible card text, action values, logs, and NVIDIA input, except for the configured token inside the `Open workspace` HTTPS URL.

### Interaction behavior

- [x] Greeting renders Victor's welcome card with the verified active workspace.
- [x] Semantically varied current-workspace questions receive the verified current-workspace response through the existing bounded NVIDIA classifier.
- [x] `Open workspace` targets only the configured root.
- [x] Other folder names are informational and cannot start organization without an exact link and existing validation.
- [x] Discovery failure still returns a useful welcome or safe context-unavailable response.
- [x] Existing greetings, help, file analysis, folder analysis, approval, rejection, execution, undo, and `/ping` behavior remain green.

## Failure behavior

- Missing or unusable OAuth grant: keep the welcome functional and state that Drive context is unavailable; do not invent a folder.
- Temporary Lark failure: return the same safe fallback without provider detail.
- Configured root absent from My Folders: report that the active workspace could not be verified and perform no other action.
- Too many top-level folders: stop at the fixed bound and do not return a partial list as complete.
- Duplicate names: display safely, but identity and authorization remain token-based.

No failure may switch the active workspace, search recursively, send workspace metadata to NVIDIA, or broaden Drive permissions.

## Non-goals

- RAG, embeddings, vector search, or document indexing.
- Reading or summarizing the contents of every folder.
- Tracking the folder currently open in the Lark desktop UI.
- Workspace switching, selecting another allowlisted root, or multi-folder organization.
- A new MCP tool, database table, migration, cache, worker, service, or dependency.
- Multi-employee workspace preferences.

## Complexity budget

- One root-list method on the existing Drive client.
- One small workspace-context module and focused tests.
- Small additions to the existing message dispatcher and cards.
- No new infrastructure or persistence.
- Target approximately 120–220 non-test production lines. Stop and explain the demonstrated requirement before exceeding 300 lines or adding a new architectural boundary.

## Verification commands

```bash
npm run typecheck
npm test
npm run test:integration
npm run doctor
git diff --check
```

During acceptance, `npm run doctor` must continue to report `write_enabled: false`.

Automated verification on 2026-08-11:

- `npm run typecheck`: passed.
- `npm test`: passed, 361 tests.
- `npm run test:integration`: passed, 4 tests.
- `npm run doctor`: passed with `write_enabled: false`.
- `git diff --check`: passed.
- Simplification review: the production change remains within the 300-line stop boundary and adds no new infrastructure.

## Live Lark acceptance

1. [x] Send `Hello` as Victor.
2. [x] Verify the welcome card names `My Folders / Test_Synvo_AI_Assistant`.
3. [x] Verify it displays `test_directory_2` and `test_directory_3` as other folders.
4. [x] Click `Open workspace` and verify the configured folder opens.
5. [x] Send a semantic variant: `What is our current work directory?`.
6. [x] Verify the assistant understands the question and answers with the configured active workspace. The classifier receives only the sanitized utterance; workspace metadata is resolved afterward by the backend.
7. [x] Ask to organize `test_directory_2` by name and verify the assistant still requests its exact link and starts no workflow.
8. [x] Run one existing greeting, file-analysis, and link-free organize-folder smoke test.
9. [x] Confirm no Drive file or folder changed and the write switch remains disabled.

## Exit gate

Phase 12 is complete only when:

- Victor's top-level My Folders list is read through the existing OAuth grant with no recursive access.
- The configured root is matched by exact token and shown as the active workspace.
- The welcome card and current-folder question both use verified workspace context.
- Other folder names remain read-only information and do not expand the organizer allowlist.
- NVIDIA receives only the bounded sanitized utterance for current-workspace classification; it receives no tools, links, tokens, folder names, or Drive data.
- No new persistence, MCP tool, worker, service, dependency, or write capability exists.
- All automated checks and live acceptance steps pass with writes disabled.
