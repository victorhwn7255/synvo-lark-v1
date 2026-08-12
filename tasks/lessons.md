# Synvo AI Assistant: Engineering Lessons

This document records mistakes and near-misses from building the Synvo AI Assistant, why they mattered, how we corrected them, and the rule that should prevent a recurrence.

It is not a blame log or a phase history. It is a practical engineering playbook. When a new incident matches an existing pattern, improve the existing lesson instead of adding a duplicate.

## How to use this document

Before designing or merging a workflow:

1. Read the relevant lessons and checklists below.
2. Define the exact provider boundary, mutation boundary, and verified outcome.
3. Prefer one small end-to-end loop over speculative infrastructure.
4. Treat the Lark UI and actual provider state as separate systems.
5. Do not call a phase complete until the live Lark loop has passed.

## Permanent principles

- **One invariant, one home.** Validate provider data when it enters the system. Trust typed internal data afterward.
- **One operation, one owner.** One component owns retries, state transitions, delivery, and terminal UI updates for an operation.
- **One process owns the Lark connection.** Never run two assistant instances against the same app and database.
- **Provider state is authoritative.** A card, local database row, or visible Drive tree is not proof that a provider mutation succeeded.
- **Every mutation is bounded and verified.** Check the actor, tenant, root, exact targets, scopes, write switch, approval, and observed final state.
- **Every asynchronous card reaches a terminal state.** Success, rejection, cancellation, failure, and undo must update the exact progress card.
- **The model proposes; deterministic code decides.** Models may classify intent or propose a plan. They never choose arbitrary functions, supply provider identifiers, approve work, or bypass safeguards.
- **Simplicity is a production feature.** New layers, tables, validators, queues, and abstractions require a demonstrated current need.
- **A console permission is not an OAuth grant.** Inspect the actual user's granted scopes before starting work.
- **Acceptance fixtures are not runtime invariants.** Tests may expect four files or two folders; production code must not.

---

## 1. We planned a Wiki mutation workflow before validating Victor's permissions

**Mistake**

The first `/organize-wiki` plan assumed that Victor could create or reorganize a Lark Wiki space. In reality, he had view-only Wiki access and could create files and folders only in My Space Drive.

**Why it was wrong**

The plan, tool names, permission model, and expected mutations were based on a provider surface that was not available to the pilot user. Continuing would have produced infrastructure with no executable acceptance loop.

**How we fixed it**

We changed the active pilot from Wiki to a bounded My Space Drive folder, first named `Test_Synvo_AI_Assistant` and later renamed `Synvo_Wiki`. The Wiki plan was archived and the executable plan became Drive-based.

**Lesson**

Before drafting a workflow, verify in the real provider UI:

- the user can see the target;
- the user can perform the intended mutation manually;
- the API exposes the required operation;
- the app and user grant can receive the required scope;
- a disposable acceptance fixture exists.

Plan future targets separately from the active, executable pilot.

## 2. We confused Lark product surfaces and authorization layers

**Mistake**

We sometimes treated Wiki, My Document Library, My Space Drive, app permissions, app availability, tenant tokens, and user OAuth grants as if they were interchangeable.

**Why it was wrong**

Each surface has different APIs, tokens, capabilities, and review requirements. The app being approved for a scope does not mean Victor's existing refresh token contains that scope.

**How we fixed it**

We separated:

- Lark app release and admin scope approval;
- bot event permissions using tenant credentials;
- Victor's Drive access using a user OAuth grant;
- the configured root folder token from its mutable display name.

When folder creation failed in Phase 15, we inspected the real grant and required fresh OAuth authorization for `space:folder:create` rather than trusting the developer-console status.

**Lesson**

Every provider operation must declare:

1. which API it calls;
2. whether it uses a tenant or user token;
3. the exact required scopes;
4. whether the current persisted grant actually contains them;
5. whether a new app release or fresh user authorization is required.

Run this preflight before queuing an operation, not after approval.

## 3. We requested broad future permissions to avoid repeated reviews

**Mistake**

We requested a large set of read and write scopes for hypothetical future workflows so that manager approval would not be needed again.

**Why it was wrong**

This enlarged the app's potential blast radius and made consent harder to explain. It also did not eliminate future OAuth work: an already-stored user grant still needs reauthorization when newly used scopes are absent.

**How we fixed it**

Runtime workflows remain explicitly allowlisted and guarded even when the app has broader console scopes. Write operations require deterministic code, an exact proposal, user approval, an operator switch, and provider verification.

**Lesson**

Request enough scope for a clearly planned release horizon, not every imaginable workflow. More importantly, enforce least capability in code even when the provider grant is broader.

## 4. We treated an environment flag as a safety control before enforcing it

**Mistake**

Adding `ORGANIZE_FOLDER_WRITE_ENABLED=false` to `.env` was initially treated as sufficient.

**Why it was wrong**

An unused configuration value changes nothing. Any write path that does not load, validate, and check the flag can still mutate provider state.

**How we fixed it**

The backend loads and validates the boolean, exposes it through startup/doctor diagnostics, and checks it at the mutation boundary. Approval may be recorded while execution remains disabled.

**Lesson**

A safety switch is real only when:

- startup rejects malformed values;
- every write path checks it immediately before mutation;
- tests prove both enabled and disabled behavior;
- operators can see its current state;
- it defaults to false outside a controlled write window.

Leaving the switch permanently true is convenient but increases risk. Prefer enabling it for an authorized operation and restoring it to false afterward.

## 5. We allowed one-time OAuth links and provider errors to produce confusing dead ends

**Mistake**

The first authorization link appeared to do nothing, and a second click produced “Authorization link unavailable.” Later, callbacks displayed only the generic “Authorization was not completed.”

**Why it was wrong**

The user could not distinguish an expired request, consumed request, state mismatch, token-exchange error, wrong account, or provider failure. Retrying from the UI was unsafe and confusing.

**How we fixed it**

OAuth requests became bounded, durable, one-time state transitions with state/PKCE checks, requester and tenant binding, safe error categories, refresh-token persistence, and clear instructions to start a new request when necessary.

**Lesson**

Consume one-time state only at the correct transition. Log safe provider error categories, never secrets. The user-facing error should say whether to retry, reauthorize, use the correct account, or contact an admin.

## 6. We ran more than one backend instance

**Mistake**

At different points Docker and `npm run dev`, or multiple local Node processes, competed for port 3000 and the Lark persistent connection. This produced `EADDRINUSE`, replayed events, and duplicated cards.

**Why it was wrong**

Two consumers can race to claim the same events or delivery jobs. Lark may replay events after reconnect, so multiple live consumers magnify duplicates and make debugging misleading.

**How we fixed it**

We clarified that Docker provides PostgreSQL while one Node.js process runs the assistant. The backend durably claims inbound message IDs, ignores replays and stale reconnect events, and logs those decisions.

**Lesson**

Before starting development:

1. check `/health` or `lsof -iTCP:3000 -sTCP:LISTEN`;
2. stop the existing assistant process if necessary;
3. start exactly one backend;
4. do not restart it during an active mutation job.

“Ignored replayed direct message” and “ignored stale direct message after reconnect” are expected safeguards. A growing number of new cards is not.

## 7. We restarted or retried while durable work was still queued

**Mistake**

We restarted the backend and generated new proposals while earlier analysis or execution jobs were still pending or running.

**Why it was wrong**

This created ambiguous recovery states, duplicate work, and “organization needs attention” results with zero moved files. Retrying without clearing or resolving the exact failed operation obscured the real provider error.

**How we fixed it**

We inspected and cancelled exact queued jobs before retrying, fixed folder-creation authorization, and made delivery/execution state durable and idempotent.

**Lesson**

Never “clear the global queue.” Cancel or resolve the exact job, proposal, user, tenant, and chat. Before retrying:

- identify the current job state;
- determine whether any provider mutation was observed;
- reconcile partial state;
- repair the root cause;
- create a new proposal only when the previous snapshot is terminal.

## 8. We hard-coded a four-file, two-folder pilot as if it were the product

**Mistake**

The early organizer expected exactly two folders, four root PDFs, and Product/Research classification based partly on filename prefixes.

**Why it was wrong**

After a successful move, the root correctly contained zero PDFs, but the next scan reported a baseline failure. The implementation could not generalize to neutral filenames or real workspaces.

**How we fixed it**

We removed filename prefixes, added content-aware classification, generalized the knowledge inventory, and implemented a Phase 15 workspace proposal that accounts for every eligible PDF and proposes a bounded taxonomy of two to six folders.

**Lesson**

Keep fixture assertions in acceptance tests. Runtime rules should validate safety properties, not fixture counts. Label pilot shortcuts clearly and remove them before calling a workflow complete.

## 9. We almost let the model become the execution authority

**Mistake**

As natural-language routing and content-aware organization grew, it was tempting to let the LLM choose functions, URLs, provider identifiers, folder operations, or approvals.

**Why it was wrong**

Model output is probabilistic and untrusted. It must not define the mutation boundary or manufacture provider arguments.

**How we fixed it**

NVIDIA performs bounded intent classification, summarization, question answering, and organization proposals. Deterministic backend code extracts links locally, resolves allowlisted tokens, validates structured output, enforces the folder-count range, creates proposals, records approval, and performs verified mutations.

**Lesson**

Use models for semantic judgment. Use code for authority. Never execute a model-generated function name, URL, token, mutation, approval, or arbitrary argument.

## 10. We relied on exact sentence matching for human requests

**Mistake**

Questions such as “Which folder are we at now?” and “Please organize test_directory_2” initially failed because routing expected narrow phrases or explicit slash commands.

**Why it was wrong**

Synvo employees communicate in natural language. Exact matching produced a brittle, robotic experience and pushed implementation details into the UI.

**How we fixed it**

We introduced bounded NVIDIA intent classification with explicit deterministic dispatch. Current-workspace questions, knowledge refresh requests, file analysis, and organize-workspace requests accept natural paraphrases. Explicit commands remain operational fallbacks.

**Lesson**

Natural-language understanding belongs at the input boundary, but authorization remains deterministic. Discovering that another folder exists does not authorize it; non-active folders still require an exact verified link or explicit workspace-selection flow.

## 11. We routed greetings and unrelated messages into RAG

**Mistake**

Messages such as “hey there” produced “Searching workspace knowledge…” cards and sometimes repeated searches.

**Why it was wrong**

It wasted provider calls, increased latency, and made the assistant feel unable to distinguish conversation from work.

**How we fixed it**

Local deterministic handling recognizes obvious greetings and help. The model classifies ambiguous work requests. A RAG progress card is sent only after classification confirms a workspace-knowledge question.

**Lesson**

Use the cheapest correct route:

1. explicit commands and card actions;
2. safe local signals such as greetings and links;
3. bounded intent classification;
4. only then start a long workflow or RAG search.

## 12. We displayed progress as decoration rather than real state

**Mistake**

Some cards displayed static text such as “2 chunks created” or “Embedding chunks: 0 of 1 batches,” regardless of actual extraction and embedding progress.

**Why it was wrong**

False progress is worse than no progress. It makes failures and rate limits harder to diagnose and erodes user trust.

**How we fixed it**

Knowledge progress now derives from actual file, chunk, batch, and completion state. The same card is updated as work advances. Exact-job stop and resume preserve completed files and continue only the remainder.

**Lesson**

Progress UI must be a projection of persisted operation state. If precise progress is unavailable, show an honest indeterminate state rather than invented numbers.

## 13. We created asynchronous cards without guaranteed terminal updates

**Mistake**

Approve/Reject buttons initially produced no chat response. Later, “Approved — organizing the workspace…” remained visible after a separate success card appeared.

**Why it was wrong**

The user could not tell whether a click was received or whether work had finished. Sending a new terminal card does not complete the lifecycle of the original progress card.

**How we fixed it**

We configured and published Lark card callbacks, acknowledged actions immediately, and added durable storage for the exact operation message ID. The worker now updates that message to success or failure. Repeated actions are idempotent and receive a clear response.

**Lesson**

For every interactive asynchronous card:

- publish and verify the callback subscription;
- acknowledge the click immediately;
- persist the exact Lark message ID;
- update that same card while work runs;
- replace it with a terminal success, rejection, stopped, failure, or undo state;
- test repeated and conflicting clicks.

## 14. We assumed we could control Lark UI behavior that the API does not expose

**Mistake**

We considered blocking chat during work, forcing the Drive tree to refresh, customizing Lark's native upload popup, and adding animations beyond supported message-card behavior.

**Why it was wrong**

Those controls belong to the Lark client, not our app. Promising them confuses provider UI state with backend capability.

**How we fixed it**

We use supported interactive cards, dynamic message updates, progress images, buttons, and verified backend status. We instruct users to reopen or refresh Drive when its visible tree is stale.

**Lesson**

Confirm a Lark client capability exists before designing around it. When it does not, provide honest progress, idempotency, and provider-state verification rather than simulating control.

## 15. We made user-facing cards too verbose and exposed implementation language

**Mistake**

Cards included phrases such as “provider-consent review,” repeated zero counts, raw proposal IDs, long filename lists, and operational wording that was meaningful to developers but not employees.

**Why it was wrong**

The primary users are humans trying to finish work, not debug OAuth or state machines. Important actions became harder to find, and large proposals risked truncation.

**How we fixed it**

We rewrote cards in plain language, hid zero-only sections, listed filenames only when actionable, added buttons instead of requiring slash commands, reduced visual spacing, and separated answer text from smaller grey citations.

**Lesson**

Every card should answer:

1. What is happening?
2. Does the user need to act?
3. What changed?
4. What is safe to do next?

Keep internal IDs and diagnostics in logs unless the user needs them for support. Paginate or summarize large proposals.

## 16. We coupled knowledge identity to visible file location

**Mistake**

Early RAG behavior treated the flat root path as the knowledge boundary and risked reprocessing files after a rename or move.

**Why it was wrong**

A Drive path is mutable metadata. Re-embedding unchanged content wastes time and rate limit, while citations become stale after organization.

**How we fixed it**

Phase 14 recursively discovers PDFs beneath the approved workspace, identifies unchanged content, updates moved or renamed paths without re-embedding, and removes unavailable sources only after a complete scan and final absence verification.

**Lesson**

Separate:

- stable source identity and content digest;
- mutable folder path and display name;
- extracted chunks and embeddings;
- citation metadata.

Moving an unchanged source should update metadata, not recompute meaning.

## 17. We showed noisy reconciliation information

**Mistake**

The review card always displayed “Sources no longer in the folder: 0.”

**Why it was wrong**

It occupied attention without giving the user an action or risk to review.

**How we fixed it**

Zero-count sections are hidden. When removals exist, the card says “Sources to remove from knowledge” and lists the exact paths.

**Lesson**

Show zero only when zero is an important safety result. Otherwise, display only actionable changes.

## 18. We duplicated provider retries and amplified rate limits

**Mistake**

Voyage failures were retried by more than one layer. A five-file refresh produced repeated `VOYAGE_TEMPORARY` and `VOYAGE_RATE_LIMITED` failures.

**Why it was wrong**

Nested retries multiply traffic, extend latency unpredictably, and worsen the very rate limit they are trying to recover from.

**How we fixed it**

One layer owns provider retries, batching, backoff, and terminal classification. Completed files remain committed so a later refresh resumes from remaining work.

**Lesson**

Each external call has one retry owner. Honor provider hints, cap attempts, add jitter, persist progress between files, and never let the delivery worker and provider client both retry the same request independently.

## 19. We let internal citation labels leak into employee answers

**Mistake**

RAG answers displayed internal prompt labels such as `[S4†L1-L4]`.

**Why it was wrong**

Those labels are implementation details, confuse users, and expose the prompt's evidence encoding rather than a usable source citation.

**How we fixed it**

The provider boundary validates and normalizes the model response. The backend maps retrieved evidence to stable Drive path and page citations and prevents internal labels from reaching Lark.

**Lesson**

Citation rendering is backend-owned. The model may refer to bounded evidence, but only validated source IDs that map to retrieved chunks may appear in the final answer.

## 20. Our retrieval initially underperformed on cross-document questions

**Mistake**

A question comparing Cocoa Assistant requirements with the IT Security Baseline initially returned insufficient evidence even though both files were indexed.

**Why it was wrong**

Pure global similarity can fill the evidence budget with chunks from one source. Cross-document synthesis requires source diversity as well as relevance.

**How we fixed it**

We improved retrieval and acceptance testing so multi-source questions can surface evidence from both documents. The successful response cited both paths.

**Lesson**

RAG acceptance must include:

- a fact question from one source;
- a question from a nested path;
- a cross-document comparison;
- an unsupported question that must abstain;
- rename/move reconciliation;
- deletion and re-add behavior.

Do not evaluate RAG quality only with single-document lookups.

## 21. We called a placeholder test harness an evaluation system

**Mistake**

An early RAG “evaluation” harness did not measure retrieval or answer quality against a real corpus and ground truth.

**Why it was wrong**

The name implied evidence of quality that the code did not provide. Passing it could create false confidence.

**How we fixed it**

We removed or honestly renamed placeholder checks and used explicit live acceptance questions with verified citations and abstention behavior.

**Lesson**

Do not call a script an evaluation unless it has defined cases, expected evidence, scoring, and failure thresholds. Honest smoke tests are useful; mislabeled benchmarks are not.

## 22. We initially defined undo more narrowly than users expected

**Mistake**

Phase 15 undo restored all 15 PDFs to their original parent but deliberately left the newly created empty folders in place.

**Why it was wrong or incomplete**

The behavior is safe and was reported accurately, but “Undo file moves” can reasonably be interpreted as restoring the entire organization operation. The implementation contract and user expectation were not fully aligned.

**How we handled it**

The card explicitly reports that files were restored and lists the created folders left in place. No folder is deleted automatically without proving it was created by the exact proposal and is still empty.

**Lesson**

Define rollback semantics before implementation:

- **Move undo:** restore exact original parents and verify them.
- **Full organization rollback:** additionally delete only folders created by that proposal, after verifying their token, parent, ownership, and emptiness.

Never delete pre-existing or non-empty folders in the name of undo. Button text must match the implemented scope.

## 23. We over-defended boundaries we already controlled

**Mistake**

The code accumulated duplicate Zod parsing of internal typed results, repeated pagination validation, encrypted non-sensitive authorization prompts, redundant database reads, and validation on both sides of an internal boundary.

**Why it was wrong**

Each layer looked individually “safe,” but together they increased code size, branching, and maintenance risk without addressing a distinct threat.

**How we fixed it**

We validated provider responses once, replaced internal runtime schemas with TypeScript unions where appropriate, centralized invariants, removed unused fields and queries, and simplified recovery paths.

**Lesson**

Defensive code also spends the complexity budget. Encryption, sanitization, validation, and retry logic require a specific threat or failure sentence. If an invariant is already enforced at the owned boundary, move it there; do not copy it.

## 24. We designed structures around phases rather than stable responsibilities

**Mistake**

Folders and modules used names such as `phase3`, `drive-round-trip`, and `assistant-backend`, while the database and source tree accumulated layers for anticipated future work.

**Why it was wrong**

Phase names expire, obscure product responsibilities, and encourage permanent scaffolding for temporary acceptance work.

**How we fixed it**

The application became `synvo-assistant`; HTTP files were flattened; MCP received a clear module boundary; workflows, Lark adapters, delivery, database code, and knowledge code are named by responsibility. Database tables and fields were reduced to durable requirements.

**Lesson**

Name production code for the capability it owns, not the phase that introduced it. Acceptance-only code should be deleted or clearly isolated when the phase closes.

## 25. We misunderstood MCP as the application architecture

**Mistake**

We initially discussed putting skills and workflows “inside MCP” and considered routing the assistant through its own MCP server.

**Why it was wrong**

MCP is a transport adapter that exposes reusable tools to external agents. It is not the workflow engine, model router, authorization system, or place where product skills must live.

**How we fixed it**

The Synvo Assistant calls its application capabilities directly in-process. The authenticated `/mcp` endpoint exposes only proven reusable read-only tools such as folder listing and Drive-file analysis to external agents.

**Lesson**

Build the capability once in application code. Add a thin MCP adapter only when an external agent needs it. Keep actor identity fixed by authentication, not supplied in tool arguments, and do not expose write tools before their authorization contract is proven.

## 26. We allowed documentation to drift and grow beyond its usefulness

**Mistake**

Old plans remained active-looking, an archived Wiki plan grew very large, and AGENTS source-ownership descriptions sometimes diverged from the actual tree.

**Why it was wrong**

Agents and developers act on stale documentation. More documentation is not better when it contradicts the executable system.

**How we fixed it**

Completed or superseded plans moved to `tasks/archive`, obsolete material was removed, active plans were updated, and AGENTS/README descriptions were condensed.

**Lesson**

Every phase exit must verify:

- one active executable plan;
- archived plans clearly marked historical;
- AGENTS source ownership matches the tree;
- README describes current commands and behavior;
- no obsolete phase scaffolding remains in production code.

## 27. We ran integration tests against shared live state

**Mistake**

A live worker could claim the same development-database jobs used by the integration test, causing nondeterministic failures even when unit tests passed.

**Why it was wrong**

Tests and the running app competed for durable queue rows. A failure could reflect interference rather than product behavior.

**How we fixed it**

The integration suite uses an isolated temporary PostgreSQL database. Environment-specific sandbox failures, such as local socket restrictions, are distinguished from code failures.

**Lesson**

Never run destructive or queue-sensitive integration tests against the active development database. Give tests isolated database state, unique job identity, and deterministic time. Report infrastructure failures separately from assertion failures.

## 28. We sometimes declared phases complete before the live loop passed

**Mistake**

Code and unit tests were occasionally described as “production ready” before OAuth, Lark cards, provider calls, mutation verification, or undo had passed in the real client.

**Why it was wrong**

The most important failures occurred at integration boundaries: unpublished Lark configuration, stale grants, provider rate limits, replayed events, callback behavior, and provider-state verification.

**How we fixed it**

Later phases used explicit live acceptance gates: disposable non-sensitive documents, consent for external providers, read-only proposal, exact approval, verified execution, path reconciliation, verified undo, and post-operation database checks.

**Lesson**

“Implemented” means code exists. “Verified” means automated tests pass. “Loop closed” means the live user journey reached a verified outcome. “Production ready” additionally requires deployment, monitoring, secrets, retention, concurrency, and operational ownership. Do not use these labels interchangeably.

## 29. We selected providers from showcase pages without treating endpoint limits as operational requirements

**Mistake**

Free NVIDIA NIM and Voyage endpoints were initially discussed mainly in terms of model capability.

**Why it was wrong**

Free endpoints may be deprecated, throttled, rate-limited, or unsuitable for sensitive production data. A larger model is not automatically the best everyday model.

**How we fixed it**

We chose a primary text model and separate multimodal specialist based on workload, added bounded calls, provider error categories, batching, retries, and explicit consent for acceptance documents.

**Lesson**

Model selection must include latency, tool/JSON reliability, context limits, rate limits, data handling, retention, cost, availability, and fallback policy—not only benchmark strength.

## 30. We risked purging knowledge before proving provider deletion

**Mistake**

When designing “remove this file,” it was tempting to remove embeddings/chunks and delete the Drive file as one loose action.

**Why it was wrong**

If knowledge is purged first and Drive deletion fails, the source still exists but is no longer searchable. Broad filename matching could also delete the wrong file.

**How we fixed or constrained it**

Destructive removal is designed as an exact, separately confirmed operation: resolve one source inside the approved workspace, verify token/path/actor/scope/write switch, delete or recycle the Drive object, verify provider absence, then purge its knowledge rows.

**Lesson**

For cross-system destructive operations, order steps so failures remain recoverable. Never delete by ambiguous name, never use model-selected identifiers, and never purge the index before verifying source deletion.

---

## Review checklists

### Before adding or changing a Lark workflow

- [ ] The real user can perform the action manually in the intended Lark surface.
- [ ] The exact API, token type, and scopes are documented.
- [ ] The persisted user grant—not just the app console—contains the scopes.
- [ ] Lark configuration changes have been published in a released version.
- [ ] Event or card callbacks are configured and verified.
- [ ] Replay, stale-event, and repeated-click behavior is defined.
- [ ] Every asynchronous card has a persisted message ID and terminal state.
- [ ] Provider-state verification defines success.

### Before adding a mutation

- [ ] The target is inside the approved root and tenant.
- [ ] The exact actor and OAuth grant are bound.
- [ ] The write switch is enforced at the mutation boundary.
- [ ] The proposal snapshot still matches current provider state.
- [ ] Approval is exact, durable, idempotent, and unexpired.
- [ ] Every mutation has a postcondition read and safe error result.
- [ ] Partial execution and restart recovery are defined.
- [ ] Undo semantics and limitations are stated before execution.

### Before changing RAG ingestion or retrieval

- [ ] Source identity is separate from mutable path metadata.
- [ ] Unchanged content skips extraction and embedding.
- [ ] Moved or renamed content updates citations without re-embedding.
- [ ] Deletion requires a complete successful scan and final absence check.
- [ ] One layer owns provider retries.
- [ ] Progress comes from real persisted state.
- [ ] Stop affects only the exact job; completed files remain usable.
- [ ] Internal evidence labels cannot leak to users.
- [ ] Tests cover single-source, nested-source, cross-source, and abstention cases.

### Before calling a phase complete

- [ ] Typecheck, lint, unit tests, migration checks, and isolated integration tests pass.
- [ ] The live Lark UI journey passes from request to terminal card.
- [ ] External-provider consent and non-sensitive fixtures are confirmed.
- [ ] Database state matches the reported result.
- [ ] Provider state matches the reported result.
- [ ] Repeat, rejection, cancellation, failure, restart, and undo paths are tested as applicable.
- [ ] The active plan and AGENTS/README match the actual tree and behavior.
- [ ] A small simplification pass removed unneeded code added during the phase.

## How this file should evolve

Add a lesson only when it changes a future engineering decision. Each lesson must contain:

1. the observed mistake or near-miss;
2. the concrete harm or risk;
3. the correction actually made;
4. a reusable prevention rule;
5. a checklist or test when automation can prevent recurrence.

When a failure repeats, strengthen the existing rule or automate it. Do not merely document the same mistake twice.
