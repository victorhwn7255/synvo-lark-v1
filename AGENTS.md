# Synvo Lark Assistant

## Project vision

Build a trusted, AI-powered work assistant inside Lark for the Synvo AI team.

The assistant turns natural-language requests into permission-aware, bounded workflows powered by GPT or Codex capabilities.
It can retrieve authorized company knowledge, analyze repositories, create content, and execute approved operational or engineering tools.
It returns useful, verified outcomes inside Lark so team members do not need to leave their normal workspace.

The long-term goal is to turn Lark from a communication tool into an AI-enabled workspace for Synvo AI.
The immediate goal is not to build a general-purpose agent platform.
The immediate goal is to prove one valuable, reliable, end-to-end workflow.

## Product principles

- Lark is the primary user interface.
- Natural language is the primary input method.
- Lark messages, interactive cards, and embedded web views are the primary output surfaces.
- Each workflow has an explicit contract, bounded tools, bounded permissions, and a verifiable outcome.
- Models reason and propose.
- Deterministic application code authorizes, validates, executes, and verifies.
- Consequential actions require clear human approval.
- The assistant must preserve the requesting user's access boundaries.
- Reliability and trust are more important than the number of available workflows.

## MVP delivery strategy: close the loop

Develop the product through a small number of complete, end-to-end workflows.

We call this "closing the loop."
A workflow is closed only when it reliably handles the full journey from user request to verified outcome, including safe failure and recovery paths.

The standard lifecycle is:

1. Receive the request in Lark.
2. Acknowledge it immediately.
3. Resolve the user, requested scope, and permissions.
4. Gather only the required context.
5. Produce a bounded plan or result.
6. Show the user what will happen.
7. Obtain explicit approval for consequential actions.
8. Execute through allowlisted tools.
9. Verify the resulting external state.
10. Report success, partial success, or failure clearly.
11. Offer recovery or undo where practical.
12. Record an audit trail and lightweight user feedback.

Do not add another major workflow until the active workflow meets its definition of done reliably.
Do not build speculative orchestration, plugin, memory, or agent infrastructure without a requirement from the active workflow.

## Current implementation status

The first messaging micro-loop is complete.
The Phase 2 OAuth and read-only Drive inventory code is implemented locally, but Phase 2 has not passed its live Lark exit gate.

- A custom Lark App Bot named `Synvo AI Assistant` exists in the Synvo tenant.
- The released pilot version is available only to Victor.
- Direct-message receive and bot-send scopes are enabled.
- The `im.message.receive_v1` event is delivered through a persistent connection.
- The TypeScript backend receives `/ping` and replies `pong` inside Lark.
- `/organize-folder <drive-folder-link>` parsing, exact root allowlisting, OAuth state and PKCE handling, encrypted token persistence and refresh, PostgreSQL workflow state, and a bounded read-only Drive MCP tool are implemented.
- The loopback-only Docker PostgreSQL development service is healthy, and both versioned Phase 2 database migrations are applied.
- Durable event-inbox and encrypted delivery-outbox workers use bounded leases, retries, and stale-attempt guards.
- Scan runs use bounded leases and encrypted cached terminal results so an interrupted scan can recover without widening its Drive access.
- Retryable scan failures release the run for a fresh claim, while retry exhaustion produces a generic encrypted no-change message and terminal run state.
- Root and destination contents are reconciled before success, and untrusted Lark display values are sanitized before Lark rendering.
- `npm run typecheck` passes.
- The default unit and contract suite discovers 237 tests, and all 237 pass.
- The separate Docker-backed PostgreSQL integration suite discovers five tests, and all five pass against the migrated local database.
- A verified local backend run reported `status: ok`, Phase 2, and read-only Drive mode while its persistent Lark connection was ready.
- The redacted `npm run verify:phase2-live` exit verifier is implemented and currently reports `pending` with `NO_LIVE_RUN`, which is the expected pre-OAuth state.
- The safe `npm run pin:phase2-identity` bootstrap helper is implemented and currently reports `pending` with `NO_VERIFIED_RUN`; after a verified bootstrap delivery, it will atomically pin the matching identity pair without printing it.

The live Phase 2 gate still requires the three read-only user scopes, the exact OAuth redirect, a restricted app release and any required tenant-admin approval, and Victor's initial OAuth consent.
After that bootstrap run, pin the verified Victor and Synvo tenant identity pair in private configuration without printing it, restart the backend, and run the inventory again with the static allowlist active.
Phase 2 closes only after the pinned rerun visibly returns the exact two-folder and four-file inventory in Lark and `npm run verify:phase2-live` returns `pass` with exit code `0`.
Do not claim live OAuth, live Drive access, or Phase 2 completion until that gate passes.
GPT analysis, approval cards, file moves, write verification, and undo remain unimplemented future phases.

## Active implementation pilot: `/organize-folder`

The active executable plan is `tasks/organize-folder-implementation-plan.md`.
The archived Wiki plan remains historical reference material only.

### Why the active pilot uses My Space Drive

Victor can view Synvo Wiki spaces but cannot create or reorganize Wiki nodes.
A workflow that requires Wiki mutations therefore cannot currently close its loop.

Victor owns a writable My Space Drive sandbox named `Test_Synvo_AI_Assistant`.
The active pilot uses that sandbox to prove the trusted workflow mechanics against real Lark reads and writes.

Closing the Drive pilot proves the shared organizer mechanics.
It does not close, certify, or replace `/organize-wiki`.

### User contract

`/organize-folder <drive-folder-link>` analyzes one authorized and allowlisted Lark My Space folder, shows its current organization, proposes moving eligible files into existing approved destination folders, applies only the exact moves approved by the requesting user, verifies the resulting parent folders, records an audit trail, and offers best-effort undo.

The first user-visible result may use a Lark text message or card.
An embedded visualization is optional until the workflow mechanics are closed.

### Pilot sandbox contract

The first sandbox is:

```text
My Folders/
└── Test_Synvo_AI_Assistant/
    ├── Product/
    ├── Research/
    └── four labeled PDF fixtures in the root
```

The pilot is deliberately narrow:

- The exact sandbox root folder is allowlisted by an internal folder token.
- The exact root token is present only in ignored local secret configuration and must never be documented or logged.
- The command link must resolve to that exact root.
- Only Victor is an authorized live pilot user initially.
- The app release is restricted to Victor for this pilot.
- Only direct file children of the root are move candidates.
- Only the existing `Product` and `Research` direct child folders are approved destinations.
- Both destination folders are confirmed empty at the starting baseline.
- The four PDF fixtures are confirmed disposable test copies.
- PDF bodies must not be opened, downloaded, retained, or sent to a model during the metadata-only plumbing phases.
- `ORGANIZE_FOLDER_WRITE_ENABLED` must remain `false` throughout Phase 2.
- The workflow may inspect the root and those two destination folders for planning and verification.
- The workflow must not recursively traverse deeper folders during the first pilot.
- The workflow must never move a folder.
- The workflow must never create a destination folder automatically.
- The workflow must never leave the allowlisted root boundary.
- The workflow must skip unsupported, missing, stale, or inaccessible items.
- The workflow must abstain when no approved destination is sufficiently supported.

The following actions are out of scope:

- Renaming, deleting, copying, uploading, or rewriting files.
- Creating, renaming, deleting, or moving folders.
- Moving files into Shared Folders, another My Space root, or a Wiki space.
- Changing owners, collaborators, sharing settings, or permissions.
- Automatically applying every suggestion.
- Crawling all of My Space.
- Treating a successful Drive test as evidence that Wiki mutations work.
- Building a general-purpose organizer framework.
- Building a company-wide ontology or general graph database.

### Fixture and model modes

The four current PDF names begin with `[product]` or `[research]`.
Those prefixes are fixture labels, not evidence of model intelligence.

The implementation must distinguish these modes:

1. A deterministic plumbing mode may use the prefixes to prove list, proposal, approval, move, verification, and undo.
2. A GPT title-only mode must remove the label prefix from model-visible titles and retain the label only as the expected answer.
3. A future content-aware mode may read approved PDF content only after the narrower download scope and data-handling policy are enabled.

The four-file fixture is an integration smoke test.
It is not a statistically meaningful model-quality evaluation.

### Delivery stages

#### Stage 0: messaging foundation

- Receive a direct Lark message through the persistent connection.
- Parse an allowlisted command.
- Reply inside the same Lark conversation.
- Keep `/ping` as a permanent health check.

This stage is complete for the local connection spike.

#### Stage 1: user OAuth and read-only Drive inventory

- Authorize Victor through Lark OAuth.
- Bind the OAuth identity to the Lark bot requester.
- List the exact sandbox root and approved destination folders.
- Return a bounded metadata-only inventory inside Lark.
- Make no Drive changes.

The Stage 1 code is implemented locally.
The stage remains incomplete until the console, admin, OAuth, database, and live inventory checks pass.

#### Stage 2: one-file Drive capability spike

- Add the narrow move scope only after the read-only Stage 1 gate passes.
- Move one known PDF to one approved destination under a narrowly enabled write flag.
- Verify the observed destination.
- Move the same PDF back to the root.
- Verify the restored parent.

This future stage uses deterministic code and no GPT.

#### Stage 3: read-only folder map and proposal

- Build a complete bounded snapshot of the pilot root and destination folders.
- Show exact folder and file relationships.
- Report every visible skipped or unsupported item.
- Generate a structured proposal using only allowlisted destinations.
- Show every suggestion as `current parent -> proposed parent`.
- Include confidence, evidence, content mode, and a short explanation.
- Make no changes.

#### Stage 4: exact approval, apply, verify, and undo

- Let the user select or reject individual moves.
- Require a separate confirmation of the exact selected move set.
- Re-read every source and destination before the first write.
- Re-check the approving user's identity and authorization.
- Require the pilot root, every source, and every destination to remain owned and manageable by the approving OAuth user.
- Reject the whole batch if a source metadata digest or destination identity digest differs from the approved snapshot.
- Execute only selected moves that remain valid.
- Verify the observed parent folder of every attempted file.
- Stop safely on unexpected or ambiguous outcomes.
- Report succeeded, failed, unknown, and untouched operations separately.
- Offer a separately reviewed and approved undo.
- Verify every undo operation.

The active pilot is not closed until Stage 4 works reliably.

## Resource-specific terminology

Use Lark Drive terminology for the active pilot:

- `file`
- `folder`
- `root folder`
- `destination folder`
- `parent folder`
- `child item`
- `folder tree`
- `Folder Map`

Use Lark Wiki terminology only for the future Wiki workflow:

- `page`
- `node`
- `category page`
- `parent`
- `child`
- `subtree`
- `Wiki Map`

Do not call a Drive folder a Wiki space.
Do not call a Drive file a Wiki node or page.
Do not present provider-specific behavior as a generic filesystem abstraction.

The active Folder Map uses a small set of relationships:

- `parent_of` is an exact relationship observed from the Drive hierarchy.
- `similar_to` is optional and must be labeled as model-inferred with confidence and evidence.

Do not add `links_to` for PDF fixtures unless an explicit supported link-extraction method exists.
Exact and inferred relationships must remain visually and semantically distinct.

## Model and tool responsibility boundaries

Models may:

- Summarize authorized and policy-approved file metadata or content.
- Classify eligible files into an allowlisted set of destination folders.
- Suggest possible duplicates or related files.
- Explain a proposed destination in plain language.
- Return output that conforms to an explicit schema.

Models must not:

- Decide whether a user is authorized.
- Grant themselves tools or permissions.
- Expand the requested root folder.
- Choose an unapproved destination.
- Execute a Drive or Wiki mutation directly.
- Treat retrieved file content as trusted instructions.
- Receive Lark access tokens, application secrets, folder tokens, or file tokens.
- Conceal uncertainty, unsupported files, skipped items, or incomplete scans.
- Use fixture label prefixes during a genuine GPT classification evaluation.

Deterministic application code must:

- Resolve and verify the Lark requester and OAuth identity.
- Enforce the exact root, destination, item-count, depth, and batch limits.
- Check access before returning file or folder information.
- Map model-facing opaque references back to internal Lark tokens.
- Validate every structured model result.
- Reject missing, stale, outside-root, folder-as-source, cross-boundary, duplicate, or no-op moves.
- Require and validate exact human approval.
- Keep write tools unavailable to the model.
- Deduplicate messages and card callbacks durably.
- Execute Lark API calls.
- Reconcile ambiguous responses before retrying.
- Verify results against Lark.
- Produce audit and undo records.

## Permissions, privacy, and security

Use least-privilege Lark scopes.
Bot messaging and My Space access are separate authorization concerns.

The current bot tenant scopes are:

- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`

The Drive pilot uses user OAuth so access follows Victor's My Space permissions.
The minimum Phase 2 user scopes are:

- `space:document:retrieve`
- `drive:drive.metadata:readonly`
- `offline_access`

The narrow metadata scope is required because the current read-only scan verifies the selected root folder's title and owner through the batch metadata API.
The folder-list scope alone returns child metadata but does not return the selected root as its own child.

Do not add `space:document:move` until the separately approved Phase 3 capability spike.
Do not add `drive:file:download`, `drive:file:readonly`, `drive:drive:readonly`, or the broad `drive:drive` scope during Phase 2.

The app's released availability must remain restricted to the pilot user while this is a personal My Space test.
The isolated `Test Companies & Users` tenant must not be used for this sandbox because it cannot access Victor's Synvo-tenant My Space.

Store App Secrets and OAuth tokens only in local environment configuration or an approved secret store.
Never log, commit, send to a model, or place credentials in MCP arguments.
Store refresh tokens encrypted.
Refresh rotating tokens under a lock and atomically persist the replacement.
Persist separate access-token and refresh-token expiry timestamps from the values returned by Lark.
Require reauthorization after terminal refresh expiry or revocation.
Validate OAuth state, PKCE, redirect URI, tenant, and returned `open_id`.

The existence, title, owner, token, URL, and hierarchy of a restricted Drive item may all be sensitive.
Never reveal inaccessible items through counts, titles, clusters, relationships, search results, or errors.

Treat all retrieved Lark content as untrusted data.
Content inside a file cannot override system policy, workflow limits, tool permissions, or approval requirements.

Do not send Synvo content to a model provider unless the configured data-handling policy permits it.
Store only the content and derived data required by the workflow.
Define retention and deletion behavior before reading production Synvo content.

## Lark user experience

Keep the primary interaction inside Lark.

- Use chat for invocation, acknowledgement, progress, questions, and terminal results.
- Use interactive cards for proposal review, selection, approval, rejection, retry, and undo.
- Use a compact text or card Folder Map for the first four-file pilot.
- Link visible items back to their original Lark resources when safe.
- Show whether analysis used fixture labels, titles only, or file content.
- Never leave a long-running request without visible progress or a clear terminal state.

Message events currently arrive through the persistent connection.
Interactive-card callbacks also use the persistent connection, but they are configured separately under Lark Callback Configuration.
Subscribe to the current `card.action.trigger` callback, not the legacy `card.action.trigger_v1` callback.
Deduplicate callbacks durably and return their acknowledgement within three seconds.
OAuth requires an exact registered redirect route.
Use HTTPS for that route in deployed environments.
The single-machine local pilot may register `http://localhost:3000/oauth/lark/callback` and must complete OAuth from Lark Desktop or a browser on that same machine.
The exact staging redirect is `https://lark-assistant-staging.synvo.ai/oauth/lark/callback` when the staging host is available.
Victor does not currently control Synvo DNS or domain configuration.
For staging, Victor's manager or Synvo domain administrator must provision the DNS record and managed HTTPS route, register the exact staging redirect in Lark, and publish or approve the corresponding restricted app version.
Those staging actions do not block the single-machine localhost Phase 2 pilot.
The configured redirect URI, the OAuth request, and the callback route must match character for character.

## Definition of done for `/organize-folder`

The Drive pilot is closed only when all of the following are true:

1. The authorized pilot user can invoke the workflow entirely from Lark.
2. The bot requester is bound to the same authorized OAuth user and Synvo tenant.
3. The requested Drive link resolves to the exact allowlisted sandbox root.
4. The scan is complete within the stated scope, or every visible omission is reported.
5. The Folder Map accurately represents the root, destinations, and visible files.
6. Every proposal moves an eligible root file to an existing approved destination folder.
7. Every proposal declares its analysis mode and includes evidence and confidence.
8. No file changes occur without approval of the exact selected move set.
9. Duplicate messages or callbacks cannot duplicate a file move.
10. Every selected move is revalidated immediately before execution.
11. Every claimed successful move is verified against the observed Lark parent folder.
12. Ambiguous API outcomes are reconciled before any retry.
13. Partial failures leave the sandbox in a known state and produce an actionable report.
14. Best-effort undo is separately approved, tested, and verified.
15. A second run against the correctly organized sandbox proposes zero moves.
16. Audit records identify the run, actor, root, plan, approvals, tool calls, results, and undo state.
17. Tests demonstrate that the workflow cannot inspect or move items outside the allowlisted root.
18. End-to-end tests pass against the dedicated My Space sandbox.
19. A deterministic fixture-label run moves and verifies all four files, returns `COMPLETED_NO_CHANGE` on rerun, and completes verified undo.
20. At least one nonempty prefix-hidden GPT title-only proposal completes exact approval, apply, verification, and undo for every selected suggestion that passes deterministic policy.
21. A GPT abstention is allowed, remains untouched, and is reported clearly rather than being forced into a destination.
22. The pilot user can provide feedback on suggestions and the completed run.

The live pilot currently has one authorized user.
Cross-user permission isolation must be covered by test doubles until a second authorized test user is available.
Passing test doubles alone does not establish multi-user production readiness.

Closing `/organize-folder` does not close `/organize-wiki`.

## Future production target: `/organize-wiki`

The long-term target remains:

`/organize-wiki <wiki-subtree-link>` analyzes an authorized Lark Wiki subtree, visualizes its organization, proposes a small set of page moves, applies only explicitly approved moves, verifies the resulting hierarchy, and supports audited best-effort undo.

The target combines:

1. A read-only Wiki Map for analysis and explanation.
2. A controlled Wiki organizer for approved structural changes.

The archived Wiki implementation plan is a future reference, not the active task plan.
The Wiki workflow is blocked until Synvo provides a writable non-production Wiki space or subtree and an authorized Wiki administrator or editor for mutation testing.

Drive pilot results may inform shared approval, audit, and state-machine code.
They do not validate:

- Wiki node traversal.
- Wiki object types and shortcuts.
- Wiki-specific permission filtering.
- Same-space and subtree policies.
- Wiki node move semantics.
- Wiki move verification.
- Wiki undo behavior.

The Wiki workflow requires its own provider-specific contracts, scopes, tests, and closure review.
Never report `/organize-wiki` as closed based on Drive evidence.

## Engineering guidance

- Build the smallest architecture required by `/organize-folder`.
- Prefer direct, typed workflow code over a general agent framework.
- Prefer explicit state machines and schemas over free-form autonomous planning.
- Keep workflow orchestration in `assistant-backend`, not inside the MCP server.
- Keep one `synvo-lark-mcp` server with an active Drive module and a future Wiki module.
- Keep the MCP endpoint private and authenticated to `assistant-backend`.
- Pass server-owned run or mutation-batch IDs across the MCP boundary, not OAuth tokens, actor IDs, native Drive tokens, or plaintext approval grants.
- Do not build a generic provider or plugin framework before real duplication exists.
- Use background jobs only where Lark deadlines or durable recovery require them.
- Make retries bounded and distinguish retryable failures from terminal failures.
- Make every internal write idempotent.
- Treat external Drive moves as non-idempotent until the observed state is reconciled.
- Persist original parent, approved destination, approving user, plan hash, request result, observed state, and undo result.
- Use the dedicated My Space sandbox for all active mutation tests.
- Use a dedicated writable non-production Wiki only for future Wiki mutation tests.
- Include unit tests for parsers, validators, state transitions, and policies.
- Include contract tests for Lark adapters and structured model output.
- Include end-to-end tests for approval, duplicate callbacks, partial failure, verification, no-op reruns, and undo.
- Preserve the existing `/ping` health check.
- Do not commit, push, or create pull requests unless the user explicitly requests it.

## Deferred workflows

Do not implement another major workflow until `/organize-folder` is closed or the project owner explicitly changes the priority.

The blocked `/organize-wiki` target is handled separately above.
Other deferred workflows include:

- `/summarize`
- `/ask`
- `/explain-repo`
- `/create-task`
- `/review-pr`
- `/investigate-ci`
- Patch or code generation
- Pull-request creation
- Unrelated production operations
- General-purpose autonomous agent behavior
- A company-wide semantic knowledge graph

After the active Drive loop is closed, choose the next workflow based on demonstrated Synvo team value and available permissions.
Do not choose work merely because it appears to justify reusable infrastructure.
