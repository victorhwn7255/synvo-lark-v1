import assert from "node:assert/strict";
import test from "node:test";

import { TokenCipher } from "../lark/auth/index.js";
import { encryptDeliveryMessage } from "./crypto.js";
import type { DeliveryJob, DeliveryQueue } from "./repository.js";
import { DeliveryWorker } from "./worker.js";

class FakeQueue implements DeliveryQueue {
  jobs: DeliveryJob[] = [];
  storedPayload: string | null = null;
  completed = 0;
  retried = 0;
  failedCodes: string[] = [];
  extendedLeases: Date[] = [];

  async enqueue(): Promise<boolean> { return true; }
  async claimNext(): Promise<DeliveryJob | null> { return this.jobs.shift() ?? null; }
  async extendLease(_job: DeliveryJob, leaseExpiresAt: Date): Promise<boolean> {
    this.extendedLeases.push(leaseExpiresAt);
    return true;
  }
  async storePayload(_job: DeliveryJob, payload: string): Promise<boolean> {
    this.storedPayload = payload;
    return true;
  }
  async complete(): Promise<boolean> { this.completed += 1; return true; }
  async retry(): Promise<boolean> { this.retried += 1; return true; }
  async fail(_job: DeliveryJob, code: string): Promise<boolean> {
    this.failedCodes.push(code);
    return true;
  }
  async requestCancellation() { return "terminal" as const; }
  async isCancellationRequested() { return false; }
}

function scanJob(attemptCount = 1, payloadCiphertext: string | null = null): DeliveryJob {
  return {
    id: "ca55f05b-f138-41a1-8a73-7cf609866d79",
    dedupeKey: "scan:test",
    runId: "9d8b0137-ab5d-4b88-bbc3-fef37e1849a2",
    kind: "ORGANIZE_FOLDER_SCAN",
    chatId: "oc_pilot",
    payloadCiphertext,
    attemptCount,
    expiresAt: null,
  };
}

function createWorker(
  queue: FakeQueue,
  options: {
    prepareMessage?: () => Promise<string>;
    prepareExhaustedMessage?: () => Promise<string>;
    sendText?: (
      chatId: string,
      text: string,
      key: string,
      operation?: Pick<DeliveryJob, "kind" | "runId">,
    ) => Promise<void>;
    maxAttempts?: number;
  } = {},
) {
  return new DeliveryWorker({
    queue,
    cipher: new TokenCipher(Buffer.alloc(32, 3)),
    prepareMessage: options.prepareMessage ?? (async () => "bounded inventory"),
    prepareExhaustedMessage:
      options.prepareExhaustedMessage ??
      (async () => "Inventory failed safely.\n\nNo files were changed."),
    sendText: options.sendText ?? (async () => {}),
    maxAttempts: options.maxAttempts,
  });
}

test("stores a prepared scan result before idempotent delivery", async () => {
  const queue = new FakeQueue();
  queue.jobs.push(scanJob());
  const sent: Array<{ text: string; key: string }> = [];
  await createWorker(queue, {
    sendText: async (_chatId, text, key) => { sent.push({ text, key }); },
  }).processOne();

  assert.ok(queue.storedPayload);
  assert.deepEqual(sent, [{
    text: "bounded inventory",
    key: "ca55f05b-f138-41a1-8a73-7cf609866d79",
  }]);
  assert.equal(queue.completed, 1);
});

test("extends a folder scan lease for bounded content analysis", async () => {
  const queue = new FakeQueue();
  queue.jobs.push(scanJob());
  const now = new Date("2026-08-09T00:00:00.000Z");
  const worker = new DeliveryWorker({
    queue,
    cipher: new TokenCipher(Buffer.alloc(32, 3)),
    prepareMessage: async () => "bounded inventory",
    prepareExhaustedMessage: async () => "unused",
    sendText: async () => {},
    now: () => now,
  });

  await worker.processOne();

  assert.deepEqual(queue.extendedLeases, [
    new Date("2026-08-09T00:15:00.000Z"),
  ]);
});

test("supports a durable folder progress card through the existing job payload", async () => {
  const queue = new FakeQueue();
  queue.jobs.push(scanJob(3));
  const observed: Array<{ payload: string | null; finalAttempt: boolean }> = [];
  const worker = new DeliveryWorker({
    queue,
    cipher: new TokenCipher(Buffer.alloc(32, 3)),
    prepareMessage: async () => "unused",
    prepareExhaustedMessage: async () => "unused",
    sendText: async () => {},
    maxAttempts: 3,
    handleOrganizeFolderScan: async (
      _job,
      payload,
      storePayload,
      finalAttempt,
    ) => {
      observed.push({ payload, finalAttempt });
      assert.equal(await storePayload("om_progress"), true);
    },
  });

  await worker.processOne();

  assert.deepEqual(observed, [{ payload: null, finalAttempt: true }]);
  assert.ok(queue.storedPayload);
  assert.equal(queue.completed, 1);
});

test("reuses a stored payload when Lark delivery is retried", async () => {
  const queue = new FakeQueue();
  const cipher = new TokenCipher(Buffer.alloc(32, 3));
  const payload = encryptDeliveryMessage(
    cipher,
    scanJob().id,
    "cached inventory",
  );
  queue.jobs.push(scanJob(2, payload));
  let prepareCalls = 0;
  const sent: string[] = [];
  const worker = new DeliveryWorker({
    queue,
    cipher,
    prepareMessage: async () => { prepareCalls += 1; return "unused"; },
    prepareExhaustedMessage: async () => "unused",
    sendText: async (_chatId, text) => { sent.push(text); },
  });

  await worker.processOne();
  assert.equal(prepareCalls, 0);
  assert.deepEqual(sent, ["cached inventory"]);
});

test("uses the existing worker for execution and forwards the job kind", async () => {
  const queue = new FakeQueue();
  queue.jobs.push({
    ...scanJob(),
    kind: "ORGANIZE_FOLDER_EXECUTE",
  });
  const observed: string[] = [];
  const deliveries: Array<Pick<DeliveryJob, "kind" | "runId"> | undefined> = [];
  const worker = new DeliveryWorker({
    queue,
    cipher: new TokenCipher(Buffer.alloc(32, 3)),
    prepareMessage: async (_runId, kind) => {
      observed.push(kind);
      return "verified execution";
    },
    prepareExhaustedMessage: async () => "unused",
    sendText: async (_chatId, _text, _key, operation) => {
      deliveries.push(operation);
    },
  });

  await worker.processOne();

  assert.deepEqual(observed, ["ORGANIZE_FOLDER_EXECUTE"]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.kind, "ORGANIZE_FOLDER_EXECUTE");
  assert.equal(deliveries[0]?.runId, scanJob().runId);
  assert.equal(queue.completed, 1);
});

test("uses the existing worker for attachment analysis and stores its progress id", async () => {
  const queue = new FakeQueue();
  queue.jobs.push({
    ...scanJob(),
    dedupeKey: "analyze-attachment:om_source",
    runId: null,
    kind: "ANALYZE_ATTACHMENT",
  });
  const observedProgress: Array<string | null> = [];
  const worker = new DeliveryWorker({
    queue,
    cipher: new TokenCipher(Buffer.alloc(32, 3)),
    prepareMessage: async () => "unused",
    prepareExhaustedMessage: async () => "unused",
    sendText: async () => {},
    handleAnalyzeAttachment: async (_job, progressId, storeProgress) => {
      observedProgress.push(progressId);
      assert.equal(await storeProgress("om_progress"), true);
    },
  });

  await worker.processOne();

  assert.deepEqual(observedProgress, [null]);
  assert.ok(queue.storedPayload);
  assert.equal(queue.completed, 1);
});

test("attachment restart recovery supplies the stored progress id", async () => {
  const queue = new FakeQueue();
  const cipher = new TokenCipher(Buffer.alloc(32, 3));
  queue.jobs.push({
    ...scanJob(),
    dedupeKey: "analyze-attachment:om_source",
    runId: null,
    kind: "ANALYZE_ATTACHMENT",
    payloadCiphertext: encryptDeliveryMessage(
      cipher,
      scanJob().id,
      "om_existing_progress",
    ),
  });
  let observedProgress: string | null = null;
  const worker = new DeliveryWorker({
    queue,
    cipher,
    prepareMessage: async () => "unused",
    prepareExhaustedMessage: async () => "unused",
    sendText: async () => {},
    handleAnalyzeAttachment: async (_job, progressId) => {
      observedProgress = progressId;
    },
  });

  await worker.processOne();
  assert.equal(observedProgress, "om_existing_progress");
  assert.equal(queue.completed, 1);
});

test("uses the same worker for Drive file analysis and preserves encrypted context", async () => {
  const queue = new FakeQueue();
  const cipher = new TokenCipher(Buffer.alloc(32, 3));
  const context = JSON.stringify({
    version: 1,
    fileLink: "https://synvo-ai.larksuite.com/file/boxcnPdf123",
    progressMessageId: null,
  });
  queue.jobs.push({
    ...scanJob(),
    dedupeKey: "analyze-drive-file:om_source",
    runId: null,
    kind: "ANALYZE_DRIVE_FILE",
    payloadCiphertext: encryptDeliveryMessage(cipher, scanJob().id, context),
  });
  let observedPayload: string | null = null;
  const worker = new DeliveryWorker({
    queue,
    cipher,
    prepareMessage: async () => "unused",
    prepareExhaustedMessage: async () => "unused",
    sendText: async () => {},
    handleAnalyzeDriveFile: async (_job, payload, storePayload) => {
      observedPayload = payload;
      assert.equal(await storePayload("updated context"), true);
    },
  });

  await worker.processOne();

  assert.equal(observedPayload, context);
  assert.ok(queue.storedPayload);
  assert.equal(queue.storedPayload.includes("updated context"), false);
  assert.equal(queue.completed, 1);
});

test("extends the lease and preserves encrypted context for a knowledge job", async () => {
  const queue = new FakeQueue();
  const cipher = new TokenCipher(Buffer.alloc(32, 3));
  const job = {
    ...scanJob(),
    dedupeKey: "knowledge:question:om_source",
    runId: null,
    kind: "KNOWLEDGE" as const,
  };
  const context = JSON.stringify({
    operation: "question",
    question: "What does the workspace say?",
    progressMessageId: null,
  });
  queue.jobs.push({
    ...job,
    payloadCiphertext: encryptDeliveryMessage(cipher, job.id, context),
  });
  const now = new Date("2026-08-11T00:00:00.000Z");
  let observedPayload: string | null = null;
  const worker = new DeliveryWorker({
    queue,
    cipher,
    prepareMessage: async () => "unused",
    prepareExhaustedMessage: async () => "unused",
    sendText: async () => {},
    now: () => now,
    handleKnowledge: async (_job, payload, storePayload) => {
      observedPayload = payload;
      assert.equal(await storePayload("updated knowledge context"), true);
    },
  });

  await worker.processOne();

  assert.equal(observedPayload, context);
  assert.deepEqual(queue.extendedLeases, [
    new Date("2026-08-11T00:15:00.000Z"),
  ]);
  assert.ok(queue.storedPayload);
  assert.equal(queue.storedPayload.includes("updated knowledge context"), false);
  assert.equal(queue.completed, 1);
});

test("retries a temporary scan failure", async () => {
  const queue = new FakeQueue();
  queue.jobs.push(scanJob());
  await createWorker(queue, {
    prepareMessage: async () => { throw new Error("temporary"); },
  }).processOne();
  assert.equal(queue.retried, 1);
  assert.equal(queue.completed, 0);
});

test("persists and sends a safe terminal message after scan attempts are exhausted", async () => {
  const queue = new FakeQueue();
  queue.jobs.push(scanJob(3));
  const sent: string[] = [];
  await createWorker(queue, {
    prepareMessage: async () => { throw new Error("private provider detail"); },
    prepareExhaustedMessage: async () =>
      "The inventory could not be completed.\n\nNo files were changed.",
    sendText: async (_chatId, text) => { sent.push(text); },
    maxAttempts: 3,
  }).processOne();
  assert.ok(queue.storedPayload);
  assert.deepEqual(sent, [
    "The inventory could not be completed.\n\nNo files were changed.",
  ]);
  assert.equal(sent[0]?.includes("private provider detail"), false);
});

test("fails an invalid stored payload instead of retrying forever", async () => {
  const queue = new FakeQueue();
  queue.jobs.push(scanJob(1, "not-valid-ciphertext"));
  await createWorker(queue).processOne();
  assert.deepEqual(queue.failedCodes, ["DELIVERY_PAYLOAD_INVALID"]);
  assert.equal(queue.retried, 0);
});

test("rejects unsafe worker timing and retry options", () => {
  const queue = new FakeQueue();
  const base = {
    queue,
    cipher: new TokenCipher(Buffer.alloc(32, 3)),
    prepareMessage: async () => "message",
    prepareExhaustedMessage: async () => "message",
    sendText: async () => {},
  };
  assert.throws(() => new DeliveryWorker({ ...base, leaseMs: 0 }));
  assert.throws(() => new DeliveryWorker({ ...base, pollMs: -1 }));
  assert.throws(() => new DeliveryWorker({ ...base, maxAttempts: 0 }));
});
