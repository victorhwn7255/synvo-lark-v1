import assert from "node:assert/strict";
import test from "node:test";

import { decryptDeliveryMessage } from "../../delivery/crypto.js";
import type {
  DeliveryJob,
  DeliveryQueue,
  InsertDeliveryJobInput,
} from "../../delivery/repository.js";
import { TokenCipher } from "../../lark/auth/index.js";
import type { KnowledgeSearchHit, KnowledgeSource } from "./repository.js";
import {
  KnowledgeWorkflow,
  type KnowledgeProgress,
} from "./workflow.js";
import {
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  KNOWLEDGE_MAX_EVIDENCE_CODE_POINTS,
  KNOWLEDGE_SEARCH_MIN_SIMILARITY,
  KNOWLEDGE_SEARCH_TOP_K,
} from "./policy.js";

class FakeQueue implements DeliveryQueue {
  inputs: InsertDeliveryJobInput[] = [];
  cancelRequested = false;
  cancellationChecks = 0;
  cancelAfterChecks: number | null = null;
  enqueue(input: InsertDeliveryJobInput): Promise<boolean> {
    this.inputs.push(input);
    return Promise.resolve(true);
  }
  claimNext(): Promise<DeliveryJob | null> { throw new Error("unused"); }
  extendLease(): Promise<boolean> { throw new Error("unused"); }
  storePayload(): Promise<boolean> { throw new Error("unused"); }
  complete(): Promise<boolean> { throw new Error("unused"); }
  retry(): Promise<boolean> { throw new Error("unused"); }
  fail(): Promise<boolean> { throw new Error("unused"); }
  async requestCancellation() {
    this.cancelRequested = true;
    return "requested" as const;
  }
  async isCancellationRequested() {
    this.cancellationChecks += 1;
    return this.cancelRequested || (
      this.cancelAfterChecks !== null &&
      this.cancellationChecks > this.cancelAfterChecks
    );
  }
}

class FakeRepository {
  sources: KnowledgeSource[] = [];
  hits: KnowledgeSearchHit[] = [];
  replacements: Array<Record<string, unknown>> = [];
  deletions: Array<{ kind: string; key: string }> = [];
  nameUpdates: Array<{ key: string; name: string }> = [];
  searchInputs: Array<{ limit: number; minimumSimilarity: number }> = [];

  async replaceSource(input: Record<string, unknown>) {
    this.replacements.push(input);
    const source = input as {
      sourceKind: "drive_file" | "chat_attachment";
      sourceKey: string;
      sourceName: string;
      sourceVersionOrHash: string;
      chunks: unknown[];
    };
    this.sources = this.sources.filter(
      (existing) =>
        existing.sourceKind !== source.sourceKind ||
        existing.sourceKey !== source.sourceKey,
    );
    this.sources.push({
      sourceKind: source.sourceKind,
      sourceKey: source.sourceKey,
      sourceName: source.sourceName,
      sourceVersionOrHash: source.sourceVersionOrHash,
    });
    return "replaced" as const;
  }
  async listSources() { return this.sources; }
  async deleteSource(_scope: unknown, kind: string, key: string) {
    this.deletions.push({ kind, key });
    return true;
  }
  async updateSourceName(input: {
    sourceKey: string;
    sourceName: string;
    sourceVersionOrHash: string;
  }) {
    const source = this.sources.find(
      (candidate) =>
        candidate.sourceKind === "drive_file" &&
        candidate.sourceKey === input.sourceKey &&
        candidate.sourceVersionOrHash === input.sourceVersionOrHash,
    );
    if (!source) {
      return false;
    }
    source.sourceName = input.sourceName;
    this.nameUpdates.push({ key: input.sourceKey, name: input.sourceName });
    return true;
  }
  async search(input: {
    scope: unknown;
    embedding: number[];
    limit: number;
    minimumSimilarity: number;
  }) {
    this.searchInputs.push({
      limit: input.limit,
      minimumSimilarity: input.minimumSimilarity,
    });
    return this.hits;
  }
}

class FakeMessenger {
  creates: KnowledgeProgress[] = [];
  updates: KnowledgeProgress[] = [];
  async create(_chatId: string, progress: KnowledgeProgress) {
    this.creates.push(progress);
    return "om_progress";
  }
  async update(_messageId: string, progress: KnowledgeProgress) {
    this.updates.push(progress);
  }
}

const cipher = new TokenCipher(Buffer.alloc(32, 14));
const vector = Array.from(
  { length: KNOWLEDGE_EMBEDDING_DIMENSIONS },
  (_, index) => index === 0 ? 1 : 0,
);

function makeWorkflow(options: {
  repository?: FakeRepository;
  queue?: FakeQueue;
  messenger?: FakeMessenger;
  driveFiles?: Array<{ token: string; name: string; version: string }>;
  driveFileResponses?: Array<
    Array<{ token: string; name: string; version: string }> | Error
  >;
  verifyWorkspace?: () => Promise<boolean>;
  observeDocuments?: (texts: string[]) => void;
  observeEvidence?: (evidence: Array<{ label: string; text: string }>) => void;
  answerCitations?: string[];
} = {}) {
  const repository = options.repository ?? new FakeRepository();
  const queue = options.queue ?? new FakeQueue();
  const messenger = options.messenger ?? new FakeMessenger();
  const driveFiles = options.driveFiles ?? [];
  let documentEmbeddingCalls = 0;
  let driveListCalls = 0;
  let driveReadCalls = 0;
  const workflow = new KnowledgeWorkflow({
    queue,
    cipher,
    repository,
    embedder: {
      async embedDocuments(texts) {
        documentEmbeddingCalls += 1;
        options.observeDocuments?.(texts);
        return texts.map(() => vector);
      },
      async embedQuery() { return vector; },
    },
    attachmentReader: {
      async downloadPdf() {
        return { filename: "Quarterly Strategy.pdf", bytes: Buffer.from("pdf") };
      },
    },
    driveReader: {
      async listKnowledgeFiles() {
        driveListCalls += 1;
        const response = options.driveFileResponses?.[driveListCalls - 1];
        if (response instanceof Error) {
          throw response;
        }
        return response ?? driveFiles;
      },
      async readKnowledgeFile(input) {
        driveReadCalls += 1;
        const file = driveFiles.find((candidate) => candidate.token === input.fileToken);
        if (
          !file ||
          file.version !== input.expectedVersion ||
          file.name !== input.expectedName
        ) {
          throw new Error("snapshot changed");
        }
        return { ...file, bytes: Buffer.from("pdf") };
      },
    },
    answerer: {
      async answerGrounded(input) {
        options.observeEvidence?.(input.evidence);
        return {
          supported: true,
          answer: "Grounded answer.",
          citations: options.answerCitations ?? ["S1"],
        };
      },
    },
    messenger,
    scope: {
      tenantKey: "tenant_synvo",
      userOpenId: "ou_victor",
      workspaceFolderToken: "fldcnRoot123",
    },
    verifyWorkspace: options.verifyWorkspace ?? (async () => true),
    now: () => new Date("2026-08-11T00:00:00Z"),
    extractPdf: async () => ({
      text: "Architecture evidence.",
      pageCount: 1,
      truncated: false,
      pages: [{ pageNumber: 1, text: "Architecture evidence." }],
    }),
  });
  return {
    workflow,
    repository,
    queue,
    messenger,
    documentEmbeddingCalls: () => documentEmbeddingCalls,
    driveListCalls: () => driveListCalls,
    driveReadCalls: () => driveReadCalls,
  };
}

function queuedJob(input: InsertDeliveryJobInput): DeliveryJob {
  return {
    id: input.id,
    dedupeKey: input.dedupeKey,
    runId: null,
    kind: "KNOWLEDGE",
    chatId: input.chatId,
    payloadCiphertext: input.payloadCiphertext ?? null,
    attemptCount: 1,
    expiresAt: input.expiresAt ?? null,
  };
}

test("queues only encrypted attachment identity and indexes after consent", async () => {
  const { workflow, queue, repository, messenger } = makeWorkflow();
  assert.equal(
    await workflow.enqueueAttachment({
      sourceMessageId: "om_source",
      cardMessageId: "om_card",
      chatId: "oc_chat",
    }),
    true,
  );
  const input = queue.inputs[0]!;
  assert.equal(input.kind, "KNOWLEDGE");
  assert.equal(input.dedupeKey, "knowledge:attachment:om_source");
  assert.equal(JSON.stringify(input).includes("Quarterly Strategy"), false);
  const job = queuedJob(input);
  const plaintext = decryptDeliveryMessage(cipher, job.id, input.payloadCiphertext!);
  await workflow.process(job, plaintext, async () => true, false);

  assert.equal(repository.replacements.length, 1);
  const replacement = repository.replacements[0] as {
    scope: { tenantKey: string; userOpenId: string; workspaceFolderToken: string };
    sourceKind: string;
    sourceKey: string;
    chunks: Array<{ pageNumber: number; embedding: number[] }>;
  };
  assert.deepEqual(replacement.scope, {
    tenantKey: "tenant_synvo",
    userOpenId: "ou_victor",
    workspaceFolderToken: "fldcnRoot123",
  });
  assert.equal(replacement.sourceKind, "chat_attachment");
  assert.equal(replacement.sourceKey, "om_source");
  assert.equal(replacement.chunks[0]?.pageNumber, 1);
  assert.equal(replacement.chunks[0]?.embedding.length, 1_024);
  assert.equal(messenger.updates.at(-1)?.stage, "complete");
  assert.ok(messenger.updates.at(-1)?.sourceReference);

  assert.equal(
    await workflow.removeSource(messenger.updates.at(-1)!.sourceReference!),
    true,
  );
  assert.deepEqual(repository.deletions, [
    { kind: "chat_attachment", key: "om_source" },
  ]);
});

test("does not ingest an attachment after active workspace verification is lost", async () => {
  const repository = new FakeRepository();
  const { workflow, queue, messenger } = makeWorkflow({
    repository,
    verifyWorkspace: async () => false,
  });
  await workflow.enqueueAttachment({
    sourceMessageId: "om_source",
    cardMessageId: "om_card",
    chatId: "oc_chat",
  });
  const input = queue.inputs[0]!;
  const job = queuedJob(input);
  await workflow.process(
    job,
    decryptDeliveryMessage(cipher, job.id, input.payloadCiphertext!),
    async () => true,
    false,
  );

  assert.equal(repository.replacements.length, 0);
  assert.equal(messenger.updates.at(-1)?.stage, "failed");
});

test("reuses the knowledge-search card for question progress", async () => {
  const { workflow, queue, messenger } = makeWorkflow();
  await workflow.enqueueQuestion({
    messageId: "om_question",
    chatId: "oc_chat",
    question: "What documentation is required?",
    progressMessageId: "om_thinking",
  });

  const input = queue.inputs[0]!;
  const job = queuedJob(input);
  const plaintext = decryptDeliveryMessage(cipher, job.id, input.payloadCiphertext!);
  await workflow.process(job, plaintext, async () => true, false);

  assert.equal(messenger.creates.length, 0);
  assert.equal(messenger.updates[0]?.stage, "answering");
  assert.equal(messenger.updates.at(-1)?.stage, "complete");
});

test("refresh approval is exact, expiring, and revalidates each Drive file", async () => {
  const repository = new FakeRepository();
  repository.sources = [
    {
      sourceKind: "drive_file",
      sourceKey: "old-token",
      sourceName: "old.pdf",
      sourceVersionOrHash: "1",
    },
  ];
  const { workflow, queue, messenger } = makeWorkflow({
    repository,
    driveFiles: [{ token: "new-token", name: "new.pdf", version: "2" }],
  });
  const proposal = await workflow.proposeRefresh();
  assert.deepEqual(proposal.files, [{ name: "new.pdf" }]);
  assert.deepEqual(proposal.pathUpdates, []);
  assert.deepEqual(proposal.removedSources, [{ name: "old.pdf" }]);
  assert.equal(proposal.snapshot.includes("new-token"), false);

  assert.equal(
    (await workflow.enqueueRefresh({
      messageId: "om_refresh_card",
      chatId: "oc_chat",
      snapshot: proposal.snapshot,
    })).queued,
    true,
  );
  const input = queue.inputs[0]!;
  const job = queuedJob(input);
  const plaintext = decryptDeliveryMessage(cipher, job.id, input.payloadCiphertext!);
  await workflow.process(job, plaintext, async () => true, false);
  assert.equal(repository.replacements.length, 1);
  assert.deepEqual(repository.deletions, [{ kind: "drive_file", key: "old-token" }]);
  assert.match(messenger.updates.at(-1)?.message ?? "", /Added or refreshed: \*\*1\*\*/u);
});

test("classifies and applies a path-only Drive change without extraction or Voyage", async () => {
  const repository = new FakeRepository();
  repository.sources = [{
    sourceKind: "drive_file",
    sourceKey: "stable-token",
    sourceName: "Archive / Guide.pdf",
    sourceVersionOrHash: "version-one",
  }];
  const driveFiles = [{
    token: "stable-token",
    name: "Research / Guide.pdf",
    version: "version-one",
  }];
  const fixture = makeWorkflow({ repository, driveFiles });
  const proposal = await fixture.workflow.proposeRefresh();
  assert.deepEqual(proposal.files, []);
  assert.deepEqual(proposal.pathUpdates, [{
    name: "Research / Guide.pdf",
    previousName: "Archive / Guide.pdf",
  }]);
  assert.deepEqual(proposal.removedSources, []);

  await fixture.workflow.enqueueRefresh({
    messageId: "om_refresh_card",
    chatId: "oc_chat",
    snapshot: proposal.snapshot,
  });
  const input = fixture.queue.inputs[0]!;
  const job = queuedJob(input);
  await fixture.workflow.process(
    job,
    decryptDeliveryMessage(cipher, job.id, input.payloadCiphertext!),
    async () => true,
    false,
  );

  assert.equal(fixture.driveReadCalls(), 0);
  assert.equal(fixture.documentEmbeddingCalls(), 0);
  assert.equal(repository.replacements.length, 0);
  assert.deepEqual(repository.nameUpdates, [{
    key: "stable-token",
    name: "Research / Guide.pdf",
  }]);
  assert.equal(repository.sources[0]?.sourceName, "Research / Guide.pdf");
  assert.match(
    fixture.messenger.updates.at(-1)?.message ?? "",
    /Paths updated without reprocessing: \*\*1\*\*/u,
  );
  repository.hits = [{
    sourceName: repository.sources[0]!.sourceName,
    pageNumber: 3,
    text: "The stable source remains queryable after its path changes.",
  }];
  assert.deepEqual(await fixture.workflow.searchWorkspace("Where is the guide?"), {
    supported: true,
    answer: "Grounded answer.",
    citations: [{ sourceName: "Research / Guide.pdf", pageNumber: 3 }],
  });
});

test("content changes replace the source once even when its path also changed", async () => {
  const repository = new FakeRepository();
  repository.sources = [{
    sourceKind: "drive_file",
    sourceKey: "stable-token",
    sourceName: "Archive / Guide.pdf",
    sourceVersionOrHash: "version-one",
  }];
  const driveFiles = [{
    token: "stable-token",
    name: "Research / Guide.pdf",
    version: "version-two",
  }];
  const fixture = makeWorkflow({ repository, driveFiles });
  const proposal = await fixture.workflow.proposeRefresh();
  assert.deepEqual(proposal.files, [{ name: "Research / Guide.pdf" }]);
  assert.deepEqual(proposal.pathUpdates, []);
  await fixture.workflow.enqueueRefresh({
    messageId: "om_refresh_card",
    chatId: "oc_chat",
    snapshot: proposal.snapshot,
  });
  const input = fixture.queue.inputs[0]!;
  const job = queuedJob(input);
  await fixture.workflow.process(
    job,
    decryptDeliveryMessage(cipher, job.id, input.payloadCiphertext!),
    async () => true,
    false,
  );
  assert.equal(fixture.driveReadCalls(), 1);
  assert.equal(fixture.documentEmbeddingCalls(), 1);
  assert.equal(repository.replacements.length, 1);
  assert.equal(repository.nameUpdates.length, 0);
  assert.equal(repository.sources[0]?.sourceName, "Research / Guide.pdf");
});

test("rejects an approval when the recursive file set changes before enqueue", async () => {
  const reviewed = [{ token: "one", name: "Root.pdf", version: "1" }];
  const changed = [{ token: "one", name: "Nested / Root.pdf", version: "1" }];
  const { workflow, queue } = makeWorkflow({
    driveFileResponses: [reviewed, changed],
  });
  const proposal = await workflow.proposeRefresh();
  await assert.rejects(
    workflow.enqueueRefresh({
      messageId: "om_refresh_card",
      chatId: "oc_chat",
      snapshot: proposal.snapshot,
    }),
    /workspace changed/u,
  );
  assert.equal(queue.inputs.length, 0);
});

test("never removes a source after an incomplete final Drive scan", async () => {
  const repository = new FakeRepository();
  repository.sources = [{
    sourceKind: "drive_file",
    sourceKey: "missing-token",
    sourceName: "Old / Missing.pdf",
    sourceVersionOrHash: "1",
  }];
  const fixture = makeWorkflow({
    repository,
    driveFileResponses: [[], [], [], new Error("incomplete recursive scan")],
  });
  const proposal = await fixture.workflow.proposeRefresh();
  assert.deepEqual(proposal.removedSources, [{ name: "Old / Missing.pdf" }]);
  await fixture.workflow.enqueueRefresh({
    messageId: "om_refresh_card",
    chatId: "oc_chat",
    snapshot: proposal.snapshot,
  });
  const input = fixture.queue.inputs[0]!;
  const job = queuedJob(input);
  await fixture.workflow.process(
    job,
    decryptDeliveryMessage(cipher, job.id, input.payloadCiphertext!),
    async () => true,
    true,
  );
  assert.deepEqual(repository.deletions, []);
  assert.equal(fixture.messenger.updates.at(-1)?.stage, "failed");
});

test("rejects unrelated recursive tree drift before final removal reconciliation", async () => {
  const repository = new FakeRepository();
  repository.sources = [{
    sourceKind: "drive_file",
    sourceKey: "missing-token",
    sourceName: "Old / Missing.pdf",
    sourceVersionOrHash: "1",
  }];
  const addedLater = [{
    token: "new-token",
    name: "Research / Added Later.pdf",
    version: "1",
  }];
  const fixture = makeWorkflow({
    repository,
    driveFileResponses: [[], [], [], addedLater],
  });
  const proposal = await fixture.workflow.proposeRefresh();
  await fixture.workflow.enqueueRefresh({
    messageId: "om_refresh_card",
    chatId: "oc_chat",
    snapshot: proposal.snapshot,
  });
  const input = fixture.queue.inputs[0]!;
  const job = queuedJob(input);
  await fixture.workflow.process(
    job,
    decryptDeliveryMessage(cipher, job.id, input.payloadCiphertext!),
    async () => true,
    true,
  );

  assert.deepEqual(repository.deletions, []);
  assert.equal(fixture.messenger.updates.at(-1)?.stage, "failed");
});

test("an unchanged nested PDF produces no work, download, embedding, or write", async () => {
  const repository = new FakeRepository();
  repository.sources = [{
    sourceKind: "drive_file",
    sourceKey: "nested-token",
    sourceName: "Research / Nested.pdf",
    sourceVersionOrHash: "1",
  }];
  const fixture = makeWorkflow({
    repository,
    driveFiles: [{
      token: "nested-token",
      name: "Research / Nested.pdf",
      version: "1",
    }],
  });
  const proposal = await fixture.workflow.proposeRefresh();
  assert.equal(proposal.hasChanges, false);
  assert.deepEqual(proposal.files, []);
  assert.deepEqual(proposal.pathUpdates, []);
  assert.deepEqual(proposal.removedSources, []);
  assert.equal(fixture.driveReadCalls(), 0);
  assert.equal(fixture.documentEmbeddingCalls(), 0);
  assert.equal(repository.replacements.length, 0);
  assert.equal(repository.nameUpdates.length, 0);
});

test("rejects a recursive review that cannot fit one bounded Lark approval", async () => {
  const driveFiles = Array.from({ length: 80 }, (_, index) => ({
    token: `token-${index}`,
    name: `${"Nested ".repeat(12)}Document ${index}.pdf`,
    version: "1",
  }));
  const { workflow, queue } = makeWorkflow({ driveFiles });
  await assert.rejects(workflow.proposeRefresh(), /safe Lark card limit/u);
  assert.equal(queue.inputs.length, 0);
});

test("refresh deduplication binds the exact approval rather than the reused card", async () => {
  const driveFiles = [{ token: "current-token", name: "current.pdf", version: "2" }];
  const { workflow, queue } = makeWorkflow({ driveFiles });
  const firstProposal = await workflow.proposeRefresh();
  await workflow.enqueueRefresh({
    messageId: "om_reused_card",
    chatId: "oc_chat",
    snapshot: firstProposal.snapshot,
  });
  await workflow.enqueueRefresh({
    messageId: "om_reused_card",
    chatId: "oc_chat",
    snapshot: firstProposal.snapshot,
  });

  const resumedProposal = await workflow.proposeRefresh();
  await workflow.enqueueRefresh({
    messageId: "om_reused_card",
    chatId: "oc_chat",
    snapshot: resumedProposal.snapshot,
  });

  assert.equal(queue.inputs[0]?.dedupeKey, queue.inputs[1]?.dedupeKey);
  assert.notEqual(queue.inputs[0]?.dedupeKey, queue.inputs[2]?.dedupeKey);
  assert.match(queue.inputs[0]?.dedupeKey ?? "", /^knowledge:refresh:[a-f0-9]{64}$/u);
});

test("a retried refresh skips a Drive file version already indexed", async () => {
  const repository = new FakeRepository();
  const driveFiles = [{ token: "current-token", name: "current.pdf", version: "2" }];
  const { workflow, queue, messenger } = makeWorkflow({ repository, driveFiles });
  const proposal = await workflow.proposeRefresh();
  await workflow.enqueueRefresh({
    messageId: "om_refresh_card",
    chatId: "oc_chat",
    snapshot: proposal.snapshot,
  });

  repository.sources = [{
    sourceKind: "drive_file",
    sourceKey: "current-token",
    sourceName: "current.pdf",
    sourceVersionOrHash: "2",
  }];
  const input = queue.inputs[0]!;
  const job = queuedJob(input);
  await workflow.process(
    job,
    decryptDeliveryMessage(cipher, job.id, input.payloadCiphertext!),
    async () => true,
    false,
  );

  assert.equal(repository.replacements.length, 0);
  assert.match(messenger.updates.at(-1)?.message ?? "", /Added or refreshed: \*\*0\*\*/u);
});

test("stops one exact refresh between files and keeps completed sources", async () => {
  const repository = new FakeRepository();
  const queue = new FakeQueue();
  queue.cancelAfterChecks = 2;
  const driveFiles = [
    { token: "first-token", name: "first.pdf", version: "1" },
    { token: "second-token", name: "second.pdf", version: "1" },
  ];
  const { workflow, messenger } = makeWorkflow({ repository, queue, driveFiles });
  const proposal = await workflow.proposeRefresh();
  const enqueued = await workflow.enqueueRefresh({
    messageId: "om_refresh_card",
    chatId: "oc_chat",
    snapshot: proposal.snapshot,
  });
  const input = queue.inputs[0]!;
  const job = queuedJob(input);

  await workflow.process(
    job,
    decryptDeliveryMessage(cipher, job.id, input.payloadCiphertext!),
    async () => true,
    false,
  );

  assert.equal(repository.replacements.length, 1);
  assert.equal(repository.sources[0]?.sourceName, "first.pdf");
  assert.equal(messenger.updates.at(-1)?.stage, "stopped");
  assert.match(messenger.updates.at(-1)?.message ?? "", /Completed: \*\*1 files\*\*/u);
  assert.match(messenger.updates.at(-1)?.message ?? "", /Not processed: \*\*1 files\*\*/u);
  assert.equal(enqueued.queued, true);
});

test("binds refresh cancellation to the configured identity and exact chat", async () => {
  const queue = new FakeQueue();
  const { workflow } = makeWorkflow({ queue });
  assert.equal(
    await workflow.requestRefreshStop({
      jobId: "ca55f05b-f138-41a1-8a73-7cf609866d79",
      chatId: "oc_chat",
      requesterOpenId: "ou_other",
      tenantKey: "tenant_synvo",
    }),
    "unauthorized",
  );
  assert.equal(queue.cancelRequested, false);
  assert.equal(
    await workflow.requestRefreshStop({
      jobId: "ca55f05b-f138-41a1-8a73-7cf609866d79",
      chatId: "oc_chat",
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
    }),
    "requested",
  );
  assert.equal(queue.cancelRequested, true);
});

test("answers only from bounded retrieved evidence and handles an empty vault", async () => {
  const repository = new FakeRepository();
  const { workflow } = makeWorkflow({ repository });
  assert.deepEqual(await workflow.searchWorkspace("What does it say?"), {
    supported: false,
    answer: "The current workspace knowledge does not contain enough evidence to answer that question.",
    citations: [],
  });

  repository.hits = [
    {
      sourceName: "Guide.pdf",
      pageNumber: 4,
      text: "Page-aware chunks preserve provenance.",
    },
  ];
  assert.deepEqual(await workflow.searchWorkspace("How are chunks created?"), {
    supported: true,
    answer: "Grounded answer.",
    citations: [{ sourceName: "Guide.pdf", pageNumber: 4 }],
  });
  assert.equal(KNOWLEDGE_SEARCH_MIN_SIMILARITY, 0.25);
  assert.deepEqual(repository.searchInputs, [
    {
      limit: KNOWLEDGE_SEARCH_TOP_K,
      minimumSimilarity: KNOWLEDGE_SEARCH_MIN_SIMILARITY,
    },
    {
      limit: KNOWLEDGE_SEARCH_TOP_K,
      minimumSimilarity: KNOWLEDGE_SEARCH_MIN_SIMILARITY,
    },
  ]);
});

test("returns distinct relative-path citations for root, nested, cross-folder, and same-name evidence", async () => {
  const repository = new FakeRepository();
  repository.hits = [
    {
      sourceName: "Root.pdf",
      pageNumber: 1,
      text: "Root evidence.",
    },
    {
      sourceName: "Product / Guide.pdf",
      pageNumber: 2,
      text: "Product evidence.",
    },
    {
      sourceName: "Research / Guide.pdf",
      pageNumber: 4,
      text: "Research evidence.",
    },
  ];
  const { workflow } = makeWorkflow({
    repository,
    answerCitations: ["S1", "S2", "S3"],
  });

  assert.deepEqual(await workflow.searchWorkspace("Compare all three guides."), {
    supported: true,
    answer: "Grounded answer.",
    citations: [
      { sourceName: "Root.pdf", pageNumber: 1 },
      { sourceName: "Product / Guide.pdf", pageNumber: 2 },
      { sourceName: "Research / Guide.pdf", pageNumber: 4 },
    ],
  });
});

test("keeps Drive paths and native identifiers out of Voyage and NVIDIA inputs", async () => {
  const driveFiles = [{
    token: "private-native-file-token",
    name: "Research / Private Guide.pdf",
    version: "version-one",
  }];
  let embeddedTexts: string[] = [];
  let evidence: Array<{ label: string; text: string }> = [];
  const repository = new FakeRepository();
  const fixture = makeWorkflow({
    repository,
    driveFiles,
    observeDocuments: (texts) => { embeddedTexts = texts; },
    observeEvidence: (value) => { evidence = value; },
  });
  const proposal = await fixture.workflow.proposeRefresh();
  await fixture.workflow.enqueueRefresh({
    messageId: "om_refresh_card",
    chatId: "oc_chat",
    snapshot: proposal.snapshot,
  });
  const input = fixture.queue.inputs[0]!;
  const job = queuedJob(input);
  await fixture.workflow.process(
    job,
    decryptDeliveryMessage(cipher, job.id, input.payloadCiphertext!),
    async () => true,
    false,
  );

  assert.deepEqual(embeddedTexts, ["Architecture evidence."]);
  assert.doesNotMatch(JSON.stringify(embeddedTexts), /Research|private-native-file-token/u);

  repository.hits = [{
    sourceName: "Research / Private Guide.pdf",
    pageNumber: 1,
    text: "Bounded evidence only.",
  }];
  await fixture.workflow.searchWorkspace("What does the guide say?");
  assert.deepEqual(evidence, [{ label: "S1", text: "Bounded evidence only." }]);
  assert.doesNotMatch(JSON.stringify(evidence), /Research|private-native-file-token/u);
});

test("verifies the active workspace and enforces the evidence budget before answering", async () => {
  const repository = new FakeRepository();
  repository.hits = Array.from({ length: 10 }, (_, index) => ({
    sourceName: `Guide-${index}.pdf`,
    pageNumber: index + 1,
    text: "x".repeat(3_000),
  }));
  let evidence: Array<{ label: string; text: string }> = [];
  const { workflow } = makeWorkflow({
    repository,
    observeEvidence: (value) => { evidence = value; },
  });
  await workflow.searchWorkspace("What is supported?");
  assert.ok(evidence.length <= 10);
  assert.ok(
    evidence.reduce((total, item) => total + Array.from(item.text).length, 0) <=
      KNOWLEDGE_MAX_EVIDENCE_CODE_POINTS,
  );

  const unverified = makeWorkflow({
    repository,
    verifyWorkspace: async () => false,
  });
  assert.deepEqual(await unverified.workflow.searchWorkspace("Question"), {
    supported: false,
    answer: "I couldn’t verify the active workspace, so I didn’t search its knowledge vault.",
    citations: [],
  });
});
