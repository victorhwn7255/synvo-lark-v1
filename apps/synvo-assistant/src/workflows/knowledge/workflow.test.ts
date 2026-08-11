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
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from "./policy.js";
import { KNOWLEDGE_MAX_EVIDENCE_CODE_POINTS } from "./policy.js";

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
  async search() { return this.hits; }
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
  verifyWorkspace?: () => Promise<boolean>;
  observeEvidence?: (evidence: Array<{ label: string; text: string }>) => void;
} = {}) {
  const repository = options.repository ?? new FakeRepository();
  const queue = options.queue ?? new FakeQueue();
  const messenger = options.messenger ?? new FakeMessenger();
  const driveFiles = options.driveFiles ?? [];
  const workflow = new KnowledgeWorkflow({
    queue,
    cipher,
    repository,
    embedder: {
      async embedDocuments(texts) { return texts.map(() => vector); },
      async embedQuery() { return vector; },
    },
    attachmentReader: {
      async downloadPdf() {
        return { filename: "Quarterly Strategy.pdf", bytes: Buffer.from("pdf") };
      },
    },
    driveReader: {
      async listKnowledgeFiles() { return driveFiles; },
      async readKnowledgeFile(input) {
        const file = driveFiles.find((candidate) => candidate.token === input.fileToken);
        if (!file || file.version !== input.expectedVersion) {
          throw new Error("snapshot changed");
        }
        return { ...file, bytes: Buffer.from("pdf") };
      },
    },
    answerer: {
      async answerGrounded(input) {
        options.observeEvidence?.(input.evidence);
        return { supported: true, answer: "Grounded answer.", citations: ["S1"] };
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
  return { workflow, repository, queue, messenger };
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
