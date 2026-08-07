import assert from "node:assert/strict";
import test from "node:test";

import { TokenCipher } from "@synvo/lark-auth";

import {
  decryptDeliveryMessage,
  encryptDeliveryMessage,
} from "./crypto.js";
import type { DeliveryJob, DeliveryQueue } from "./repository.js";
import { DeliveryWorker } from "./worker.js";

class FakeQueue implements DeliveryQueue {
  jobs: DeliveryJob[] = [];
  storedPayload: string | null = null;
  completed = 0;
  retried = 0;
  failed = 0;
  retryCalls: Array<{ availableAt: Date; errorCode: string }> = [];
  failCodes: string[] = [];
  storePayloadResult = true;
  completeResult = true;

  async enqueue(): Promise<boolean> {
    return true;
  }

  async claimNext(): Promise<DeliveryJob | null> {
    return this.jobs.shift() ?? null;
  }

  async storePayload(
    _job: DeliveryJob,
    payloadCiphertext: string,
  ): Promise<boolean> {
    this.storedPayload = payloadCiphertext;
    return this.storePayloadResult;
  }

  async complete(): Promise<boolean> {
    this.completed += 1;
    return this.completeResult;
  }

  async retry(
    _job: DeliveryJob,
    availableAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    this.retried += 1;
    this.retryCalls.push({ availableAt, errorCode });
    return true;
  }

  async fail(_job: DeliveryJob, errorCode: string): Promise<boolean> {
    this.failed += 1;
    this.failCodes.push(errorCode);
    return true;
  }
}

function scanJob(attemptCount = 1, payloadCiphertext: string | null = null): DeliveryJob {
  return {
    id: "ca55f05b-f138-41a1-8a73-7cf609866d79",
    runId: "9d8b0137-ab5d-4b88-bbc3-fef37e1849a2",
    kind: "ORGANIZE_FOLDER_SCAN",
    chatId: "oc_pilot",
    payloadCiphertext,
    attemptCount,
    expiresAt: null,
  };
}

function textJob(
  payloadCiphertext: string | null,
  options: { attemptCount?: number; expiresAt?: Date | null } = {},
): DeliveryJob {
  return {
    id: "3b8a3787-2f7c-42e3-9f29-961102288afd",
    runId: null,
    kind: "TEXT",
    chatId: "oc_pilot",
    payloadCiphertext,
    attemptCount: options.attemptCount ?? 1,
    expiresAt: options.expiresAt ?? null,
  };
}

function finalizeWithQueue(queue: FakeQueue) {
  return (job: DeliveryJob, payloadCiphertext: string): Promise<boolean> =>
    queue.storePayload(job, payloadCiphertext);
}

test("persists a scan result before idempotent Lark delivery", async () => {
  const queue = new FakeQueue();
  queue.jobs.push(scanJob());
  const sent: Array<{ chatId: string; text: string; key: string }> = [];
  const worker = new DeliveryWorker({
    queue,
    cipher: new TokenCipher(Buffer.alloc(32, 3)),
    scanFolder: async () => "bounded inventory",
    finalizeExhaustedScan: finalizeWithQueue(queue),
    sendText: async (chatId, text, key) => {
      sent.push({ chatId, text, key });
    },
  });

  assert.equal(await worker.processOne(), true);
  assert.ok(queue.storedPayload);
  assert.deepEqual(sent, [
    {
      chatId: "oc_pilot",
      text: "bounded inventory",
      key: "ca55f05b-f138-41a1-8a73-7cf609866d79",
    },
  ]);
  assert.equal(queue.completed, 1);
  assert.equal(queue.retried, 0);
});

test("retries delivery with the stored payload and the same message UUID", async () => {
  const queue = new FakeQueue();
  const cipher = new TokenCipher(Buffer.alloc(32, 4));
  queue.jobs.push(scanJob());
  let scanCalls = 0;
  let sendCalls = 0;
  const keys: string[] = [];
  const worker = new DeliveryWorker({
    queue,
    cipher,
    scanFolder: async () => {
      scanCalls += 1;
      return "recoverable inventory";
    },
    finalizeExhaustedScan: finalizeWithQueue(queue),
    sendText: async (_chatId, _text, key) => {
      sendCalls += 1;
      keys.push(key);
      if (sendCalls === 1) {
        throw new Error("temporary Lark send failure");
      }
    },
    now: () => new Date("2026-08-07T00:00:00.000Z"),
  });

  assert.equal(await worker.processOne(), true);
  assert.ok(queue.storedPayload);
  assert.equal(queue.retried, 1);
  queue.jobs.push(scanJob(2, queue.storedPayload));

  assert.equal(await worker.processOne(), true);
  assert.equal(scanCalls, 1);
  assert.equal(queue.completed, 1);
  assert.deepEqual(keys, [
    "ca55f05b-f138-41a1-8a73-7cf609866d79",
    "ca55f05b-f138-41a1-8a73-7cf609866d79",
  ]);
});

test("delivers a stored text payload without invoking a scan", async () => {
  const queue = new FakeQueue();
  const cipher = new TokenCipher(Buffer.alloc(32, 5));
  const job = textJob(
    encryptDeliveryMessage(
      cipher,
      "3b8a3787-2f7c-42e3-9f29-961102288afd",
      "authorization required",
    ),
  );
  queue.jobs.push(job);
  let scanCalls = 0;
  const sent: string[] = [];
  const worker = new DeliveryWorker({
    queue,
    cipher,
    scanFolder: async () => {
      scanCalls += 1;
      return "unexpected";
    },
    finalizeExhaustedScan: finalizeWithQueue(queue),
    sendText: async (_chatId, text) => {
      sent.push(text);
    },
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(scanCalls, 0);
  assert.deepEqual(sent, ["authorization required"]);
  assert.equal(queue.completed, 1);
});

test("uses exponential retry delay for a retryable scan failure", async () => {
  const queue = new FakeQueue();
  queue.jobs.push(scanJob(4));
  const now = new Date("2026-08-07T01:00:00.000Z");
  const worker = new DeliveryWorker({
    queue,
    cipher: new TokenCipher(Buffer.alloc(32, 6)),
    scanFolder: async () => {
      throw new Error("temporary scan failure");
    },
    finalizeExhaustedScan: finalizeWithQueue(queue),
    sendText: async () => {},
    now: () => now,
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(queue.retried, 1);
  assert.deepEqual(queue.retryCalls, [
    {
      availableAt: new Date("2026-08-07T01:00:08.000Z"),
      errorCode: "DELIVERY_RETRYABLE",
    },
  ]);
  assert.equal(queue.failed, 0);
});

test("fails an expired job instead of retrying it", async () => {
  const queue = new FakeQueue();
  const cipher = new TokenCipher(Buffer.alloc(32, 7));
  queue.jobs.push(
    textJob(
      encryptDeliveryMessage(
        cipher,
        "3b8a3787-2f7c-42e3-9f29-961102288afd",
        "expired authorization",
      ),
      { expiresAt: new Date("2026-08-07T00:59:59.000Z") },
    ),
  );
  const worker = new DeliveryWorker({
    queue,
    cipher,
    scanFolder: async () => "unused",
    finalizeExhaustedScan: finalizeWithQueue(queue),
    sendText: async () => {
      throw new Error("temporary send failure");
    },
    now: () => new Date("2026-08-07T01:00:00.000Z"),
  });

  assert.equal(await worker.processOne(), true);
  assert.deepEqual(queue.failCodes, ["DELIVERY_EXPIRED"]);
  assert.equal(queue.retried, 0);
});

test("finalizes and reports an exhausted scan without exposing its error", async () => {
  const queue = new FakeQueue();
  queue.jobs.push(scanJob(3));
  const cipher = new TokenCipher(Buffer.alloc(32, 8));
  const finalized: Array<{ job: DeliveryJob; payloadCiphertext: string }> = [];
  const sent: Array<{ text: string; key: string }> = [];
  const worker = new DeliveryWorker({
    queue,
    cipher,
    scanFolder: async () => {
      throw new Error("provider response included a sensitive request ID");
    },
    finalizeExhaustedScan: async (job, payloadCiphertext) => {
      finalized.push({ job, payloadCiphertext });
      return queue.storePayload(job, payloadCiphertext);
    },
    sendText: async (_chatId, text, key) => {
      sent.push({ text, key });
    },
    maxAttempts: 3,
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0]?.job.runId, scanJob().runId);
  assert.equal(finalized[0]?.payloadCiphertext, queue.storedPayload);
  assert.notEqual(finalized[0]?.payloadCiphertext, sent[0]?.text);
  assert.equal(
    decryptDeliveryMessage(
      cipher,
      "ca55f05b-f138-41a1-8a73-7cf609866d79",
      finalized[0]?.payloadCiphertext ?? "",
    ),
    sent[0]?.text,
  );
  assert.deepEqual(sent, [
    {
      text: "The read-only inventory could not be completed after several attempts.\n\nNo files were changed.",
      key: "ca55f05b-f138-41a1-8a73-7cf609866d79",
    },
  ]);
  assert.doesNotMatch(sent[0]?.text ?? "", /provider|request ID/i);
  assert.equal(queue.completed, 1);
  assert.equal(queue.failed, 0);
  assert.equal(queue.retried, 0);
});

test("preserves expiration instead of finalizing an exhausted scan", async () => {
  const queue = new FakeQueue();
  queue.jobs.push({
    ...scanJob(3),
    expiresAt: new Date("2026-08-07T00:59:59.000Z"),
  });
  let finalizationCalls = 0;
  let sendCalls = 0;
  const worker = new DeliveryWorker({
    queue,
    cipher: new TokenCipher(Buffer.alloc(32, 15)),
    scanFolder: async () => {
      throw new Error("temporary scan failure");
    },
    finalizeExhaustedScan: async () => {
      finalizationCalls += 1;
      return true;
    },
    sendText: async () => {
      sendCalls += 1;
    },
    now: () => new Date("2026-08-07T01:00:00.000Z"),
    maxAttempts: 3,
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(finalizationCalls, 0);
  assert.equal(sendCalls, 0);
  assert.deepEqual(queue.failCodes, ["DELIVERY_EXPIRED"]);
});

test("preserves exhausted Lark send failure behavior after a scan payload exists", async () => {
  const queue = new FakeQueue();
  const cipher = new TokenCipher(Buffer.alloc(32, 13));
  queue.jobs.push(
    scanJob(
      3,
      encryptDeliveryMessage(
        cipher,
        "ca55f05b-f138-41a1-8a73-7cf609866d79",
        "bounded inventory",
      ),
    ),
  );
  let finalizationCalls = 0;
  const worker = new DeliveryWorker({
    queue,
    cipher,
    scanFolder: async () => "unused",
    finalizeExhaustedScan: async () => {
      finalizationCalls += 1;
      return true;
    },
    sendText: async () => {
      throw new Error("temporary Lark send failure");
    },
    maxAttempts: 3,
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(finalizationCalls, 0);
  assert.deepEqual(queue.failCodes, ["DELIVERY_ATTEMPTS_EXHAUSTED"]);
  assert.equal(queue.retried, 0);
});

test("does not send an exhausted scan failure after losing its finalization lease", async () => {
  const queue = new FakeQueue();
  queue.jobs.push(scanJob(3));
  let sendCalls = 0;
  const worker = new DeliveryWorker({
    queue,
    cipher: new TokenCipher(Buffer.alloc(32, 14)),
    scanFolder: async () => {
      throw new Error("temporary scan failure");
    },
    finalizeExhaustedScan: async () => false,
    sendText: async () => {
      sendCalls += 1;
    },
    maxAttempts: 3,
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(sendCalls, 0);
  assert.deepEqual(queue.failCodes, ["DELIVERY_ATTEMPTS_EXHAUSTED"]);
  assert.equal(queue.completed, 0);
});

test("fails a missing or undecryptable payload without an endless retry", async (t) => {
  for (const payload of [null, "not-valid-ciphertext"]) {
    await t.test(payload === null ? "missing" : "undecryptable", async () => {
      const queue = new FakeQueue();
      queue.jobs.push(textJob(payload));
      const worker = new DeliveryWorker({
        queue,
        cipher: new TokenCipher(Buffer.alloc(32, 9)),
        scanFolder: async () => "unused",
        finalizeExhaustedScan: finalizeWithQueue(queue),
        sendText: async () => {
          throw new Error("must not send");
        },
      });

      assert.equal(await worker.processOne(), true);
      assert.deepEqual(queue.failCodes, ["DELIVERY_PAYLOAD_INVALID"]);
      assert.equal(queue.retried, 0);
      assert.equal(queue.completed, 0);
    });
  }
});

test("retries safely when the completion lease is lost after send", async () => {
  const queue = new FakeQueue();
  const cipher = new TokenCipher(Buffer.alloc(32, 10));
  queue.jobs.push(
    textJob(
      encryptDeliveryMessage(
        cipher,
        "3b8a3787-2f7c-42e3-9f29-961102288afd",
        "same delivery",
      ),
    ),
  );
  queue.completeResult = false;
  const sentKeys: string[] = [];
  const worker = new DeliveryWorker({
    queue,
    cipher,
    scanFolder: async () => "unused",
    finalizeExhaustedScan: finalizeWithQueue(queue),
    sendText: async (_chatId, _text, key) => {
      sentKeys.push(key);
    },
  });

  assert.equal(await worker.processOne(), true);
  assert.equal(queue.completed, 1);
  assert.equal(queue.retried, 1);
  assert.deepEqual(sentKeys, ["3b8a3787-2f7c-42e3-9f29-961102288afd"]);
});

test("rejects unsafe worker timing and retry options", () => {
  const base = {
    queue: new FakeQueue(),
    cipher: new TokenCipher(Buffer.alloc(32, 12)),
    scanFolder: async () => "unused",
    finalizeExhaustedScan: async () => true,
    sendText: async () => {},
  };

  assert.throws(() => new DeliveryWorker({ ...base, leaseMs: 0 }), /lease/);
  assert.throws(() => new DeliveryWorker({ ...base, pollMs: -1 }), /poll/);
  assert.throws(
    () => new DeliveryWorker({ ...base, maxAttempts: 0 }),
    /max attempts/,
  );
});
